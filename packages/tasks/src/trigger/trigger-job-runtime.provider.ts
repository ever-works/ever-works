import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IJobRuntimeProvider,
    JobRunStatus,
    JobRuntimeDispatchers,
    JobRuntimeId,
    PluginCategory,
    PluginContext,
    ScheduleSpec,
    TenantCredentialSnapshot,
    WorkerHostHandle,
    WorkerHostOptions,
} from '@ever-works/plugin';
import {
    mapTriggerStatus as mapTriggerStatusLocal,
    type TriggerClient,
    type TriggerTenantCredentials,
} from '@ever-works/job-runtime-trigger-plugin';
import { TriggerService, triggerTenantStampStorage } from './trigger.service';
import {
    createTenantTriggerClient,
    dispatchersFromTenantClient,
} from './trigger-tenant-client.factory';

/**
 * EW-742 P3.2 T22 (stamping) — the subset of dispatcher method names on
 * {@link TriggerService} that intentionally RUN OUTSIDE a tenant stamp,
 * even when reached through a per-tenant bound view. Operator-bootstrap
 * dispatchers (KB skeleton backfill) sweep work that may legitimately
 * cross tenant boundaries — pinning them to one tenant would mis-bucket
 * the queue and corrupt the concurrency partition for the rest of the
 * fleet.
 *
 * Kept as a small explicit `Set` rather than a method-property naming
 * convention (e.g. `dispatchFleet*`) so the carve-out is documented in
 * one obvious place; the corresponding `dispatchKbBackfillSkeleton`
 * JSDoc on `TriggerService` cross-references this list.
 */
const FLEET_WIDE_DISPATCH_METHODS: ReadonlySet<string> = new Set(['dispatchKbBackfillSkeleton']);

/**
 * EW-686 P1 — adapter that exposes the existing {@link TriggerService}
 * through the full {@link IJobRuntimeProvider} contract (EW-685 P0,
 * shipped in `packages/plugin/src/contracts/capabilities/
 * job-runtime.interface.ts`).
 *
 * No behaviour change at runtime: every IJobRuntimeProvider method
 * delegates straight back into the `TriggerService` instance, which
 * already implements the IJobRuntimeProvider *method* surface
 * (`runtimeId`, `dispatchers`, `isEnabled`, `cancel`, `getRunStatus`,
 * `registerSchedules`, `startWorkerHost`) but deliberately does NOT
 * `implements IJobRuntimeProvider` — because `IJobRuntimeProvider`
 * extends `IPlugin` and `TriggerService` is a plain NestJS service that
 * has no need for the full plugin-manifest surface (id, name, version,
 * category, capabilities, settingsSchema, onLoad, onUnload).
 *
 * This adapter is what closes the gap: it satisfies `IJobRuntimeProvider`
 * (and therefore `IPlugin`) by adding the synthetic plugin metadata, while
 * delegating every dispatch/schedule/cancel/status call straight to
 * `TriggerService`. The EW-685 T4 binding factory (lands in a follow-up
 * PR at `packages/agent/src/tasks/job-runtime.providers.ts`) injects this
 * adapter by class and reads `.dispatchers` to wire the `*_DISPATCHER`
 * symbols — the existing direct `useExisting: TriggerService` bindings
 * stay untouched until the factory replaces them.
 *
 * **Synthetic plugin — NOT registry-discoverable.** The IPlugin metadata
 * below is stubbed, not loaded from a `package.json` manifest. This class
 * does NOT participate in `PluginRegistryService` hot-load / discovery;
 * it's wired into NestJS DI directly by `TriggerModule`. A proper plugin-
 * manifest extraction (turning the trigger runtime into a sibling of
 * `packages/plugins/openai` etc.) is tracked under EW-689 — this adapter
 * is the smallest type-conforming shim that unblocks the EW-685 T4
 * wiring without pulling the full `@ever-works/plugin` manifest pipeline
 * into the `@ever-works/trigger-tasks` package.
 *
 * Drift note — the EW-683 architecture spec §3 and the IJobRuntimeProvider
 * contract JSDoc both say a job-runtime plugin declares
 * `category: 'job-runtime'`, but `PLUGIN_CATEGORIES` in
 * `packages/plugin/src/contracts/plugin-manifest.types.ts` does NOT yet
 * list `'job-runtime'` (it's tracked as a follow-up additive change so
 * existing manifest validators keep passing untouched). The
 * `as PluginCategory` cast below is deliberate and removes itself
 * automatically the day `'job-runtime'` is added to the categories tuple.
 */
