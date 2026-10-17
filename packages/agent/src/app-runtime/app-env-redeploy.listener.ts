/**
 * APW-06 × APW-07 (2026-10-17, lane aw-env-redeploy) — **a runtime env change
 * redeploys what is live.**
 *
 * APW-07's `AppEnvService` emits `app.env.changed` / `app.env.rotated` with the
 * changed names split by phase (`AppEnvChangedPayload`). A **runtime-phase** name
 * (`runtime` / `both`) is read by the running app at deploy time, so the change
 * only takes effect when the Work's current Deployment is rolled out again. This
 * listener asks for that one redeploy through `AppDeployRequestService.request`
 * — the same path every other Deployment takes, with every §5.1 precondition,
 * the deploy lock and the latest-wins queue — and decides only *whether* to ask.
 *
 * ## Debounced, one redeploy per batch
 *
 * The first runtime change of a Work starts a {@link APP_ENV_REDEPLOY_DEBOUNCE_MS}
 * window; every change inside it rides along. A member saving five values in a
 * row gets ONE redeploy, with all five applied. The request carries
 * `requestId: app-env:<workId>:<window start>`, and an in-process guard covers a
 * window firing twice.
 *
 * ## When it does not ask
 *
 * - App Works is off, or no request service / runtime state is bound;
 * - the window saw no runtime-phase name (a build-only change reaches the app
 *   through the next Build, which APW-05's listener re-prepares for);
 * - the Work has no target, or `targetSettings.autoDeploy` is off — the owner
 *   turned automatic Deployments off, and an env save is not a reason to override
 *   that;
 * - there is no live Deployment (no `READY` App Deployment) — nothing runs that
 *   could read the new value, and the first Deploy will;
 * - a push or manual Build is open (`queued` / `running`): when it lands green it
 *   auto-deploys (APW-06 T35) with the new values, so a redeploy of the old image
 *   now would be a Deployment the next one immediately replaces.
 *
 * Every failure is logged and swallowed: the env change already landed.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { config } from '../config';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import { AppEnvChangedEvent, AppEnvRotatedEvent } from '../events/app-env.events';
import { AppDeployRequestService, type AppDeployRequestResult } from './app-deploy-request.service';

/** The debounce window: a batch of env saves becomes one redeploy. */
export const APP_ENV_REDEPLOY_DEBOUNCE_MS = 30_000;

/** How many recent Deployment rows the live read looks at. */
const RECENT_DEPLOYMENTS = 20;

/** The runtime-state facts this listener reads. */
export interface AppEnvRedeployStateStore {
    getOrCreate(workId: string): Promise<{
        target?: string | null;
        targetSettings?: { autoDeploy?: boolean | null } | null;
    } | null>;
}

/** What one window decided, returned for the spec (the timer ignores it). */
export type AppEnvRedeployOutcome =
    | { requested: true; deploymentOf: string; result: AppDeployRequestResult }
    | { requested: false; reason: string };

/** Either env event, as the bus delivers it, or its bare payload. */
type EnvEventLike =
    | AppEnvChangedEvent
    | AppEnvRotatedEvent
    | {
          readonly workId?: string;
          readonly runtimePhaseNames?: readonly string[];
          readonly payload?: {
              readonly workId?: string;
              readonly runtimePhaseNames?: readonly string[];
          };
      };

