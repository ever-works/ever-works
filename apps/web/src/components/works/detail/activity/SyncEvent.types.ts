/**
 * EW-628 sync-event row types. The canonical wire format lives in
 * `@ever-works/contracts/api` as `SyncEventPayload` so the API emitter
 * (`apps/api/src/data-sync/data-sync.service.ts`) and the
 * `SyncEventRow` renderer share a single source of truth — adding a
 * new `kind`, `reason`, or `errorClass` requires touching the contract
 * file in one place.
 *
 * The local `SyncEvent` alias is preserved so existing
 * `SyncEventRow` / fixture imports continue to compile.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.6.
 */

import type {
    SyncEventErrorClass,
    SyncEventKind,
    SyncEventPayload,
    SyncEventSkipReason,
    SyncEventSource,
} from '@ever-works/contracts/api';

export type { SyncEventErrorClass, SyncEventKind, SyncEventSkipReason, SyncEventSource };

/**
 * Local alias for the discriminated union. New consumers should prefer
 * importing `SyncEventPayload` from `@ever-works/contracts/api`
 * directly; this alias exists so the in-tree imports of `SyncEvent`
 * keep working without a sweeping rename.
 */
export type SyncEvent = SyncEventPayload;
