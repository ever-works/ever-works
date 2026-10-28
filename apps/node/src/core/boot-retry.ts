/**
 * Bounded retry for the node's boot-time probes.
 *
 * ## The defect
 *
 * Two boot-time answers came from ONE short-deadline spawn each: the
 * owner-only ACL (`icacls`) that proves the worker-safety marker is the
 * owner's alone, and the PATH lookup (`where claude`) that decides whether a
 * model CLI is installed. On a busy PC (a boot storm, an antivirus scan, a
 * saturated disk) that spawn can miss its deadline. A missed deadline was
 * read as the NEGATIVE answer: the marker was left "not proven owner-only",
 * so the worker quarantined itself, and because the marker is durable it
 * stayed quarantined across restarts until someone cleared it at the
 * keyboard. The PATH lookup reported `claude-code: not found on PATH` for a
 * CLI that was installed, and the node stopped advertising it.
 *
 * ## The rule
 *
 * A timeout is NOT an answer. It is retried, a bounded number of times,
 * with a growing deadline and a pause in between, and only when every
 * attempt timed out is the result reported — as "probe timed out", never as
 * the negative result it is not. An attempt that ANSWERS (an `icacls` that
 * exits non-zero, a `where` that says "not found") ends the retry at once
 * and is believed exactly as before: this module never turns a real
 * refusal into a retry, and never changes what the safety check checks.
 */

/** Per-probe retry budget. */
export interface BootRetryPolicy {
	/** One deadline per attempt, growing. The length IS the attempt budget. */
	readonly attemptTimeoutsMs: readonly number[];
	/** The pause before each RETRY: index 0 is the wait before attempt 2. */
	readonly backoffMs: readonly number[];
}

/**
 * The owner-only ACL (`icacls`) on the worker-safety marker and the config
 * file — 4 attempts, deadlines 10 s / 20 s / 30 s / 40 s, pauses 1 s / 2 s /
 * 4 s: at most 107 s, inside the two-minute budget.
 *
 * - The FIRST attempt keeps the old 10 s deadline, so a healthy machine
 *   (where `icacls` takes well under a second) sees no change at all.
 * - Each later deadline is longer, because a spawn slowed by a load spike
 *   needs more room, not the same wall four times.
 * - The pauses are short: a spike that is passing gets a moment to pass,
 *   without padding the budget. Nothing is leased while this runs (the
 *   marker is armed before the FIRST lease), and the heartbeat keeps
 *   beating because every spawn is asynchronous.
 */
export const OWNER_ONLY_ACL_RETRY_POLICY: BootRetryPolicy = Object.freeze({
	attemptTimeoutsMs: Object.freeze([10_000, 20_000, 30_000, 40_000]),
	backoffMs: Object.freeze([1_000, 2_000, 4_000])
});

/**
 * The model-CLI PATH lookup (`where` / `which`) — 4 attempts, deadlines
 * 5 s / 10 s / 20 s / 30 s, pauses 1 s / 2 s / 4 s: at most 72 s. Same
 * reasoning; the first deadline is the old 5 s, and the providers are
 * looked up CONCURRENTLY, so 72 s bounds the whole resolution.
 */
export const PATH_LOOKUP_RETRY_POLICY: BootRetryPolicy = Object.freeze({
	attemptTimeoutsMs: Object.freeze([5_000, 10_000, 20_000, 30_000]),
	backoffMs: Object.freeze([1_000, 2_000, 4_000])
});

/** Worst-case wall time of a policy: every deadline plus every pause. */
export function bootRetryBudgetMs(policy: BootRetryPolicy): number {
	const deadlines = attemptDeadlines(policy);
	let total = deadlines.reduce((sum, ms) => sum + ms, 0);
	for (let retry = 1; retry < deadlines.length; retry++) total += backoffBefore(policy, retry);
	return total;
}

/** One attempt's answer: `timedOut` when its deadline killed it, else the value it produced. */
export type TimedAttempt<T> = { timedOut: true } | { timedOut: false; value: T };

/** What a retry loop ended with. */
export type BootRetryOutcome<T> =
	| { timedOut: false; value: T; attempts: number }
	| { timedOut: true; attempts: number; deadlinesMs: number[] };

/** Said before each retry, so the log shows the machine was busy rather than the probe being silent. */
export interface BootRetryEvent {
	/** The attempt that just timed out, from 1. */
	attempt: number;
	attempts: number;
	timedOutAfterMs: number;
	waitMs: number;
	nextTimeoutMs: number;
}

