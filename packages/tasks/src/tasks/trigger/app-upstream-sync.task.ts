import { Module } from '@nestjs/common';
import { logger, task, wait } from '@trigger.dev/sdk';
import {
    APP_UPSTREAM_LICENSE_SERVICE,
    APP_UPSTREAM_SYNC_SPEC_SOURCE,
    AppActionsHygieneService,
    AppUpstreamStateService,
    AppUpstreamSyncService,
    type AppUpstreamSyncTrigger,
} from '@ever-works/agent/app-works';
import { WorkUpstreamStateRepository } from '@ever-works/agent/database';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import { getOptionalProvider } from '@ever-works/agent/utils';
import {
    APP_UPSTREAM_STATE_SERVICE,
    TriggerInternalModule,
    WORK_UPSTREAM_STATE_REPOSITORY,
} from '../../trigger/worker/modules/trigger-internal.module';
import { TriggerFacadesModule } from '../../trigger/worker/modules/trigger-facades.module';
import { TriggerPluginsModule } from '../../trigger/worker/modules/trigger-plugins.module';
import { TriggerRemoteCacheModule } from '../../trigger/worker/modules/trigger-remote-cache.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import { createRemoteProxy } from '../../trigger/worker/remote-proxy';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * APW-02 T33 — `app-upstream-sync` (plan §6.3, `plan.md:715-760`).
 *
 * One sync run of one Fork / private-copy App Work: `AppUpstreamSyncService.run`
 * (`@ever-works/agent`'s `app-works` barrel, T26) compares the Work Repository with its
 * upstream, fast-forwards or opens the sync pull request, records a conflict, runs
 * Actions hygiene when the tracked branch moved, and settles the row. This file only
 * registers the id, composes the worker context and reports what the run did.
 *
 * ## Why the service runs HERE (unlike readiness, which proxies a runner)
 *
 * Plan §2.4 puts `AppUpstreamSyncService` in the worker, and T33 says why it builds:
 * **it needs no database and no callback**. Every row it touches is reached through a
 * remote proxy — the per-Work claim (`beginSync` / `finishSync` / `recordConflict`) on
 * `AppUpstreamStateService`, the coordinates and counters on
 * `WorkUpstreamStateRepository`, the owner on `WorkRepository`, the App spec on
 * `AppSpecService`, the licence question on `AppLicenseService` — and each proxy call
 * is short. Its `deps.sleep` (§9.2's 3 × 5 s
 * `mergeable` re-reads) is a local function here, so `wait.for` can be passed directly;
 * a runner on the API side would hold one RPC open for the whole run, past the
 * internal client's 45 s request budget. The provider calls go through the worker's own
 * `GitFacadeService` (`TriggerFacadesModule`).
 *
 * ## What this worker context does NOT bind (each a documented degradation)
 *
 * - `ActivityLogService` — the worker has none (`trigger-worker.module.ts:161-163`), so
 *   the run's `app.upstream.*` Activity events are not written from here. The outcome
 *   itself is on the row (`finishSync`) and in this task's result.
 * - `APP_UPSTREAM_PRIVATE_COPY_PORT` (FR-63) — unbound ⇒ a private copy's sync is
 *   `failed/provider_unsupported`; a fork's sync is unaffected.
 *
 * ## Budget — 1 800 s, no retry
 *
 * `plan.md:717` fixes `maxDuration: 1_800`. No retry: the run never throws (every
 * ending is recorded on the row), and the next dispatcher tick is the retry.
 */

/** The task id — the string `TriggerService.dispatchAppUpstreamSync` enqueues under. */
export const APP_UPSTREAM_SYNC_TASK_ID = 'app-upstream-sync' as const;

/** Plan §6.1:656's payload — ids and a trigger only, never a coordinate or a credential. */
export interface AppUpstreamSyncTaskPayload {
    workId: string;
    trigger?: AppUpstreamSyncTrigger;
    providerId?: string;
    credentialVersion?: number;
}

/** What one run reports — the shape every App Works job answers with. */
export interface AppUpstreamSyncTaskResult {
    /** `ran` — the service answered. `skipped` — a gate refused. `failed` — it threw. */
    status: 'ran' | 'skipped' | 'failed';
    jobId: string;
    workId: string | null;
    /** The service's `outcome` (`settled` · `refused`), when it answered. */
    outcome: string | null;
    /** The recorded result (`fast_forwarded`, `pull_request_opened`, …) or a named refusal. */
    reason: string | null;
    error: string | null;
    /** The service's own result, when it ran. */
    result: unknown;
}

const TRIGGERS: readonly AppUpstreamSyncTrigger[] = ['schedule', 'manual', 'divergence', 'merged'];

/**
 * The worker composition: plugins + cache (the git facade's two `@Global()` needs), the
 * worker git facade, the internal RPC channel (the upstream trio + `WorkRepository`), and
 * the two App Works classes the run needs, built over proxies. No database module.
 */
@Module({
    imports: [
        TriggerPluginsModule.forRoot(),
        TriggerRemoteCacheModule.forRoot(),
        TriggerFacadesModule,
        TriggerInternalModule,
    ],
    providers: [
        // The claim, the conflict and the settle — a proxy to the API's state service.
        { provide: AppUpstreamStateService, useExisting: APP_UPSTREAM_STATE_SERVICE },
        // The epic's own row — the binding T26 named and `TriggerInternalModule` proxies.
        { provide: WorkUpstreamStateRepository, useExisting: WORK_UPSTREAM_STATE_REPOSITORY },
        // §6.4 — the App spec's `upstreamSync` block, read fresh every run.
        {
            provide: APP_UPSTREAM_SYNC_SPEC_SOURCE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppSpecService'),
            inject: [TriggerInternalApiClient],
        },
        // §6.3 steps 6 and 8 — FR-37's `previewUpstream` and FR-40's `request`, on the
        // API's `AppLicenseService` (APW-03 T42; a three-read facade in the remoteMap).
        {
            provide: APP_UPSTREAM_LICENSE_SERVICE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AppLicenseService'),
            inject: [TriggerInternalApiClient],
        },
        // The drained-credential gate (EW-742 P3.2), as every per-Work job has it.
        {
            provide: CredentialVersionService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'CredentialVersionService'),
            inject: [TriggerInternalApiClient],
        },
        TenantRuntimeBindingResolverService,
        AppActionsHygieneService,
        AppUpstreamSyncService,
    ],
})
export class AppUpstreamSyncWorkerModule {}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The run's wait: `wait.for` (plan §6.3), whole seconds, at least one. */
export async function upstreamSyncSleep(ms: number): Promise<void> {
    await wait.for({ seconds: Math.max(1, Math.ceil(ms / 1000)) });
}

