import { describe, expect, it, vi } from 'vitest';
import { BullMqDispatcherFactory } from '../bullmq-dispatcher-factory.js';
import type { BullMqDeps, BullMqQueueAdapter, BullMqWorkerAdapter } from '../bullmq-types.js';

/**
 * The factory accepts injected `Queue` / `Worker` constructors so the
 * plugin package never hard-depends on `bullmq`. Tests stand up a
 * minimal in-memory queue stub that records every `add` call.
 */

interface QueueCall {
	name: string;
	data: unknown;
	opts?: Readonly<Record<string, unknown>>;
}

class FakeQueue implements BullMqQueueAdapter {
	static instances: FakeQueue[] = [];
	readonly calls: QueueCall[] = [];
	readonly jobs = new Map<string, { remove: () => Promise<void>; getState: () => Promise<string> }>();
	closed = false;
	private nextId = 1;

	constructor(
		public readonly queueName: string,
		public readonly opts: Readonly<Record<string, unknown>>
	) {
		FakeQueue.instances.push(this);
	}

	async add(name: string, data: unknown, opts?: Readonly<Record<string, unknown>>): Promise<{ id?: string | null }> {
		this.calls.push({ name, data, opts });
		const id = `job_${this.nextId++}`;
		this.jobs.set(id, {
			remove: vi.fn(async () => {
				this.jobs.delete(id);
			}),
			getState: vi.fn(async () => 'waiting')
		});
		return { id };
	}

	async getJob(id: string) {
		return this.jobs.get(id);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class UnusedFakeWorker implements BullMqWorkerAdapter {
	on(): void {
		// noop
	}
	async close(): Promise<void> {
		// noop
	}
}

const makeDeps = (): BullMqDeps => ({
	// vitest types disagree about constructor mapping; cast through unknown.
	Queue: FakeQueue as unknown as BullMqDeps['Queue'],
	Worker: UnusedFakeWorker as unknown as BullMqDeps['Worker']
});

describe('BullMqDispatcherFactory', () => {
	it('forQueue memoises the Queue per name', () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: { fake: true } });
		factory.forQueue('q1');
		factory.forQueue('q1');
		factory.forQueue('q2');
		expect(FakeQueue.instances.map((q) => q.queueName)).toEqual(['q1', 'q2']);
		expect(factory.queueCount).toBe(2);
	});

	it('passes connection + prefix + defaultJobOptions to the Queue ctor', () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), {
			connection: { fake: 'redis' },
			prefix: 'ew',
			defaultJobOptions: { attempts: 3 }
		});
		factory.forQueue('q1');
		expect(FakeQueue.instances[0].opts).toEqual({
			connection: { fake: 'redis' },
			prefix: 'ew',
			defaultJobOptions: { attempts: 3 }
		});
	});

	it('omits prefix when not provided', () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		factory.forQueue('q1');
		expect('prefix' in FakeQueue.instances[0].opts).toBe(false);
	});

	it('dispatch enqueues with per-call opts and returns bullmq job id', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const d = factory.forQueue('q1');
		const id = await d.dispatch('q1', { hello: 'world' }, { jobId: 'idem-1', attempts: 5 });
		expect(id).toBe('job_1');
		const recorded = FakeQueue.instances[0].calls[0];
		expect(recorded.name).toBe('q1');
		expect(recorded.data).toEqual({ hello: 'world' });
		expect(recorded.opts).toEqual({ jobId: 'idem-1', attempts: 5 });
	});

	it('dispatch returns null when the queue returns no id', async () => {
		FakeQueue.instances = [];
		class NullIdQueue extends FakeQueue {
			async add() {
				return { id: null };
			}
		}
		const factory = new BullMqDispatcherFactory(
			{
				Queue: NullIdQueue as unknown as BullMqDeps['Queue'],
				Worker: UnusedFakeWorker as unknown as BullMqDeps['Worker']
			},
			{ connection: 'r' }
		);
		const id = await factory.forQueue('q1').dispatch('q1', {});
		expect(id).toBeNull();
	});

	it('cancel iterates queues and returns true when removed', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const dA = factory.forQueue('qA');
		factory.forQueue('qB');
		const idA = await dA.dispatch('qA', {});
		expect(idA).not.toBeNull();
		const ok = await factory.cancel(idA as string);
		expect(ok).toBe(true);
		const ok2 = await factory.cancel('does-not-exist');
		expect(ok2).toBe(false);
	});

	it('close closes every queue and clears the cache', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		factory.forQueue('qA');
		factory.forQueue('qB');
		expect(factory.queueCount).toBe(2);
		await factory.close();
		expect(factory.queueCount).toBe(0);
		expect(FakeQueue.instances.every((q) => q.closed)).toBe(true);
	});
});
