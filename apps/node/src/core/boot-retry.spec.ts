import { describe, expect, it, vi } from 'vitest';
import {
	bootRetryBudgetMs,
	describeProbeTimeout,
	isProbeTimedOut,
	OWNER_ONLY_ACL_RETRY_POLICY,
	PATH_LOOKUP_RETRY_POLICY,
	ProbeTimedOutError,
	retryWhileTimedOut,
	type TimedAttempt
} from './boot-retry';

/**
 * Boot-probe retry — a boot-time probe that MISSED its deadline is not a negative
 * answer. It is retried with a growing deadline; an attempt that answers
 * (positively or negatively) or throws ends the loop at once.
 */

const instant = () => {
	const waits: number[] = [];
	return { waits, sleep: vi.fn(async (ms: number) => void waits.push(ms)) };
};

function scripted<T>(answers: Array<TimedAttempt<T> | Error>) {
	const deadlines: number[] = [];
	const attempt = vi.fn(async (timeoutMs: number) => {
		deadlines.push(timeoutMs);
		const next = answers.shift();
		if (!next) throw new Error('attempted more often than scripted');
		if (next instanceof Error) throw next;
		return next;
	});
	return { attempt, deadlines };
}

describe('boot retry policies', () => {
	it('keep the old first deadline, grow after it, and stay inside two minutes', () => {
		for (const [policy, firstMs] of [
			[OWNER_ONLY_ACL_RETRY_POLICY, 10_000],
			[PATH_LOOKUP_RETRY_POLICY, 5_000]
		] as const) {
			const deadlines = policy.attemptTimeoutsMs;
			expect(deadlines[0]).toBe(firstMs);
			expect(deadlines.length).toBeGreaterThanOrEqual(3);
			expect(deadlines.length).toBeLessThanOrEqual(4);
			for (let i = 1; i < deadlines.length; i++) expect(deadlines[i]).toBeGreaterThan(deadlines[i - 1]);
			expect(bootRetryBudgetMs(policy)).toBeLessThan(120_000);
		}
		expect(bootRetryBudgetMs(OWNER_ONLY_ACL_RETRY_POLICY)).toBe(107_000);
		expect(bootRetryBudgetMs(PATH_LOOKUP_RETRY_POLICY)).toBe(72_000);
	});
});

describe('retryWhileTimedOut', () => {
	it('retries a timeout with a growing deadline and backoff, then returns the answer', async () => {
		const clock = instant();
		const { attempt, deadlines } = scripted<string>([
			{ timedOut: true },
			{ timedOut: true },
			{ timedOut: false, value: 'proven' }
		]);
		const onRetry = vi.fn();

		const outcome = await retryWhileTimedOut(attempt, {
			policy: OWNER_ONLY_ACL_RETRY_POLICY,
			sleep: clock.sleep,
			onRetry
		});

		expect(outcome).toEqual({ timedOut: false, value: 'proven', attempts: 3 });
		expect(deadlines).toEqual([10_000, 20_000, 30_000]);
		expect(clock.waits).toEqual([1_000, 2_000]);
		expect(onRetry.mock.calls.map(([event]) => event)).toEqual([
			{ attempt: 1, attempts: 4, timedOutAfterMs: 10_000, waitMs: 1_000, nextTimeoutMs: 20_000 },
			{ attempt: 2, attempts: 4, timedOutAfterMs: 20_000, waitMs: 2_000, nextTimeoutMs: 30_000 }
		]);
	});

	it('believes a NEGATIVE answer at once — "not found" is never retried', async () => {
		const clock = instant();
		const { attempt } = scripted<string>([{ timedOut: false, value: 'not-found' }]);

		await expect(
			retryWhileTimedOut(attempt, { policy: PATH_LOOKUP_RETRY_POLICY, sleep: clock.sleep })
		).resolves.toEqual({ timedOut: false, value: 'not-found', attempts: 1 });
		expect(attempt).toHaveBeenCalledTimes(1);
		expect(clock.sleep).not.toHaveBeenCalled();
	});

	it('propagates a genuine failure on the attempt that threw, even after a timeout', async () => {
		const clock = instant();
		const refused = new Error('icacls exited 5: Access is denied.');
		const { attempt } = scripted<void>([{ timedOut: true }, refused]);

		await expect(
			retryWhileTimedOut(attempt, { policy: OWNER_ONLY_ACL_RETRY_POLICY, sleep: clock.sleep })
		).rejects.toBe(refused);
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it('reports timed out — with every deadline — when no attempt finished', async () => {
		const clock = instant();
		const { attempt } = scripted<void>([
			{ timedOut: true },
			{ timedOut: true },
			{ timedOut: true },
			{ timedOut: true }
		]);

		await expect(
			retryWhileTimedOut(attempt, { policy: OWNER_ONLY_ACL_RETRY_POLICY, sleep: clock.sleep })
		).resolves.toEqual({ timedOut: true, attempts: 4, deadlinesMs: [10_000, 20_000, 30_000, 40_000] });
		// No pause after the LAST attempt: the budget is exactly the documented one.
		expect(clock.waits).toEqual([1_000, 2_000, 4_000]);
	});
});

describe('ProbeTimedOutError', () => {
	it('reads as "probe timed out", never as the negative result it is not', () => {
		const error = new ProbeTimedOutError('owner-only ACL (icacls)', [10_000, 20_000]);
		expect(error.message).toMatch(/^probe timed out: owner-only ACL \(icacls\) did not finish in 2 attempts/);
		expect(error.message).toContain('deadlines 10 s, 20 s');
		expect(error.message).toMatch(/not a negative result/);
		expect(isProbeTimedOut(error)).toBe(true);
		expect(isProbeTimedOut(Object.assign(new Error('x'), { code: error.code }))).toBe(true);
		expect(isProbeTimedOut(new Error('icacls exited 5'))).toBe(false);
		expect(describeProbeTimeout('PATH lookup', [5_000])).toMatch(
			/^probe timed out: PATH lookup did not finish in 1 attempt /
		);
	});
});
