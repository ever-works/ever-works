import { describe, expect, it } from 'vitest';
import type { JobEnqueueOptions } from '@ever-works/plugin';
import { mapEnqueueOptions } from '../trigger-enqueue-options.js';
import { TriggerDispatcherFactory } from '../trigger-dispatcher-factory.js';
import type { TriggerClient, TriggerRunHandle, TriggerRunRecord, TriggerTaskOptions } from '../trigger-types.js';

describe('mapEnqueueOptions (EW-742 P4 T31 Trigger.dev stamping)', () => {
	it('idempotencyKey → idempotencyKey', () => {
		expect(mapEnqueueOptions({ idempotencyKey: 'idem-1' })).toEqual({
			options: { idempotencyKey: 'idem-1' }
		});
	});

	it('tenantId → metadata.tenantId', () => {
		expect(mapEnqueueOptions({ tenantId: 't-acme' })).toEqual({
			options: { metadata: { tenantId: 't-acme' } }
		});
	});

	it('concurrencyKey → concurrencyKey (SDK native)', () => {
		expect(mapEnqueueOptions({ concurrencyKey: 'work-7' })).toEqual({
			options: { concurrencyKey: 'work-7' }
		});
	});

	it('tags → tags (SDK native)', () => {
		expect(mapEnqueueOptions({ tags: ['kb', 'embed'] })).toEqual({
			options: { tags: ['kb', 'embed'] }
		});
	});

	it('maxDurationSeconds → maxDuration', () => {
		expect(mapEnqueueOptions({ maxDurationSeconds: 600 })).toEqual({
			options: { maxDuration: 600 }
		});
	});

	it('machineHint → machine (passed through verbatim)', () => {
		expect(mapEnqueueOptions({ machineHint: 'small-2x' })).toEqual({
			options: { machine: 'small-2x' }
		});
	});

	it('empty input returns empty options', () => {
		expect(mapEnqueueOptions({})).toEqual({ options: {} });
	});

	it('all fields together stamp the full Trigger.dev options bag', () => {
		const opts: JobEnqueueOptions = {
			idempotencyKey: 'idem-A',
			tenantId: 'tenant-A',
			concurrencyKey: 'work-A',
			tags: ['kb'],
			maxDurationSeconds: 600,
			machineHint: 'medium-1x'
		};
		expect(mapEnqueueOptions(opts)).toEqual({
			options: {
				idempotencyKey: 'idem-A',
				concurrencyKey: 'work-A',
				tags: ['kb'],
				maxDuration: 600,
				machine: 'medium-1x',
				metadata: { tenantId: 'tenant-A' }
			}
		});
	});
});

interface TriggerCall {
	readonly taskId: string;
	readonly payload: unknown;
	readonly options?: TriggerTaskOptions;
}

class FakeTrigger implements TriggerClient {
	calls: TriggerCall[] = [];
	private nextId = 1;
	readonly tasks = {
		trigger: async (taskId: string, payload: unknown, options?: TriggerTaskOptions): Promise<TriggerRunHandle> => {
			this.calls.push({ taskId, payload, options });
			return { id: `run_${this.nextId++}` };
		}
	};
	readonly runs = {
		cancel: async (): Promise<unknown> => undefined,
		retrieve: async (runId: string): Promise<TriggerRunRecord> => ({
			id: runId,
			status: 'EXECUTING'
		})
	};
}

describe('TriggerDispatcherFactory.enqueue (EW-742 P4 T31)', () => {
	it('stamps translated options onto tasks.trigger and returns the run id', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		const id = await factory.enqueue(
			'kb-embed-document',
			{ workId: 'w7' },
			{ idempotencyKey: 'idem-1', tenantId: 't-acme', tags: ['kb'] }
		);
		expect(id).toBe('run_1');
		expect(client.calls[0].taskId).toBe('kb-embed-document');
		expect(client.calls[0].payload).toEqual({ workId: 'w7' });
		expect(client.calls[0].options).toEqual({
			idempotencyKey: 'idem-1',
			tags: ['kb'],
			metadata: { tenantId: 't-acme' }
		});
	});

	it('applies defaultTaskQueue when neither mapped nor extra override queue', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({
			client,
			defaultTaskQueue: 'platform-default'
		});
		await factory.enqueue('evt', { x: 1 }, { idempotencyKey: 'idem' });
		expect(client.calls[0].options).toEqual({
			queue: 'platform-default',
			idempotencyKey: 'idem'
		});
	});

	it('extraOptions shallow-merge OVER mapped translation (operator wins)', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		await factory.enqueue(
			'evt',
			{},
			{ idempotencyKey: 'idem-platform', machineHint: 'small-1x' },
			{ machine: 'large-1x' }
		);
		expect(client.calls[0].options).toEqual({
			idempotencyKey: 'idem-platform',
			machine: 'large-1x'
		});
	});

	it('dispatch() path is unchanged', async () => {
		const client = new FakeTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		await factory.dispatch('evt', { hello: 'world' });
		expect(client.calls[0]).toEqual({
			taskId: 'evt',
			payload: { hello: 'world' },
			options: {}
		});
	});
});
