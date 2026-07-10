import { describe, expect, it } from 'vitest';
import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '@ever-works/plugin';
import { TemporalJobRuntimePlugin, type TemporalTenantBindingView } from '../temporal-job-runtime.plugin.js';
import { TenantAwareTemporalWorkerHostFactory } from '../temporal-tenant-aware-worker-host-factory.js';
import type { TemporalWorker } from '../temporal-types.js';

class FakeWorker implements TemporalWorker {
	static instances: FakeWorker[] = [];
	runResolver: (() => void) | null = null;
	runPromise: Promise<void>;
	shutdownCount = 0;
	constructor(
		public readonly tenantId: string,
		public readonly taskQueue: string,
		public readonly binding: IJobRuntimeProvider
	) {
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

function makeSnapshot(tenantId: string, namespace: string, credentialVersion = 1): TenantCredentialSnapshot {
	return {
		tenantId,
		providerId: 'temporal',
		credentialVersion,
		credentials: { namespace }
	};
}

describe('TenantAwareTemporalWorkerHostFactory', () => {
	it('register accumulates without instantiation', () => {
		FakeWorker.instances = [];
		const plugin = new TemporalJobRuntimePlugin();
		const f = new TenantAwareTemporalWorkerHostFactory({ plugin });
		f.register({
			tenantId: 'tenant-a',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-a', 'ew', binding)
		});
		f.register({
			tenantId: 'tenant-b',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-b', 'ew', binding)
		});
		expect(f.registrationCount).toBe(2);
		expect(FakeWorker.instances).toHaveLength(0);
	});

	it('start materialises one worker per tenant, each with its own binding', async () => {
		FakeWorker.instances = [];
		const plugin = new TemporalJobRuntimePlugin();
		const snapshots: Record<string, TenantCredentialSnapshot> = {
			'tenant-a': makeSnapshot('tenant-a', 'ns-a'),
			'tenant-b': makeSnapshot('tenant-b', 'ns-b')
		};
		const f = new TenantAwareTemporalWorkerHostFactory({
			plugin,
			resolveSnapshot: (tenantId) => snapshots[tenantId]
		});
		f.register({
			tenantId: 'tenant-a',
			taskQueue: 'ew-a',
			build: async (binding) => new FakeWorker('tenant-a', 'ew-a', binding)
		});
		f.register({
			tenantId: 'tenant-b',
			taskQueue: 'ew-b',
			build: async (binding) => new FakeWorker('tenant-b', 'ew-b', binding)
		});

		await f.start();

		expect(FakeWorker.instances).toHaveLength(2);
		const [workerA, workerB] = FakeWorker.instances;
		expect(workerA.tenantId).toBe('tenant-a');
		expect(workerA.taskQueue).toBe('ew-a');
		expect(workerA.binding).toBeDefined();
		expect((workerA.binding as TemporalTenantBindingView).tenantNamespace).toBe('ns-a');
		expect((workerA.binding as TemporalTenantBindingView).tenantSnapshot.tenantId).toBe('tenant-a');

		expect(workerB.tenantId).toBe('tenant-b');
		expect(workerB.taskQueue).toBe('ew-b');
		expect((workerB.binding as TemporalTenantBindingView).tenantNamespace).toBe('ns-b');
		expect((workerB.binding as TemporalTenantBindingView).tenantSnapshot.tenantId).toBe('tenant-b');
	});

	it('tenant A and tenant B yield distinct bindings (memoised per tenant)', async () => {
		FakeWorker.instances = [];
		const plugin = new TemporalJobRuntimePlugin();
		const snapshots: Record<string, TenantCredentialSnapshot> = {
			'tenant-a': makeSnapshot('tenant-a', 'ns-a'),
			'tenant-b': makeSnapshot('tenant-b', 'ns-b')
		};
		const f = new TenantAwareTemporalWorkerHostFactory({
			plugin,
			resolveSnapshot: (tenantId) => snapshots[tenantId]
		});
		f.register({
			tenantId: 'tenant-a',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-a', 'ew', binding)
		});
		f.register({
			tenantId: 'tenant-b',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-b', 'ew', binding)
		});

		await f.start();
		const [workerA, workerB] = FakeWorker.instances;
		// Distinct binding views per tenant.
		expect(workerA.binding).not.toBe(workerB.binding);
		// Same snapshot through plugin.bindToTenant returns the SAME view
		// (memoised on (tenantId, credentialVersion) per the
		// `IJobRuntimeProvider.bindToTenant` idempotency clause).
		const reboundA = plugin.bindToTenant(snapshots['tenant-a']);
		expect(reboundA).toBe(workerA.binding);
	});

	it('handle.stop() shuts down all workers + awaits run promises (idempotent)', async () => {
		FakeWorker.instances = [];
		const plugin = new TemporalJobRuntimePlugin();
		const f = new TenantAwareTemporalWorkerHostFactory({
			plugin,
			resolveSnapshot: (tenantId) => makeSnapshot(tenantId, `ns-${tenantId}`)
		});
		f.register({
			tenantId: 'tenant-a',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-a', 'ew', binding)
		});
		f.register({
			tenantId: 'tenant-b',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-b', 'ew', binding)
		});

		const handle = await f.start();
		await handle.stop();
		expect(FakeWorker.instances.every((w) => w.shutdownCount === 1)).toBe(true);
		// Second stop is a no-op (idempotent).
		await expect(handle.stop()).resolves.toBeUndefined();
		expect(FakeWorker.instances.every((w) => w.shutdownCount === 1)).toBe(true);
	});

	it('AbortSignal triggers stopAll', async () => {
		FakeWorker.instances = [];
		const plugin = new TemporalJobRuntimePlugin();
		const f = new TenantAwareTemporalWorkerHostFactory({
			plugin,
			resolveSnapshot: (tenantId) => makeSnapshot(tenantId, `ns-${tenantId}`)
		});
		f.register({
			tenantId: 'tenant-a',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-a', 'ew', binding)
		});

		const ctrl = new AbortController();
		await f.start({ signal: ctrl.signal });
		ctrl.abort();
		await new Promise((r) => setImmediate(r));
		expect(FakeWorker.instances[0].shutdownCount).toBeGreaterThan(0);
	});

	it('register-after-start throws; double-start throws', async () => {
		FakeWorker.instances = [];
		const plugin = new TemporalJobRuntimePlugin();
		const f = new TenantAwareTemporalWorkerHostFactory({
			plugin,
			resolveSnapshot: (tenantId) => makeSnapshot(tenantId, `ns-${tenantId}`)
		});
		f.register({
			tenantId: 'tenant-a',
			taskQueue: 'ew',
			build: async (binding) => new FakeWorker('tenant-a', 'ew', binding)
		});
		await f.start();
		expect(() =>
			f.register({
				tenantId: 'tenant-b',
				taskQueue: 'ew',
				build: async (binding) => new FakeWorker('tenant-b', 'ew', binding)
			})
		).toThrow(/cannot register/);
		await expect(f.start()).rejects.toThrow(/start\(\) called twice/);
	});
});
