import { Global, Module } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { TriggerJobRuntimeProvider } from './trigger-job-runtime.provider';
import {
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
    KB_NORMALIZE_MEDIA_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    KB_REEMBED_WORK_DISPATCHER,
    MEMORY_FACT_EMBED_DISPATCHER,
    // APW-07 T17 — the `app-dependency-provision` dispatcher. Bound by the
    // `buildJobRuntimeProviders()` spread below like every other symbol and
    // EXPORTED here so `AppDependenciesService` (declared in the agent-side
    // `AppDependenciesModule`) can inject it. The API imports that module through
    // `AppDeployRequestModule` since 2026-09-26; before that no API module did, so
    // this export reached nothing.
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    // APW-05 T19/T20 and APW-03 T12 — the three App dispatchers that were
    // BOUND (they are `DISPATCHER_SYMBOLS`, so `buildJobRuntimeProviders()`
    // spreads them in) and never exported. See the export block below.
    APP_BUILD_PREPARE_DISPATCHER,
    APP_BUILD_WATCH_DISPATCHER,
    APP_SPEC_EVALUATE_DISPATCHER,
    ROSTER_PROVISION_DISPATCHER,
    WORKSPACE_BACKUP_DISPATCHER,
    JOB_RUNTIME_PROVIDER_REGISTRY,
    InMemoryJobRuntimeProviderRegistry,
    buildJobRuntimeProviders,
    type JobRuntimeProviderRegistry,
} from '@ever-works/agent/tasks';
import {
    NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
    type NotificationChannelDeliveryDispatcher,
    type NotificationChannelDeliveryPayload,
} from '@ever-works/agent/facades';

