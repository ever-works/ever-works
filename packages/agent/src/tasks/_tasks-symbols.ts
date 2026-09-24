/**
 * EW-638 — Single source of truth for the runtime symbols re-exported from
 * `@ever-works/agent/tasks`.
 *
 * "Runtime symbols" means anything that survives TypeScript erasure: DI
 * tokens (`Symbol(...)`), const enums made non-const, runtime enums,
 * runtime constants. Type-only exports (interfaces, types, type aliases)
 * erase at runtime and do NOT appear in `Object.keys(tasksBarrel)` — so
 * they are NOT listed here.
 *
 * Why this list exists:
 *   `tasks.spec.ts` pins the exact set of runtime symbols exposed by the
 *   `./index.ts` barrel ("exposes the documented runtime symbols — no
 *   extras silently appearing"). Adding a new dispatcher token without
 *   updating the spec used to fail CI one merge late (it happened on
 *   EW-634 with `WEBHOOK_DELIVERY_DISPATCHER`).
 *
 *   Centralizing the list here turns it into a single deliberate update:
 *   one entry below, and the spec re-counts automatically.
 *
 * # When adding a new runtime symbol to @ever-works/agent/tasks
 *
 *   1. Add the `export ...` line to `./index.ts` as usual.
 *   2. Add the symbol's NAME (string) below. Alphabetical insertion.
 *
 * That's it. The spec picks up the change automatically.
 */

