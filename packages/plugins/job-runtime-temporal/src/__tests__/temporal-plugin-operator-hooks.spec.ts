import { describe, expect, it } from 'vitest';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	TemporalDispatcherFactory,
	TemporalDispatcherNotConfiguredError,
	TemporalJobRuntimePlugin,
	TemporalWorkerHostFactory
} from '../index.js';
import type { TemporalWorker, TemporalWorkflowClient, TemporalWorkflowHandle } from '../temporal-types.js';

class StubHandle implements TemporalWorkflowHandle {
	constructor(
		public readonly workflowId: string,
		public readonly statusName: string = 'RUNNING'
	) {}
	async cancel() {
		// noop
	}
	async describe() {
		return { status: { name: this.statusName } };
	}
}

class StubClient implements TemporalWorkflowClient {
	constructor(private readonly statusByWorkflow: Record<string, string> = {}) {}
	async start(_type: string, options: { workflowId: string; taskQueue: string }) {
		return new StubHandle(options.workflowId);
	}
	getHandle(workflowId: string) {
		return new StubHandle(workflowId, this.statusByWorkflow[workflowId] ?? 'RUNNING');
	}
}

class FakeWorker implements TemporalWorker {
	static instances: FakeWorker[] = [];
	shutdownCount = 0;
	private runResolver: (() => void) | null = null;
	private runPromise: Promise<void>;
	constructor() {
		FakeWorker.instances.push(this);
		this.runPromise = new Promise<void>((resolve) => {
			this.runResolver = resolve;
		});
	}
	run() {
		return this.runPromise;
	}
	shutdown() {
		this.shutdownCount += 1;
		this.runResolver?.();
	}
}

const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
	tenantId: '00000000-0000-0000-0000-00000000aaaa',
	providerId: 'temporal',
	credentialVersion: 1,
	credentials: { namespace: 'tenant-acme' },
	...overrides
});

describe('TemporalJobRuntimePlugin — operator hooks', () => {
	it('useDispatchers replaces the throwing stub', async () => {
		const client = new StubClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		const plugin = new TemporalJobRuntimePlugin().useDispatchers({
			dispatchKbEmbedDocument: async (payload: { workId: string }) => {
				const handle = await factory.start('kbEmbedWorkflow', {
					workflowId: `kb-embed:${payload.workId}`
				});
				return handle.workflowId;
			}
		});
		const d = plugin.dispatchers as unknown as {
			dispatchKbEmbedDocument: (p: unknown) => Promise<string>;
		};
		await expect(d.dispatchKbEmbedDocument({ workId: 'w1' })).resolves.toBe('kb-embed:w1');
	});

	it('without useDispatchers the throwing stub still fires', () => {
		const plugin = new TemporalJobRuntimePlugin();
		const d = plugin.dispatchers as unknown as { dispatchKbEmbedDocument: () => unknown };
		expect(() => d.dispatchKbEmbedDocument()).toThrow(TemporalDispatcherNotConfiguredError);
	});

	it('cancel delegates to dispatcher factory; returns false without it', async () => {
		const client = new StubClient();
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		const plugin = new TemporalJobRuntimePlugin().useDispatcherFactory(factory);
		await expect(plugin.cancel('wf-1')).resolves.toBe(true);

		const orphan = new TemporalJobRuntimePlugin();
		await expect(orphan.cancel('wf-1')).resolves.toBe(false);
	});

	it('getRunStatus projects Temporal status onto JobRunStatus', async () => {
		const client = new StubClient({
			'wf-running': 'RUNNING',
			'wf-completed': 'COMPLETED',
			'wf-cancelled': 'CANCELED',
			'wf-terminated': 'TERMINATED',
			'wf-timed-out': 'TIMED_OUT',
			'wf-weird': 'EXTRATERRESTRIAL'
		});
		const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
		const plugin = new TemporalJobRuntimePlugin().useDispatcherFactory(factory);
		await expect(plugin.getRunStatus('wf-running')).resolves.toBe('running');
		await expect(plugin.getRunStatus('wf-completed')).resolves.toBe('completed');
		await expect(plugin.getRunStatus('wf-cancelled')).resolves.toBe('cancelled');
		await expect(plugin.getRunStatus('wf-terminated')).resolves.toBe('cancelled');
		await expect(plugin.getRunStatus('wf-timed-out')).resolves.toBe('failed');
		await expect(plugin.getRunStatus('wf-weird')).resolves.toBe('unknown');

		const orphan = new TemporalJobRuntimePlugin();
		await expect(orphan.getRunStatus('wf-any')).resolves.toBe('unknown');
	});

	it('startWorkerHost delegates to the worker host factory', async () => {
		FakeWorker.instances = [];
		const wh = new TemporalWorkerHostFactory();
		wh.register({ taskQueue: 'ew', build: async () => new FakeWorker() });
		const plugin = new TemporalJobRuntimePlugin().useWorkerHostFactory(wh);
		const handle = await plugin.startWorkerHost({});
		await handle.stop();
		expect(FakeWorker.instances[0].shutdownCount).toBe(1);
	});

	it('startWorkerHost without a factory returns a no-op handle', async () => {
		const plugin = new TemporalJobRuntimePlugin();
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	describe('dispatchersBuilder', () => {
		it('bindToTenant view uses tenant-built dispatchers when builder is set', () => {
			const plugin = new TemporalJobRuntimePlugin({
				dispatchersBuilder: (snap): JobRuntimeDispatchers => ({
					dispatchKbEmbedDocument: () => Promise.resolve(`ns:${snap.credentials.namespace}`)
				})
			});
			const view = plugin.bindToTenant(snapshot());
			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			return expect(d.dispatchKbEmbedDocument()).resolves.toBe('ns:tenant-acme');
		});

		it('useDispatchers clears the tenant view cache', () => {
			const plugin = new TemporalJobRuntimePlugin().useDispatchers({
				dispatchKbEmbedDocument: () => Promise.resolve('v1')
			});
			const v1 = plugin.bindToTenant(snapshot());
			plugin.useDispatchers({
				dispatchKbEmbedDocument: () => Promise.resolve('v2')
			});
			const v2 = plugin.bindToTenant(snapshot());
			expect(v2).not.toBe(v1);
		});
	});
});