interface Window {
    readonly startedAt: number;
    readonly names: Set<string>;
    readonly timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class AppEnvRedeployListener implements OnModuleDestroy {
    private readonly logger = new Logger(AppEnvRedeployListener.name);
    private readonly windows = new Map<string, Window>();
    private readonly inFlight = new Set<string>();

    constructor(
        @Optional() private readonly requests?: AppDeployRequestService,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppEnvRedeployStateStore,
        @Optional() private readonly deployments?: WorkDeploymentRepository,
        @Optional() private readonly builds?: AppBuildRepository,
    ) {}

    onModuleDestroy(): void {
        for (const window of this.windows.values()) clearTimeout(window.timer);
        this.windows.clear();
    }

    @OnEvent(AppEnvChangedEvent.EVENT_NAME)
    onEnvChanged(event: EnvEventLike): void {
        this.collect(event);
    }

    @OnEvent(AppEnvRotatedEvent.EVENT_NAME)
    onEnvRotated(event: EnvEventLike): void {
        this.collect(event);
    }

    /** Add one event's runtime names to its Work's window, opening the window when needed. */
    private collect(event: EnvEventLike): void {
        if (!enabled()) return;
        const payload =
            (event as { payload?: { workId?: string; runtimePhaseNames?: readonly string[] } })
                ?.payload ?? (event as { workId?: string; runtimePhaseNames?: readonly string[] });
        const workId = payload?.workId;
        const names = payload?.runtimePhaseNames ?? [];
        if (!workId || names.length === 0) return;

        const open = this.windows.get(workId);
        if (open) {
            for (const name of names) open.names.add(name);
            return;
        }
        const startedAt = Date.now();
        const timer = setTimeout(() => {
            const window = this.windows.get(workId);
            this.windows.delete(workId);
            void this.redeploy(workId, startedAt, window ? [...window.names] : [...names]).catch(
                (error) =>
                    this.logger.warn(`Env redeploy of Work ${workId} failed: ${messageOf(error)}`),
            );
        }, APP_ENV_REDEPLOY_DEBOUNCE_MS);
        timer.unref?.();
        this.windows.set(workId, { startedAt, names: new Set(names), timer });
    }

    /**
     * One window's decision and, when it passes, its one request. Public so the
     * spec can drive it without the timer.
     */
    async redeploy(
        workId: string,
        windowStartedAt: number,
        names: readonly string[],
    ): Promise<AppEnvRedeployOutcome> {
        if (!enabled()) return { requested: false, reason: 'disabled' };
        if (names.length === 0) return { requested: false, reason: 'no_runtime_names' };
        if (!this.requests?.request || !this.states?.getOrCreate)
            return { requested: false, reason: 'unbound' };

        const key = `${workId}:${windowStartedAt}`;
        if (this.inFlight.has(key)) return { requested: false, reason: 'in_flight' };
        this.inFlight.add(key);
        try {
            const state = await this.states.getOrCreate(workId);
            const target = state?.target ?? null;
            if (!target || target === 'none') return { requested: false, reason: 'target_none' };
            if (state?.targetSettings?.autoDeploy === false)
                return { requested: false, reason: 'auto_deploy_off' };

            if (await this.buildPending(workId))
                return { requested: false, reason: 'build_pending' };

            const live = await this.liveDeployment(workId);
            if (!live) return { requested: false, reason: 'no_live_deployment' };

            const specCommitSha =
                typeof live.appRender?.specCommitSha === 'string'
                    ? live.appRender.specCommitSha
                    : null;
            const result = await this.requests.request({
                workId,
                userId: null,
                trigger: 'env-changed',
                buildId: live.buildId ?? null,
                ...(specCommitSha ? { specCommitSha } : {}),
                branch: live.branch ?? null,
                requestId: `app-env:${workId}:${windowStartedAt}`,
            });
            if (result.status === 'refused') {
                this.logger.log(`Env redeploy of Work ${workId} was refused: ${result.code}.`);
            }
            return { requested: true, deploymentOf: live.id, result };
        } finally {
            this.inFlight.delete(key);
        }
    }

    /** An open push or manual Build: it auto-deploys with the new values when it lands. */
    private async buildPending(workId: string): Promise<boolean> {
        if (!this.builds?.findPage) return false;
        try {
            const page = await this.builds.findPage(
                workId,
                { status: ['queued', 'running'], trigger: ['push', 'manual'] },
                1,
                1,
            );
            return page.rows.length > 0;
        } catch (error) {
            // Unreadable: redeploy anyway — a redundant Deployment is the safer error
            // than a value that never reaches the running app.
            this.logger.warn(`Open Builds of Work ${workId} unreadable: ${messageOf(error)}`);
            return false;
        }
    }

    /** The newest `READY` App Deployment among the recent rows, or `null`. */
    private async liveDeployment(workId: string): Promise<{
        id: string;
        buildId?: string | null;
        branch?: string | null;
        appRender?: Record<string, unknown> | null;
    } | null> {
        if (!this.deployments?.findByWork) return null;
        const rows = await this.deployments.findByWork(workId, { limit: RECENT_DEPLOYMENTS });
        const live = (rows ?? []).find((row) => Boolean(row?.appTarget) && row?.state === 'READY');
        return live
            ? {
                  id: live.id,
                  buildId: live.buildId ?? null,
                  branch: live.branch ?? null,
                  appRender: live.appRender ?? null,
              }
            : null;
    }
}

function enabled(): boolean {
    try {
        return config.everWorks?.apps?.worksEnabled?.() === true;
    } catch {
        return false;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
