/**
 * EW-742 P3.2 T22 — default `clientFactory` + `dispatchersFromClient`
 * implementations for the `@ever-works/job-runtime-trigger-plugin` BYO
 * path.
 *
 * The plugin (PR #1548) ships library-only — `bindToTenant` accepts
 * operator-supplied hooks that turn a tenant's credential bag into a
 * per-tenant `@trigger.dev/sdk` client + dispatchers map. This module
 * wires the production-default implementations of those two hooks
 * against the `@trigger.dev/sdk` v4 surface that apps/api already
 * depends on, so the BYO mode works end-to-end without each operator
 * having to wire it themselves.
 *
 * # Why the SDK construction looks the way it does
 *
 * `@trigger.dev/sdk` v4 does not expose a per-instance `Client` class.
 * The `tasks.trigger(...)` / `runs.cancel(...)` / `runs.retrieve(...)`
 * functions are module-level and read the access token + base URL from
 * an internal `apiClientManager` global registered via
 * `configure({ accessToken, baseURL })`. Using `configure` here would
 * cross-tenant pollute (it is a process-global mutation).
 *
 * Two per-call paths are available in v4 that avoid that pollution:
 *
 *   1. `tasks.trigger(id, payload, options, { clientConfig })` —
 *      `trigger_internal` calls `apiClientManager.clientOrThrow(
 *      requestOptions?.clientConfig)`, which constructs a fresh
 *      `ApiClient(baseURL, accessToken, ...)` per call when the
 *      `clientConfig` is supplied. This is race-free under concurrent
 *      multi-tenant dispatch.
 *
 *   2. `withAuth({ accessToken, baseURL }, () => runs.cancel(...))`
 *      — `runs.cancel` / `runs.retrieve` do NOT accept a
 *      `clientConfig` requestOption, so they have to be wrapped in
 *      `auth.withAuth(...)`. `withAuth` uses
 *      `apiClientManager.runWithConfig`, which mutates the global
 *      apiClientManager registration for the duration of the callback
 *      (sync mutate + finally restore). This is correct for sequential
 *      multi-tenant calls but DOES race under concurrent calls from
 *      different tenants. For Ever Works' use the `runs.*` path is
 *      cancel + status polling — both low-volume and not on the hot
 *      enqueue path — so the practical risk is small. A follow-up
 *      could lift the `runs.*` calls onto a per-tenant `ApiClient`
 *      constructed via `@trigger.dev/core`'s `ApiClient` class for
 *      strict race-freedom.
 *
 * # Tenant isolation invariants
 *
 *   - Construction is cheap + offline-safe: no network call happens
 *     in `createTenantTriggerClient(creds)` — the returned object
 *     holds closures over `creds` and only contacts Trigger.dev when
 *     a dispatcher is invoked.
 *   - Idempotency: calling `createTenantTriggerClient(creds)` twice
 *     with the same credentials returns two functionally equivalent
 *     objects (different identities — the plugin's
 *     `TenantCredentialCache` dedups by `(tenantId, credentialVersion)`
 *     so this matters only for the test path).
 *   - The factory throws nothing synchronously beyond what
 *     `@trigger.dev/sdk` itself throws when imported. The plugin's
 *     `safeBuildClient` already catches throws and fails open with a
 *     warn, but the defensive try/catch here surfaces a clearer
 *     error message naming `createTenantTriggerClient` in the chain.
 */

