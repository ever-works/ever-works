import { describe, expect, it, vi } from 'vitest';

import type { ManagedAgentsEvent } from '../types.js';
import { runManagedSessions } from './fan-out.js';
import type { AnthropicManagedAgentsClient } from './managed-agents-client.js';

function agentMessageEvent(id: string, text: string): ManagedAgentsEvent {
	return { id, type: 'agent.message', content: [{ type: 'text', text }] };
}

function createClientStub(overrides: Partial<Record<string, unknown>> = {}) {
	let sessionCounter = 0;

	const stub = {
		createSession: vi.fn().mockImplementation(async () => {
			sessionCounter += 1;
			return { id: `session_${sessionCounter}`, status: 'running' };
		}),
		waitForSessionIdle: vi.fn().mockImplementation(async (sessionId: string) => ({
			id: sessionId,
			status: 'idle',
			usage: { input_tokens: 100, output_tokens: 50, list_cost_usd: 1.25 }
		})),
		listAllEvents: vi
			.fn()
			.mockImplementation(async (sessionId: string) => [
				agentMessageEvent(`${sessionId}_e1`, `output for ${sessionId}`)
			]),
		archiveSession: vi.fn().mockResolvedValue(undefined),
		...overrides
	};

	return stub;
}

type ClientStub = ReturnType<typeof createClientStub>;

function asClient(stub: ClientStub): AnthropicManagedAgentsClient {
	return stub as unknown as AnthropicManagedAgentsClient;
}

function prompts(count: number) {
	return Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, prompt: `prompt ${i + 1}` }));
}

const BASE_OPTIONS = {
	agentId: 'agent_1',
	environmentId: 'env_1',
	pollIntervalMs: 1000
};

describe('runManagedSessions', () => {
	it('returns an empty array for an empty prompt list', async () => {
		const stub = createClientStub();
		expect(await runManagedSessions(asClient(stub), { ...BASE_OPTIONS, prompts: [] })).toEqual([]);
		expect(stub.createSession).not.toHaveBeenCalled();
	});

	it('runs every prompt and returns results in prompt order', async () => {
		const stub = createClientStub();

		const results = await runManagedSessions(asClient(stub), { ...BASE_OPTIONS, prompts: prompts(4) });

		expect(results.map((r) => r.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
		expect(results.every((r) => r.status === 'completed')).toBe(true);
		expect(results[0].output).toContain('output for');
		expect(results[0].tokens).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
		expect(results[0].costUsd).toBe(1.25);
		expect(stub.createSession).toHaveBeenCalledTimes(4);
	});

	it('never runs more than `concurrency` sessions at once', async () => {
		let active = 0;
		let peakActive = 0;
		const stub = createClientStub({
			waitForSessionIdle: vi.fn().mockImplementation(async (sessionId: string) => {
				active += 1;
				peakActive = Math.max(peakActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
				return { id: sessionId, status: 'idle' };
			})
		});

		await runManagedSessions(asClient(stub), { ...BASE_OPTIONS, prompts: prompts(7), concurrency: 2 });

		expect(peakActive).toBeLessThanOrEqual(2);
		expect(stub.createSession).toHaveBeenCalledTimes(7);
	});

	it('passes the per-session budget and initial prompt to session creation', async () => {
		const stub = createClientStub();

		await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: [{ id: 'p1', prompt: 'generate variant one', title: 'Variant 1' }],
			perSessionBudgetUsd: 2.5,
			resources: [{ type: 'file', file_id: 'file_1', mount_path: '/mnt/seed.json' }],
			agentOverrides: { model: 'claude-sonnet-4-6' }
		});

		expect(stub.createSession).toHaveBeenCalledWith({
			agentId: 'agent_1',
			environmentId: 'env_1',
			title: 'Variant 1',
			resources: [{ type: 'file', file_id: 'file_1', mount_path: '/mnt/seed.json' }],
			budgetUsd: 2.5,
			initialMessages: ['generate variant one'],
			agentOverrides: { model: 'claude-sonnet-4-6' }
		});
	});

	it('collects failures without aborting sibling sessions', async () => {
		const stub = createClientStub({
			waitForSessionIdle: vi.fn().mockImplementation(async (sessionId: string) => {
				if (sessionId === 'session_2') {
					throw new Error('budget exhausted');
				}
				return { id: sessionId, status: 'idle', usage: { input_tokens: 10, output_tokens: 5 } };
			})
		});

		const results = await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: prompts(3),
			concurrency: 1
		});

		expect(results.map((r) => r.status)).toEqual(['completed', 'failed', 'completed']);
		expect(results[1].error).toContain('budget exhausted');
		expect(results[1].sessionId).toBe('session_2');
		expect(stub.createSession).toHaveBeenCalledTimes(3);
	});

	it('archives every created session, including failed ones', async () => {
		const stub = createClientStub({
			waitForSessionIdle: vi.fn().mockImplementation(async (sessionId: string) => {
				if (sessionId === 'session_1') {
					throw new Error('boom');
				}
				return { id: sessionId, status: 'idle' };
			})
		});

		await runManagedSessions(asClient(stub), { ...BASE_OPTIONS, prompts: prompts(2), concurrency: 1 });

		expect(stub.archiveSession).toHaveBeenCalledTimes(2);
		expect(stub.archiveSession).toHaveBeenCalledWith('session_1');
		expect(stub.archiveSession).toHaveBeenCalledWith('session_2');
	});

	it('does not archive sessions when archiveSessions is false', async () => {
		const stub = createClientStub();

		await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: prompts(1),
			archiveSessions: false
		});

		expect(stub.archiveSession).not.toHaveBeenCalled();
	});

	it('a failed archive is logged but does not fail the result', async () => {
		const warn = vi.fn();
		const stub = createClientStub({
			archiveSession: vi.fn().mockRejectedValue(new Error('archive failed'))
		});

		const results = await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: prompts(1),
			logger: { warn }
		});

		expect(results[0].status).toBe('completed');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive'));
	});

	it('derives the poll-attempt bound from timeoutMs', async () => {
		const stub = createClientStub();

		await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: prompts(1),
			timeoutMs: 10000,
			pollIntervalMs: 1000
		});

		expect(stub.waitForSessionIdle).toHaveBeenCalledWith(
			'session_1',
			expect.objectContaining({ maxPollAttempts: 10, pollIntervalMs: 1000 })
		);
	});

	it('reports prompts as cancelled when the signal is already aborted', async () => {
		const stub = createClientStub();
		const controller = new AbortController();
		controller.abort();

		const results = await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: prompts(2),
			signal: controller.signal
		});

		expect(results.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
		expect(stub.createSession).not.toHaveBeenCalled();
	});

	it('marks in-flight failures as cancelled when the signal aborts mid-run', async () => {
		const controller = new AbortController();
		const stub = createClientStub({
			waitForSessionIdle: vi.fn().mockImplementation(async () => {
				controller.abort();
				throw new Error('Pipeline cancelled');
			})
		});

		const results = await runManagedSessions(asClient(stub), {
			...BASE_OPTIONS,
			prompts: prompts(2),
			concurrency: 1,
			signal: controller.signal
		});

		expect(results[0].status).toBe('cancelled');
		expect(results[1].status).toBe('cancelled');
	});
});
