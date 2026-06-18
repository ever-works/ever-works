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
    // Tenant-scoped job-runtime overlay (EW-742 P1 / EW-745) — credential
    // versioning service for graceful drain on rotation. See ADR-017 §3.
    'CredentialVersionService',
    // EW-685 P0 T4 — DI token for the in-memory job-runtime provider
    // registry consumed by the binding factory `buildJobRuntimeProviders()`.
    // Declared but not wired into any NestJS module yet; see
    // `job-runtime.providers.ts` header "Critical constraint" for rationale.
    'JOB_RUNTIME_PROVIDER_REGISTRY',
    'KB_BACKFILL_SKELETON_DISPATCHER',
    'KB_EMBED_DOCUMENT_DISPATCHER',
    'KB_MIRROR_DOCUMENT_DISPATCHER',
    'KB_NORMALIZE_MEDIA_DISPATCHER',
    'KB_ORG_OVERLAY_FANOUT_DISPATCHER',
    'KB_REEMBED_WORK_DISPATCHER',
    'KB_TRANSCRIBE_DISPATCHER',
    'TEMPLATE_CUSTOMIZATION_DISPATCHER',
    // Tenant-scoped job-runtime overlay (EW-742 P3.1 / T21) — in-process
    // LRU+TTL credential snapshot cache. Standalone class; the P3
    // resolver follow-up and P4 worker host layer it in independently.
    'TenantCredentialCache',
    'WEBHOOK_DELIVERY_DISPATCHER',
    'WORK_GENERATION_DISPATCHER',
    'WORK_GENERATION_MODE',
    'WORK_IMPORT_DISPATCHER',
    'WorkImportErrorCode',
] as const;
