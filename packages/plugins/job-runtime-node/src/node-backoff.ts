/**
 * Poll/backoff policy for a fleet worker host.
 *
 * Pure functions with no timers, so both worker-host implementations
 * (this package's in-process host and the standalone loop in
 * `apps/node`) can agree on the same schedule and both be tested
 * without waiting a single real millisecond.
 */

/** Gap between polls when the fleet queue is empty. */
export const WORKER_IDLE_POLL_MS = 5_000;

/** First retry delay after a failed poll. */
export const WORKER_BACKOFF_BASE_MS = 1_000;

/** Ceiling on the retry delay — an outage must not back off forever. */
export const WORKER_BACKOFF_MAX_MS = 60_000;

/**
 * Exponential backoff for `n` consecutive failures, capped.
 *
 * `nextBackoffMs(1)` is the base delay, and each further failure
 * doubles it up to the ceiling. Non-positive / nonsense inputs collapse
 * to the base delay rather than throwing — a backoff calculation must
 * never be the thing that kills a worker loop.
 */
export function nextBackoffMs(consecutiveFailures: number): number {
	if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) {
		return WORKER_BACKOFF_BASE_MS;
	}
	const exponent = Math.min(Math.trunc(consecutiveFailures) - 1, 16);
	return Math.min(WORKER_BACKOFF_BASE_MS * 2 ** exponent, WORKER_BACKOFF_MAX_MS);
}
