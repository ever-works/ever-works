import { Injectable } from '@nestjs/common';
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
import { TriggerService } from './trigger.service';

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

    constructor(private readonly triggerService: TriggerService) {}

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
        // Build a frozen tenant view. Every method delegates back to
        // the singleton `TriggerService` (via `base`), but the view
        // carries the snapshot for downstream stamping.
        const view: IJobRuntimeProvider & {
            readonly tenantSnapshot: TenantCredentialSnapshot;
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
                return base.dispatchers;
            },
            registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
                return base.registerSchedules(schedules);
            },
            cancel(runId: string): Promise<boolean> {
                return base.cancel(runId);
            },
            getRunStatus(runId: string): Promise<JobRunStatus> {
                return base.getRunStatus(runId);
            },
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
}
