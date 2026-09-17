/**
 * Safety rails (AW-24) — the owner's own stop.
 *
 * The platform stop flag is the OPERATOR's, behind a deployment switch, over
 * the whole installation. An owner has drain-all and cancel-in-flight for
 * their own machines and nothing at all for a workspace that runs in the
 * cloud. This is the row that means "this workspace is stopped", and the
 * place the actor, the reason and the resume progress hang off.
 *
 * It exists **only while paused**: pausing inserts, resuming deletes. That is
 * what makes "is this workspace paused?" a presence check rather than a
 * boolean somebody has to remember to reset.
 *
 * Reads fail CLOSED, exactly as the platform stop flag does: a state that
 * could not be read answers `{ paused: true, unverified: true }`. A stop that
 * permits whenever it cannot read itself is not a stop.
 *
 * P1 publishes the shape and the read; P3 wires the enforcement at every
 * start point.
 */

/** What every reader of the pause gets. Never throws, never guesses. */
export interface WorkspacePauseState {
	paused: boolean;
	/** True when `paused` is a fail-closed default rather than a read row. */
	unverified: boolean;
	reason: string | null;
	pausedByUserId: string | null;
	/** ISO-8601, or `null` when not paused. */
	pausedAt: string | null;
	/** Starts this pause has refused so far — the banner's count. */
	refusedStarts: number;
	/** Runs that reached a tool boundary and parked cleanly. */
	cleanlyStopped: number;
}

/** The state of a workspace that is running. */
export const WORKSPACE_RUNNING: WorkspacePauseState = Object.freeze({
	paused: false,
	unverified: false,
	reason: null,
	pausedByUserId: null,
	pausedAt: null,
	refusedStarts: 0,
	cleanlyStopped: 0
} as WorkspacePauseState);

/** The fail-closed answer. Identical wherever a read failed (FR-46). */
export const WORKSPACE_PAUSED_UNVERIFIED: WorkspacePauseState = Object.freeze({
	paused: true,
	unverified: true,
	reason: null,
	pausedByUserId: null,
	pausedAt: null,
	refusedStarts: 0,
	cleanlyStopped: 0
} as WorkspacePauseState);
