import { describe, expect, it } from 'vitest';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	TriggerDispatcherFactory,
	TriggerDispatcherNotConfiguredError,
	TriggerJobRuntimePlugin,
	mapTriggerStatus
} from '../index.js';
import type { TriggerClient, TriggerRunHandle, TriggerRunRecord, TriggerTaskOptions } from '../trigger-types.js';

class StubTrigger implements TriggerClient {
	triggeredTasks: string[] = [];
	cancelCalls: string[] = [];
	retrieveCalls: string[] = [];
	retrieveStatus = 'EXECUTING';
	cancelShouldThrow = false;
	retrieveShouldThrow = false;
	private nextId = 1;

	readonly tasks = {
		trigger: async (
			taskId: string,
			_payload: unknown,
			_options?: TriggerTaskOptions
		): Promise<TriggerRunHandle> => {
			this.triggeredTasks.push(taskId);
			return { id: `run_${this.nextId++}` };
		}
	};

	readonly runs = {
		cancel: async (runId: string): Promise<unknown> => {
			this.cancelCalls.push(runId);
			if (this.cancelShouldThrow) throw new Error('boom');
			return undefined;
		},
		retrieve: async (runId: string): Promise<TriggerRunRecord> => {
			this.retrieveCalls.push(runId);
			if (this.retrieveShouldThrow) throw new Error('boom');
			return { id: runId, status: this.retrieveStatus };
		}
	};
}

const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
	tenantId: '00000000-0000-0000-0000-00000000aaaa',
	providerId: 'trigger',
	credentialVersion: 1,
	credentials: { projectAccessToken: 'tr_pat_tenant_a', projectRef: 'proj_a' },
	...overrides
});

