import { describe, expect, it, vi } from 'vitest';
import { InngestDispatcherFactory } from '../inngest-dispatcher-factory.js';
import type { InngestClient, InngestFunction, InngestSendEvent, InngestSendResult } from '../inngest-types.js';

class FakeInngest implements InngestClient {
	sendCalls: (InngestSendEvent | readonly InngestSendEvent[])[] = [];
	createFunctionCalls: { config: unknown; trigger: unknown }[] = [];
	private nextId = 1;

	async send(event: InngestSendEvent | readonly InngestSendEvent[]): Promise<InngestSendResult> {
		this.sendCalls.push(event);
		const count = Array.isArray(event) ? event.length : 1;
		const ids = Array.from({ length: count }, () => `evt_${this.nextId++}`);
		return { ids };
	}

	createFunction(
		config: Readonly<Record<string, unknown>>,
		trigger: Readonly<Record<string, unknown>>,
		_handler: (...args: unknown[]) => Promise<unknown>
	): InngestFunction {
		this.createFunctionCalls.push({ config, trigger });
		return { __fn: config['id'] };
	}
}

describe('InngestDispatcherFactory', () => {
	it('send prepends eventNamespace and returns the first event id', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });
		const id = await factory.send('kb-embed-document', { workId: 'w1' });
		expect(id).toBe('evt_1');
		expect(client.sendCalls[0]).toEqual({
			name: 'ever.works/kb-embed-document',
			data: { workId: 'w1' }
		});
	});

	it('send without namespace uses the raw event name', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client });
		await factory.send('raw.event', { x: 1 });
		expect(client.sendCalls[0]).toEqual({ name: 'raw.event', data: { x: 1 } });
	});

	it('send merges overrides (id, user) into the event', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client });
		await factory.send('evt', { x: 1 }, { id: 'idem-1', user: { uid: 'u' } });
		const sent = client.sendCalls[0] as InngestSendEvent;
		expect(sent.id).toBe('idem-1');
		expect(sent.user).toEqual({ uid: 'u' });
	});

	it('send returns null when client returns no ids', async () => {
		const client = new FakeInngest();
		client.send = vi.fn(async () => ({ ids: [] }));
		const factory = new InngestDispatcherFactory({ client });
		await expect(factory.send('evt', {})).resolves.toBeNull();
	});

	it('sendBatch namespaces every event and returns ids', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ew' });
		const ids = await factory.sendBatch([
			{ name: 'evt-a', data: { x: 1 } },
			{ name: 'evt-b', data: { x: 2 } }
		]);
		expect(ids).toEqual(['evt_1', 'evt_2']);
		expect(client.sendCalls[0]).toEqual([
			{ name: 'ew/evt-a', data: { x: 1 } },
			{ name: 'ew/evt-b', data: { x: 2 } }
		]);
	});

	it('defineFunction registers + collects functions for serve()', () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client });
		const fn = factory.defineFunction(
			{ id: 'kb-embed-document' },
			{ event: 'ever.works/kb-embed-document' },
			async () => undefined
		);
		expect(client.createFunctionCalls).toHaveLength(1);
		expect(client.createFunctionCalls[0].config).toEqual({ id: 'kb-embed-document' });
		expect(factory.functions).toEqual([fn]);
	});

	it('defineFunction throws when client.createFunction is missing', () => {
		const minimal: InngestClient = {
			async send() {
				return { ids: [] };
			}
		};
		const factory = new InngestDispatcherFactory({ client: minimal });
		expect(() => factory.defineFunction({ id: 'x' }, { event: 'x' }, async () => undefined)).toThrow(
			/createFunction is unavailable/
		);
	});
});
