import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * EW-742 P6 T32/T37 — REAL-INFRA integration spec for the BullMQ plugin.
 *
 * Mocks-free: this suite connects to a live Redis instance and exercises
 * the full enqueue → worker handler loop through the real `bullmq` and
 * `ioredis` libraries. The mocks-only `bullmq-*-isolation.spec.ts`
 * covers the structural contract; this spec catches wire-level
 * regressions (option translation, key-prefix isolation, dedup semantics,
 * cancel-before-process races) that mocks can mask.
 *
 * # Gating
 *
 * The entire suite skips when `EW_TEST_REAL_REDIS_URL` is unset. This
 * means `pnpm test` works in two modes:
 *
 *   - operator dev box (no Redis): every case shows as `skipped`
 *   - CI `job-runtime-real-infra` job (Redis service container):
 *     `EW_TEST_REAL_REDIS_URL=redis://localhost:6379` is exported and
 *     the suite runs for real.
 *
 * # Concurrency safety
 *
 * Every test creates queues whose names embed a fresh `randomUUID()` so
 * parallel CI shards / repeated reruns / vitest's own worker pool never
 * collide on a shared Redis key. Tear-down `close()` is best-effort; a
 * leak only costs Redis memory for the TTL of the keys, not test
 * correctness.
 */

const REDIS_URL = process.env['EW_TEST_REAL_REDIS_URL'];
const realInfra = REDIS_URL ? describe : describe.skip;

import { BullMqDispatcherFactory } from '../bullmq-dispatcher-factory.js';
import { BullMqWorkerHostFactory } from '../bullmq-worker-host-factory.js';
import type { BullMqDeps, BullMqJobView } from '../bullmq-types.js';

interface RealConnection {
	quit(): Promise<unknown>;
	keys(pattern: string): Promise<string[]>;
	del(...keys: string[]): Promise<number>;
}

interface BullMqLibrary {
	Queue: BullMqDeps['Queue'];
	Worker: BullMqDeps['Worker'];
}

/**
 * Lazy-load the real bullmq/ioredis only when the suite is actually
 * going to run. Both are devDeps gated behind `EW_TEST_REAL_REDIS_URL`,
 * so when an operator runs `pnpm test` without Redis we never try to
 * import them.
 */
async function loadRealBullMq(): Promise<{ bullmq: BullMqLibrary; redis: RealConnection }> {
	const bullmqMod = (await import('bullmq')) as unknown as BullMqLibrary;
	const ioredisMod = (await import('ioredis')) as { default: new (url: string, opts?: unknown) => RealConnection };
	const Redis = ioredisMod.default;
	const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
	return { bullmq: { Queue: bullmqMod.Queue, Worker: bullmqMod.Worker }, redis };
}

