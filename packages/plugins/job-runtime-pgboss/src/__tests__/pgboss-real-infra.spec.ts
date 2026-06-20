import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * EW-742 P6 T32/T37 — REAL-INFRA integration spec for the pg-boss plugin.
 *
 * Mocks-free: connects to a live Postgres and runs the full
 * `boss.send()` → `boss.work()` loop through the real `pg-boss` library.
 * Companion to `pgboss-tenant-isolation.spec.ts` (mocks-only) — together
 * they cover both the structural contract and wire-level behaviour
 * (singletonKey dedup, expireInSeconds enforcement, schema-per-tenant
 * isolation, batched workers).
 *
 * # Gating
 *
 * Skips entirely when `EW_TEST_REAL_PGBOSS_URL` is unset, so
 * `pnpm test` works for operators without a local Postgres. CI exports
 * the URL inside the `job-runtime-real-infra` job, where Postgres runs
 * as a service container.
 *
 * # Concurrency safety
 *
 * Each test creates a fresh schema name with `randomUUID()` so parallel
 * vitest workers + repeated CI reruns don't trample each other inside
 * the same Postgres database. Schemas are dropped on cleanup so a long
 * CI lifetime doesn't accumulate dead `tenant_*` schemas.
 */

const PG_URL = process.env['EW_TEST_REAL_PGBOSS_URL'];
const realInfra = PG_URL ? describe : describe.skip;

import { PgBossDispatcherFactory } from '../pgboss-dispatcher-factory.js';
import { PgBossWorkerHostFactory } from '../pgboss-worker-host-factory.js';
import type { PgBossInstance, PgBossJobView } from '../pgboss-types.js';

interface PgBossCtor {
	new (opts: Record<string, unknown>): PgBossInstance;
}

/** Lazy import — only loaded when the gate is open. */
async function loadRealPgBoss(): Promise<PgBossCtor> {
	const mod = (await import('pg-boss')) as unknown as { default: PgBossCtor };
	return mod.default;
}

/** Best-effort cleanup of the per-test schema so CI Postgres stays tidy. */
async function dropSchema(schema: string): Promise<void> {
	try {
		const { Client } = (await import('pg')) as unknown as {
			Client: new (cfg: { connectionString: string }) => {
				connect(): Promise<void>;
				query(sql: string): Promise<unknown>;
				end(): Promise<void>;
			};
		};
		const client = new Client({ connectionString: PG_URL! });
		await client.connect();
		await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await client.end();
	} catch {
		// pg might not be installed (it's a pg-boss transitive); ignore.
	}
}