import { auth, runs, tasks } from '@trigger.dev/sdk/v3';
import {
    DEFAULT_TRIGGER_API_URL,
    type TriggerTenantCredentials,
} from '@ever-works/job-runtime-trigger-plugin';
import type {
    TriggerClient,
    TriggerRunHandle,
    TriggerRunRecord,
    TriggerTaskOptions,
} from '@ever-works/job-runtime-trigger-plugin';
import type { JobRuntimeDispatchers } from '@ever-works/plugin';
import type {
    WorkGenerationPayload,
    WorkImportPayload,
    TemplateCustomizationPayload,
    WebhookDeliveryPayload,
    KbMirrorDocumentPayload,
    KbBackfillSkeletonPayload,
    KbEmbedDocumentPayload,
    KbOrgOverlayFanoutPayload,
    KbNormalizeMediaPayload,
    KbTranscribePayload,
    KbReembedWorkPayload,
    MemoryFactEmbedPayload,
    AppDependencyProvisionPayload,
    // APW-03 T13 — the payload of the job APW-02 T28 wires below.
    AppSpecEvaluatePayload,
    AppBuildPreparePayload,
    AppBuildWatchPayload,
    PluginOperationPayload,
} from '@ever-works/agent/tasks';
// C-8 — the App jobs' payloads, TYPE-only: the task modules themselves are the
// worker's graph, which this factory must not pull in (see `TASK_IDS`).
import type {
    AppBlueprintApplyJobPayload,
    AppForkReadinessJobPayload,
    AppUpstreamSyncJobPayload,
} from '@ever-works/agent/app-works';
import type { AppDeployTaskPayload } from '../tasks/trigger/app-deploy.task';
import type { AppClusterOpTaskPayload } from '../tasks/trigger/app-cluster-op.task';
import { config } from '@ever-works/agent/config';
import {
    appBlueprintApplyIdempotencyKey,
    appUpstreamSyncIdempotencyKey,
} from './app-job-idempotency-keys';
// T26 / EW-742 P3 — read inside `dispatchPluginOperation`, never at module
// scope: several specs replace `@ever-works/agent/tasks` with a partial mock
// that does not carry them, and a top-level read would fail the whole file.
import {
    PLUGIN_OPERATION_QUEUE_TTL_SECONDS,
    PLUGIN_OPERATION_TASK_ID,
} from '@ever-works/agent/tasks';
import { pluginOperationRunPayload } from './plugin-operation-run-payload';
import type { NotificationChannelDeliveryPayload } from '@ever-works/agent/facades';

/**
 * Per-tenant task id constants. Kept in sync with the per-task module
 * names under `packages/tasks/src/tasks/trigger/` so the BYO path uses
 * the same task identifiers as the inherit path. A drift here would
 * surface as "task not found" at dispatch time against the tenant's
 * Trigger.dev project — operators bringing their own project must
 * deploy the same task package the platform ships.
 */
const TASK_IDS = {
    workGeneration: 'work-generation',
    workImport: 'work-import',
    templateCustomization: 'template-customization',
    webhookDelivery: 'webhook-delivery',
    kbMirrorDocument: 'kb-mirror-document',
    kbBackfillSkeleton: 'kb-backfill-skeleton',
    kbEmbedDocument: 'kb-embed-document',
    kbOrgOverlayFanout: 'kb-org-overlay-fanout',
    kbNormalizeVideo: 'kb-normalize-video',
    kbNormalizeAudio: 'kb-normalize-audio',
    kbTranscribe: 'kb-transcribe',
    kbReembedWork: 'kb-reembed-work',
    notificationChannelDelivery: 'notification-channel-delivery',
    // AW-07 — must match `MEMORY_FACT_EMBED_JOB_ID` / the task module id.
    memoryFactEmbed: 'memory-fact-embed',
    // APW-07 T17 — must match the `app-dependency-provision` task's own `id`
    // (and the APW-06 `app-cluster-io` queue it declares).
    appDependencyProvision: 'app-dependency-provision',
    // APW-03 T13 — must match the `app-spec-evaluate` task's own `id`. Wired by
    // APW-02 T28 so the same dispatch works for a BYO Trigger.dev tenant.
    appSpecEvaluate: 'app-spec-evaluate',
    // C-8 — the rest of `TriggerService`'s App dispatchers. Each must match its
    // task module's exported `*_TASK_ID` (`app-fork-readiness.task.ts`,
    // `app-build-prepare.task.ts`, …): a BYO tenant's bound view reads its
    // dispatchers from THIS map only, so one missing here answered `undefined`
    // and the App job never left the API for that tenant.
    appForkReadiness: 'app-fork-readiness',
    appBuildPrepare: 'app-build-prepare',
    appBuildWatch: 'app-build-watch',
    appDeploy: 'app-deploy',
    appClusterOp: 'app-cluster-op',
    appUpstreamSync: 'app-upstream-sync',
    appBlueprintApply: 'app-blueprint-apply',
    // `run-plugin-operation` is not listed: its id is the shared
    // `PLUGIN_OPERATION_TASK_ID` constant (the router, the dispatchers and the
    // task registration all import it), read in `dispatchPluginOperation`.
} as const;

