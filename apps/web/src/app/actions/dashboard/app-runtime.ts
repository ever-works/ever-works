'use server';

import { z } from 'zod';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { appRuntimeAPI, appRuntimeActionsAPI } from '@/lib/api/app-runtime';
import {
    APP_RUNTIME_ROUTE_UNAVAILABLE,
    APP_TARGET_TLS_MODES,
    type AppDeployNotice,
    APP_LIFECYCLE_ACTIONS,
    type AppDeployRequestView,
    type AppLifecycleView,
    type AppRuntimeActionResult,
    type AppTargetSettingsView,
    type AppTargetView,
} from '@/lib/api/app-runtime.types';
import { APP_DEPLOY_TARGET_CHOICES } from '@ever-works/contracts';

/**
 * APW-06 T36 — the App runtime server actions behind the Deploy tab's App
 * branch.
 *
 * Security: server actions are reachable as POST endpoints via the
 * `Next-Action` header, so every action verifies the session itself before it
 * proxies anything — UI gating is not a security boundary. The API repeats the
 * access check (view for reads, edit for writes).
 *
 * The kubeconfig is accepted by exactly ONE action, {@link checkAppTargetAction},
 * and goes to exactly one route, `POST /api/works/:id/app-target/check`. It is
 * never logged, never echoed and never returned (ACC-06-56).
 */

/** The API caps the kubeconfig at 64 KiB (plan §9.1). */
const KUBECONFIG_MAX_BYTES = 64 * 1024;

const workIdSchema = z.string().uuid();

function unauthorized<T>(): AppRuntimeActionResult<T> {
    return { success: false, error: 'unauthorized', code: 'unauthorized', httpStatus: 401 };
}

function failure<T>(context: string, error: unknown): AppRuntimeActionResult<T> {
    if (error instanceof ApiResponseError) {
        const details = (error.details ?? {}) as { unmet?: unknown };
        const unmet: AppDeployNotice[] | undefined = Array.isArray(details.unmet)
            ? details.unmet.map((entry) => ({
                  code: String((entry as { code?: unknown })?.code ?? ''),
                  message: String((entry as { message?: unknown })?.message ?? ''),
              }))
            : undefined;
        return {
            success: false,
            error: error.message,
            code: error.statusCode === 404 ? APP_RUNTIME_ROUTE_UNAVAILABLE : error.code,
            httpStatus: error.statusCode,
            ...(unmet ? { unmet } : {}),
        };
    }
    // Never log the request body: one of these carries a kubeconfig.
    console.error(
        `Failed to ${context}:`,
        error instanceof Error ? error.message : 'unknown error',
    );
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
}

/** Read the App Work's target (degrades to the derived target on a 404). */
export async function getAppTargetAction(
    workId: string,
    deployProvider?: string | null,
): Promise<AppRuntimeActionResult<AppTargetView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    try {
        return { success: true, data: await appRuntimeAPI.getAppTarget(workId, deployProvider) };
    } catch (error) {
        return failure('read the App target', error);
    }
}

const settingsSchema = z
    .object({
        namespaceOverride: z.string().trim().max(63).optional(),
        ingressClass: z.string().trim().max(253).optional(),
        controllerNamespace: z.string().trim().max(63).optional(),
        tls: z.enum(APP_TARGET_TLS_MODES).optional(),
        issuer: z.string().trim().max(253).optional(),
        storageClass: z.string().trim().max(253).optional(),
        networkIsolation: z.boolean().optional(),
        allowRoot: z.boolean().optional(),
        managedSubdomain: z.boolean().optional(),
        primaryDomain: z.string().trim().max(253).optional(),
        autoDeploy: z.boolean().optional(),
        previews: z.boolean().optional(),
    })
    .strict();

/** Change the App Work's target (and, for Your cluster, its settings). */
export async function saveAppTargetAction(
    workId: string,
    input: { target: AppTargetView['target']; settings?: AppTargetSettingsView },
): Promise<AppRuntimeActionResult<AppTargetView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();

    const parsed = z
        .object({
            workId: workIdSchema,
            target: z.enum(APP_DEPLOY_TARGET_CHOICES),
            settings: settingsSchema.optional(),
        })
        .safeParse({ workId, target: input?.target, settings: input?.settings });
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0]?.message, code: 'invalid_input' };
    }

    try {
        const data = await appRuntimeAPI.putAppTarget(parsed.data.workId, {
            target: parsed.data.target,
            ...(parsed.data.settings ? { settings: parsed.data.settings } : {}),
        });
        return { success: true, data };
    } catch (error) {
        return failure('save the App target', error);
    }
}

/**
 * Store a pasted kubeconfig and start the worker's cluster check. Without a
 * kubeconfig it re-checks the stored credential. Answers once the check is
 * dispatched; the result is read back through {@link getAppTargetAction}.
 */
