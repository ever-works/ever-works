import { describe, expect, it } from 'vitest';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	BullMqDispatcherFactory,
	BullMqDispatcherNotConfiguredError,
	BullMqJobRuntimePlugin,
	BullMqWorkerHostFactory
} from '../index.js';
import type { BullMqDeps, BullMqQueueAdapter, BullMqWorkerAdapter } from '../bullmq-types.js';

class FakeQueue implements BullMqQueueAdapter {
	static instances: FakeQueue[] = [];
	readonly jobs = new Map<string, { remove: () => Promise<void>; getState: () => Promise<string> }>();
	constructor(public readonly name: string, public readonly opts: Readonly<Record<string, unknown>>) {
		FakeQueue.instances.push(this);
	}
	async add(_: string, __: unknown) {
		const id = 'id-1';
		this.jobs.set(id, {
			remove: async () => {
				this.jobs.delete(id);
			},
			getState: async () => 'waiting'
		});
		return { id };
	}
	async getJob(id: string) {
		return this.jobs.get(id);
	}
	async close() {
		// noop
	}
}

class FakeWorker implements BullMqWorkerAdapter {
	static instances: FakeWorker[] = [];
	closed = false;
	constructor(public readonly name: string, public readonly fn: unknown, public readonly opts: unknown) {
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
	Queue: FakeQueue as unknown as BullMqDeps['Queue'],
	Worker: FakeWorker as unknown as BullMqDeps['Worker']
});

const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
	tenantId: '00000000-0000-0000-0000-00000000aaaa',
	providerId: 'bullmq',
	credentialVersion: 1,
	credentials: { queuePrefix: 'tenant-acme' },
	...overrides
});

describe('BullMqJobRuntimePlugin — operator hooks', () => {
	it('useDispatchers replaces the throwing stub with the operator map', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const kbEmbed = factory.forQueue('kb-embed-document');
		const plugin = new BullMqJobRuntimePlugin().useDispatchers({
			dispatchKbEmbedDocument: (payload: unknown) => kbEmbed.dispatch('kb-embed-document', payload)
		});
		const d = plugin.dispatchers as unknown as {
			dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
			dispatchKbMirror?: (p: unknown) => unknown;
		};
		await expect(d.dispatchKbEmbedDocument({ workId: 'w1' })).resolves.toBe('id-1');
		// Methods not in the operator map are simply undefined (no throwing proxy anymore).
		expect(d.dispatchKbMirror).toBeUndefined();
	});

	it('without useDispatchers, the throwing stub still fires', () => {
		const plugin = new BullMqJobRuntimePlugin();
		const d = plugin.dispatchers as unknown as { dispatchKbEmbedDocument: () => unknown };
		expect(() => d.dispatchKbEmbedDocument()).toThrow(BullMqDispatcherNotConfiguredError);
	});

	it('useWorkerHostFactory: startWorkerHost starts the registered workers and stop closes them', async () => {
		FakeWorker.instances = [];
		const workerHost = new BullMqWorkerHostFactory(makeDeps(), { connection: 'r' });
		workerHost.register('kb-embed-document', async () => undefined);
		const plugin = new BullMqJobRuntimePlugin().useWorkerHostFactory(workerHost);
		const handle = await plugin.startWorkerHost({ concurrency: 2 });
		expect(FakeWorker.instances).toHaveLength(1);
		await handle.stop();
		expect(FakeWorker.instances[0].closed).toBe(true);
	});

	it('startWorkerHost without a factory returns a no-op handle', async () => {
		const plugin = new BullMqJobRuntimePlugin();
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it('useDispatcherFactory wires cancel through to the factory', async () => {
		FakeQueue.instances = [];
		const factory = new BullMqDispatcherFactory(makeDeps(), { connection: 'r' });
		const d = factory.forQueue('kb-embed-document');
		const id = await d.dispatch('kb-embed-document', { workId: 'w1' });
		expect(id).toBe('id-1');
		const plugin = new BullMqJobRuntimePlugin().useDispatcherFactory(factory);
		await expect(plugin.cancel(id as string)).resolves.toBe(true);
		await expect(plugin.cancel('unknown')).resolves.toBe(false);
	});

	describe('dispatchersBuilder — per-tenant dispatcher routing', () => {
		it('bindToTenant view uses tenant-built dispatchers when the hook is set', () => {
			const callsByTenant: string[] = [];
			const plugin = new BullMqJobRuntimePlugin({
				dispatchersBuilder: (snap): JobRuntimeDispatchers => {
					callsByTenant.push(snap.tenantId);
					return {
						dispatchKbEmbedDocument: () => Promise.resolve(`tenant:${snap.tenantId}`)
					};
				}
			});
			const view = plugin.bindToTenant(snapshot());
			expect(callsByTenant).toEqual(['00000000-0000-0000-0000-00000000aaaa']);
			const dispatchers = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			return expect(dispatchers.dispatchKbEmbedDocument()).resolves.toBe(
				'tenant:00000000-0000-0000-0000-00000000aaaa'
			);
		});

		it('bindToTenant view falls back to base dispatchers when no builder is set', () => {
			const plugin = new BullMqJobRuntimePlugin().useDispatchers({
				dispatchKbEmbedDocument: () => Promise.resolve('base')
			});
			const view = plugin.bindToTenant(snapshot());
			const dispatchers = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			return expect(dispatchers.dispatchKbEmbedDocument()).resolves.toBe('base');
		});

		it('useDispatchers clears the tenant view cache so subsequent binds see the new map', () => {
			const plugin = new BullMqJobRuntimePlugin().useDispatchers({
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
