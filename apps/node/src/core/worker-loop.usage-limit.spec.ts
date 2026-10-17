import { describe, expect, it, vi } from 'vitest';
import type { FleetJobKind, FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT } from '@ever-works/contracts';
import { WorkerLoop, type JobLeaseCapableClient } from './worker-loop';
import type { Scheduler } from './heartbeat';
import { describeWorkerHealth } from './worker-health';

/**
 * Fleet usage limits on the node (prod, 2026-10-17): a model CLI that is out
 * of quota must stop this machine leasing THAT CLI's agent work until the
 * reset — and say so on the beat — instead of failing one job every thirty
 * seconds until the Agent is halted.
 */

const NOW = Date.parse('2026-10-17T15:27:00Z');
const RESET = '2026-10-19T01:01:00.000Z';

/** Timers that only fire when the test says so. */
function manualScheduler(): Scheduler {
	return {
		setTimeout: () => 0,
		clearTimeout: () => undefined
	};
}

interface LeaseRequest {
	excludeKinds?: FleetJobKind[];
}

function recordingClient(script: FleetJobView[][]): JobLeaseCapableClient & {
	requests: LeaseRequest[];
	complete: ReturnType<typeof vi.fn>;
} {
	const requests: LeaseRequest[] = [];
	let index = 0;
	const complete = vi.fn(async () => true);
	return {
		requests,
		complete,
		heartbeat: vi.fn(async () => null),
		lease: async (request: LeaseRequest) => {
			requests.push({ ...(request.excludeKinds ? { excludeKinds: [...request.excludeKinds] } : {}) });
			const next = script[Math.min(index, script.length - 1)] ?? [];
			index += 1;
			return next;
		}
	} as never;
}