realInfra('BullMQ real-infra (EW-742 P6 T32/T37)', () => {
	let bullmq: BullMqLibrary;
	let redis: RealConnection;
	const cleanup: Array<() => Promise<unknown>> = [];
	const prefixesUsed = new Set<string>();

	beforeAll(async () => {
		const loaded = await loadRealBullMq();
		bullmq = loaded.bullmq;
		redis = loaded.redis;
	}, 30_000);

	afterEach(async () => {
		// Tear down per-test queues + workers in reverse-LIFO order.
		while (cleanup.length > 0) {
			const fn = cleanup.pop();
			if (fn) await fn().catch(() => undefined);
		}
		// Best-effort scrub of any per-tenant prefixes we created so a
		// flaky run can't leak keys into the next test's assertions.
		for (const prefix of prefixesUsed) {
			try {
				const keys = await redis.keys(`${prefix}:*`);
				if (keys.length > 0) await redis.del(...keys);
			} catch {
				// Ignore — Redis cleanup is best-effort.
			}
		}
		prefixesUsed.clear();
	});

	function makeDeps(): BullMqDeps {
		return { Queue: bullmq.Queue, Worker: bullmq.Worker };
	}

	function trackPrefix(prefix: string): string {
		prefixesUsed.add(prefix);
		return prefix;
	}

	it('single-tenant enqueue + worker handler processes the job end-to-end', async () => {
		const queueName = `ew-it-single-${randomUUID()}`;
		const prefix = trackPrefix(`ew-real-${randomUUID().slice(0, 8)}`);

		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		cleanup.push(() => factory.close());
		const dispatcher = factory.forQueue(queueName);

		const workerHost = new BullMqWorkerHostFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		const received: Array<{ name: string; data: unknown }> = [];
		let resolveProcessed: () => void;
		const processed = new Promise<void>((r) => (resolveProcessed = r));
		workerHost.register(queueName, async (job) => {
			received.push({ name: job.name, data: job.data });
			resolveProcessed();
		});
		const handle = await workerHost.start();
		cleanup.push(() => handle.stop());

		const jobId = await dispatcher.dispatch(queueName, { hello: 'world' });
		expect(jobId).toBeTruthy();
		await processed;
		expect(received).toHaveLength(1);
		expect(received[0]?.data).toEqual({ hello: 'world' });
	}, 30_000);

	it('two tenants on the same queue name route by JobsOptions.tenantId without cross-leak', async () => {
		const queueName = `ew-it-tenant-${randomUUID()}`;
		const prefix = trackPrefix(`ew-real-${randomUUID().slice(0, 8)}`);

		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		cleanup.push(() => factory.close());
		const dispatcher = factory.forQueue(queueName);

		const workerHost = new BullMqWorkerHostFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		const seen: Array<{ tenantId: unknown; payload: unknown }> = [];
		let pending = 2;
		let resolveAll: () => void;
		const allDone = new Promise<void>((r) => (resolveAll = r));

		workerHost.register(queueName, async (job: BullMqJobView) => {
			// T31 stamping carrier: tenantId lives on opts.tenantId (mirrors
			// the carrier the dispatcher writes via mapEnqueueOptions).
			const opts = (job as unknown as { opts?: { tenantId?: unknown } }).opts;
			seen.push({ tenantId: opts?.tenantId, payload: job.data });
			if (--pending === 0) resolveAll();
		});
		const handle = await workerHost.start();
		cleanup.push(() => handle.stop());

		const idA = await dispatcher.enqueue(
			queueName,
			{ which: 'A' },
			{ tenantId: 'tenant-a', idempotencyKey: `a-${randomUUID()}` }
		);
		const idB = await dispatcher.enqueue(
			queueName,
			{ which: 'B' },
			{ tenantId: 'tenant-b', idempotencyKey: `b-${randomUUID()}` }
		);
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();

		await allDone;
		expect(seen).toHaveLength(2);
		const a = seen.find((s) => (s.payload as { which?: string }).which === 'A');
		const b = seen.find((s) => (s.payload as { which?: string }).which === 'B');
		expect(a?.tenantId).toBe('tenant-a');
		expect(b?.tenantId).toBe('tenant-b');
	}, 30_000);

	it('per-tenant queue-prefix isolation lands jobs in distinct Redis keys', async () => {
		const queueName = `ew-it-prefix-${randomUUID()}`;
		const prefixA = trackPrefix(`ew-tenant-a-${randomUUID().slice(0, 8)}`);
		const prefixB = trackPrefix(`ew-tenant-b-${randomUUID().slice(0, 8)}`);

		const factoryA = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix: prefixA });
		const factoryB = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix: prefixB });
		cleanup.push(() => factoryA.close());
		cleanup.push(() => factoryB.close());

		// Enqueue with NO worker attached so the keys persist for inspection.
		await factoryA.forQueue(queueName).dispatch(queueName, { tenant: 'a' });
		await factoryB.forQueue(queueName).dispatch(queueName, { tenant: 'b' });

		const keysA = await redis.keys(`${prefixA}:*`);
		const keysB = await redis.keys(`${prefixB}:*`);
		expect(keysA.length).toBeGreaterThan(0);
		expect(keysB.length).toBeGreaterThan(0);
		// Cross-leak guard: tenant A keys never carry tenant B's prefix and vice versa.
		expect(keysA.every((k) => k.startsWith(`${prefixA}:`))).toBe(true);
		expect(keysB.every((k) => k.startsWith(`${prefixB}:`))).toBe(true);
		expect(keysA.some((k) => k.startsWith(`${prefixB}:`))).toBe(false);
	}, 30_000);

	it('idempotencyKey dedup: second enqueue with same key returns same id or null', async () => {
		const queueName = `ew-it-idem-${randomUUID()}`;
		const prefix = trackPrefix(`ew-real-${randomUUID().slice(0, 8)}`);
		const idemKey = `idem-${randomUUID()}`;

		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		cleanup.push(() => factory.close());
		const dispatcher = factory.forQueue(queueName);

		const first = await dispatcher.enqueue(queueName, { n: 1 }, { idempotencyKey: idemKey });
		const second = await dispatcher.enqueue(queueName, { n: 2 }, { idempotencyKey: idemKey });

		expect(first).toBeTruthy();
		// BullMQ's dedup semantic: same `jobId` returns the original
		// job's id (older bullmq) or null (newer bullmq).
		expect([first, null]).toContain(second);
	}, 30_000);

	it('cancel before processing: removed job is never handed to the worker', async () => {
		const queueName = `ew-it-cancel-${randomUUID()}`;
		const prefix = trackPrefix(`ew-real-${randomUUID().slice(0, 8)}`);

		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		cleanup.push(() => factory.close());
		const dispatcher = factory.forQueue(queueName);

		// Enqueue with a far-future delay so cancel wins the race.
		const jobId = await dispatcher.dispatch(queueName, { cancelMe: true }, { delay: 60_000 });
		expect(jobId).toBeTruthy();

		const cancelled = await factory.cancel(jobId!);
		expect(cancelled).toBe(true);

		// Now start a worker; give it ~1.5s to confirm nothing arrives.
		const workerHost = new BullMqWorkerHostFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		let received = 0;
		workerHost.register(queueName, async () => {
			received++;
		});
		const handle = await workerHost.start();
		cleanup.push(() => handle.stop());

		await new Promise((r) => setTimeout(r, 1500));
		expect(received).toBe(0);
	}, 30_000);

	it('T31 end-to-end: factory.enqueue stamps opts; worker reads job.opts.tenantId + tags', async () => {
		const queueName = `ew-it-t31-${randomUUID()}`;
		const prefix = trackPrefix(`ew-real-${randomUUID().slice(0, 8)}`);
		const tenantId = `tenant-${randomUUID().slice(0, 8)}`;

		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		cleanup.push(() => factory.close());
		const dispatcher = factory.forQueue(queueName);

		const workerHost = new BullMqWorkerHostFactory(makeDeps(), { connection: REDIS_URL!, prefix });
		let observed: { tenantId?: unknown; tags?: unknown } | null = null;
		let resolveDone: () => void;
		const done = new Promise<void>((r) => (resolveDone = r));
		workerHost.register(queueName, async (job) => {
			const opts = (job as unknown as { opts?: { tenantId?: unknown; tags?: unknown } }).opts;
			observed = { tenantId: opts?.tenantId, tags: opts?.tags };
			resolveDone();
		});
		const handle = await workerHost.start();
		cleanup.push(() => handle.stop());

		const id = await dispatcher.enqueue(
			queueName,
			{ workId: 'w-1' },
			{ tenantId, idempotencyKey: `idem-${randomUUID()}`, tags: ['kb', 'embed'] }
		);
		expect(id).toBeTruthy();
		await done;
		expect(observed).not.toBeNull();
		expect(observed!.tenantId).toBe(tenantId);
		expect(observed!.tags).toEqual(['kb', 'embed']);
	}, 30_000);
});
