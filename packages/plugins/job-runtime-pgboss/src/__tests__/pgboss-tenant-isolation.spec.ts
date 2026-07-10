import { describe, expect, it, vi } from 'vitest';
import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '@ever-works/plugin';
import { PgBossJobRuntimePlugin } from '../pgboss-job-runtime.plugin.js';
import { TenantAwarePgBossWorkerHostFactory } from '../pgboss-tenant-aware-worker-host-factory.js';
import type { PgBossInstance, PgBossJobView } from '../pgboss-types.js';

/**
 * EW-742 P4 T29/T30/T32 — tenant-isolation spec for the pg-boss
 * tenant-aware worker host. Mirrors the BullMQ T28 tenant-isolation
 * coverage:
 *
 *   1. tenantA → A's binding
 *   2. tenantB → distinct binding
 *   3. concurrent A+B never cross-route
 *   4. missing `_ew.tenantId` → plugin default (FR-5 fallback)
 *   5. `resolveSnapshot` is called per tenant; bindings memoise via the
 *      plugin's `(tenantId, credentialVersion)` cache
 *   6. when pg-boss hands a batch (array of jobs), each job in the
 *      batch routes to the right tenant independently
 *
 * pg-boss itself is mocked with a minimal `FakeBoss` (matching the
 * `pgboss-factories.spec.ts` pattern) that records `boss.work(...)`
 * calls and lets the test drive the captured processor by hand.
 */

interface WorkCall {
	name: string;
	options: Readonly<Record<string, unknown>>;
	handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>;
}

class FakeBoss implements PgBossInstance {
	workCalls: WorkCall[] = [];
	stopped = false;
	private nextSubId = 1;

	async send(): Promise<string | null> {
		return null;
	}

	async work(
		name: string,
		options: Readonly<Record<string, unknown>>,
		handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
	): Promise<string> {
		this.workCalls.push({ name, options, handler });
		return `sub${this.nextSubId++}`;
	}

	async cancel(): Promise<void> {
		return undefined;
	}

	async start(): Promise<unknown> {
		return undefined;
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}
}

function makeJob(id: string, data: Record<string, unknown>): PgBossJobView {
	return { id, name: 'q1', data };
}

function stampedJob(id: string, tenantId: string, extra: Record<string, unknown> = {}): PgBossJobView {
	return makeJob(id, { ...extra, _ew: { tenantId } });
}

