import type { WorkerPollCadence } from '../worker-loop';

/**
 * The attended live-view lane's poll cadence.
 *
 * An owner who opens a live view is waiting on a "Waking up the view…"
 * screen, so a machine whose owner switched live viewing on (`--attend`)
 * looks for views far more often than for ordinary work — but a machine
 * nobody has watched in a while must not hit the platform every two seconds
 * forever. So:
 *
 *   - **fast** — every {@link ATTENDED_FAST_POLL_MS} (clamped to
 *     {@link ATTENDED_MIN_POLL_MS}–{@link ATTENDED_MAX_POLL_MS});
 *   - **slow** — {@link ATTENDED_SLOW_POLL_MS}, after
 *     {@link ATTENDED_EMPTY_POLLS_BEFORE_SLOW} consecutive empty polls with
 *     no view claimed in the previous {@link ATTENDED_RECENT_SESSION_MS};
 *   - **back to fast** at once when a heartbeat says a view is waiting
 *     ({@link AttendedPollCadence.notePendingSessions}) or a poll claims one.
 *
 * Pure over an injected clock, so every boundary is a one-line test.
 */

export const ATTENDED_FAST_POLL_MS = 2000;
export const ATTENDED_MIN_POLL_MS = 500;
export const ATTENDED_MAX_POLL_MS = 10_000;
export const ATTENDED_SLOW_POLL_MS = 15_000;
export const ATTENDED_EMPTY_POLLS_BEFORE_SLOW = 10;
export const ATTENDED_RECENT_SESSION_MS = 10 * 60_000;

/** Clamp an operator-supplied fast interval; nonsense is the default. */
export function clampAttendedPollMs(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return ATTENDED_FAST_POLL_MS;
	return Math.min(Math.max(Math.round(value), ATTENDED_MIN_POLL_MS), ATTENDED_MAX_POLL_MS);
}

export class AttendedPollCadence implements WorkerPollCadence {
	private readonly fastMs: number;
	private readonly now: () => number;
	private emptyPolls = 0;
	private lastSessionAt: number | null = null;

	constructor(options: { fastPollMs?: number; now?: () => number } = {}) {
		this.fastMs = clampAttendedPollMs(options.fastPollMs);
		this.now = options.now ?? (() => Date.now());
	}

	recordPoll(leased: number): void {
		if (leased > 0) {
			this.emptyPolls = 0;
			this.lastSessionAt = this.now();
			return;
		}
		this.emptyPolls += 1;
	}

	/** A heartbeat carried `pendingComputerSessions`: be fast again, now. */
	notePendingSessions(sessionIds: readonly string[] | undefined): boolean {
		if (!Array.isArray(sessionIds) || sessionIds.length === 0) return false;
		this.emptyPolls = 0;
		this.lastSessionAt = this.now();
		return true;
	}

	isSlow(): boolean {
		if (this.emptyPolls < ATTENDED_EMPTY_POLLS_BEFORE_SLOW) return false;
		return this.lastSessionAt === null || this.now() - this.lastSessionAt >= ATTENDED_RECENT_SESSION_MS;
	}

	nextIdleDelayMs(): number {
		return this.isSlow() ? ATTENDED_SLOW_POLL_MS : this.fastMs;
	}
}
