import { describe, expect, it, vi } from 'vitest';
import { TriggerDispatcherFactory } from '../trigger-dispatcher-factory.js';
import type {
	TriggerClient,
	TriggerRunHandle,
	TriggerRunRecord,
	TriggerTaskOptions
} from '../trigger-types.js';

interface TriggerCall {
	readonly taskId: string;
	readonly payload: unknown;
	readonly options?: TriggerTaskOptions;
}

class FakeTrigger implements TriggerClient {
	triggerCalls: TriggerCall[] = [];
	cancelCalls: string[] = [];
	cancelShouldThrow = false;
	private nextId = 1;

	readonly tasks = {
		trigger: async (
			taskId: string,
			payload: unknown,
			options?: TriggerTaskOptions
		): Promise<TriggerRunHandle> => {
			this.triggerCalls.push({ taskId, payload, options });
			return { id: `run_${this.nextId++}` };
		}
	};

	readonly runs = {
		cancel: async (runId: string): Promise<unknown> => {
			this.cancelCalls.push(runId);
			if (this.cancelShouldThrow) throw new Error('boom');
			return undefined;
		},
		retrieve: async (runId: string): Promise<TriggerRunRecord> => ({
			id: runId,
			status: 'EXECUTING'
		})
	};
}

describe('TriggerDispatcherFactory', () => {
	it('dispatch returns the run id and forwards the payload', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		const id = await factory.dispatch('kb-embed-document', { workId: 'w1' });
		expect(id).toBe('run_1');
		expect(client.triggerCalls).toEqual([
			{ taskId: 'kb-embed-document', payload: { workId: 'w1' }, options: {} }
		]);
	});

	it('dispatch applies defaultTaskQueue when no extra options', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({
			client,
			defaultTaskQueue: 'platform-default'
		});
		await factory.dispatch('kb-embed-document', { workId: 'w1' });
		expect(client.triggerCalls[0].options).toEqual({ queue: 'platform-default' });
	});

	it('dispatch extra options shallow-merge over defaultTaskQueue', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({
			client,
			defaultTaskQueue: 'platform-default'
		});
		await factory.dispatch(
			'kb-embed-document',
			{ workId: 'w1' },
			{ queue: 'override-q', tags: ['kb'] }
		);
		expect(client.triggerCalls[0].options).toEqual({
			queue: 'override-q',
			tags: ['kb']
		});
	});

	it('dispatch returns null when SDK handle has no id', async () => {
		const client = new FakeTrigger();
		client.tasks.trigger = vi.fn(async () => ({}) as TriggerRunHandle);
		const factory = new TriggerDispatcherFactory({ client });
		await expect(factory.dispatch('t', {})).resolves.toBeNull();
	});

	it('cancel returns true on success and forwards the run id', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		await expect(factory.cancel('run_42')).resolves.toBe(true);
		expect(client.cancelCalls).toEqual(['run_42']);
	});

	it('cancel returns false when the SDK throws', async () => {
		const client = new FakeTrigger();
		client.cancelShouldThrow = true;
		const factory = new TriggerDispatcherFactory({ client });
		await expect(factory.cancel('run_42')).resolves.toBe(false);
	});

	it('exposes the bound client read-only', () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		expect(factory.client).toBe(client);
	});
});
