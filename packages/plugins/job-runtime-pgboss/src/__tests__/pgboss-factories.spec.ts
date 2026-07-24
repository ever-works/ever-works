import { describe, expect, it, vi } from 'vitest';
import { PgBossDispatcherFactory } from '../pgboss-dispatcher-factory.js';
import { PgBossWorkerHostFactory } from '../pgboss-worker-host-factory.js';
import type { PgBossInstance, PgBossJobRecord, PgBossJobView } from '../pgboss-types.js';

/**
 * Operator-side pg-boss is mocked with a minimal fake that records
 * every call. The plugin package never imports `pg-boss` directly.
 */

interface SendCall {
	name: string;
	data: unknown;
	options?: Readonly<Record<string, unknown>>;
}

interface WorkCall {
	name: string;
	options: Readonly<Record<string, unknown>>;
	handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>;
}

class FakeBoss implements PgBossInstance {
	sendCalls: SendCall[] = [];
	workCalls: WorkCall[] = [];
	cancelled: string[] = [];
	scheduled: { name: string; cron: string; data: unknown }[] = [];
	stopped = false;
	private nextId = 1;
	private nextSubId = 1;

	async send(name: string, data: unknown, options?: Readonly<Record<string, unknown>>): Promise<string | null> {
		this.sendCalls.push({ name, data, options });
		return `j${this.nextId++}`;
	}

	async work(
		name: string,
		options: Readonly<Record<string, unknown>>,
		handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
	): Promise<string> {
		this.workCalls.push({ name, options, handler });
		return `sub${this.nextSubId++}`;
	}

	async cancel(_name: string, id: string): Promise<void> {
		this.cancelled.push(id);
	}

	async schedule(name: string, cron: string, data?: unknown): Promise<void> {
		this.scheduled.push({ name, cron, data });
	}

	async getJobById(id: string): Promise<PgBossJobRecord | null> {
		if (id === 'j-active') {
			return { id, name: 'q', state: 'active' };
		}
		if (id === 'j-completed') {
			return { id, name: 'q', state: 'completed' };
		}
		if (id === 'j-cancelled') {
			return { id, name: 'q', state: 'cancelled' };
		}
		if (id === 'j-weird') {
			return { id, name: 'q', state: 'extraterrestrial' };
		}
		return null;
	}

	async start() {
		return undefined;
	}
	async stop() {
		this.stopped = true;
	}
}

describe('PgBossDispatcherFactory', () => {
	it('send merges defaultSendOptions with per-call options', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({
			boss,
			defaultSendOptions: { retryLimit: 3, expireInHours: 1 }
		});
		await factory.send('q1', { hello: 'world' }, { singletonKey: 'k1', retryLimit: 5 });
		expect(boss.sendCalls).toHaveLength(1);
		// Per-call options override defaults field-by-field.
		expect(boss.sendCalls[0].options).toEqual({
			retryLimit: 5,
			expireInHours: 1,
			singletonKey: 'k1'
		});
	});

	it('send returns the pg-boss job id, or null on dedup', async () => {
		const boss = new FakeBoss();
		boss.send = vi.fn(async () => null);
		const factory = new PgBossDispatcherFactory({ boss });
		await expect(factory.send('q1', {})).resolves.toBeNull();
	});

	it('cancel resolves the queue from a prior send, then true on resolve / false on throw', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		// v10 cancel needs the queue name; the dispatcher learns it from the send.
		const id1 = await factory.send('q1', {}); // 'j1'
		await expect(factory.cancel(id1!)).resolves.toBe(true);
		expect(boss.cancelled).toEqual(['j1']);
		const id2 = await factory.send('q1', {}); // 'j2'
		boss.cancel = vi.fn(async () => {
			throw new Error('boom');
		});
		await expect(factory.cancel(id2!)).resolves.toBe(false);
		// A job this dispatcher never sent has no known queue -> false, no throw.
		await expect(factory.cancel('never-sent')).resolves.toBe(false);
	});

	it('getJob returns null when boss.getJobById is absent or throws', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		const job = await factory.getJob('j-active');
		expect(job?.state).toBe('active');

		const minimal = { ...boss, getJobById: undefined } as PgBossInstance;
		const factory2 = new PgBossDispatcherFactory({ boss: minimal });
		await expect(factory2.getJob('any')).resolves.toBeNull();
	});
});

describe('PgBossWorkerHostFactory', () => {
	it('register accumulates registrations without calling boss.work', () => {
		const boss = new FakeBoss();
		const f = new PgBossWorkerHostFactory({ boss });
		f.register('q1', { batchSize: 1 }, async () => undefined);
		f.register('q2', { batchSize: 1 }, async () => undefined);
		expect(f.registrationCount).toBe(2);
		expect(boss.workCalls).toHaveLength(0);
	});

	it('start invokes boss.work for each registration with merged options', async () => {
		const boss = new FakeBoss();
		const f = new PgBossWorkerHostFactory({
			boss,
			defaultWorkOptions: { batchSize: 1, teamRefill: true }
		});
		f.register('q1', { teamSize: 4 }, async () => undefined);
		f.register('q2', {}, async () => undefined);
		await f.start({ concurrency: 8 });
		expect(boss.workCalls.map((w) => w.name)).toEqual(['q1', 'q2']);
		expect(boss.workCalls[0].options).toEqual({
			batchSize: 1,
			teamRefill: true,
			teamSize: 4 // per-call override wins over hostOpts.concurrency
		});
		expect(boss.workCalls[1].options).toEqual({
			batchSize: 1,
			teamRefill: true,
			teamSize: 8 // host concurrency fills in when registration omits teamSize
		});
	});

	it('register after start throws; start twice throws', async () => {
		const boss = new FakeBoss();
		const f = new PgBossWorkerHostFactory({ boss });
		f.register('q1', {}, async () => undefined);
		await f.start();
		expect(() => f.register('q2', {}, async () => undefined)).toThrow(/cannot register/);
		await expect(f.start()).rejects.toThrow(/start\(\) called twice/);
	});

	it('handle.stop calls boss.stop and is idempotent', async () => {
		const boss = new FakeBoss();
		const f = new PgBossWorkerHostFactory({ boss });
		f.register('q1', {}, async () => undefined);
		const handle = await f.start();
		await handle.stop();
		expect(boss.stopped).toBe(true);
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it('AbortSignal triggers stop', async () => {
		const boss = new FakeBoss();
		const f = new PgBossWorkerHostFactory({ boss });
		f.register('q1', {}, async () => undefined);
		const ctrl = new AbortController();
		await f.start({ signal: ctrl.signal });
		ctrl.abort();
		await new Promise((r) => setImmediate(r));
		expect(boss.stopped).toBe(true);
	});
});