describe('TriggerJobRuntimePlugin — operator hooks', () => {
	it('useDispatchers replaces the throwing stub', async () => {
		const client = new StubTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		const plugin = new TriggerJobRuntimePlugin().useDispatchers({
			dispatchKbEmbedDocument: (payload: unknown) => factory.dispatch('kb-embed-document', payload)
		});
		const d = plugin.dispatchers as unknown as {
			dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
		};
		await expect(d.dispatchKbEmbedDocument({ workId: 'w' })).resolves.toBe('run_1');
		expect(client.triggeredTasks).toEqual(['kb-embed-document']);
	});

	it('without useDispatchers the throwing stub still fires', () => {
		const plugin = new TriggerJobRuntimePlugin();
		const d = plugin.dispatchers as unknown as { dispatchKbEmbedDocument: () => unknown };
		expect(() => d.dispatchKbEmbedDocument()).toThrow(TriggerDispatcherNotConfiguredError);
	});

	it('useDispatcherFactory holds the factory reference', () => {
		const client = new StubTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		const plugin = new TriggerJobRuntimePlugin().useDispatcherFactory(factory);
		expect(plugin.factory).toBe(factory);
	});

	it('factory is null without useDispatcherFactory', () => {
		const plugin = new TriggerJobRuntimePlugin();
		expect(plugin.factory).toBeNull();
	});

	it('startWorkerHost is no-op even with factory wired (push-model)', async () => {
		const client = new StubTrigger();
		const factory = new TriggerDispatcherFactory({ client });
		const plugin = new TriggerJobRuntimePlugin().useDispatcherFactory(factory);
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	describe('cancel / getRunStatus', () => {
		it('return safe defaults without a client opt', async () => {
			const plugin = new TriggerJobRuntimePlugin();
			await expect(plugin.cancel('any')).resolves.toBe(false);
			await expect(plugin.getRunStatus('any')).resolves.toBe('unknown');
		});

		it('cancel forwards to client.runs.cancel when client is wired', async () => {
			const client = new StubTrigger();
			const plugin = new TriggerJobRuntimePlugin({ client });
			await expect(plugin.cancel('run_42')).resolves.toBe(true);
			expect(client.cancelCalls).toEqual(['run_42']);
		});

		it('cancel returns false when the SDK throws', async () => {
			const client = new StubTrigger();
			client.cancelShouldThrow = true;
			const plugin = new TriggerJobRuntimePlugin({ client });
			await expect(plugin.cancel('run_42')).resolves.toBe(false);
		});

		it('getRunStatus projects SDK status through mapTriggerStatus', async () => {
			const client = new StubTrigger();
			client.retrieveStatus = 'EXECUTING';
			const plugin = new TriggerJobRuntimePlugin({ client });
			await expect(plugin.getRunStatus('run_1')).resolves.toBe('running');

			client.retrieveStatus = 'COMPLETED';
			await expect(plugin.getRunStatus('run_2')).resolves.toBe('completed');

			client.retrieveStatus = 'CANCELED';
			await expect(plugin.getRunStatus('run_3')).resolves.toBe('cancelled');

			client.retrieveStatus = 'SYSTEM_FAILURE';
			await expect(plugin.getRunStatus('run_4')).resolves.toBe('failed');

			client.retrieveStatus = 'QUEUED';
			await expect(plugin.getRunStatus('run_5')).resolves.toBe('queued');

			client.retrieveStatus = 'NEW_FUTURE_STATUS';
			await expect(plugin.getRunStatus('run_6')).resolves.toBe('unknown');
		});

		it('getRunStatus returns "unknown" when the SDK throws', async () => {
			const client = new StubTrigger();
			client.retrieveShouldThrow = true;
			const plugin = new TriggerJobRuntimePlugin({ client });
			await expect(plugin.getRunStatus('run_1')).resolves.toBe('unknown');
		});
	});

	describe('mapTriggerStatus', () => {
		it('maps all canonical SDK v4 status values', () => {
			expect(mapTriggerStatus('QUEUED')).toBe('queued');
			expect(mapTriggerStatus('DEQUEUED')).toBe('queued');
			expect(mapTriggerStatus('WAITING')).toBe('queued');
			expect(mapTriggerStatus('DELAYED')).toBe('queued');
			expect(mapTriggerStatus('PENDING_VERSION')).toBe('queued');
			expect(mapTriggerStatus('EXECUTING')).toBe('running');
			expect(mapTriggerStatus('REATTEMPTING')).toBe('running');
			expect(mapTriggerStatus('COMPLETED')).toBe('completed');
			expect(mapTriggerStatus('COMPLETED_SUCCESSFULLY')).toBe('completed');
			expect(mapTriggerStatus('CANCELED')).toBe('cancelled');
			expect(mapTriggerStatus('FAILED')).toBe('failed');
			expect(mapTriggerStatus('CRASHED')).toBe('failed');
			expect(mapTriggerStatus('SYSTEM_FAILURE')).toBe('failed');
			expect(mapTriggerStatus('TIMED_OUT')).toBe('failed');
			expect(mapTriggerStatus('EXPIRED')).toBe('failed');
			expect(mapTriggerStatus('COMPLETED_WITH_ERRORS')).toBe('failed');
		});

		it('falls back to "unknown" for unrecognised statuses', () => {
			expect(mapTriggerStatus('SOMETHING_NEW')).toBe('unknown');
			expect(mapTriggerStatus('')).toBe('unknown');
		});
	});

	describe('bindToTenant', () => {
		it('exposes tenantProjectAccessToken from snapshot.credentials', () => {
			const plugin = new TriggerJobRuntimePlugin();
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantProjectAccessToken).toBe('tr_pat_tenant_a');
			expect(view.tenantSnapshot.tenantId).toBe(snapshot().tenantId);
			expect(Object.isFrozen(view)).toBe(true);
		});

		it('null projectAccessToken when credentials are absent', () => {
			const plugin = new TriggerJobRuntimePlugin();
			const view = plugin.bindToTenant(snapshot({ credentials: {} }));
			expect(view.tenantProjectAccessToken).toBeNull();
		});

		it('memoises on (tenantId, credentialVersion)', () => {
			const plugin = new TriggerJobRuntimePlugin();
			const a = plugin.bindToTenant(snapshot());
			const b = plugin.bindToTenant(snapshot());
			expect(b).toBe(a);
		});

		it('evicts older view on credentialVersion bump', () => {
			const plugin = new TriggerJobRuntimePlugin();
			const v1 = plugin.bindToTenant(snapshot({ credentialVersion: 1 }));
			const v2 = plugin.bindToTenant(snapshot({ credentialVersion: 2 }));
			expect(v2).not.toBe(v1);
		});

		it('view.bindToTenant(self) returns self', () => {
			const plugin = new TriggerJobRuntimePlugin();
			const view = plugin.bindToTenant(snapshot());
			expect(view.bindToTenant?.(snapshot())).toBe(view);
		});

		it('view uses tenant-built dispatchers when builder is set', async () => {
			const plugin = new TriggerJobRuntimePlugin({
				dispatchersBuilder: (snap): JobRuntimeDispatchers => ({
					dispatchKbEmbedDocument: () => Promise.resolve(`tenant:${snap.credentials.projectAccessToken}`)
				})
			});
			const view = plugin.bindToTenant(snapshot());
			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			await expect(d.dispatchKbEmbedDocument()).resolves.toBe('tenant:tr_pat_tenant_a');
		});

		it('useDispatchers clears the tenant view cache', () => {
			const plugin = new TriggerJobRuntimePlugin().useDispatchers({
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