@Global()
@Module({
    providers: [
        TriggerService,
        // EW-686 P1 — adapter exposing TriggerService through the
        // pluggable IJobRuntimeProvider contract. The registry below
        // registers it as the active provider at boot.
        //
        // Use a factory so NestJS DI only injects TriggerService; the
        // second constructor parameter (opts) is a plain object with a
        // default value — NestJS cannot resolve plain interface types and
        // would throw UnknownDependenciesException if the class were
        // listed directly.
        {
            provide: TriggerJobRuntimeProvider,
            useFactory: (triggerService: TriggerService) =>
                new TriggerJobRuntimeProvider(triggerService),
            inject: [TriggerService],
        },
        // EW-685 T4 cutover — the in-memory registry + active-provider
        // registration. `JOB_RUNTIME_PROVIDER_REGISTRY` is the DI token
        // every `*_DISPATCHER` binding (below) injects through.
        //
        // Runtime no-op vs the old `useExisting: TriggerService` bindings:
        // `TriggerService.dispatchers` is literally `this as unknown as
        // JobRuntimeDispatchers` (see trigger.service.ts), so the
        // resolved injection is the same TriggerService instance. Every
        // existing `@Inject(WORK_GENERATION_DISPATCHER) dispatcher`
        // continues to receive the same object — no call-site changes.
        //
        // What the indirection BUYS: when the EW-742 P3 tenant-aware
        // resolver replaces `InMemoryJobRuntimeProviderRegistry` with a
        // per-request resolver, the binding sites stay identical. And
        // when the operator flips `EVER_WORKS_JOB_RUNTIME=bullmq`, the
        // registry hands out the BullMQ provider's dispatchers map
        // instead — without redeploying or editing this file.
        {
            provide: JOB_RUNTIME_PROVIDER_REGISTRY,
            useFactory: (adapter: TriggerJobRuntimeProvider) => {
                const registry = new InMemoryJobRuntimeProviderRegistry();
                registry.register(adapter);
                return registry;
            },
            inject: [TriggerJobRuntimeProvider],
        },
        // EW-685 T4 full cutover — every `*_DISPATCHER` symbol now
        // flows through the registry. `buildJobRuntimeProviders()`
        // with no `symbols:` filter binds all 11 tokens from the
        // `@ever-works/agent/tasks` barrel. The previous 3-symbol
        // carve-out (KB_NORMALIZE_MEDIA / KB_TRANSCRIBE /
        // KB_REEMBED_WORK) was retired once their custom Trigger.dev
        // SDK adapters in `apps/api/src/works/works.module.ts` were
        // replaced by matching `TriggerService.dispatchXxx` methods —
        // see the trio of `dispatchKbNormalizeMedia` /
        // `dispatchKbTranscribe` / `dispatchKbReembedWork` impls on
        // `TriggerService`. From this PR forward, an
        // `EVER_WORKS_JOB_RUNTIME=bullmq` flip swaps all 11 the same
        // way (no per-dispatcher special-casing). AW-07 adds
        // `MEMORY_FACT_EMBED_DISPATCHER` to the same list (12 tokens).
        ...buildJobRuntimeProviders(),
        // Notifications v2 (EW-663) — the facade's delivery dispatcher
        // contract is `enqueue(payload) → { runId }`, which differs
        // from the `JobRuntimeDispatchers` `dispatchXxx → string | null`
        // method shape every other `*_DISPATCHER` symbol exposes. Per
        // EW-685 T4 full cutover (Path 2 — picked over moving the
        // symbol onto the registry's 11-symbol list because that would
        // churn the facade consumer and cross the `@ever-works/agent/
        // facades` ↔ `@ever-works/agent/tasks` symbol boundary): the
        // binding stays a custom adapter, but it now resolves the
        // active provider via the registry instead of the underlying
        // `TriggerService` instance. The active provider's
        // `dispatchers.dispatchNotificationChannelDelivery(payload)`
        // returns a `string | null` run id (null when the runtime is
        // disabled / no provider registered / the dispatch threw); the
        // adapter wraps that into the `{ runId }` envelope the facade
        // expects. When the operator flips
        // `EVER_WORKS_JOB_RUNTIME=bullmq`, this adapter automatically
        // routes through the BullMQ provider's dispatchers map — same
        // single-source-of-truth as the other 11.
        {
            provide: NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
            useFactory: (
                registry: JobRuntimeProviderRegistry,
            ): NotificationChannelDeliveryDispatcher => ({
                async enqueue(payload: NotificationChannelDeliveryPayload) {
                    const provider = registry.getActive();
                    if (!provider) {
                        return { runId: null };
                    }
                    // The active provider's dispatchers bag is the
                    // intentionally-untyped `JobRuntimeDispatchers`
                    // shape (see IJobRuntimeProvider JSDoc); cast to
                    // the concrete dispatcher to call through. The
                    // `?.()` guard returns `null` if the runtime
                    // doesn't implement notification delivery (future
                    // pull-model providers can opt out).
                    const dispatch = (
                        provider.dispatchers as {
                            dispatchNotificationChannelDelivery?: (
                                p: NotificationChannelDeliveryPayload,
                            ) => Promise<string | null>;
                        }
                    ).dispatchNotificationChannelDelivery?.bind(provider.dispatchers);
                    if (!dispatch) {
                        return { runId: null };
                    }
                    return { runId: await dispatch(payload) };
                },
            }),
            inject: [JOB_RUNTIME_PROVIDER_REGISTRY],
        },
    ],
    exports: [
        TriggerService,
        TriggerJobRuntimeProvider,
        // The registry is exported so EW-742 P3 (tenant-aware resolver)
        // can replace it without re-importing the whole TriggerModule.
        JOB_RUNTIME_PROVIDER_REGISTRY,
        WORK_GENERATION_DISPATCHER,
        WORK_IMPORT_DISPATCHER,
        TEMPLATE_CUSTOMIZATION_DISPATCHER,
        WEBHOOK_DELIVERY_DISPATCHER,
        KB_MIRROR_DOCUMENT_DISPATCHER,
        KB_BACKFILL_SKELETON_DISPATCHER,
        KB_EMBED_DOCUMENT_DISPATCHER,
        KB_ORG_OVERLAY_FANOUT_DISPATCHER,
        // EW-685 T4 full cutover — the 3 KB tokens previously bound
        // in apps/api/src/works/works.module.ts now ship through here.
        KB_NORMALIZE_MEDIA_DISPATCHER,
        KB_TRANSCRIBE_DISPATCHER,
        KB_REEMBED_WORK_DISPATCHER,
        // AW-07 — the memory-fact embed dispatcher resolves through the same
        // registry, so any active job-runtime provider (and the tenant
        // overlay in front of it) runs `memory-fact-embed`. Exported from
        // this @Global() module so `MemoryFactService`, declared in the
        // agent-side `MemoryFactsModule`, can see it.
        MEMORY_FACT_EMBED_DISPATCHER,
        // A token bound in `providers` and absent from `exports` is not
        // shared by a @Global() module: it resolves to `undefined` at every
        // `@Optional() @Inject()` site in another module, silently, and the
        // app still boots. These two were in that state.
        //
        // AW-20's `ROSTER_PROVISION_DISPATCHER` (injected by
        // `onboarding-roster.controller.ts`) and AW-22's
        // `WORKSPACE_BACKUP_DISPATCHER` (injected by
        // `WorkspaceBackupService`, declared in the agent-side
        // `AccountTransferModule`). Without the backup entry every
        // `POST /api/account/backups` answered 202 with a row that was
        // already `failed` / 'Could not enqueue the backup: no job runtime
        // is configured', because `create()` saw `dispatcher?.…` resolve to
        // undefined — on a deployment with the job runtime fully
        // configured. `trigger.module.spec.ts` now asserts every symbol
        // `buildJobRuntimeProviders()` binds is also exported, so the next
        // dispatcher cannot land half-wired.
        ROSTER_PROVISION_DISPATCHER,
        WORKSPACE_BACKUP_DISPATCHER,
        NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER,
        // APW-07 T17 — exported for the API's dependency wiring; the token
        // itself is bound by `...buildJobRuntimeProviders()` above (all
        // `DISPATCHER_SYMBOLS` flow through the registry), so this line is the
        // export and nothing else.
        APP_DEPENDENCY_PROVISION_DISPATCHER,
        // APW-05 T19/T20 and APW-03 T12 — the same story, three more times, and
        // these three were HALF-WIRED until 2026-09-21.
        //
        // They are `DISPATCHER_SYMBOLS`, so `buildJobRuntimeProviders()` bound
        // them; nothing exported them. A token bound in `providers` and absent
        // from `exports` is not shared even by an `@Global()` module — it
        // resolves to `undefined` at every `@Optional() @Inject()` site in
        // another module, silently, and the app still boots. The sites are
        // `AppBuildsService` (`app-builds.module.ts`) and `AppSpecService`
        // (`app-spec.module.ts`), both of which the API imports, so the
        // observable effect was: a build prepare or a spec evaluation was
        // “requested”, nothing was ever enqueued, and no error was raised.
        //
        // Found by develop's own `trigger.module.spec.ts` guard the moment
        // `develop` was merged into this branch — which is what that guard was
        // added for. It names the tokens it catches, so this cannot regress
        // quietly.
        APP_BUILD_PREPARE_DISPATCHER,
        APP_BUILD_WATCH_DISPATCHER,
        APP_SPEC_EVALUATE_DISPATCHER,
    ],
})
export class TriggerModule {}