@Injectable()
export class TriggerJobRuntimeProvider implements IJobRuntimeProvider {
    // -- IPlugin synthetic metadata ----------------------------------------
    readonly id = 'trigger';
    readonly name = 'Trigger.dev';
    readonly version = '1.0.0';
    // EW-742 P3.2 follow-up — `'job-runtime'` is now part of
    // `PLUGIN_CATEGORIES` (alongside `'secret-store-resolver'`). The
    // earlier `as PluginCategory` cast is no longer needed.
    readonly category: PluginCategory = 'job-runtime';
    readonly capabilities: readonly string[] = [
        'job-runtime-enqueue',
        'job-runtime-cancel',
        'job-runtime-status',
        'job-runtime-schedule',
        // EW-742 P3.2 T21.1 — the adapter implements bindToTenant
        // (memoised view that swaps Trigger.dev project credentials
        // per tenant). The capability flag was missing from the
        // initial EW-686 P1 list; the shared P6 conformance suite
        // caught it.
        'job-runtime-bind-tenant',
    ];
    // Synthetic plugin — no operator-tunable settings (Trigger.dev creds
    // are read from `config.trigger.*` env vars, not from the plugin
    // settings system). Empty object schema = "accepts no settings".
    readonly settingsSchema = { type: 'object', properties: {} } as const;

    // -- IJobRuntimeProvider ----------------------------------------------
    readonly runtimeId: JobRuntimeId = 'trigger';

    private readonly logger = new Logger(TriggerJobRuntimeProvider.name);

    /**
     * EW-742 P3.2 T22 — operator-supplied per-tenant `TriggerClient`
     * factory. Defaults to the `@trigger.dev/sdk`-v4-backed
     * {@link createTenantTriggerClient} which uses
     * `tasks.trigger(..., { clientConfig })` + `auth.withAuth(...)` so
     * concurrent multi-tenant calls don't cross-pollute. Overridable
     * for tests + alternate operator wiring (e.g. self-hosted
     * Trigger.dev with a custom client class).
     */
    private readonly clientFactory: (credentials: TriggerTenantCredentials) => TriggerClient;

    /**
     * Builds the per-tenant dispatchers map from a per-tenant
     * `TriggerClient`. Defaults to {@link dispatchersFromTenantClient}
     * (mirrors {@link TriggerService}'s dispatchers via the BYO
     * client). Overridable per the same reasoning as
     * {@link clientFactory}.
     */
    private readonly dispatchersFromClient: (client: TriggerClient) => JobRuntimeDispatchers;

    constructor(
        private readonly triggerService: TriggerService,
        // NestJS DI is metadata-driven: `opts` is typed as an inline
        // object literal, which SWC emits as `Object` in the design
        // paramtypes. Without `@Optional()` the container tries (and
        // fails) to resolve a provider for `Object` at API boot, even
        // though the default value `= {}` makes the param logically
        // optional. `@Optional()` tells the injector to pass `undefined`
        // when no provider matches — the runtime then falls back to the
        // default in the same way the unit tests (which pass nothing)
        // already exercise.
        @Optional()
        opts?: {
            clientFactory?: (credentials: TriggerTenantCredentials) => TriggerClient;
            dispatchersFromClient?: (client: TriggerClient) => JobRuntimeDispatchers;
        },
    ) {
        this.clientFactory = opts?.clientFactory ?? createTenantTriggerClient;
        this.dispatchersFromClient = opts?.dispatchersFromClient ?? dispatchersFromTenantClient;
    }

