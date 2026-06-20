import { describe, expect, it, vi } from 'vitest';
import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '@ever-works/plugin';
import { BullMqJobRuntimePlugin } from '../bullmq-job-runtime.plugin.js';
import { TenantAwareBullMqWorkerHostFactory } from '../bullmq-tenant-aware-worker-host-factory.js';
import type {
	BullMqDeps,
	BullMqJobView,
	BullMqQueueAdapter,
	BullMqWorkerAdapter
} from '../bullmq-types.js';

/**
 * EW-742 P4 T28/T30/T32 — tenant-isolation contract for the BullMQ
 * tenant-aware worker host. Uses the FakeQueue / FakeWorker mock
 * pattern from `bullmq-worker-host-factory.spec.ts`; no real bullmq or
 * ioredis is constructed.
 */

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

const TENANT_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * Construct a job view with the `opts.tenantId` carrier T31 writes.
 * `BullMqJobView` in `bullmq-types.ts` doesn't type `opts`, so the
 * factory reads it via a widened cast — we mirror that here.
 */
function jobWithTenant(name: string, tenantId: string | undefined, data: unknown = {}): BullMqJobView {
	const job: Record<string, unknown> = { id: `${name}-${tenantId ?? 'none'}`, name, data };
	if (tenantId !== undefined) {
		job['opts'] = { tenantId };
	}
	return job as unknown as BullMqJobView;
}