export const TASKS_BARREL_RUNTIME_SYMBOLS: ReadonlyArray<string> = [
    // APW-05 T18 — the two Build dispatchers (plan §7.1:1312-1319): one enqueues
    // `app-build-prepare`, one enqueues `app-build-watch`. A `null` from either
    // means "no runtime took it" and runs the matching runner in process.
    'APP_BUILD_PREPARE_DISPATCHER',
    // APW-05 T18 — the runtime-neutral id of the prepare job
    // (`packages/tasks/src/tasks/trigger/app-build-prepare.task.ts` registers it).
    'APP_BUILD_PREPARE_TASK_ID',
    'APP_BUILD_WATCH_DISPATCHER',
    // APW-05 T18 — the runtime-neutral id of the watch job, declared by T18 and
    // registered by T20's `app-build-watch.task.ts`.
    'APP_BUILD_WATCH_TASK_ID',
    // APW-07 T17 — the `app-dependency-provision` dispatcher symbol. The
    // service's own provisional declaration of the same NAME is a different
    // Symbol; this barrel entry is the one `job-runtime.providers.ts` binds
    // and the one `TriggerModule` exports.
    'APP_DEPENDENCY_PROVISION_DISPATCHER',
    // APW-03 T13 — the `app-spec-evaluate` dispatcher symbol (plan §6.1:650).
    // Bound by `job-runtime.providers.ts`; a `null` from it runs the handler
    // in-process for this job id only.
    'APP_SPEC_EVALUATE_DISPATCHER',
    // APW-03 T13 — runtime-neutral id of the App spec evaluation job, and the
    // list of job ids a `null` dispatch runs in-process (`app-works-jobs.ts`).
    'APP_SPEC_EVALUATE_JOB_ID',
    'APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS',
    // APW-03 T13 — the payload refusal a malformed `app-spec-evaluate` message
    // raises at the runtime boundary, plus the handler every provider registers
    // and the predicate that answers "does a `null` dispatch mean run it here?".
    'AppSpecEvaluatePayloadError',
    // Tenant-scoped job-runtime overlay (EW-742 P1 / EW-745) — credential
    // versioning service for graceful drain on rotation. See ADR-017 §3.
    'CredentialVersionService',
    // EW-685 P0 T4 — default in-memory implementation of
    // `JobRuntimeProviderRegistry`, exposed via the barrel so DI modules
    // can bind it as the `JOB_RUNTIME_PROVIDER_REGISTRY` useClass.
    'InMemoryJobRuntimeProviderRegistry',
    // EW-742 P3.2 — default in-process SecretStoreResolver bound at the
    // SECRET_STORE_RESOLVER DI token. Only supports `inline:` scheme;
    // other schemes (vault:, k8s:, op:) require a non-default binding.
    'InProcessSecretStoreResolver',
    // EW-685 P0 T4 — DI token for the in-memory job-runtime provider
    // registry consumed by the binding factory `buildJobRuntimeProviders()`.
    // Wired into `packages/tasks/src/trigger/trigger.module.ts` per the
    // EW-685 T4 full cutover (all 11 *_DISPATCHER symbols resolve
    // through the registry, no per-dispatcher special-casing).
    'JOB_RUNTIME_PROVIDER_REGISTRY',
    'KB_BACKFILL_SKELETON_DISPATCHER',
    'KB_EMBED_DOCUMENT_DISPATCHER',
    'KB_MIRROR_DOCUMENT_DISPATCHER',
    'KB_NORMALIZE_MEDIA_DISPATCHER',
    'KB_ORG_OVERLAY_FANOUT_DISPATCHER',
    'KB_REEMBED_WORK_DISPATCHER',
    'KB_TRANSCRIBE_DISPATCHER',
    // AW-07 — embeds one memory fact (create / body edit / accept). `null`
    // leaves the fact unembedded for the nightly sweep.
    'MEMORY_FACT_EMBED_DISPATCHER',
    // AW-07 — runtime-neutral ids for the two memory-fact jobs (see
    // `memory-fact-jobs.ts`): every provider registers under these.
    'MEMORY_FACT_EMBED_JOB_ID',
    'MEMORY_FACT_GC_CRON',
    'MEMORY_FACT_GC_JOB_ID',
    // EW-685 P0 T4 — binding factory that wires every `*_DISPATCHER` symbol
    // onto the active job-runtime provider's `dispatchers` view via the
    // `JOB_RUNTIME_PROVIDER_REGISTRY`. Wired into TriggerModule per the
    // EW-685 T4 full cutover.
    'buildJobRuntimeProviders',
    // APW-03 T13 — see the APW_SPEC_* block above: the predicate that answers
    // whether a `null` dispatch runs a job in-process, and the runtime-neutral
    // handler + payload parser the providers register.
    'hasInProcessFallback',
    'parseAppSpecEvaluatePayload',
    'runAppSpecEvaluateJob',
    // AW-07 — runtime-neutral memory-fact job handlers. A provider's
    // registration (Trigger.dev task, BullMQ / pg-boss worker host, …) is a
    // one-line adapter over these, so behaviour is identical on every runtime.
    'parseMemoryFactEmbedPayload',
    'runMemoryFactEmbedJob',
    'runMemoryFactGcJob',
    // EW-742 P3.1 / T22 — enqueue-site `credentialVersion` capture helper.
    // Dispatchers `await stamper.stamp(tenantId)` and write the result into
    // the run record so the worker host can later resolve THAT snapshot
    // via CredentialVersionService.resolveSnapshot. See
    // `runtime-binding-stamper.service.ts` header for the per-dispatcher
    // wiring deferral.
    // EW-693 / T27 — the long-running plugin operation job: the method the active
    // job runtime's dispatchers expose for it, the task id it registers under,
    // and the run's time budget — queue TTL, maxDuration and the router's
    // default wait derived from both (`plugin-operation-dispatch.ts`).
    'PLUGIN_OPERATION_DEFAULT_WAIT_MS',
    'PLUGIN_OPERATION_DISPATCH_METHOD',
    'PLUGIN_OPERATION_MAX_DURATION_SECONDS',
    'PLUGIN_OPERATION_QUEUE_TTL_SECONDS',
    'PLUGIN_OPERATION_TASK_ID',
    // AW-20 P1 — enqueues one roster provisioning run (a coordinator plus
    // lane-owning specialists, wired together). Sequential, retryable,
    // and reports per-lane progress, so it belongs off the request thread.
    'ROSTER_PROVISION_DISPATCHER',
    'RuntimeBindingStamperService',
    // EW-742 P3.2 — DI token for SecretStoreResolver implementations.
    // Symbol, not string — the value's reference is the unique identity.
    'SECRET_STORE_RESOLVER',
    'TEMPLATE_CUSTOMIZATION_DISPATCHER',
    // EW-742 P3 / EW-747 (T20 + T23) — tenant-aware resolver wrapping
    // the EW-685 binding factory registry. See
    // `tenant-aware-runtime.resolver.ts` header for the P3 stopgap +
    // T21 / T22 deferral notes.
    'TenantAwareRuntimeResolver',
    // Tenant-scoped job-runtime overlay (EW-742 P3.1 / T21) — in-process
    // LRU+TTL credential snapshot cache. Standalone class; the P3
    // resolver and P4 worker host layer it in independently.
    'TenantCredentialCache',
    'WEBHOOK_DELIVERY_DISPATCHER',
    // Judgment layer G5 — enqueues a saved workflow graph's run. The walk
    // can take ~40 minutes, so it can never happen in an API request.
    'WORKFLOW_RUN_DISPATCHER',
    'WORK_GENERATION_DISPATCHER',
    'WORK_GENERATION_MODE',
    'WORK_IMPORT_DISPATCHER',
    // AW-22 Workspace backup — enqueues one complete archive of one
    // workspace. A `null` return is treated as a hard failure by the
    // caller, not a deferral: nothing else would ever pick the row up.
    'WORKSPACE_BACKUP_DISPATCHER',
    'WorkImportErrorCode',
] as const;