export interface BootRetryOptions {
	policy: BootRetryPolicy;
	/** Injected so specs run the whole budget in no time; defaults to a real timer. */
	sleep?: (ms: number) => Promise<void>;
	onRetry?: (event: BootRetryEvent) => void;
}

/**
 * Run `attempt` until it answers or the budget is spent.
 *
 * `attempt` is handed its deadline and resolves `{ timedOut: true }` when
 * that deadline killed it; any other resolution is its ANSWER (a genuine
 * negative included) and ends the loop. A throw is a genuine failure and
 * propagates unchanged on the first attempt that throws — it is never
 * retried, because retrying a real refusal until it happens to pass would
 * be weakening the check, not hardening the node.
 */
export async function retryWhileTimedOut<T>(
	attempt: (timeoutMs: number, attemptNumber: number) => Promise<TimedAttempt<T>>,
	options: BootRetryOptions
): Promise<BootRetryOutcome<T>> {
	const deadlines = attemptDeadlines(options.policy);
	const sleep = options.sleep ?? realSleep;
	for (let index = 0; index < deadlines.length; index++) {
		const result = await attempt(deadlines[index], index + 1);
		if (!result.timedOut) return { timedOut: false, value: result.value, attempts: index + 1 };
		if (index + 1 < deadlines.length) {
			const waitMs = backoffBefore(options.policy, index + 1);
			options.onRetry?.({
				attempt: index + 1,
				attempts: deadlines.length,
				timedOutAfterMs: deadlines[index],
				waitMs,
				nextTimeoutMs: deadlines[index + 1]
			});
			if (waitMs > 0) await sleep(waitMs);
		}
	}
	return { timedOut: true, attempts: deadlines.length, deadlinesMs: [...deadlines] };
}

/** `code` of a {@link ProbeTimedOutError}, for callers that cannot use `instanceof` across bundles. */
export const PROBE_TIMED_OUT_CODE = 'EW_PROBE_TIMED_OUT';

/**
 * Every attempt of a probe timed out. Its message begins `probe timed out`,
 * so wherever it surfaces — the quarantine reason Fleet shows, a log line —
 * it reads as "the machine was too busy to answer", never as the negative
 * result (a refused ACL, a missing binary) it is not.
 */
export class ProbeTimedOutError extends Error {
	readonly code = PROBE_TIMED_OUT_CODE;

	constructor(
		readonly probe: string,
		readonly deadlinesMs: readonly number[]
	) {
		super(describeProbeTimeout(probe, deadlinesMs));
		this.name = 'ProbeTimedOutError';
	}
}

export function isProbeTimedOut(error: unknown): boolean {
	return (
		error instanceof ProbeTimedOutError ||
		(typeof error === 'object' && error !== null && (error as { code?: unknown }).code === PROBE_TIMED_OUT_CODE)
	);
}

/** `probe timed out: <probe> did not finish in 4 attempts (deadlines 10 s, 20 s, 30 s, 40 s); …`. */
export function describeProbeTimeout(probe: string, deadlinesMs: readonly number[]): string {
	const count = deadlinesMs.length;
	return (
		`probe timed out: ${probe} did not finish in ${count} attempt${count === 1 ? '' : 's'} ` +
		`(deadlines ${deadlinesMs.map(formatSeconds).join(', ')}); the machine was too busy to answer, ` +
		'which is not a negative result'
	);
}

/** `10 s`, `1.5 s`. */
export function formatSeconds(ms: number): string {
	const seconds = ms / 1000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** The policy's deadlines, with anything that is not a positive finite number dropped; never empty. */
function attemptDeadlines(policy: BootRetryPolicy): number[] {
	const deadlines = policy.attemptTimeoutsMs.filter((ms) => Number.isFinite(ms) && ms > 0).map(Math.floor);
	return deadlines.length > 0 ? deadlines : [OWNER_ONLY_ACL_RETRY_POLICY.attemptTimeoutsMs[0]];
}

/** The pause before attempt `retry + 1`; the last configured pause repeats, a bad one is 0. */
function backoffBefore(policy: BootRetryPolicy, retry: number): number {
	if (policy.backoffMs.length === 0) return 0;
	const ms = policy.backoffMs[Math.min(retry - 1, policy.backoffMs.length - 1)];
	return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
