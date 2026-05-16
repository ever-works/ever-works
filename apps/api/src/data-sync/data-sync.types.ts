/**
 * Shared types for the data-repo instant-sync feature (EW-628).
 *
 * The full contract is documented in
 * `docs/specs/features/data-repo-instant-sync/spec.md`. The
 * `DataSyncService` exposes `runDataSync(workId, source)`, the EW-628
 * dispatcher (Phase 4) fans out into it from both webhook and poller
 * paths, and the activity feed (Phase 7) renders the outcomes.
 *
 * The wire-format types (`SyncEventSource` / `SyncEventSkipReason` /
 * `SyncEventErrorClass`) live in `@ever-works/contracts/api` so the API
 * emitter and the web `SyncEventRow` renderer share a single source of
 * truth. The aliases re-exported below keep the existing call sites
 * compiling and document the intent — the API service speaks in
 * `SyncSource` and `SyncReason`, both of which ARE the contract types.
 */

import type {
    SyncEventErrorClass,
    SyncEventSkipReason,
    SyncEventSource,
} from '@ever-works/contracts/api';

/**
 * Which transport surfaced this sync attempt.
 *
 * - `webhook` — GitHub App push handler set `Work.pendingSyncRequestedAt`
 *   and the dispatcher flushed once the row was ≥ 30 s old.
 * - `poll` — App not installed; dispatcher's `ls-remote HEAD` saw a SHA
 *   delta against `Work.lastSyncedDataRepoSha`.
 * - `manual` — operator hit the force-sync endpoint
 *   (`POST /api/works/:id/sync`, Phase 6).
 */
export type SyncSource = SyncEventSource;

/**
 * Why a sync attempt was skipped (logged on the `data-sync.skipped`
 * activity row). The three gate ids in `runDataSync` map to the first
 * three values here; `no-changes` and `app-not-installed-and-no-credentials`
 * are emitted upstream by the dispatcher before the lock attempt.
 */
export type SyncReason = SyncEventSkipReason;

/** Terminal outcome of a `runDataSync` invocation. */
export type DataSyncOutcome =
    | { status: 'success'; stats: DataSyncSuccessStats }
    | { status: 'skipped'; reason: SyncReason }
    | { status: 'failed'; errorClass: SyncEventErrorClass; errorTail: string };

export type DataSyncSuccessStats = {
    /** Data-repo SHA before the sync's clone/pull. May be undefined until gitFacade SHA helper lands (EW-628 Phase 2 follow-up). */
    beforeSha?: string;
    /** Data-repo SHA the main repo was rendered against. May be undefined until gitFacade SHA helper lands. */
    afterSha?: string;
    /** Number of files written in the main repo. Stubbed at 0 until Phase 2 follow-up. */
    filesChanged: number;
    /** Wall-clock duration of the sync run in ms. */
    durationMs: number;
};
