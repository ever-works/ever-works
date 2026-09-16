/**
 * Agent computers — the numbers a live view's link is judged by.
 *
 * Three places read them: the machine's capture pump (when to drop a
 * quality tier and when to come back), the owner's browser (when a quiet
 * picture is "stalled" and when the view is dead) and the platform's session
 * rules (when an unfinished view is expired). They live here, in the
 * zero-dependency contracts package, so all three import ONE declaration —
 * a node that stalled at 5 s while the browser waited for 6 would show the
 * owner a picture that contradicts its own banner.
 *
 * Pure: no clock is read here, every "since" is passed in.
 */

/** Degrade when the publish backlog stays above this many pictures… */
export const COMPUTER_DEGRADE_BACKLOG_FRAMES = 3;
/** …or the acknowledgement round trip stays above this… */
export const COMPUTER_DEGRADE_ACK_MS = 1500;
/** …for this long, continuously. */
export const COMPUTER_DEGRADE_WINDOW_MS = 5000;
/** Return to the chosen quality after this long within limits. */
export const COMPUTER_RECOVER_WINDOW_MS = 30_000;

/** A stream quieter than this is stalled (the strip says so over a dimmed picture). */
export const COMPUTER_STALL_AFTER_MS = 6000;
/** …one automatic refresh is attempted at this age… */
export const COMPUTER_AUTO_REFRESH_AFTER_MS = 20_000;
/** …and the session ends at this age. */
export const COMPUTER_DEAD_AFTER_MS = 45_000;

/** Consecutive failed pictures after which a capture restarts (without ending the view). */
export const COMPUTER_CAPTURE_RESTART_AFTER_FAILURES = 3;

export interface ComputerLinkSample {
	/** Pictures captured but not yet published. */
	backlog: number;
	/** Round trip of the last publish, in milliseconds. */
	ackMs: number;
}

/** True when the link is over a degrade threshold right now. */
export function isOverLinkLimits(sample: ComputerLinkSample): boolean {
	return sample.backlog > COMPUTER_DEGRADE_BACKLOG_FRAMES || sample.ackMs > COMPUTER_DEGRADE_ACK_MS;
}

/** Drop a tier? `overSinceMs` is how long the link has been continuously over a limit. */
export function shouldDegrade(sample: ComputerLinkSample, overSinceMs: number): boolean {
	return isOverLinkLimits(sample) && overSinceMs >= COMPUTER_DEGRADE_WINDOW_MS;
}

/** Return to the chosen tier? `withinSinceMs` is how long the link has been continuously within limits. */
export function shouldRecover(sample: ComputerLinkSample, withinSinceMs: number): boolean {
	return !isOverLinkLimits(sample) && withinSinceMs >= COMPUTER_RECOVER_WINDOW_MS;
}

export type ComputerStallState = 'ok' | 'stalled' | 'auto-refresh' | 'dead';

/**
 * How stale a stream is, from the age of its last picture in milliseconds,
 * at the 6 s / 20 s / 45 s boundaries (inclusive). A negative or unknown age
 * (no picture yet, a clock that ran backwards) is `ok` — "stalled" is a claim
 * about a stream that was flowing, never about one still connecting.
 */
export function computerStallStateForAge(ageMs: number | null | undefined): ComputerStallState {
	if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'ok';
	if (ageMs >= COMPUTER_DEAD_AFTER_MS) return 'dead';
	if (ageMs >= COMPUTER_AUTO_REFRESH_AFTER_MS) return 'auto-refresh';
	if (ageMs >= COMPUTER_STALL_AFTER_MS) return 'stalled';
	return 'ok';
}