    /**
     * The dispatchers surface IS the underlying {@link TriggerService}
     * instance — it already implements every `*Dispatcher` interface
     * verbatim (`WorkGenerationDispatcher`, `WorkImportDispatcher`,
     * `TemplateCustomizationDispatcher`, `WebhookDeliveryDispatcher`,
     * `KbMirrorDocumentDispatcher`, `KbBackfillSkeletonDispatcher`,
     * `KbEmbedDocumentDispatcher`, `KbOrgOverlayFanoutDispatcher`,
     * `KbNormalizeMediaDispatcher`, `KbTranscribeDispatcher`).
     *
     * Delegates to `triggerService.dispatchers` which itself is the
     * same `this`-cast `Readonly<Record<string, unknown>>` view of
     * `TriggerService`. The double-hop (this getter → service getter)
     * is intentional: it keeps the binding factory's contract simple
     * (`provider.dispatchers`) without forcing the factory to know
     * about the underlying service.
     */
    get dispatchers(): JobRuntimeDispatchers {
        return this.triggerService.dispatchers;
    }

    /**
     * Delegates to {@link TriggerService.registerSchedules} — Trigger.dev
     * tasks self-register their schedules at deploy time via
     * `schedules.task()` SDK calls, so the platform-level ScheduleSpec
     * list is a no-op for this provider (logged at debug so operators
     * see the no-op was intentional). See the JSDoc on
     * `TriggerService.registerSchedules` for the full rationale.
     */
    async registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
        await this.triggerService.registerSchedules(schedules);
    }

    /**
     * Delegates to {@link TriggerService.cancel} — single
     * `runs.cancel(runId)` SDK call, errors swallowed and logged,
     * `false` when the runtime is disabled OR the SDK call throws.
     */
    async cancel(runId: string): Promise<boolean> {
        return this.triggerService.cancel(runId);
    }

    /**
     * Delegates to {@link TriggerService.getRunStatus} — translates
     * the Trigger.dev SDK v4 status enum onto the contract's 6-value
     * {@link JobRunStatus} union, with `'unknown'` as the fallback for
     * disabled-runtime / SDK-error / future-status-widening cases.
     */
    async getRunStatus(runId: string): Promise<JobRunStatus> {
        return this.triggerService.getRunStatus(runId);
    }

    /**
     * Delegates to {@link TriggerService.isEnabled} — true when
     * Trigger.dev is configured and reachable (`shouldUseTrigger()`
     * AND `TRIGGER_SECRET_KEY` present).
     */
    isEnabled(): boolean {
        return this.triggerService.isEnabled();
    }

    /**
     * Delegates to {@link TriggerService.startWorkerHost} — Trigger.dev
     * is a push-model runtime (Trigger.dev's cloud invokes our tasks),
     * so this is a no-op returning a no-op handle. Provided so a
     * generic "start worker host if the provider supports it" caller
     * Just Works without per-provider branching; pull-model providers
     * (Temporal, BullMQ, pg-boss) will implement it for real.
     */
    async startWorkerHost(opts: WorkerHostOptions): Promise<WorkerHostHandle> {
        return this.triggerService.startWorkerHost(opts);
    }

    /**
     * Lifecycle no-op — synthetic plugin, no resources to acquire.
     * Real plugins use `onLoad` to capture the `PluginContext` and
     * stand up SDKs; this adapter already received its `TriggerService`
     * dependency through NestJS DI in the constructor.
     */
    async onLoad(_context: PluginContext): Promise<void> {
        // Intentional no-op — see class JSDoc on synthetic plugin status.
    }

    /**
     * Lifecycle no-op — synthetic plugin, no resources to release.
     */
    async onUnload(): Promise<void> {
        // Intentional no-op — see class JSDoc on synthetic plugin status.
    }

    /**
     * Memoisation cache for `bindToTenant` — keyed by
     * `${tenantId}:${credentialVersion}`. Holds the last frozen tenant
     * view per tenant so the same snapshot returns the same instance
     * (per the {@link IJobRuntimeProvider.bindToTenant} idempotency
     * contract). A new `credentialVersion` evicts and replaces the
     * previous entry — the cache size is bounded by tenant count.
     */
    private readonly tenantViews = new Map<string, IJobRuntimeProvider>();

    /**
     * EW-742 P3.2 T21.1 — minimal `bindToTenant` impl.
     *
     * Returns a per-tenant frozen view of THIS provider with the
     * snapshot captured. Trigger.dev's underlying SDK client is a
     * push-model singleton (their cloud invokes our tasks), so no
     * runtime per-tenant rebinding of the actual Trigger.dev access
     * token happens in this PR — the view's dispatchers still
     * delegate to the singleton `TriggerService`.
     *
     * What this PR DOES wire up:
     *   - Returns a fresh wrapper per `credentialVersion` so callers
     *     get a stable instance identity to memoise on.
     *   - Exposes the snapshot via `(view as any).tenantSnapshot` so
     *     T22 per-dispatcher wiring can stamp `(providerId,
     *     credentialVersion)` onto run records without needing a
     *     separate stamper service.
     *
     * What this PR DOES NOT do (TODO for the next PR):
     *   - Per-tenant Trigger.dev project switching. Today every
     *     tenant ships through the same Trigger.dev project the API
     *     boots against; the platform overlay is "BYO with inherit"
     *     and the inherit path is the only one wired. BYO Trigger.dev
     *     project per tenant requires the dispatcher layer to swap
     *     the underlying `TriggerService` SDK client per call — that's
     *     the T22 PR.
     *   - Dispatcher stamping. That's the T22 per-dispatcher PoC
     *     (KB-embed first).
     */
    bindToTenant(snapshot: TenantCredentialSnapshot): IJobRuntimeProvider {
        const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
        const cached = this.tenantViews.get(cacheKey);
        if (cached) {
            return cached;
        }

        const base = this;

        // EW-742 P3.2 T22 — BYO / override credential extraction.
        //
        // Snapshots that carry the full
        // {@link TriggerTenantCredentials} bag (accessToken + secretKey
        // + projectRef) route through a per-tenant Trigger.dev client
        // built by {@link clientFactory}. The view's `dispatchers` then
        // come from {@link dispatchersFromClient} so every
        // `dispatchXxx` call hits the tenant's project, not the
        // platform default. Inherit snapshots (empty bag, or only the
        // legacy `projectAccessToken` key) skip this branch entirely
        // and fall through to the singleton-Proxy stamping path —
        // byte-identical to the pre-T22 wiring.
        const tenantCredentials = this.extractTenantCredentials(snapshot);
        const tenantClient: TriggerClient | null = tenantCredentials
            ? this.safeBuildTenantClient(snapshot, tenantCredentials)
            : null;

        // EW-742 P3.2 T22 (stamping) — per-tenant dispatcher Proxy.
        //
        // The bound view's `dispatchers` is a Proxy around the singleton
        // TriggerService that wraps every `dispatchXxx` method in
        // `triggerTenantStampStorage.run({ tenantId }, () => method.apply(...))`.
        // Each `dispatchXxx` in TriggerService reads the stamp inside its
        // `tasks.trigger(...)` call via `stampTenantOptions(...)`, which
        // injects `concurrencyKey` + `tenant:<id>` tag into the SDK
        // options. Fleet-wide dispatchers (FLEET_WIDE_DISPATCH_METHODS)
        // bypass the wrapping and run with NO stamp on the stack — they
        // behave identically to the pre-T22 path.
        //
        // Non-dispatch property reads (e.g. `dispatchers.machine`, or the
        // future addition of a non-`dispatch*` member to the dispatcher
        // bag) pass through unchanged so the view stays a structural
        // superset of the underlying dispatchers map.
        //
        // The Proxy is constructed once per tenant view and memoised on
        // the view itself; calling `boundView.dispatchers` twice returns
        // the same Proxy instance (identity-equality matters for the
        // EW-685 binding factory + the NestJS DI graph).
        const stamp = { tenantId: snapshot.tenantId };
        let stampedDispatchersCache: JobRuntimeDispatchers | undefined;
        const buildStampedDispatchers = (): JobRuntimeDispatchers => {
            if (stampedDispatchersCache) {
                return stampedDispatchersCache;
            }
            // BYO branch — wrap the BYO dispatchers in the SAME stamp
            // Proxy so tenant tags / concurrencyKey still get prefixed
            // at the binding layer (the BYO dispatchers themselves
            // intentionally don't stamp — stamping at both layers
            // would double-prefix).
            const dispatchersSource: Record<string, unknown> = tenantClient
                ? (base.dispatchersFromClient(tenantClient) as Record<string, unknown>)
                : (base.dispatchers as Record<string, unknown>);
            stampedDispatchersCache = new Proxy(dispatchersSource, {
                get(t, prop, receiver) {
                    const value = Reflect.get(t, prop, receiver);
                    if (typeof value !== 'function') {
                        return value;
                    }
                    if (typeof prop !== 'string' || !prop.startsWith('dispatch')) {
                        // Non-dispatcher methods (cancelWorkGeneration,
                        // mapTriggerStatus, …) MUST NOT be wrapped — they
                        // don't reach `stampTenantOptions` and the stamp
                        // would be a dead store.
                        return value.bind(t);
                    }
                    if (FLEET_WIDE_DISPATCH_METHODS.has(prop)) {
                        // Operator bootstrap — no stamp on the stack.
                        return value.bind(t);
                    }
                    return (...args: unknown[]) =>
                        triggerTenantStampStorage.run(stamp, () =>
                            (value as (...a: unknown[]) => unknown).apply(t, args),
                        );
                },
            }) as unknown as JobRuntimeDispatchers;
            return stampedDispatchersCache;
        };
        // Build a frozen tenant view. Every method delegates back to
        // the singleton `TriggerService` (via `base`), but the view
        // carries the snapshot for downstream stamping.
        const view: IJobRuntimeProvider & {
            readonly tenantSnapshot: TenantCredentialSnapshot;
            readonly tenantClient: TriggerClient | null;
        } = Object.freeze({
            // -- IPlugin metadata, copied verbatim ---------------------
            id: base.id,
            name: base.name,
            version: base.version,
            category: base.category,
            capabilities: base.capabilities,
            settingsSchema: base.settingsSchema,
            // -- IJobRuntimeProvider, delegating ----------------------
            runtimeId: base.runtimeId,
            get dispatchers(): JobRuntimeDispatchers {
                return buildStampedDispatchers();
            },
            registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
                return base.registerSchedules(schedules);
            },
            cancel: tenantClient
                ? async (runId: string): Promise<boolean> => {
                      // BYO — cancel against the tenant's Trigger.dev
                      // project; a singleton cancel would either no-op
                      // (run id not in the platform project) or, worse,
                      // hit the wrong project.
                      try {
                          await tenantClient.runs.cancel(runId);
                          return true;
                      } catch {
                          return false;
                      }
                  }
                : (runId: string) => base.cancel(runId),
            getRunStatus: tenantClient
                ? async (runId: string): Promise<JobRunStatus> => {
                      try {
                          const run = await tenantClient.runs.retrieve(runId);
                          return mapTriggerStatusLocal(run.status);
                      } catch {
                          return 'unknown';
                      }
                  }
                : (runId: string) => base.getRunStatus(runId),
            isEnabled(): boolean {
                return base.isEnabled();
            },
            startWorkerHost(opts: WorkerHostOptions): Promise<WorkerHostHandle> {
                return base.startWorkerHost(opts);
            },
            onLoad(context: PluginContext): Promise<void> {
                return base.onLoad(context);
            },
            onUnload(): Promise<void> {
                return base.onUnload();
            },
            // The tenant view does NOT re-bind further — calling
            // `bindToTenant` on a tenant view returns itself for
            // matching snapshots; mismatched snapshots return the
            // root provider's bind result (cache-replace semantics).
            bindToTenant(other: TenantCredentialSnapshot): IJobRuntimeProvider {
                if (
                    other.tenantId === snapshot.tenantId &&
                    other.credentialVersion === snapshot.credentialVersion
                ) {
                    return view;
                }
                return base.bindToTenant(other);
            },
            // -- snapshot exposed for downstream stampers --------------
            tenantSnapshot: snapshot,
            // -- BYO surface: exposed so callers / tests / introspection
            //    can verify the BYO branch wired through. `null` for
            //    inherit snapshots (or BYO snapshots where the factory
            //    threw and we fell open to the singleton).
            tenantClient,
        });

        // Cache-replace: evict any older version for this tenant so
        // the cache stays bounded.
        for (const key of this.tenantViews.keys()) {
            if (key.startsWith(`${snapshot.tenantId}:`)) {
                this.tenantViews.delete(key);
            }
        }
        this.tenantViews.set(cacheKey, view);
        return view;
    }

    /**
     * EW-742 P3.2 T22 — validate the snapshot's `credentials` bag
     * against the {@link TriggerTenantCredentials} shape (mirrors the
     * `extractTenantCredentials` helper on
     * `@ever-works/job-runtime-trigger-plugin`'s
     * {@link TriggerJobRuntimePlugin}). Returns the typed bundle on
     * success; `null` (with a fail-open warn) when ANY required field
     * is missing or non-string.
     *
     * Inherit-shaped snapshots (empty `credentials`, or only the
     * legacy `projectAccessToken` key from earlier T21 wiring)
     * intentionally return `null` WITHOUT a warn — they're the
     * dominant path and noise here would drown actually-actionable
     * BYO misconfigurations. The warn fires only when there's at
     * least one Trigger.dev-shaped key but the bundle is incomplete.
     */
    private extractTenantCredentials(
        snapshot: TenantCredentialSnapshot,
    ): TriggerTenantCredentials | null {
        const bag = snapshot.credentials as Record<string, unknown>;
        const accessToken = typeof bag.accessToken === 'string' ? bag.accessToken : null;
        const secretKey = typeof bag.secretKey === 'string' ? bag.secretKey : null;
        const projectRef = typeof bag.projectRef === 'string' ? bag.projectRef : null;
        const apiUrl = typeof bag.apiUrl === 'string' ? bag.apiUrl : undefined;

        if (!accessToken && !secretKey && !projectRef) {
            return null;
        }

        if (!accessToken || !secretKey || !projectRef) {
            const missing = [
                !accessToken && 'accessToken',
                !secretKey && 'secretKey',
                !projectRef && 'projectRef',
            ]
                .filter(Boolean)
                .join(', ');
            this.logger.warn(
                `bindToTenant(tenantId=${snapshot.tenantId}, v=${snapshot.credentialVersion}): ` +
                    `malformed BYO credentials — missing ${missing}. Falling back to platform default.`,
            );
            return null;
        }

        return apiUrl !== undefined
            ? { accessToken, secretKey, projectRef, apiUrl }
            : { accessToken, secretKey, projectRef };
    }

    /**
     * Wrap the per-tenant `clientFactory` call in try/catch so a
     * misbehaving operator factory (throws on construction, returns
     * wrong shape) doesn't crash the whole bind. On failure we fall
     * open to the platform default and warn — same shape as the
     * missing-field path. Mirrors `safeBuildClient` on
     * `TriggerJobRuntimePlugin`.
     */
    private safeBuildTenantClient(
        snapshot: TenantCredentialSnapshot,
        credentials: TriggerTenantCredentials,
    ): TriggerClient | null {
        try {
            return this.clientFactory(credentials);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `bindToTenant(tenantId=${snapshot.tenantId}, v=${snapshot.credentialVersion}): ` +
                    `clientFactory threw — ${reason}. Falling back to platform default.`,
            );
            return null;
        }
    }
}
