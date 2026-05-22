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
    'KB_BACKFILL_SKELETON_DISPATCHER',
    'KB_EMBED_DOCUMENT_DISPATCHER',
    'KB_MIRROR_DOCUMENT_DISPATCHER',
    'TEMPLATE_CUSTOMIZATION_DISPATCHER',
    'WEBHOOK_DELIVERY_DISPATCHER',
    'WORK_GENERATION_DISPATCHER',
    'WORK_GENERATION_MODE',
    'WORK_IMPORT_DISPATCHER',
    'WorkImportErrorCode',
] as const;
