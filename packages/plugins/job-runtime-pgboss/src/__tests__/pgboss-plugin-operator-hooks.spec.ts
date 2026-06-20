import { describe, expect, it } from 'vitest';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	PgBossDispatcherFactory,
	PgBossDispatcherNotConfiguredError,
	PgBossJobRuntimePlugin,
	PgBossWorkerHostFactory
} from '../index.js';
import type { PgBossInstance, PgBossJobRecord, PgBossJobView } from '../pgboss-types.js';

class FakeBoss implements PgBossInstance {
	cancelled: string[] = [];
	scheduled: { name: string; cron: string; data: unknown }[] = [];
	stopped = false;
	jobsById = new Map<string, PgBossJobRecord>();

	async send(_name: string, _data: unknown) {
		return 'jb-1';
	}
	async work(
		_name: string,
		_opts: Readonly<Record<string, unknown>>,
		_h: (j: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
	) {
		return 'sub-1';
	}
	async cancel(id: string) {
		this.cancelled.push(id);
	}
	async schedule(name: string, cron: string, data?: unknown) {
		this.scheduled.push({ name, cron, data });
	}
	async getJobById(id: string): Promise<PgBossJobRecord | null> {
		return this.jobsById.get(id) ?? null;
	}
	async start() {
		return undefined;
	}
	async stop() {
		this.stopped = true;
	}
}

const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
	tenantId: '00000000-0000-0000-0000-00000000aaaa',
	providerId: 'pgboss',
	credentialVersion: 1,
	credentials: { schema: 'tenant_acme' },
	...overrides
});

describe('PgBossJobRuntimePlugin — operator hooks', () => {
	it('useDispatchers replaces the throwing stub', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		const plugin = new PgBossJobRuntimePlugin().useDispatchers({
			dispatchKbEmbedDocument: (payload: unknown) => factory.send('kb-embed-document', payload)
		});
		const d = plugin.dispatchers as unknown as {
			dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
		};
		await expect(d.dispatchKbEmbedDocument({ workId: 'w' })).resolves.toBe('jb-1');
	});

	it('without useDispatchers, the throwing stub still fires', () => {
		const plugin = new PgBossJobRuntimePlugin();
		const d = plugin.dispatchers as unknown as { dispatchKbEmbedDocument: () => unknown };
		expect(() => d.dispatchKbEmbedDocument()).toThrow(PgBossDispatcherNotConfiguredError);
	});

	it('startWorkerHost delegates to the worker host factory', async () => {
		const boss = new FakeBoss();
		const wh = new PgBossWorkerHostFactory({ boss });
		wh.register('kb-embed-document', { teamSize: 4 }, async () => undefined);
		const plugin = new PgBossJobRuntimePlugin().useWorkerHostFactory(wh);
		const handle = await plugin.startWorkerHost({});
		await handle.stop();
		expect(boss.stopped).toBe(true);
	});

	it('startWorkerHost without a factory returns a no-op handle', async () => {
		const plugin = new PgBossJobRuntimePlugin();
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it('cancel delegates to dispatcher factory; returns false without it', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		const plugin = new PgBossJobRuntimePlugin().useDispatcherFactory(factory);
		await expect(plugin.cancel('j1')).resolves.toBe(true);
		expect(boss.cancelled).toEqual(['j1']);

		const orphan = new PgBossJobRuntimePlugin();
		await expect(orphan.cancel('j1')).resolves.toBe(false);
	});

	it('getRunStatus projects pg-boss state onto JobRunStatus', async () => {
		const boss = new FakeBoss();
		boss.jobsById.set('j-active', { id: 'j-active', name: 'q', state: 'active' });
		boss.jobsById.set('j-done', { id: 'j-done', name: 'q', state: 'completed' });
		boss.jobsById.set('j-x', { id: 'j-x', name: 'q', state: 'extraterrestrial' });
		const factory = new PgBossDispatcherFactory({ boss });
		const plugin = new PgBossJobRuntimePlugin().useDispatcherFactory(factory);
		await expect(plugin.getRunStatus('j-active')).resolves.toBe('running');
		await expect(plugin.getRunStatus('j-done')).resolves.toBe('completed');
		await expect(plugin.getRunStatus('j-x')).resolves.toBe('unknown');
		await expect(plugin.getRunStatus('missing')).resolves.toBe('unknown');

		const orphan = new PgBossJobRuntimePlugin();
		await expect(orphan.getRunStatus('any')).resolves.toBe('unknown');
	});

	it('registerSchedules delegates to boss.schedule when factory is set', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		const plugin = new PgBossJobRuntimePlugin().useDispatcherFactory(factory);
		await plugin.registerSchedules([
			{ id: 'work-schedule-dispatcher', cron: '* * * * *', payload: { x: 1 } }
		]);
		expect(boss.scheduled).toEqual([
			{ name: 'work-schedule-dispatcher', cron: '* * * * *', data: { x: 1 } }
		]);
	});

	describe('dispatchersBuilder', () => {
		it('bindToTenant view uses tenant-built dispatchers when builder is set', () => {
			const calls: string[] = [];
			const plugin = new PgBossJobRuntimePlugin({
				dispatchersBuilder: (snap): JobRuntimeDispatchers => {
					calls.push(snap.tenantId);
					return {
						dispatchKbEmbedDocument: () => Promise.resolve(`tenant:${snap.tenantId}`)
					};
				}
			});
			const view = plugin.bindToTenant(snapshot());
			expect(calls).toEqual(['00000000-0000-0000-0000-00000000aaaa']);
			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			return expect(d.dispatchKbEmbedDocument()).resolves.toBe('tenant:00000000-0000-0000-0000-00000000aaaa');
		});

		it('falls back to base dispatchers without builder', () => {
			const plugin = new PgBossJobRuntimePlugin().useDispatchers({
				dispatchKbEmbedDocument: () => Promise.resolve('base')
			});
			const view = plugin.bindToTenant(snapshot());
			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			return expect(d.dispatchKbEmbedDocument()).resolves.toBe('base');
		});

		it('useDispatchers clears the tenant view cache', () => {
			const plugin = new PgBossJobRuntimePlugin().useDispatchers({
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