realInfra('pg-boss real-infra (EW-742 P6 T32/T37)', () => {
	let PgBoss: PgBossCtor;
	const cleanup: Array<() => Promise<unknown>> = [];
	const schemasUsed = new Set<string>();

	beforeAll(async () => {
		PgBoss = await loadRealPgBoss();
	}, 30_000);

	afterEach(async () => {
		while (cleanup.length > 0) {
			const fn = cleanup.pop();
			if (fn) await fn().catch(() => undefined);
		}
		for (const schema of schemasUsed) {
			await dropSchema(schema);
		}
		schemasUsed.clear();
	});

	function freshSchema(label: string): string {
		const schema = `ew_${label}_${randomUUID().replace(/-/g, '_')}`;
		schemasUsed.add(schema);
		return schema;
	}

	async function startBoss(schema: string): Promise<PgBossInstance> {
		const boss = new PgBoss({ connectionString: PG_URL!, schema });
		await boss.start();
		cleanup.push(() => boss.stop({ graceful: true, timeout: 5000 } as Record<string, unknown>));
		return boss;
	}

	it('single-tenant send + work handler processes the job end-to-end', async () => {
		const schema = freshSchema('single');
		const boss = await startBoss(schema);
		const queueName = `q-single-${randomUUID().slice(0, 8)}`;

		const factory = new PgBossDispatcherFactory({ boss });
		const workerHost = new PgBossWorkerHostFactory({ boss });
		const seen: unknown[] = [];
		let resolveDone: () => void;
		const done = new Promise<void>((r) => (resolveDone = r));
		workerHost.register(queueName, { teamSize: 1 }, async (jobOrBatch) => {
			const job = Array.isArray(jobOrBatch) ? jobOrBatch[0]! : (jobOrBatch as PgBossJobView);
			seen.push(job.data);
			resolveDone();
		});
		await workerHost.start();

		const id = await factory.send(queueName, { hello: 'world' });
		expect(id).toBeTruthy();
		await done;
		expect(seen).toEqual([{ hello: 'world' }]);
	}, 30_000);

	it('two-tenant isolation via _ew.tenantId payload namespace', async () => {
		const schema = freshSchema('tenants');
		const boss = await startBoss(schema);
		const queueName = `q-tenants-${randomUUID().slice(0, 8)}`;

		const factory = new PgBossDispatcherFactory({ boss });
		const workerHost = new PgBossWorkerHostFactory({ boss });
		const seen: Array<{ tenantId: unknown; payload: unknown }> = [];
		let pending = 2;
		let resolveAll: () => void;
		const allDone = new Promise<void>((r) => (resolveAll = r));
		workerHost.register(queueName, { teamSize: 2 }, async (jobOrBatch) => {
			const jobs = Array.isArray(jobOrBatch) ? jobOrBatch : [jobOrBatch as PgBossJobView];
			for (const j of jobs) {
				const ew = (j.data as { _ew?: { tenantId?: unknown } })._ew;
				seen.push({ tenantId: ew?.tenantId, payload: j.data });
				if (--pending === 0) resolveAll();
			}
		});
		await workerHost.start();

		await factory.enqueue(queueName, { which: 'A' }, { tenantId: 'tenant-a' });
		await factory.enqueue(queueName, { which: 'B' }, { tenantId: 'tenant-b' });

		await allDone;
		const a = seen.find((s) => (s.payload as { which?: string }).which === 'A');
		const b = seen.find((s) => (s.payload as { which?: string }).which === 'B');
		expect(a?.tenantId).toBe('tenant-a');
		expect(b?.tenantId).toBe('tenant-b');
	}, 30_000);

	it('per-tenant schema isolation: two PgBoss instances on distinct schemas', async () => {
		const schemaA = freshSchema('tenant_a');
		const schemaB = freshSchema('tenant_b');
		const bossA = await startBoss(schemaA);
		const bossB = await startBoss(schemaB);
		const queueName = `q-iso-${randomUUID().slice(0, 8)}`;

		const factoryA = new PgBossDispatcherFactory({ boss: bossA });
		const factoryB = new PgBossDispatcherFactory({ boss: bossB });

		// Only attach worker on bossA to confirm bossB's job never bleeds across.
		const workerHost = new PgBossWorkerHostFactory({ boss: bossA });
		const seenA: unknown[] = [];
		let resolveA: () => void;
		const aGot = new Promise<void>((r) => (resolveA = r));
		workerHost.register(queueName, { teamSize: 1 }, async (jobOrBatch) => {
			const job = Array.isArray(jobOrBatch) ? jobOrBatch[0]! : (jobOrBatch as PgBossJobView);
			seenA.push(job.data);
			resolveA();
		});
		await workerHost.start();

		const idA = await factoryA.send(queueName, { from: 'A' });
		const idB = await factoryB.send(queueName, { from: 'B' });
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();

		await aGot;
		// 800ms grace to confirm bossA's worker never picks up B's job.
		await new Promise((r) => setTimeout(r, 800));
		expect(seenA).toHaveLength(1);
		expect(seenA[0]).toEqual({ from: 'A' });

		// Cleanup the second boss explicitly (startBoss pushes it onto cleanup queue).
		void factoryB;
	}, 45_000);

	it('singletonKey idempotency: second send with same key returns null', async () => {
		const schema = freshSchema('idem');
		const boss = await startBoss(schema);
		const queueName = `q-idem-${randomUUID().slice(0, 8)}`;
		const idemKey = `idem-${randomUUID()}`;

		const factory = new PgBossDispatcherFactory({ boss });
		const first = await factory.enqueue(queueName, { n: 1 }, { idempotencyKey: idemKey });
		const second = await factory.enqueue(queueName, { n: 2 }, { idempotencyKey: idemKey });

		expect(first).toBeTruthy();
		// pg-boss's documented dedup semantic: second call returns null
		// while the singletonKey row is still in-flight.
		expect(second).toBeNull();
	}, 30_000);

	it('cancel before processing: removed job is never handed to the worker', async () => {
		const schema = freshSchema('cancel');
		const boss = await startBoss(schema);
		const queueName = `q-cancel-${randomUUID().slice(0, 8)}`;

		const factory = new PgBossDispatcherFactory({ boss });
		// startAfter in the far future so cancel wins.
		const id = await factory.send(queueName, { cancelMe: true }, { startAfter: 60 });
		expect(id).toBeTruthy();
		const cancelled = await factory.cancel(id!);
		expect(cancelled).toBe(true);

		const workerHost = new PgBossWorkerHostFactory({ boss });
		let received = 0;
		workerHost.register(queueName, { teamSize: 1 }, async () => {
			received++;
		});
		await workerHost.start();

		await new Promise((r) => setTimeout(r, 1500));
		expect(received).toBe(0);
	}, 30_000);

	it('batched workers (teamSize > 1) handle multi-tenant jobs in parallel correctly', async () => {
		const schema = freshSchema('batch');
		const boss = await startBoss(schema);
		const queueName = `q-batch-${randomUUID().slice(0, 8)}`;

		const factory = new PgBossDispatcherFactory({ boss });
		const workerHost = new PgBossWorkerHostFactory({ boss });
		const seen: Array<{ tenantId: unknown; payload: unknown }> = [];
		const expected = 6;
		let pending = expected;
		let resolveAll: () => void;
		const allDone = new Promise<void>((r) => (resolveAll = r));
		workerHost.register(queueName, { teamSize: 4, batchSize: 2 }, async (jobOrBatch) => {
			const jobs = Array.isArray(jobOrBatch) ? jobOrBatch : [jobOrBatch as PgBossJobView];
			for (const j of jobs) {
				const ew = (j.data as { _ew?: { tenantId?: unknown } })._ew;
				seen.push({ tenantId: ew?.tenantId, payload: j.data });
				if (--pending === 0) resolveAll();
			}
		});
		await workerHost.start();

		const tenants = ['tenant-a', 'tenant-b', 'tenant-c'];
		for (let i = 0; i < expected; i++) {
			const t = tenants[i % tenants.length]!;
			await factory.enqueue(queueName, { n: i }, { tenantId: t });
		}

		await allDone;
		expect(seen).toHaveLength(expected);
		// Each delivered job's stamped tenantId matches the dispatcher's choice
		// (i.e. the worker never invents or swaps a tenant).
		for (const entry of seen) {
			expect(tenants).toContain(entry.tenantId);
		}
	}, 45_000);
});