export async function checkAppTargetAction(
    workId: string,
    input: { kubeconfig?: string; kubeContext?: string },
): Promise<AppRuntimeActionResult> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();

    const kubeconfig = typeof input?.kubeconfig === 'string' ? input.kubeconfig.trim() : '';
    const kubeContext = typeof input?.kubeContext === 'string' ? input.kubeContext.trim() : '';
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    if (Buffer.byteLength(kubeconfig, 'utf8') > KUBECONFIG_MAX_BYTES) {
        return { success: false, error: 'kubeconfig too large', code: 'kubeconfig_too_large' };
    }
    if (kubeContext.length > 253) {
        return { success: false, error: 'context too long', code: 'invalid_input' };
    }

    try {
        await appRuntimeAPI.checkAppTarget(workId, {
            ...(kubeconfig ? { kubeconfig } : {}),
            ...(kubeContext ? { kubeContext } : {}),
        });
        return { success: true };
    } catch (error) {
        return failure('check the cluster connection', error);
    }
}

/**
 * **Deploy now** — `POST /api/works/:id/deploy`. `202` is a success; `409`
 * (another Deployment holds the lock) and `422` (unmet preconditions, the
 * isolated worker missing) come back as a failure that still carries the
 * controller's whole answer in `data`, so the button can render it.
 */
export async function requestAppDeployAction(
    workId: string,
    input: { buildId?: string; confirmClusterChange?: boolean } = {},
): Promise<AppRuntimeActionResult<AppDeployRequestView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();

    const parsed = z
        .object({
            workId: workIdSchema,
            buildId: z.string().uuid().optional(),
            confirmClusterChange: z.boolean().optional(),
        })
        .safeParse({ workId, ...input });
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0]?.message, code: 'invalid_input' };
    }

    try {
        const { httpStatus, result } = await appRuntimeAPI.requestAppDeploy(parsed.data.workId, {
            ...(parsed.data.buildId ? { buildId: parsed.data.buildId } : {}),
            ...(parsed.data.confirmClusterChange ? { confirmClusterChange: true } : {}),
        });
        if (httpStatus === 202) return { success: true, data: result, httpStatus };
        return {
            success: false,
            data: result,
            httpStatus,
            code: result.code ?? undefined,
            unmet: result.unmet,
        };
    } catch (error) {
        return failure('request an App deployment', error);
    }
}

/**
 * Lane aw-deploy-3 — **Roll back** (`POST /api/works/:id/app-rollback`, FR-34): an earlier Live
 * Deployment runs again; answers like `requestAppDeployAction` (202, 409, 422, 503).
 */
export async function rollbackAppAction(
    workId: string,
    input: { deploymentId: string; runPreDeployJobs?: boolean },
): Promise<AppRuntimeActionResult<AppDeployRequestView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();

    const parsed = z
        .object({
            workId: workIdSchema,
            deploymentId: z.string().uuid(),
            runPreDeployJobs: z.boolean().optional(),
        })
        .safeParse({ workId, ...input });
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0]?.message, code: 'invalid_input' };
    }

    try {
        const { httpStatus, result } = await appRuntimeActionsAPI.rollbackApp(parsed.data.workId, {
            deploymentId: parsed.data.deploymentId,
            ...(parsed.data.runPreDeployJobs ? { runPreDeployJobs: true } : {}),
        });
        if (httpStatus === 202) return { success: true, data: result, httpStatus };
        return {
            success: false,
            data: result,
            httpStatus,
            code: result.code ?? undefined,
            unmet: result.unmet,
        };
    } catch (error) {
        return failure('roll back an App', error);
    }
}

/**
 * Lane aw-deploy-3 — **Pause / Resume / Remove** (`POST /api/works/:id/app-lifecycle`). A removal
 * that also deletes stored data carries the slug the member typed; the API compares it.
 */
export async function appLifecycleAction(
    workId: string,
    input: { action: string; deleteData?: boolean; confirmSlug?: string },
): Promise<AppRuntimeActionResult<AppLifecycleView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();

    const parsed = z
        .object({
            workId: workIdSchema,
            action: z.enum(APP_LIFECYCLE_ACTIONS),
            deleteData: z.boolean().optional(),
            confirmSlug: z.string().max(200).optional(),
        })
        .safeParse({ workId, ...input });
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0]?.message, code: 'invalid_input' };
    }

    try {
        const data = await appRuntimeActionsAPI.appLifecycle(parsed.data.workId, {
            action: parsed.data.action,
            ...(parsed.data.deleteData ? { deleteData: true } : {}),
            ...(parsed.data.confirmSlug ? { confirmSlug: parsed.data.confirmSlug } : {}),
        });
        return { success: true, data, httpStatus: 202 };
    } catch (error) {
        return failure('change the App lifecycle', error);
    }
}
