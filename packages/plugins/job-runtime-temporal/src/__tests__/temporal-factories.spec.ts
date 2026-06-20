import { describe, expect, it, vi } from 'vitest';
import { TemporalDispatcherFactory } from '../temporal-dispatcher-factory.js';
import { TemporalWorkerHostFactory } from '../temporal-worker-host-factory.js';
import type {
	TemporalStartWorkflowOptions,
	TemporalWorker,
	TemporalWorkflowClient,
	TemporalWorkflowHandle
} from '../temporal-types.js';

class FakeHandle implements TemporalWorkflowHandle {
	cancelCount = 0;
	constructor(public readonly workflowId: string, public readonly statusName: string = 'RUNNING') {}
	async cancel(): Promise<void> {
		this.cancelCount += 1;
	}
	async describe() {
		return { status: { name: this.statusName } };
	}
}

class FakeClient implements TemporalWorkflowClient {
	startCalls: { type: string; options: TemporalStartWorkflowOptions }[] = [];
	private handles = new Map<string, FakeHandle>();

	constructor(public readonly statusByWorkflow: Record<string, string> = {}) {}

	async start(workflowType: string, options: TemporalStartWorkflowOptions): Promise<TemporalWorkflowHandle> {
		this.startCalls.push({ type: workflowType, options });
		const h = new FakeHandle(options.workflowId, this.statusByWorkflow[options.workflowId] ?? 'RUNNING');
		this.handles.set(options.workflowId, h);
		return h;
	}

	getHandle(workflowId: string): TemporalWorkflowHandle {
		let h = this.handles.get(workflowId);
		if (!h) {
			h = new FakeHandle(workflowId, this.statusByWorkflow[workflowId] ?? 'RUNNING');
			this.handles.set(workflowId, h);
		}
		return h;
	}
}

describe('TemporalDispatcherFactory', () => {
	it('start merges defaultWorkflowOptions and defaultTaskQueue', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({
			client,
			defaultTaskQueue: 'ew',
			defaultWorkflowOptions: { workflowExecutionTimeout: '1h' }
		});
		await factory.start('kbEmbedWorkflow', { workflowId: 'wf-1', args: [{ x: 1 }] });
		expect(client.startCalls[0]).toEqual({
			type: 'kbEmbedWorkflow',
			options: {
				workflowExecutionTimeout: '1h',
				workflowId: 'wf-1',
				args: [{ x: 1 }],
				taskQueue: 'ew'
			}
		});
	});

	it('per-call taskQueue and options override defaults', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({
			client,
			defaultTaskQueue: 'ew',
			defaultWorkflowOptions: { workflowExecutionTimeout: '1h' }
		});
		await factory.start('wf', {
			workflowId: 'wf-2',
			taskQueue: 'tenant-acme',
			workflowExecutionTimeout: '15m'
		});
		expect(client.startCalls[0].options.taskQueue).toBe('tenant-acme');
		expect(client.startCalls[0].options.workflowExecutionTimeout).toBe('15m');
	});

	it('start throws when no taskQueue is available', async () => {
		const factory = new TemporalDispatcherFactory({ client: new FakeClient() });
		await expect(factory.start('wf', { workflowId: 'x' })).rejects.toThrow(/no taskQueue/);
	});

	it('cancel returns true when handle.cancel resolves; false on throw', async () => {
		const client = new FakeClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		await factory.start('wf', { workflowId: 'wf-1' });
		await expect(factory.cancel('wf-1')).resolves.toBe(true);

		client.getHandle = vi.fn(() => {
			throw new Error('boom');
		});
		await expect(factory.cancel('wf-1')).resolves.toBe(false);
	});

	it('describe returns the Temporal status name or null on error', async () => {
		const client = new FakeClient({ 'wf-1': 'COMPLETED' });
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		await factory.start('wf', { workflowId: 'wf-1' });
		await expect(factory.describe('wf-1')).resolves.toBe('COMPLETED');

		client.getHandle = vi.fn(() => {
			throw new Error('boom');
		});
		await expect(factory.describe('any')).resolves.toBeNull();
	});
});

describe('TemporalWorkerHostFactory', () => {
	class FakeWorker implements TemporalWorker {
		static instances: FakeWorker[] = [];
		runResolver: (() => void) | null = null;
		runPromise: Promise<void>;
		shutdownCount = 0;
		constructor(public readonly taskQueue: string) {
			FakeWorker.instances.push(this);
			this.runPromise = new Promise<void>((resolve) => {
				this.runResolver = resolve;
			});
		}
		run() {
			return this.runPromise;
		}
		async shutdown() {
			this.shutdownCount += 1;
			this.runResolver?.();
		}
	}

	it('register accumulates specs without constructing workers', () => {
		FakeWorker.instances = [];
		const f = new TemporalWorkerHostFactory();
		f.register({ taskQueue: 'ew', build: async () => new FakeWorker('ew') });
		expect(f.registrationCount).toBe(1);
		expect(FakeWorker.instances).toHaveLength(0);
	});

	it('start calls each spec.build(), then run + waits on shutdown', async () => {
		FakeWorker.instances = [];
		const f = new TemporalWorkerHostFactory();
		f.register({ taskQueue: 'ew-a', build: async () => new FakeWorker('ew-a') });
		f.register({ taskQueue: 'ew-b', build: async () => new FakeWorker('ew-b') });
		const handle = await f.start();
		expect(FakeWorker.instances.map((w) => w.taskQueue)).toEqual(['ew-a', 'ew-b']);
		await handle.stop();
		expect(FakeWorker.instances.every((w) => w.shutdownCount === 1)).toBe(true);
	});

	it('register-after-start and double-start throw', async () => {
		FakeWorker.instances = [];
		const f = new TemporalWorkerHostFactory();
		f.register({ taskQueue: 'ew', build: async () => new FakeWorker('ew') });
		await f.start();
		expect(() => f.register({ taskQueue: 'ew2', build: async () => new FakeWorker('ew2') })).toThrow(
			/cannot register/
		);
		await expect(f.start()).rejects.toThrow(/start\(\) called twice/);
	});

	it('AbortSignal triggers stopAll', async () => {
		FakeWorker.instances = [];
		const f = new TemporalWorkerHostFactory();
		f.register({ taskQueue: 'ew', build: async () => new FakeWorker('ew') });
		const ctrl = new AbortController();
		await f.start({ signal: ctrl.signal });
		ctrl.abort();
		await new Promise((r) => setImmediate(r));
		// Worker.shutdown may have been called synchronously inside stopAll.
		expect(FakeWorker.instances[0].shutdownCount).toBeGreaterThan(0);
	});

	it('stop is idempotent', async () => {
		FakeWorker.instances = [];
		const f = new TemporalWorkerHostFactory();
		f.register({ taskQueue: 'ew', build: async () => new FakeWorker('ew') });
		const handle = await f.start();
		await handle.stop();
		await expect(handle.stop()).resolves.toBeUndefined();
	});
});