describe('TenantAwareBullMqWorkerHostFactory — tenant isolation', () => {
	it("routes job with tenant A's id to tenant A's binding", async () => {
		FakeWorker.instances = [];
		const plugin = new BullMqJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const factory = new TenantAwareBullMqWorkerHostFactory({
			deps: makeDeps(),
			plugin,
			connection: 'r'
		});
		factory.register('q1', async (_job, binding) => {
			captured.push(binding);
		});
		await factory.start();

		await FakeWorker.instances[0].processor(jobWithTenant('q1', TENANT_A_ID));

		expect(captured).toHaveLength(1);
		const bindingA = captured[0];
		expect(bindingA).not.toBe(plugin);
		// `bindToTenant` on the per-tenant view returns the SAME view when
		// called with the same (tenantId, credentialVersion) — that's how
		// we assert it's tied to tenant A.
		expect(
			bindingA.bindToTenant?.({
				tenantId: TENANT_A_ID,
				providerId: 'bullmq',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(bindingA);
	});

	it('routes tenant B to a distinct binding from A', async () => {
		FakeWorker.instances = [];
		const plugin = new BullMqJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const factory = new TenantAwareBullMqWorkerHostFactory({
			deps: makeDeps(),
			plugin,
			connection: 'r'
		});
		factory.register('q1', async (_job, binding) => {
			captured.push(binding);
		});
		await factory.start();

		await FakeWorker.instances[0].processor(jobWithTenant('q1', TENANT_A_ID));
		await FakeWorker.instances[0].processor(jobWithTenant('q1', TENANT_B_ID));

		expect(captured).toHaveLength(2);
		const [bindingA, bindingB] = captured;
		expect(bindingA).not.toBe(bindingB);
		expect(bindingA).not.toBe(plugin);
		expect(bindingB).not.toBe(plugin);
	});

	it("two concurrent jobs from different tenants don't cross contexts", async () => {
		FakeWorker.instances = [];
		const plugin = new BullMqJobRuntimePlugin();
		const observed: { jobId: string; binding: IJobRuntimeProvider }[] = [];

		// Gate handlers so they actually overlap.
		let releaseA: () => void = () => undefined;
		let releaseB: () => void = () => undefined;
		const aReady = new Promise<void>((r) => (releaseA = r));
		const bReady = new Promise<void>((r) => (releaseB = r));

		const factory = new TenantAwareBullMqWorkerHostFactory({
			deps: makeDeps(),
			plugin,
			connection: 'r'
		});
		factory.register('q1', async (job, binding) => {
			if (job.id?.includes('A')) {
				await aReady;
			} else {
				await bReady;
			}
			observed.push({ jobId: job.id ?? '', binding });
		});
		await factory.start();

		const worker = FakeWorker.instances[0];
		const jobA = { id: 'jA', name: 'q1', data: {}, opts: { tenantId: TENANT_A_ID } } as unknown as BullMqJobView;
		const jobB = { id: 'jB', name: 'q1', data: {}, opts: { tenantId: TENANT_B_ID } } as unknown as BullMqJobView;

		const pA = worker.processor(jobA);
		const pB = worker.processor(jobB);

		// Release in reversed order to maximise interleaving.
		releaseB();
		releaseA();
		await Promise.all([pA, pB]);

		expect(observed).toHaveLength(2);
		const aObs = observed.find((o) => o.jobId === 'jA');
		const bObs = observed.find((o) => o.jobId === 'jB');
		expect(aObs).toBeDefined();
		expect(bObs).toBeDefined();
		expect(aObs!.binding).not.toBe(bObs!.binding);

		// Each binding self-reports its own tenant via bindToTenant
		// memoisation identity (same snapshot → same view).
		expect(
			aObs!.binding.bindToTenant?.({
				tenantId: TENANT_A_ID,
				providerId: 'bullmq',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(aObs!.binding);
		expect(
			bObs!.binding.bindToTenant?.({
				tenantId: TENANT_B_ID,
				providerId: 'bullmq',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(bObs!.binding);
	});

	it('job without tenantId falls back to plugin default binding', async () => {
		FakeWorker.instances = [];
		const plugin = new BullMqJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const factory = new TenantAwareBullMqWorkerHostFactory({
			deps: makeDeps(),
			plugin,
			connection: 'r'
		});
		factory.register('q1', async (_job, binding) => {
			captured.push(binding);
		});
		await factory.start();

		await FakeWorker.instances[0].processor({ id: 'jX', name: 'q1', data: {} });

		expect(captured).toHaveLength(1);
		expect(captured[0]).toBe(plugin);
	});

	it('resolveSnapshot is called per tenantId; downstream bindings are memoised by plugin.bindToTenant', async () => {
		FakeWorker.instances = [];
		const plugin = new BullMqJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const resolveSnapshot = vi.fn(
			async (tenantId: string): Promise<TenantCredentialSnapshot> => ({
				tenantId,
				providerId: 'bullmq',
				credentialVersion: 1,
				credentials: { queuePrefix: `tenant-${tenantId.slice(0, 1)}` }
			})
		);

		const factory = new TenantAwareBullMqWorkerHostFactory({
			deps: makeDeps(),
			plugin,
			connection: 'r',
			resolveSnapshot
		});
		factory.register('q1', async (_job, binding) => {
			captured.push(binding);
		});
		await factory.start();

		const worker = FakeWorker.instances[0];
		await worker.processor(jobWithTenant('q1', TENANT_A_ID));
		await worker.processor(jobWithTenant('q1', TENANT_A_ID));
		await worker.processor(jobWithTenant('q1', TENANT_B_ID));

		// resolveSnapshot fires once per job (the factory does not cache
		// snapshots — that's the operator's resolveSnapshot impl's job).
		expect(resolveSnapshot).toHaveBeenCalledTimes(3);
		expect(resolveSnapshot.mock.calls.map((c) => c[0])).toEqual([
			TENANT_A_ID,
			TENANT_A_ID,
			TENANT_B_ID
		]);

		// But plugin.bindToTenant memoises by (tenantId, credentialVersion):
		// the two A-tenant jobs share a binding identity.
		expect(captured).toHaveLength(3);
		expect(captured[0]).toBe(captured[1]);
		expect(captured[0]).not.toBe(captured[2]);
	});

	it('falls back to job.data._ew.tenantId when opts.tenantId is absent', async () => {
		FakeWorker.instances = [];
		const plugin = new BullMqJobRuntimePlugin();
		const captured: IJobRuntimeProvider[] = [];

		const factory = new TenantAwareBullMqWorkerHostFactory({
			deps: makeDeps(),
			plugin,
			connection: 'r'
		});
		factory.register('q1', async (_job, binding) => {
			captured.push(binding);
		});
		await factory.start();

		// pg-boss-style stamping — tenantId on the payload, no opts.
		const pgbossStyle: BullMqJobView = {
			id: 'jPg',
			name: 'q1',
			data: { _ew: { tenantId: TENANT_A_ID }, foo: 1 }
		};
		await FakeWorker.instances[0].processor(pgbossStyle);

		expect(captured).toHaveLength(1);
		const binding = captured[0];
		expect(binding).not.toBe(plugin);
		expect(
			binding.bindToTenant?.({
				tenantId: TENANT_A_ID,
				providerId: 'bullmq',
				credentialVersion: 1,
				credentials: {}
			})
		).toBe(binding);
	});
});