/**
 * `APP_CLUSTER_OP_VERIFICATION_MAX_DURATION` (`app-cluster-op.task.ts`): the
 * `verification-deploy` op's 3 600 s budget, set at trigger time. Re-typed for
 * the same reason the ids are.
 */
const APP_CLUSTER_OP_VERIFICATION_MAX_DURATION_SECONDS = 3600;

/**
 * `TriggerService.dispatchAppDeploy` / `dispatchAppClusterOp`'s second refusal,
 * kept for the BYO mirrors: in production, nothing that dials an owner's
 * cluster is enqueued without `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`.
 * Fails CLOSED on a missing accessor, as the singleton does. (The first
 * refusal, "no job runtime", cannot apply: a tenant client exists.)
 */
function appClusterDispatchRefused(): boolean {
    return (
        process.env.NODE_ENV === 'production' &&
        config.everWorks?.apps?.isClusterWorkerIsolated?.() !== true
    );
}

/**
 * Build a `TriggerClient` (the structural `{ tasks, runs }` interface
 * the plugin expects) bound to one tenant's Trigger.dev credentials.
 *
 * The returned object's `tasks.trigger` invocations include
 * `requestOptions.clientConfig` so the SDK constructs a fresh
 * `ApiClient` per call without touching the module-global
 * `apiClientManager` state. `runs.cancel` / `runs.retrieve` route
 * through `auth.withAuth(...)` (the SDK doesn't expose a per-call
 * `clientConfig` for them — see file header for the caveat).
 *
 * Construction is cheap + offline-safe — no network call happens
 * until a dispatcher fires.
 */
export function createTenantTriggerClient(credentials: TriggerTenantCredentials): TriggerClient {
    let clientConfig: { accessToken: string; baseURL: string };
    try {
        clientConfig = Object.freeze({
            accessToken: credentials.secretKey,
            baseURL: credentials.apiUrl ?? DEFAULT_TRIGGER_API_URL,
        });
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `createTenantTriggerClient: failed to assemble client config for ` +
                `projectRef=${credentials.projectRef}: ${reason}`,
        );
    }

    return Object.freeze({
        tasks: {
            async trigger(
                taskId: string,
                payload: unknown,
                options?: TriggerTaskOptions,
            ): Promise<TriggerRunHandle> {
                const handle = await tasks.trigger(taskId, payload, options as never, {
                    clientConfig,
                });
                // `tasks.trigger` returns `RunHandle<...>` shaped as
                // `{ id, publicAccessToken, ... }` — structurally a
                // `TriggerRunHandle` per the plugin's types.
                return handle as unknown as TriggerRunHandle;
            },
        },
        runs: {
            async cancel(runId: string): Promise<unknown> {
                return auth.withAuth(clientConfig, () => runs.cancel(runId));
            },
            async retrieve(runId: string): Promise<TriggerRunRecord> {
                const run = await auth.withAuth(clientConfig, () => runs.retrieve(runId));
                return run as unknown as TriggerRunRecord;
            },
        },
    });
}

