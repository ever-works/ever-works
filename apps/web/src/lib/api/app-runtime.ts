import 'server-only';
import { serverFetch, serverMutation, ApiResponseError } from './server-api';
import {
    deriveAppTargetFromProvider,
    isAppDeployTargetChoice,
    type AppDeployRequestView,
    type AppStatusView,
    type AppTargetSettingsView,
    type AppTargetView,
    type AppLifecycleActionChoice,
    type AppLifecycleView,
} from './app-runtime.types';

/**
 * APW-06 T36 — the App runtime client (plan §9.1).
 *
 * ```
 * GET  /api/works/:id/app-target         → AppTargetView      (T33, may 404 today)
 * PUT  /api/works/:id/app-target         → AppTargetView      (T33, may 404 today)
 * POST /api/works/:id/app-target/check   → 202                (T33, may 404 today)
 * GET  /api/works/:id/app-status         → AppStatusView      (T33, may 404 today)
 * POST /api/works/:id/deploy             → 202 | 409 | 422    (on develop)
 * ```
 *
 * The T33 routes are not on every API yet. Each read degrades on `404` to the
 * answer the page can still render (the target derived from `deployProvider`,
 * no status) and says so through `routeAvailable`; each write lets the 404
 * through so the server action can tell the member the feature is not
 * available, instead of pretending it saved.
 *
 * The kubeconfig goes out exactly once, through {@link appRuntimeAPI.checkAppTarget}
 * — never through `PATCH /api/works/:workId/plugins/:pluginId/settings`, whose
 * connection validation would dial the pasted cluster from the API process
 * before the worker's guard runs (APW06-G01, ACC-06-56). Nothing this module
 * returns carries it back.
 */

type RawAppTarget = Partial<Omit<AppTargetView, 'routeAvailable'>> & { target?: unknown };

function normaliseTarget(
    raw: RawAppTarget | null | undefined,
    deployProvider?: string | null,
): AppTargetView {
    return {
        target: isAppDeployTargetChoice(raw?.target)
            ? raw.target
            : deriveAppTargetFromProvider(deployProvider),
        settings: raw?.settings ?? null,
        namespace: raw?.namespace ?? null,
        clusterCheck: raw?.clusterCheck ?? null,
        clusterCheckedAt: raw?.clusterCheckedAt ?? null,
        eligibility: raw?.eligibility ?? null,
        routeAvailable: true,
    };
}

function isNotFound(error: unknown): boolean {
    return error instanceof ApiResponseError && error.statusCode === 404;
}

