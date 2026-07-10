import { describe, expect, it } from 'vitest';
import type { JobEnqueueOptions } from '@ever-works/plugin';
import { BullMqDispatcherFactory } from '../bullmq-dispatcher-factory.js';
import type { BullMqDeps, BullMqQueueAdapter, BullMqWorkerAdapter } from '../bullmq-types.js';

interface QueueCall {
	name: string;
	data: unknown;
	opts?: Readonly<Record<string, unknown>>;
}

class FakeQueue implements BullMqQueueAdapter {
	static instances: FakeQueue[] = [];
	readonly calls: QueueCall[] = [];
	private nextId = 1;
	constructor(
		public readonly name: string,
		public readonly ctorOpts: Readonly<Record<string, unknown>>
	) {
		FakeQueue.instances.push(this);
	}
	async add(name: string, data: unknown, opts?: Readonly<Record<string, unknown>>) {
		this.calls.push({ name, data, opts });
		return { id: `j${this.nextId++}` };
	}
	async close() {
		// noop
	}
}

class UnusedWorker implements BullMqWorkerAdapter {
	on() {
		// noop
	}
	async close() {
		// noop
	}
}

const makeDeps = (): BullMqDeps => ({
	Queue: FakeQueue as unknown as BullMqDeps['Queue'],
	Worker: UnusedWorker as unknown as BullMqDeps['Worker']
});

describe('BullMqDispatcher.enqueue (EW-742 P4 T31)', () => {
	it('translates JobEnqueueOptions onto BullMQ JobsOptions on the add call', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const d = factory.forQueue('kb-embed');
		const enqueueOpts: JobEnqueueOptions = {
			idempotencyKey: 'idem-1',
			tenantId: 't-acme',
			concurrencyKey: 'work-7',
			tags: ['kb'],
			maxDurationSeconds: 600
		};
		const id = await d.enqueue('kb-embed', { workId: 'w7' }, enqueueOpts);
		expect(id).toBe('j1');
		expect(FakeQueue.instances[0].calls[0]).toEqual({
			name: 'kb-embed',
			data: { workId: 'w7' },
			opts: {
				jobId: 'idem-1',
				tenantId: 't-acme',
				concurrencyKey: 'work-7',
				tags: ['kb'],
				maxDurationSeconds: 600
			}
		});
	});

	it('extraOpts shallow-merge OVER the translation (operator wins on conflict)', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const d = factory.forQueue('kb-embed');
		await d.enqueue(
			'kb-embed',
			{ x: 1 },
			{ idempotencyKey: 'idem-from-platform' },
			{ jobId: 'idem-from-operator', attempts: 5 }
		);
		expect(FakeQueue.instances[0].calls[0].opts).toEqual({
			jobId: 'idem-from-operator',
			attempts: 5
		});
	});

	it('dispatch() path is unchanged — no enqueueOptions translation', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const d = factory.forQueue('kb-embed');
		await d.dispatch('kb-embed', { x: 1 }, { jobId: 'raw' });
		expect(FakeQueue.instances[0].calls[0].opts).toEqual({ jobId: 'raw' });
	});
});
