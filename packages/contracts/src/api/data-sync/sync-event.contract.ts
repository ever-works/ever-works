/**
 * EW-628 data-repo instant-sync — wire-format contract for the activity
 * row `details` payload emitted by the API and consumed by the web
 * `SyncEventRow` component.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.6.
 *
 * The discriminated union is the canonical source of truth for both
 * sides — `apps/api/src/data-sync/data-sync.service.ts` writes it into
 * `activity_log.details`, and `apps/web/src/components/works/detail/
 * activity/SyncEvent.types.ts` re-exports it as `SyncEvent` so the
 * row renderer's exhaustive switch stays in lock-step.
 *
 * `kind` (not `status`) discriminates row variants — the activity-feed
 * convention reserves `status` for HTTP / pipeline lifecycle values
 * (`COMPLETED` / `FAILED` / `CANCELLED`), which live on the parent
 * `activity_log` row.
 */

/** Which transport surfaced the sync attempt. */
export type SyncEventSource = 'webhook' | 'poll' | 'manual';

/**
 * Skip reasons the dispatcher or the three gates emit. Locked to a
 * small literal union so dashboards can pivot on it without parsing
 * free-form text.
 */
export type SyncEventSkipReason =
	| 'retry-backoff'
	| 'sync-in-progress'
	| 'generation-in-progress'
	| 'no-changes'
	| 'app-not-installed-and-no-credentials';

/**
 * Failure classes the render gate maps caught errors to. The set is
 * deliberately small — adding a new class is a deliberate schema
 * decision, not an autopilot fallback. `unknown` is the explicit
 * fallback when nothing matches.
 */
export type SyncEventErrorClass =
	| 'data-repo-unreachable'
	| 'main-repo-push-rejected'
	| 'work-not-found'
	| 'timeout'
	| 'unknown';

export interface SyncEventSuccess {
	kind: 'success';
	source: SyncEventSource;
	beforeSha?: string;
	afterSha?: string;
	filesChanged: number;
	durationMs?: number;
}

export interface SyncEventSkipped {
	kind: 'skipped';
	source: SyncEventSource;
	reason: SyncEventSkipReason;
}

export interface SyncEventFailed {
	kind: 'failed';
	source: SyncEventSource;
	errorClass: SyncEventErrorClass;
	errorTail: string;
}

/**
 * The discriminated union the API writes into `activity_log.details`
 * for every `data_sync_*` row, and the web reads back to render the
 * `SyncEventRow`.
 */
export type SyncEventPayload = SyncEventSuccess | SyncEventSkipped | SyncEventFailed;

/** Narrow `kind` values used as React keys + telemetry labels. */
export type SyncEventKind = SyncEventPayload['kind'];