export const appRuntimeAPI = {
    /**
     * The App Work's target, settings and last cluster check. A `404` means the
     * route is not deployed (or the Work is not an App Work): the target is then
     * derived from `deployProvider` and `routeAvailable` is `false`.
     */
    getAppTarget: async (
        workId: string,
        deployProvider?: string | null,
    ): Promise<AppTargetView> => {
        try {
            const raw = await serverFetch<RawAppTarget>(`/works/${workId}/app-target`);
            return normaliseTarget(raw, deployProvider);
        } catch (error) {
            if (isNotFound(error)) {
                return {
                    target: deriveAppTargetFromProvider(deployProvider),
                    settings: null,
                    namespace: null,
                    clusterCheck: null,
                    clusterCheckedAt: null,
                    eligibility: null,
                    routeAvailable: false,
                };
            }
            throw error;
        }
    },

    /** Change the target and its settings. Refusals stay `ApiResponseError`s. */
    putAppTarget: async (
        workId: string,
        body: { target: AppTargetView['target']; settings?: AppTargetSettingsView },
    ): Promise<AppTargetView> => {
        const raw = await serverMutation<RawAppTarget>({
            endpoint: `/works/${workId}/app-target`,
            data: body,
            method: 'PUT',
            wrapInData: false,
        });
        return normaliseTarget(raw);
    },

    /**
     * Store a kubeconfig (when given) and dispatch the worker's cluster check.
     * Answers `202` at once; the result lands in `GET app-target`'s
     * `clusterCheck` / `clusterCheckedAt`. A body without `kubeconfig` re-checks
     * the stored credential.
     */
    checkAppTarget: async (
        workId: string,
        body: { kubeconfig?: string; kubeContext?: string },
    ): Promise<void> => {
        await serverMutation<unknown>({
            endpoint: `/works/${workId}/app-target/check`,
            data: {
                ...(body.kubeconfig ? { kubeconfig: body.kubeconfig } : {}),
                ...(body.kubeContext ? { kubeContext: body.kubeContext } : {}),
            },
            method: 'POST',
            wrapInData: false,
        });
    },

    /** The runtime snapshot; `null` while the route is not deployed. */
    getAppStatus: async (workId: string): Promise<AppStatusView | null> => {
        try {
            return await serverFetch<AppStatusView>(`/works/${workId}/app-status`);
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    },

    /**
     * `POST /api/works/:id/deploy`. The controller answers the same body shape
     * for `202`, `409` and `422` (`work-app-deploy.controller.ts`), so a refusal
     * is returned — with its HTTP status — rather than thrown; only a transport
     * fault or an unexpected status throws.
     */
    requestAppDeploy: async (
        workId: string,
        body: { buildId?: string; confirmClusterChange?: boolean } = {},
    ): Promise<{ httpStatus: number; result: AppDeployRequestView }> => {
        try {
            const result = await serverMutation<Partial<AppDeployRequestView>>({
                endpoint: `/works/${workId}/deploy`,
                data: {
                    ...(body.buildId ? { buildId: body.buildId } : {}),
                    ...(body.confirmClusterChange === true ? { confirmClusterChange: true } : {}),
                },
                method: 'POST',
                wrapInData: false,
            });
            return { httpStatus: 202, result: normaliseDeploy(result) };
        } catch (error) {
            if (
                error instanceof ApiResponseError &&
                [409, 422, 503].includes(error.statusCode) &&
                error.details
            ) {
                return {
                    httpStatus: error.statusCode,
                    result: normaliseDeploy({
                        ...(error.details as Partial<AppDeployRequestView>),
                        code:
                            (error.details as Partial<AppDeployRequestView>).code ??
                            error.code ??
                            null,
                    }),
                };
            }
            throw error;
        }
    },
};

/**
 * Lane aw-deploy-3's two writes, outside the object above only so the deploy answer's
 * normaliser is shared: `POST app-rollback` answers exactly like `POST deploy`.
 */
export const appRuntimeActionsAPI = {
    rollbackApp: async (
        workId: string,
        body: { deploymentId: string; runPreDeployJobs?: boolean },
    ): Promise<{ httpStatus: number; result: AppDeployRequestView }> => {
        try {
            const result = await serverMutation<Partial<AppDeployRequestView>>({
                endpoint: `/works/${workId}/app-rollback`,
                data: {
                    deploymentId: body.deploymentId,
                    ...(body.runPreDeployJobs === true ? { runPreDeployJobs: true } : {}),
                },
                method: 'POST',
                wrapInData: false,
            });
            return { httpStatus: 202, result: normaliseDeploy(result) };
        } catch (error) {
            if (
                error instanceof ApiResponseError &&
                [409, 422, 503].includes(error.statusCode) &&
                error.details
            ) {
                return {
                    httpStatus: error.statusCode,
                    result: normaliseDeploy({
                        ...(error.details as Partial<AppDeployRequestView>),
                        code:
                            (error.details as Partial<AppDeployRequestView>).code ??
                            error.code ??
                            null,
                    }),
                };
            }
            throw error;
        }
    },

    appLifecycle: async (
        workId: string,
        body: { action: AppLifecycleActionChoice; deleteData?: boolean; confirmSlug?: string },
    ): Promise<AppLifecycleView> =>
        serverMutation<AppLifecycleView>({
            endpoint: `/works/${workId}/app-lifecycle`,
            data: {
                action: body.action,
                ...(body.deleteData === true ? { deleteData: true } : {}),
                ...(body.confirmSlug ? { confirmSlug: body.confirmSlug } : {}),
            },
            method: 'POST',
            wrapInData: false,
        }),
};

function normaliseDeploy(
    raw: Partial<AppDeployRequestView> | null | undefined,
): AppDeployRequestView {
    const list = (value: unknown) =>
        Array.isArray(value)
            ? value
                  .filter((entry) => entry && typeof entry === 'object')
                  .map((entry) => ({
                      code: String((entry as { code?: unknown }).code ?? ''),
                      message: String((entry as { message?: unknown }).message ?? ''),
                  }))
            : [];
    return {
        status: raw?.status,
        code: raw?.code ?? null,
        deploymentId: raw?.deploymentId ?? null,
        queuedDeploymentId: raw?.queuedDeploymentId ?? null,
        runningDeploymentId: raw?.runningDeploymentId ?? null,
        dispatched: raw?.dispatched,
        deduplicated: raw?.deduplicated,
        unmet: list(raw?.unmet),
        advisory: list(raw?.advisory),
        warnings: list(raw?.warnings),
    };
}
