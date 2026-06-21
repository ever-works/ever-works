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
    type TriggerTenantCredentials
} from '@ever-works/job-runtime-trigger-plugin';
import type {
    TriggerClient,
    TriggerRunHandle,
    TriggerRunRecord,
    TriggerTaskOptions
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
    KbReembedWorkPayload
} from '@ever-works/agent/tasks';
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
    notificationChannelDelivery: 'notification-channel-delivery'
} as const;

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
export function createTenantTriggerClient(
    credentials: TriggerTenantCredentials
): TriggerClient {
    let clientConfig: { accessToken: string; baseURL: string };
    try {
        clientConfig = Object.freeze({
            accessToken: credentials.secretKey,
            baseURL: credentials.apiUrl ?? DEFAULT_TRIGGER_API_URL
        });
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `createTenantTriggerClient: failed to assemble client config for ` +
                `projectRef=${credentials.projectRef}: ${reason}`
        );
    }

    return Object.freeze({
        tasks: {
            async trigger(
                taskId: string,
                payload: unknown,
                options?: TriggerTaskOptions
            ): Promise<TriggerRunHandle> {
                const handle = await tasks.trigger(
                    taskId,
                    payload,
                    options as never,
                    { clientConfig }
                );
                // `tasks.trigger` returns `RunHandle<...>` shaped as
                // `{ id, publicAccessToken, ... }` — structurally a
                // `TriggerRunHandle` per the plugin's types.
                return handle as unknown as TriggerRunHandle;
            }
        },
        runs: {
            async cancel(runId: string): Promise<unknown> {
                return auth.withAuth(clientConfig, () => runs.cancel(runId));
            },
            async retrieve(runId: string): Promise<TriggerRunRecord> {
                const run = await auth.withAuth(clientConfig, () =>
                    runs.retrieve(runId)
                );
                return run as unknown as TriggerRunRecord;
            }
        }
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
 * `concurrencyKey`) is NOT applied here — the plugin's per-tenant view
 * carries the stamp at the binding layer (see
 * `TriggerJobRuntimeProvider.bindToTenant`'s Proxy in
 * `trigger-job-runtime.provider.ts`) and stamping at BOTH layers would
 * double-prefix the tag. This dispatcher map is the structural BYO
 * routing only; stamping stays the binding layer's job.
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
    const softDispatch = async (
        fn: () => Promise<TriggerRunHandle>
    ): Promise<string | null> => {
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
                    tags: ['work-generation', payload.mode, payload.workId]
                })
            );
        },

        async dispatchWorkImport(payload: WorkImportPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.workImport, payload, {
                    tags: ['work-import', payload.sourceType, payload.workId]
                })
            );
        },

        async dispatchTemplateCustomization(
            payload: TemplateCustomizationPayload
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.templateCustomization, payload, {
                    tags: ['template-customization', payload.customizationId]
                })
            );
        },

        async dispatchWebhookDelivery(payload: WebhookDeliveryPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.webhookDelivery, payload, {
                    tags: [
                        'webhook-delivery',
                        `event:${payload.eventName}`,
                        `subscription:${payload.subscriptionId}`
                    ]
                })
            );
        },

        async dispatchKbMirrorDocument(payload: KbMirrorDocumentPayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbMirrorDocument, payload, {
                    tags: [
                        'kb-mirror-document',
                        `op:${payload.operation}`,
                        `work:${payload.workId}`,
                        `doc:${payload.documentId}`
                    ],
                    concurrencyKey: `kb-mirror:${payload.workId}`
                })
            );
        },

        async dispatchKbBackfillSkeleton(
            payload: KbBackfillSkeletonPayload
        ): Promise<string | null> {
            // Fleet-wide — operator bootstrap that may legitimately cross
            // tenant boundaries; on the BYO path the bootstrap STILL runs
            // against the tenant's project (one tenant runs their own
            // ops scripts against their own Trigger.dev project), so the
            // dispatcher carries the same tags/concurrencyKey shape as
            // the singleton.
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbBackfillSkeleton, payload, {
                    tags: [
                        'kb-backfill-skeleton',
                        `count:${payload.workIds?.length ?? 0}`
                    ]
                })
            );
        },

        async dispatchKbEmbedDocument(
            payload: KbEmbedDocumentPayload
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbEmbedDocument, payload, {
                    tags: [
                        'kb-embed-document',
                        `work:${payload.workId}`,
                        `doc:${payload.documentId}`
                    ],
                    concurrencyKey: `kb-embed:${payload.workId}`
                })
            );
        },

        async dispatchKbOrgOverlayFanout(
            payload: KbOrgOverlayFanoutPayload
        ): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbOrgOverlayFanout, payload, {
                    tags: [
                        'kb-org-overlay-fanout',
                        `op:${payload.operation}`,
                        `org:${payload.organizationId}`,
                        `doc:${payload.documentId}`,
                        `targets:${payload.workIds.length}`
                    ],
                    concurrencyKey: `kb-org-overlay:${payload.organizationId}`
                })
            );
        },

        async dispatchKbNormalizeMedia(
            payload: KbNormalizeMediaPayload
        ): Promise<string | null> {
            const taskId =
                payload.mediaKind === 'video'
                    ? TASK_IDS.kbNormalizeVideo
                    : TASK_IDS.kbNormalizeAudio;
            return softDispatch(() =>
                client.tasks.trigger(taskId, payload, {
                    tags: [
                        `kb-normalize-${payload.mediaKind}`,
                        `work:${payload.workId}`,
                        `upload:${payload.uploadId}`
                    ],
                    concurrencyKey: `kb-normalize:${payload.workId}`
                })
            );
        },

        async dispatchKbTranscribe(payload: KbTranscribePayload): Promise<string | null> {
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.kbTranscribe, payload, {
                    tags: [
                        'kb-transcribe',
                        `work:${payload.workId}`,
                        `upload:${payload.uploadId}`
                    ],
                    concurrencyKey: `kb-transcribe:${payload.workId}`
                })
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
                    `to:${payload.newModel}`
                ],
                concurrencyKey: `kb-reembed:${payload.workId}`
            });
            if (!handle?.id) {
                throw new Error(
                    `dispatchKbReembedWork(work=${payload.workId}): SDK returned no run id`
                );
            }
            return handle.id;
        },

        async dispatchNotificationChannelDelivery(
            payload: NotificationChannelDeliveryPayload
        ): Promise<string | null> {
            const delay = payload.deferUntil ? new Date(payload.deferUntil) : undefined;
            return softDispatch(() =>
                client.tasks.trigger(TASK_IDS.notificationChannelDelivery, payload, {
                    tags: [
                        'notification-channel-delivery',
                        `channel:${payload.channelId}`,
                        ...(payload.eventType ? [`event:${payload.eventType}`] : [])
                    ],
                    ...(delay ? { delay } : {})
                } as TriggerTaskOptions)
            );
        }
    };

    return Object.freeze(dispatchers) as JobRuntimeDispatchers;
}
