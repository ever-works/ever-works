import { describe, expect, it, vi } from 'vitest';
import { BullMqWorkerHostFactory } from '../bullmq-worker-host-factory.js';
import type { BullMqDeps, BullMqJobView, BullMqQueueAdapter, BullMqWorkerAdapter } from '../bullmq-types.js';

class UnusedFakeQueue implements BullMqQueueAdapter {
	async add() {
		return { id: 'x' };
	}
	async close() {
		// noop
	}
}

class FakeWorker implements BullMqWorkerAdapter {
	static instances: FakeWorker[] = [];
	closed = false;

	constructor(
		public readonly queueName: string,
		public readonly processor: (job: BullMqJobView) => Promise<unknown>,
		public readonly opts: Readonly<Record<string, unknown>>
	) {
		FakeWorker.instances.push(this);
	}
	on() {
		// noop
	}
	async close() {
		this.closed = true;
	}
}

const makeDeps = (): BullMqDeps => ({
	Queue: UnusedFakeQueue as unknown as BullMqDeps['Queue'],
	Worker: FakeWorker as unknown as BullMqDeps['Worker']
});

describe('BullMqWorkerHostFactory', () => {
	it('register accumulates registrations and counts them', () => {
		FakeWorker.instances = [];
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		f.register('q1', async () => undefined);
		f.register('q2', async () => undefined, { concurrency: 4 });
		expect(f.registrationCount).toBe(2);
		expect(FakeWorker.instances).toHaveLength(0); // nothing constructed yet
	});

	it('start constructs one Worker per registration with connection + prefix + concurrency', async () => {
		FakeWorker.instances = [];
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r', prefix: 'ew' });
		f.register('q1', async () => undefined, { concurrency: 7 });
		f.register('q2', async () => undefined);
		await f.start({ concurrency: 3 });
		expect(FakeWorker.instances.map((w) => w.queueName)).toEqual(['q1', 'q2']);
		expect(FakeWorker.instances[0].opts).toMatchObject({ connection: 'r', prefix: 'ew', concurrency: 7 });
		expect(FakeWorker.instances[1].opts).toMatchObject({ connection: 'r', prefix: 'ew', concurrency: 3 });
	});

	it('start returns a handle whose stop() closes every worker (idempotent)', async () => {
		FakeWorker.instances = [];
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		f.register('q1', async () => undefined);
		f.register('q2', async () => undefined);
		const handle = await f.start();
		await handle.stop();
		expect(FakeWorker.instances.every((w) => w.closed)).toBe(true);
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it('register after start throws', async () => {
		FakeWorker.instances = [];
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		f.register('q1', async () => undefined);
		await f.start();
		expect(() => f.register('q2', async () => undefined)).toThrow(/cannot register/);
	});

	it('start called twice throws', async () => {
		FakeWorker.instances = [];
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		f.register('q1', async () => undefined);
		await f.start();
		await expect(f.start()).rejects.toThrow(/start\(\) called twice/);
	});

	it('respects an AbortSignal — abort triggers stopAll', async () => {
		FakeWorker.instances = [];
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		f.register('q1', async () => undefined);
		const ctrl = new AbortController();
		await f.start({ signal: ctrl.signal });
		ctrl.abort();
		// stopAll is async; wait a microtask.
		await new Promise((r) => setImmediate(r));
		expect(FakeWorker.instances[0].closed).toBe(true);
	});

	it('handler is invoked with the bullmq job shape', async () => {
		FakeWorker.instances = [];
		const handler = vi.fn(async (job: BullMqJobView) => ({ ok: true, name: job.name }));
		const f = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		f.register('q1', handler);
		await f.start();
		const w = FakeWorker.instances[0];
		await w.processor({ id: 'j1', name: 'q1', data: { ping: 1 } });
		expect(handler).toHaveBeenCalledWith({ id: 'j1', name: 'q1', data: { ping: 1 } });
	});
});