/**
 * Build the `JobRuntimeDispatchers` map for a per-tenant
 * `TriggerClient`. Each dispatcher mirrors the corresponding
 * `TriggerService.dispatchXxx` body's `tags` / `concurrencyKey` /
 * `machine` choices so a BYO tenant gets the same Trigger.dev
 * dashboard semantics as an inherit tenant — only the underlying
 * client differs.
 *
 * Tenant stamping (`tenant:<id>` tag, `tenantId`-prefixed
 * `concurrencyKey`) is NOT applied here, and nothing else applies it to
 * a BYO run either. The per-tenant view's Proxy
 * (`TriggerJobRuntimeProvider.bindToTenant` in
 * `trigger-job-runtime.provider.ts`) only puts the stamp on the stack
 * (`triggerTenantStampStorage`); the one reader of that stamp is
 * `TriggerService.stampTenantOptions`, which these dispatchers never
 * call. So a BYO run carries NO `tenant:<id>` tag and no tenant
 * concurrency key — a known gap (wave-2 review, T26). The Proxy adds no
 * options of its own, so closing it here (reading the stamp in these
 * dispatchers) would not double-prefix anything. This dispatcher map
 * is the structural BYO routing only.
 *
 * Catches per-dispatcher SDK errors and returns `null` (matches the
 * `TriggerService` shared-singleton behaviour — callers fall through
 * to the in-process fallback for the soft-error paths, or surface the
 * `null` to the workbench for the loud-error paths).
 */