const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('TenantAwarePgBossWorkerHostFactory', () => {
	it('routes a tenantA job to a binding scoped to tenantA', async () => {
		const boss = new FakeBoss();
		const plugin = new PgBossJobRuntimePlugin();
		const f = new TenantAwarePgBossWorkerHostFactory({ boss, plugin });

		const seen: IJobRuntimeProvider[] = [];
		f.register('q1', {}, async (_job, binding) => {
			seen.push(binding);
		});
		await f.start();

		const processor = boss.workCalls[0]!.handler;
		await processor(stampedJob('job-a', tenantA));

		expect(seen).toHaveLength(1);
		const view = seen[0]! as IJobRuntimeProvider & { tenantSnapshot?: TenantCredentialSnapshot };
		expect(view.tenantSnapshot?.tenantId).toBe(tenantA);
		expect(view).not.toBe(plugin);
	});

	it('routes a tenantB job to a binding distinct from tenantA', async () => {
		const boss = new FakeBoss();
		const plugin = new PgBossJobRuntimePlugin();
		const f = new TenantAwarePgBossWorkerHostFactory({ boss, plugin });

		const seen: IJobRuntimeProvider[] = [];
		f.register('q1', {}, async (_job, binding) => {
			seen.push(binding);
		});
		await f.start();

		const processor = boss.workCalls[0]!.handler;
		await processor(stampedJob('job-a', tenantA));
		await processor(stampedJob('job-b', tenantB));

		expect(seen).toHaveLength(2);
		const viewA = seen[0]! as IJobRuntimeProvider & { tenantSnapshot?: TenantCredentialSnapshot };
		const viewB = seen[1]! as IJobRuntimeProvider & { tenantSnapshot?: TenantCredentialSnapshot };
		expect(viewA.tenantSnapshot?.tenantId).toBe(tenantA);
		expect(viewB.tenantSnapshot?.tenantId).toBe(tenantB);
		expect(viewA).not.toBe(viewB);
	});

	it('concurrent jobs for A and B never cross-route', async () => {
		const boss = new FakeBoss();
		const plugin = new PgBossJobRuntimePlugin();
		const f = new TenantAwarePgBossWorkerHostFactory({ boss, plugin });

		const seen: { tenantId: string; binding: IJobRuntimeProvider }[] = [];
		f.register('q1', {}, async (job, binding) => {
			// Read the tenantId from the job and pair it with the binding we got.
			const ew = (job.data as { _ew?: { tenantId?: string } })._ew;
			seen.push({ tenantId: ew?.tenantId ?? '<none>', binding });
		});
		await f.start();

		const processor = boss.workCalls[0]!.handler;
		// Fire 6 jobs in parallel, alternating tenants.
		const jobs = [
			stampedJob('a1', tenantA),
			stampedJob('b1', tenantB),
			stampedJob('a2', tenantA),
			stampedJob('b2', tenantB),
			stampedJob('a3', tenantA),
			stampedJob('b3', tenantB)
		];
		await Promise.all(jobs.map((j) => processor(j)));

		expect(seen).toHaveLength(6);
		for (const entry of seen) {
			const view = entry.binding as IJobRuntimeProvider & {
				tenantSnapshot?: TenantCredentialSnapshot;
			};
			// Each binding's snapshot.tenantId MUST equal the job's stamped tenantId.
			expect(view.tenantSnapshot?.tenantId).toBe(entry.tenantId);
		}
	});

	it('falls back to the plugin default binding when _ew.tenantId is missing', async () => {
		const boss = new FakeBoss();
		const plugin = new PgBossJobRuntimePlugin();
		const f = new TenantAwarePgBossWorkerHostFactory({ boss, plugin });

		const seen: IJobRuntimeProvider[] = [];
		f.register('q1', {}, async (_job, binding) => {
			seen.push(binding);
		});
		await f.start();

		const processor = boss.workCalls[0]!.handler;
		await processor(makeJob('untenanted', { hello: 'world' })); // no _ew
		await processor(makeJob('empty-ew', { _ew: {} })); // _ew present but no tenantId

		expect(seen).toHaveLength(2);
		// FR-5: tenant-less jobs use the plugin singleton itself.
		expect(seen[0]).toBe(plugin);
		expect(seen[1]).toBe(plugin);
	});

	it('calls resolveSnapshot per tenant; bindings memoise via plugin.bindToTenant', async () => {
		const boss = new FakeBoss();
		const plugin = new PgBossJobRuntimePlugin();
		const resolveSnapshot = vi.fn(
			async (tenantId: string): Promise<TenantCredentialSnapshot> => ({
				tenantId,
				providerId: 'pgboss',
				credentialVersion: 1,
				credentials: { schema: `tenant_${tenantId.slice(0, 8)}` }
			})
		);
		const f = new TenantAwarePgBossWorkerHostFactory({ boss, plugin, resolveSnapshot });

		const seen: IJobRuntimeProvider[] = [];
		f.register('q1', {}, async (_job, binding) => {
			seen.push(binding);
		});
		await f.start();

		const processor = boss.workCalls[0]!.handler;
		await processor(stampedJob('a1', tenantA));
		await processor(stampedJob('a2', tenantA));
		await processor(stampedJob('b1', tenantB));
		await processor(stampedJob('a3', tenantA));

		// resolveSnapshot is called every job (operator's responsibility to
		// cache); but plugin.bindToTenant memoises so the returned view
		// instance is shared across same-tenant calls.
		expect(resolveSnapshot).toHaveBeenCalledTimes(4);
		expect(resolveSnapshot.mock.calls.map((c) => c[0])).toEqual([tenantA, tenantA, tenantB, tenantA]);

		// Same tenantA snapshot → identical view returned by the plugin.
		expect(seen[0]).toBe(seen[1]);
		expect(seen[0]).toBe(seen[3]);
		// tenantB is a different view.
		expect(seen[2]).not.toBe(seen[0]);
	});

	it('routes each job of a pg-boss batch (array) to its own tenant', async () => {
		const boss = new FakeBoss();
		const plugin = new PgBossJobRuntimePlugin();
		const f = new TenantAwarePgBossWorkerHostFactory({ boss, plugin });

		const seen: { id: string; tenantId: string | null; binding: IJobRuntimeProvider }[] = [];
		f.register('q1', {}, async (job, binding) => {
			const ew = (job.data as { _ew?: { tenantId?: string } })._ew;
			seen.push({ id: job.id, tenantId: ew?.tenantId ?? null, binding });
		});
		await f.start();

		const processor = boss.workCalls[0]!.handler;
		// pg-boss hands an array when `batchSize > 1`. Mix tenants + a
		// tenant-less entry to confirm independent routing per element.
		const batch: readonly PgBossJobView[] = [
			stampedJob('b-a1', tenantA),
			stampedJob('b-b1', tenantB),
			makeJob('b-none', { payload: 1 })
		];
		await processor(batch);

		expect(seen.map((s) => s.id)).toEqual(['b-a1', 'b-b1', 'b-none']);

		const v0 = seen[0]!.binding as IJobRuntimeProvider & {
			tenantSnapshot?: TenantCredentialSnapshot;
		};
		const v1 = seen[1]!.binding as IJobRuntimeProvider & {
			tenantSnapshot?: TenantCredentialSnapshot;
		};
		expect(v0.tenantSnapshot?.tenantId).toBe(tenantA);
		expect(v1.tenantSnapshot?.tenantId).toBe(tenantB);
		// The untenanted entry falls back to the plugin singleton.
		expect(seen[2]!.binding).toBe(plugin);
	});
});
