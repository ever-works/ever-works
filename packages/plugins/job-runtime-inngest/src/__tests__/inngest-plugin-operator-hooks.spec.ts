import { describe, expect, it } from 'vitest';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	InngestDispatcherFactory,
	InngestDispatcherNotConfiguredError,
	InngestJobRuntimePlugin
} from '../index.js';
import type { InngestClient, InngestSendEvent, InngestSendResult, InngestFunction } from '../inngest-types.js';

class StubInngest implements InngestClient {
	sentNames: string[] = [];
	createdCount = 0;
	private nextId = 1;

	async send(event: InngestSendEvent | readonly InngestSendEvent[]): Promise<InngestSendResult> {
		const events = Array.isArray(event) ? event : [event as InngestSendEvent];
		for (const e of events) this.sentNames.push(e.name);
		return { ids: events.map(() => `evt_${this.nextId++}`) };
	}
	createFunction(): InngestFunction {
		this.createdCount += 1;
		return { id: this.createdCount };
	}
}

const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
	tenantId: '00000000-0000-0000-0000-00000000aaaa',
	providerId: 'inngest',
	credentialVersion: 1,
	credentials: { eventKey: 'ek-tenant', signingKey: 'sk-tenant' },
	...overrides
});

describe('InngestJobRuntimePlugin — operator hooks', () => {
	it('useDispatchers replaces the throwing stub', async () => {
		const client = new StubInngest();
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });
		const plugin = new InngestJobRuntimePlugin().useDispatchers({
			dispatchKbEmbedDocument: (payload: unknown) =>
				factory.send('kb-embed-document', payload)
		});
		const d = plugin.dispatchers as unknown as {
			dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
		};
		await expect(d.dispatchKbEmbedDocument({ workId: 'w' })).resolves.toBe('evt_1');
		expect(client.sentNames).toEqual(['ever.works/kb-embed-document']);
	});

	it('without useDispatchers the throwing stub still fires', () => {
		const plugin = new InngestJobRuntimePlugin();
		const d = plugin.dispatchers as unknown as { dispatchKbEmbedDocument: () => unknown };
		expect(() => d.dispatchKbEmbedDocument()).toThrow(InngestDispatcherNotConfiguredError);
	});

	it('plugin.functions surfaces factory-registered functions', () => {
		const client = new StubInngest();
		const factory = new InngestDispatcherFactory({ client });
		factory.defineFunction({ id: 'f1' }, { event: 'ew/f1' }, async () => undefined);
		factory.defineFunction({ id: 'f2' }, { event: 'ew/f2' }, async () => undefined);
		const plugin = new InngestJobRuntimePlugin().useDispatcherFactory(factory);
		expect(plugin.functions).toHaveLength(2);
	});

	it('plugin.functions empty without a factory', () => {
		const plugin = new InngestJobRuntimePlugin();
		expect(plugin.functions).toEqual([]);
	});

	it('startWorkerHost is no-op even with factory wired (serverless model)', async () => {
		const client = new StubInngest();
		const factory = new InngestDispatcherFactory({ client });
		const plugin = new InngestJobRuntimePlugin().useDispatcherFactory(factory);
		const handle = await plugin.startWorkerHost({});
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it('cancel and getRunStatus return safe defaults (Inngest exposes via REST not the SDK)', async () => {
		const plugin = new InngestJobRuntimePlugin();
		await expect(plugin.cancel('any')).resolves.toBe(false);
		await expect(plugin.getRunStatus('any')).resolves.toBe('unknown');
	});

	describe('dispatchersBuilder', () => {
		it('bindToTenant view uses tenant-built dispatchers when builder set', () => {
			const plugin = new InngestJobRuntimePlugin({
				dispatchersBuilder: (snap): JobRuntimeDispatchers => ({
					dispatchKbEmbedDocument: () => Promise.resolve(`tenant:${snap.credentials.eventKey}`)
				})
			});
			const view = plugin.bindToTenant(snapshot());
			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			return expect(d.dispatchKbEmbedDocument()).resolves.toBe('tenant:ek-tenant');
		});

		it('useDispatchers clears the tenant view cache', () => {
			const plugin = new InngestJobRuntimePlugin().useDispatchers({
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
