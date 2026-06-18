/**
 * EW-683 / EW-685 — the `*_DISPATCHER` symbols re-exported below ARE
 * the seam that makes the job runtime pluggable. The API depends only
 * on these symbols; today `TriggerService` (`packages/tasks/src/trigger/trigger.service.ts`)
 * implements every one of them. EW-686 P1 will refactor `TriggerService`
 * to implement the `IJobRuntimeProvider` contract
 * (`packages/plugin/src/contracts/capabilities/job-runtime.interface.ts`,
 * shipped EW-685 P0) and a binding factory at
 * `packages/agent/src/tasks/job-runtime.providers.ts` will bind whichever
 * provider is active (env: `EVER_WORKS_JOB_RUNTIME`) to all of these symbols.
 * Call sites do not change. See `docs/specs/architecture/job-runtime-providers.md`
 * §2 (seam) and §3 (contract) for the full picture.
 */
export * from './work-generation.types';
export * from './work-generation-dispatcher';
export * from './work-import.types';
export * from './work-import-dispatcher';
export * from './template-customization.types';
export * from './template-customization-dispatcher';
export * from './webhook-delivery.types';
export * from './webhook-delivery-dispatcher';
export * from './kb-mirror-document.types';
export * from './kb-mirror-document-dispatcher';
export * from './kb-backfill-skeleton.types';
export * from './kb-backfill-skeleton-dispatcher';
export * from './kb-embed-document.types';
export * from './kb-embed-document-dispatcher';
export * from './kb-org-overlay-fanout.types';
export * from './kb-org-overlay-fanout-dispatcher';
export * from './kb-normalize-media.types';
export * from './kb-normalize-media-dispatcher';
export * from './kb-transcribe.types';
export * from './kb-transcribe-dispatcher';
export * from './kb-reembed-work.types';
export * from './kb-reembed-work-dispatcher';
// Tenant-scoped job-runtime overlay (EW-742 P1) — credential versioning
// for graceful drain on rotation. See ADR-017 §3 + spec.md FR-5.
export * from './credential-version.service';