export function dispatchersFromTenantClient(client: TriggerClient): JobRuntimeDispatchers {
    /**
     * Tiny adapter that runs a per-dispatcher closure and converts a
     * Trigger.dev SDK throw into a soft `null` return (mirrors
     * `TriggerService.dispatchXxx` shape). The `kb-reembed-work`
     * dispatcher overrides this with a `propagate` shape because its
     * contract forbids silent drops.
     */
    const softDispatch = async (fn: () => Promise<TriggerRunHandle>): Promise<string | null> => {
        try {
            const handle = await fn();
            return handle?.id ?? null;
        } catch {
            return null;
        }
    };

    const dispatchers: JobRuntimeDispatchers & Record<string, unknown> = {
        async dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.workGeneration, payload, {
                    tags: ['work-generation', payload.mode, payload.workId],
                }),
            );
        },

        async dispatchWorkImport(payload: WorkImportPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.workImport, payload, {
                    tags: ['work-import', payload.sourceType, payload.workId],
                }),
            );
        },

        async dispatchTemplateCustomization(
            payload: TemplateCustomizationPayload,
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.templateCustomization, payload, {
                    tags: ['template-customization', payload.customizationId],
                }),
            );
        },

        async dispatchWebhookDelivery(payload: WebhookDeliveryPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.webhookDelivery, payload, {
                    tags: [
                        'webhook-delivery',
                        `event:${payload.eventName}`,
                        `subscription:${payload.subscriptionId}`,
                    ],
                }),
            );
        },

        async dispatchKbMirrorDocument(payload: KbMirrorDocumentPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbMirrorDocument, payload, {
                    tags: [
                        'kb-mirror-document',
                        `op:${payload.operation}`,
                        `work:${payload.workId}`,
                        `doc:${payload.documentId}`,
                    ],
                    concurrencyKey: `kb-mirror:${payload.workId}`,
                }),
            );
        },

        async dispatchKbBackfillSkeleton(
            payload: KbBackfillSkeletonPayload,
        ): Promise<string | null> {
            // Fleet-wide — operator bootstrap that may legitimately cross
            // tenant boundaries; on the BYO path the bootstrap STILL runs
            // against the tenant's project (one tenant runs their own
            // ops scripts against their own Trigger.dev project), so the
            // dispatcher carries the same tags/concurrencyKey shape as
            // the singleton.
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbBackfillSkeleton, payload, {
                    tags: ['kb-backfill-skeleton', `count:${payload.workIds?.length ?? 0}`],
                }),
            );
        },

        async dispatchKbEmbedDocument(payload: KbEmbedDocumentPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbEmbedDocument, payload, {
                    tags: [
                        'kb-embed-document',
                        `work:${payload.workId}`,
                        `doc:${payload.documentId}`,
                    ],
                    concurrencyKey: `kb-embed:${payload.workId}`,
                }),
            );
        },

        async dispatchKbOrgOverlayFanout(
            payload: KbOrgOverlayFanoutPayload,
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbOrgOverlayFanout, payload, {
                    tags: [
                        'kb-org-overlay-fanout',
                        `op:${payload.operation}`,
                        `org:${payload.organizationId}`,
                        `doc:${payload.documentId}`,
                        `targets:${payload.workIds.length}`,
                    ],
                    concurrencyKey: `kb-org-overlay:${payload.organizationId}`,
                }),
            );
        },

        async dispatchKbNormalizeMedia(payload: KbNormalizeMediaPayload): Promise<string | null> {
            const taskId =
                payload.mediaKind === 'video'
                    ? TASK_IDS.kbNormalizeVideo
                    : TASK_IDS.kbNormalizeAudio;
            return softDispatch(() =>
                client.tasks.trigger(taskId, payload, {
                    tags: [
                        `kb-normalize-${payload.mediaKind}`,
                        `work:${payload.workId}`,
                        `upload:${payload.uploadId}`,
                    ],
                    concurrencyKey: `kb-normalize:${payload.workId}`,
                }),
            );
        },

        async dispatchKbTranscribe(payload: KbTranscribePayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbTranscribe, payload, {
                    tags: ['kb-transcribe', `work:${payload.workId}`, `upload:${payload.uploadId}`],
                    concurrencyKey: `kb-transcribe:${payload.workId}`,
                }),
            );
        },

        /**
         * EW-642 D7 contract — kb-reembed-work PROPAGATES errors
         * (silent drop would leave Work pinned to stale embedding
         * model). Bypasses `softDispatch` so the SDK throw escapes
         * the dispatcher.
         */
        async dispatchKbReembedWork(payload: KbReembedWorkPayload): Promise<string> {
            const handle = await client.tasks.trigger(TASK_IDS.kbReembedWork, payload, {
                tags: [
                    'kb-reembed-work',
                    `work:${payload.workId}`,
                    `from:${payload.previousModel}`,
                    `to:${payload.newModel}`,
                ],
                concurrencyKey: `kb-reembed:${payload.workId}`,
            });
            if (!handle?.id) {
                throw new Error(
                    `dispatchKbReembedWork(work=${payload.workId}): SDK returned no run id`,
                );
            }
            return handle.id;
        },

        /**
         * AW-07 — soft dispatch like the other enqueue paths: a failed
         * memory-fact embed is deferred work (the nightly sweep embeds the
         * fact), never a failed save.
         */
        async dispatchMemoryFactEmbed(payload: MemoryFactEmbedPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(
                    TASK_IDS.memoryFactEmbed,
                    { factId: payload.factId, userId: payload.userId },
                    { tags: ['memory-fact-embed', `fact:${payload.factId}`] },
                ),
            );
        },

        async dispatchNotificationChannelDelivery(
            payload: NotificationChannelDeliveryPayload,
        ): Promise<string | null> {
            const delay = payload.deferUntil ? new Date(payload.deferUntil) : undefined;
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.notificationChannelDelivery, payload, {
                    tags: [
                        'notification-channel-delivery',
                        `channel:${payload.channelId}`,
                        ...(payload.eventType ? [`event:${payload.eventType}`] : []),
                    ],
                    ...(delay ? { delay } : {}),
                } as TriggerTaskOptions),
            );
        },

        /**
         * APW-07 T17 — app dependencies PROPAGATE errors (APW07-G24), so this
         * uses the same `propagate` shape as `dispatchKbReembedWork` and does
         * NOT go through `softDispatch`: a silently dropped provisioning
         * dispatch leaves a dependency row `pending` with nothing scheduled
         * behind it, and `AppDependenciesService` has no reconciliation pass to
         * catch that — it records `dispatchUnavailable` and the card tells the
         * owner, which only works if the throw escapes.
         *
         * The delayed re-dispatch rides the payload (`deferUntil` ISO-8601, or
         * `notBefore` epoch ms — the same `delay` mapping the singleton uses),
         * so a BYO tenant gets identical re-dispatch behaviour and the job never
         * sleeps.
         */
        async dispatchAppDependencyProvision(
            payload: AppDependencyProvisionPayload,
        ): Promise<string> {
            const deferUntil =
                payload.deferUntil ??
                (payload.notBefore ? new Date(payload.notBefore).toISOString() : undefined);
            const delay = deferUntil ? new Date(deferUntil) : undefined;

            const handle = await client.tasks.trigger(TASK_IDS.appDependencyProvision, payload, {
                tags: [
                    'app-dependency-provision',
                    `work:${payload.workId}`,
                    ...(payload.kind ? [`kind:${payload.kind}`] : []),
                    `mode:${payload.mode}`,
                ],
                concurrencyKey: `app-dependency:${payload.workId}:${payload.kind ?? 'all'}`,
                ...(delay ? { delay } : {}),
            } as TriggerTaskOptions);

            if (!handle?.id) {
                throw new Error(
                    `dispatchAppDependencyProvision(work=${payload.workId}): SDK returned no run id`,
                );
            }
            return handle.id;
        },

        /**
         * APW-03 T13's `app-spec-evaluate`, for a BYO Trigger.dev tenant — the
         * mirror of the singleton `TriggerService.dispatchAppSpecEvaluate`
         * (APW-02 T28 wired both). Same propagate shape as
         * `dispatchAppDependencyProvision` above: a swallowed error here would
         * report an evaluation as queued with nothing behind it, which is the
         * silent no-op the shape exists to prevent.
         */
        async dispatchAppSpecEvaluate(payload: AppSpecEvaluatePayload): Promise<string> {
            const handle = await client.tasks.trigger(TASK_IDS.appSpecEvaluate, payload, {
                tags: ['app-spec-evaluate', `work:${payload.workId}`, `trigger:${payload.trigger}`],
                concurrencyKey: `app-spec-evaluate:${payload.workId}`,
            } as TriggerTaskOptions);

            if (!handle?.id) {
                throw new Error(
                    `dispatchAppSpecEvaluate(work=${payload.workId}): SDK returned no run id`,
                );
            }
            return handle.id;
        },

        /*
         * C-8 — the remaining App dispatchers, for a BYO Trigger.dev tenant:
         * mirrors of the singleton `TriggerService.dispatchAppXxx` (same task
         * ids, tags, `concurrencyKey`s, `idempotencyKey`s and delays; no
         * `machine`, like the other BYO dispatchers). All are SOFT, as the
         * singleton's are: `null` is each caller's documented deferral (the
         * readiness sweeper, the in-process Build runners, Deploy's
         * `dispatched: false`, the in-process Blueprint apply), never a throw.
         */

        async dispatchAppForkReadiness(
            payload: AppForkReadinessJobPayload,
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appForkReadiness, payload, {
                    tags: [
                        'app-fork-readiness',
                        `work:${payload.workId}`,
                        `trigger:${payload.reason ?? 'initial'}`,
                    ],
                    concurrencyKey: `app-fork-readiness:${payload.workId}`,
                }),
            );
        },

        async dispatchAppBuildPrepare(payload: AppBuildPreparePayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appBuildPrepare, payload, {
                    tags: [
                        'app-build-prepare',
                        `work:${payload.workId}`,
                        // Absent on the coalesced dispatch, which carries no Build.
                        ...(payload.buildId ? [`build:${payload.buildId}`] : []),
                    ],
                    concurrencyKey: `app-build-prepare:${payload.workId}`,
                }),
            );
        },

        async dispatchAppBuildWatch(payload: AppBuildWatchPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appBuildWatch, payload, {
                    tags: ['app-build-watch', `build:${payload.buildId}`],
                    concurrencyKey: `app-build-watch:${payload.buildId}`,
                }),
            );
        },

        /** Per-WORK `concurrencyKey`, as the singleton's: two Deployments of one App Work never roll out at once. */
        async dispatchAppDeploy(
            payload: AppDeployTaskPayload,
            opts: { delayMs?: number } = {},
        ): Promise<string | null> {
            if (appClusterDispatchRefused()) {
                return null;
            }
            const delayMs = typeof opts.delayMs === 'number' && opts.delayMs > 0 ? opts.delayMs : 0;
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appDeploy, payload, {
                    tags: [
                        'app-deploy',
                        `work:${payload.workId}`,
                        `deployment:${payload.deploymentId}`,
                        ...(payload.trigger ? [`trigger:${payload.trigger}`] : []),
                    ],
                    concurrencyKey: `app-deploy:${payload.workId}`,
                    ...(delayMs > 0 ? { delay: new Date(Date.now() + delayMs) } : {}),
                } as TriggerTaskOptions),
            );
        },

        async dispatchAppClusterOp(
            payload: AppClusterOpTaskPayload,
            opts: { delayMs?: number } = {},
        ): Promise<string | null> {
            if (appClusterDispatchRefused()) {
                return null;
            }
            const delayMs = typeof opts.delayMs === 'number' && opts.delayMs > 0 ? opts.delayMs : 0;
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appClusterOp, payload, {
                    tags: ['app-cluster-op', `work:${payload.workId}`, `op:${payload.op}`],
                    ...(payload.op === 'verification-deploy'
                        ? { maxDuration: APP_CLUSTER_OP_VERIFICATION_MAX_DURATION_SECONDS }
                        : {}),
                    ...(delayMs > 0 ? { delay: new Date(Date.now() + delayMs) } : {}),
                } as TriggerTaskOptions),
            );
        },

        async dispatchAppUpstreamSync(payload: AppUpstreamSyncJobPayload): Promise<string | null> {
            const trigger = payload.trigger ?? 'schedule';
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appUpstreamSync, payload, {
                    tags: ['app-upstream-sync', `work:${payload.workId}`, `trigger:${trigger}`],
                    idempotencyKey: appUpstreamSyncIdempotencyKey(payload.workId, trigger),
                    concurrencyKey: `app-upstream-sync:${payload.workId}`,
                } as TriggerTaskOptions),
            );
        },

        async dispatchAppBlueprintApply(
            payload: AppBlueprintApplyJobPayload,
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.appBlueprintApply, payload, {
                    tags: ['app-blueprint-apply', `work:${payload.workId}`, `mode:${payload.mode}`],
                    idempotencyKey: appBlueprintApplyIdempotencyKey(payload),
                    concurrencyKey: `app-blueprint-apply:${payload.workId}`,
                } as TriggerTaskOptions),
            );
        },

        /**
         * T26 / EW-742 P3 — the long-running plugin operation, for a BYO
         * Trigger.dev tenant: the mirror of the singleton
         * `TriggerService.dispatchPluginOperation`, which the plugin execution
         * router looks up by name on the tenant's bound view. Same payload,
         * tags and queue `ttl`; no `machine` (like the other BYO dispatchers).
         * Soft like the singleton: `null` when the SDK throws or answers no run
         * id, which the router reports as JOB_RUNTIME_DISPATCH_FAILED. The
         * tenant's project must have the `run-plugin-operation` task deployed,
         * like every other BYO task.
         */
        async dispatchPluginOperation(payload: PluginOperationPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(PLUGIN_OPERATION_TASK_ID, pluginOperationRunPayload(payload), {
                    tags: ['plugin-operation', `plugin:${payload.pluginId}`],
                    ttl: `${PLUGIN_OPERATION_QUEUE_TTL_SECONDS / 60}m`,
                }),
            );
        },
    };

    return Object.freeze(dispatchers) as JobRuntimeDispatchers;
}