/**
 * The run body, **exported** so a local worker can drain this exact function and the
 * dev path and the Trigger path cannot drift.
 */
export async function runAppUpstreamSyncTask(
    payload: AppUpstreamSyncTaskPayload,
): Promise<AppUpstreamSyncTaskResult> {
    const workId =
        typeof payload?.workId === 'string' && payload.workId.length > 0 ? payload.workId : null;
    const trigger: AppUpstreamSyncTrigger = TRIGGERS.includes(
        payload?.trigger as AppUpstreamSyncTrigger,
    )
        ? (payload.trigger as AppUpstreamSyncTrigger)
        : 'schedule';

    if (!workId) {
        return {
            status: 'skipped',
            jobId: APP_UPSTREAM_SYNC_TASK_ID,
            workId: null,
            outcome: null,
            reason: 'invalid_payload',
            error: null,
            result: null,
        };
    }

    return withWorkerContext(
        'AppUpstreamSync',
        async (appContext): Promise<AppUpstreamSyncTaskResult> => {
            const binding = getOptionalProvider<TenantRuntimeBindingResolverService>(
                appContext,
                TenantRuntimeBindingResolverService,
            );
            if (binding?.resolveForWork) {
                const resolved = await binding.resolveForWork(payload, workId);
                if (resolved?.status === 'drained') {
                    logger.warn('app-upstream-sync: credentials drained, skipping run', {
                        workId,
                        trigger,
                        providerId: resolved.providerId,
                        credentialVersion: resolved.credentialVersion,
                    });
                    return {
                        status: 'skipped',
                        jobId: APP_UPSTREAM_SYNC_TASK_ID,
                        workId,
                        outcome: null,
                        reason: 'credentials-drained',
                        error: null,
                        result: null,
                    };
                }
            }

            const service = getOptionalProvider<AppUpstreamSyncService>(
                appContext,
                AppUpstreamSyncService,
            );
            if (!service?.run) {
                logger.error(
                    'app-upstream-sync: AppUpstreamSyncService is not available in this worker context — ' +
                        'the Work was not synced.',
                    { workId, trigger },
                );
                return {
                    status: 'skipped',
                    jobId: APP_UPSTREAM_SYNC_TASK_ID,
                    workId,
                    outcome: null,
                    reason: 'serviceUnavailable',
                    error: null,
                    result: null,
                };
            }

            try {
                const result = await service.run(
                    {
                        workId,
                        trigger,
                        ...(payload.providerId ? { providerId: payload.providerId } : {}),
                        ...(typeof payload.credentialVersion === 'number'
                            ? { credentialVersion: payload.credentialVersion }
                            : {}),
                    },
                    { sleep: upstreamSyncSleep },
                );

                logger.info('app-upstream-sync finished', {
                    workId,
                    trigger,
                    outcome: result?.outcome,
                    result: result?.result,
                    reason: result?.reason,
                    providerCalls: result?.providerCalls,
                });
                return {
                    status: 'ran',
                    jobId: APP_UPSTREAM_SYNC_TASK_ID,
                    workId,
                    outcome: typeof result?.outcome === 'string' ? result.outcome : null,
                    reason:
                        typeof result?.reason === 'string'
                            ? result.reason
                            : typeof result?.result === 'string'
                              ? result.result
                              : null,
                    error: null,
                    result,
                };
            } catch (error) {
                // The service never throws by contract; a throw here is a transport or
                // composition fault. Reported, never hidden.
                const failure = errorText(error);
                logger.error(`app-upstream-sync: work ${workId} failed — ${failure}`, {
                    workId,
                    trigger,
                });
                return {
                    status: 'failed',
                    jobId: APP_UPSTREAM_SYNC_TASK_ID,
                    workId,
                    outcome: null,
                    reason: 'syncFailed',
                    error: failure,
                    result: null,
                };
            }
        },
        AppUpstreamSyncWorkerModule,
    );
}

export const appUpstreamSyncTask = task<'app-upstream-sync', AppUpstreamSyncTaskPayload>({
    id: APP_UPSTREAM_SYNC_TASK_ID,
    // §6.3:717 — thirty minutes. No retry: see the file header.
    maxDuration: 1_800,
    run: runAppUpstreamSyncTask,
});