function agentJob(id: string, provider: string): FleetJobView {
	return {
		id,
		kind: 'agent-task',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [provider],
		payload: { taskId: 'task-13', runId: 'run-13', execution: { provider } },
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

const usageLimitResult = {
	status: 'failed',
	taskId: 'task-13',
	runId: 'run-13',
	failureKind: FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT,
	modelUsageLimit: {
		provider: 'claude-code',
		window: 'weekly',
		resetsAt: '2026-10-19T01:00:00.000Z',
		retryAfter: RESET,
		message: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)"
	}
};

describe('WorkerLoop — model usage limits', () => {
	it('stops leasing agent-task work once its only CLI is out of quota, and says so on the beat', async () => {
		let now = NOW;
		const client = recordingClient([[agentJob('job-1', 'claude-code')], [], []]);
		const loop = new WorkerLoop({
			client,
			scheduler: manualScheduler(),
			now: () => now,
			modelProviders: () => ['claude-code']
		});
		loop.register('agent-task', async () => usageLimitResult);

		await loop.start();
		await vi.waitFor(() => expect(client.complete).toHaveBeenCalledTimes(1));
		// The run's verdict goes up as reported — the PLATFORM parks it.
		expect(client.complete).toHaveBeenCalledWith('job-1', { success: true, result: usageLimitResult });
		expect(loop.getState().modelThrottles).toEqual([
			{
				provider: 'claude-code',
				window: 'weekly',
				until: RESET,
				reason: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)"
			}
		]);

		await vi.waitFor(() => expect(loop.getState().activeJobIds).toEqual([]));
		await loop.tick();
		expect(client.requests.at(-1)?.excludeKinds).toEqual(['agent-task']);
		expect(describeWorkerHealth(loop.getState())).toEqual({
			workerState: 'throttled',
			workerStateReason: `claude-code: weekly limit until ${RESET}`
		});

		// After the reset the lane leases agent work again.
		now = Date.parse(RESET) + 1;
		await loop.tick();
		expect(client.requests.at(-1)?.excludeKinds).toBeUndefined();
		expect(loop.getState().modelThrottles).toBeUndefined();
		expect(describeWorkerHealth(loop.getState())?.workerState).toBe('idle');
		await loop.stop();
	});

	it('keeps leasing when another CLI is still available, and refuses the throttled CLI’s job without starting it', async () => {
		const client = recordingClient([[], [agentJob('job-claude', 'claude-code'), agentJob('job-codex', 'codex')], []]);
		const loop = new WorkerLoop({
			client,
			scheduler: manualScheduler(),
			now: () => NOW,
			concurrency: 2,
			modelProviders: () => ['claude-code', 'codex']
		});
		const executor = vi.fn(async (job: FleetJobView) => ({ ran: job.id }));
		loop.register('agent-task', executor);
		loop.noteModelUsageLimit({
			provider: 'claude-code',
			window: 'weekly',
			retryAfter: RESET,
			message: "You've hit your weekly limit"
		});

		await loop.start();
		await loop.tick();
		expect(client.requests.at(-1)?.excludeKinds).toBeUndefined();
		await vi.waitFor(() => expect(client.complete).toHaveBeenCalledTimes(2));

		// The codex job ran; the claude-code one never reached the executor.
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor.mock.calls[0]?.[0]?.id).toBe('job-codex');
		expect(client.complete).toHaveBeenCalledWith(
			'job-claude',
			expect.objectContaining({
				success: true,
				result: expect.objectContaining({
					failureKind: FLEET_JOB_FAILURE_KIND_MODEL_USAGE_LIMIT,
					taskId: 'task-13',
					runId: 'run-13',
					modelUsageLimit: expect.objectContaining({ provider: 'claude-code', retryAfter: RESET })
				})
			})
		);
		await loop.stop();
	});

	it('never lets an earlier reset shorten a later one, and ignores a reset already past', () => {
		const loop = new WorkerLoop({ client: recordingClient([[]]), scheduler: manualScheduler(), now: () => NOW });
		loop.noteModelUsageLimit({ provider: 'codex', window: 'usage', retryAfter: RESET, message: 'a' });
		loop.noteModelUsageLimit({ provider: 'codex', window: 'session', retryAfter: '2026-10-17T18:00:00.000Z', message: 'b' });
		loop.noteModelUsageLimit({ provider: 'claude-code', window: 'rate', retryAfter: '2026-10-17T15:00:00.000Z', message: 'c' });
		expect(loop.activeModelThrottles()).toEqual([{ provider: 'codex', window: 'usage', until: RESET, reason: 'a' }]);
	});

	it('adopts the platform throttles after a restart and lifts one the owner cleared', () => {
		let now = NOW;
		const loop = new WorkerLoop({ client: recordingClient([[]]), scheduler: manualScheduler(), now: () => now });

		// A fresh daemon learns from the beat that its CLI is still out.
		loop.syncModelThrottles([{ provider: 'claude-code', window: 'weekly', until: RESET, reason: 'weekly' }]);
		expect(loop.activeModelThrottles()).toEqual([
			{ provider: 'claude-code', window: 'weekly', until: RESET, reason: 'weekly' }
		]);

		// The owner pressed "clear limit now": the beat no longer lists it.
		now += 5 * 60_000;
		loop.syncModelThrottles([]);
		expect(loop.activeModelThrottles()).toEqual([]);
	});

	it('keeps a throttle it JUST recorded when a beat answered before the platform did', () => {
		let now = NOW;
		const loop = new WorkerLoop({ client: recordingClient([[]]), scheduler: manualScheduler(), now: () => now });
		loop.noteModelUsageLimit({ provider: 'claude-code', window: 'weekly', retryAfter: RESET, message: 'x' });
		now += 10_000;
		loop.syncModelThrottles([]);
		expect(loop.activeModelThrottles()).toHaveLength(1);
		// An API older than the field says nothing at all: nothing changes.
		now += 10 * 60_000;
		loop.syncModelThrottles(undefined);
		expect(loop.activeModelThrottles()).toHaveLength(1);
	});
});
