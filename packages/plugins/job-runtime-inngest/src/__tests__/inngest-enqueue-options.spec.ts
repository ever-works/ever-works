import { describe, expect, it } from 'vitest';
import type { JobEnqueueOptions } from '@ever-works/plugin';
import { mapEnqueueOptions } from '../inngest-enqueue-options.js';
import { InngestDispatcherFactory } from '../inngest-dispatcher-factory.js';
import type { InngestClient, InngestSendEvent, InngestSendResult } from '../inngest-types.js';

describe('mapEnqueueOptions (EW-742 P4 T31 Inngest stamping)', () => {
	it('idempotencyKey → top-level id', () => {
		expect(mapEnqueueOptions({ idempotencyKey: 'idem-1' })).toEqual({
			topLevel: { id: 'idem-1' },
			dataMeta: {}
		});
	});

	it('tenantId / concurrencyKey / tags / maxDurationSeconds / machineHint → dataMeta', () => {
		expect(
			mapEnqueueOptions({
				tenantId: 't-acme',
				concurrencyKey: 'work-7',
				tags: ['kb'],
				maxDurationSeconds: 900,
				machineHint: 'small-2x'
			})
		).toEqual({
			topLevel: {},
			dataMeta: {
				tenantId: 't-acme',
				concurrencyKey: 'work-7',
				tags: ['kb'],
				maxDurationSeconds: 900,
				machineHint: 'small-2x'
			}
		});
	});

	it('empty input returns empty translation', () => {
		expect(mapEnqueueOptions({})).toEqual({ topLevel: {}, dataMeta: {} });
	});

	it('all fields together', () => {
		const opts: JobEnqueueOptions = {
			idempotencyKey: 'idem-A',
			tenantId: 'tenant-A',
			concurrencyKey: 'work-A',
			tags: ['kb'],
			maxDurationSeconds: 600,
			machineHint: 'medium-1x'
		};
		expect(mapEnqueueOptions(opts)).toEqual({
			topLevel: { id: 'idem-A' },
			dataMeta: {
				tenantId: 'tenant-A',
				concurrencyKey: 'work-A',
				tags: ['kb'],
				maxDurationSeconds: 600,
				machineHint: 'medium-1x'
			}
		});
	});
});

class FakeInngest implements InngestClient {
	sentEvents: (InngestSendEvent | readonly InngestSendEvent[])[] = [];
	private nextId = 1;
	async send(event: InngestSendEvent | readonly InngestSendEvent[]): Promise<InngestSendResult> {
		this.sentEvents.push(event);
		const count = Array.isArray(event) ? event.length : 1;
		const ids = Array.from({ length: count }, () => `evt_${this.nextId++}`);
		return { ids };
	}
}

describe('InngestDispatcherFactory.enqueue (EW-742 P4 T31)', () => {
	it('stamps id + data._ew with translated fields, applies eventNamespace', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });
		const id = await factory.enqueue(
			'kb-embed-document',
			{ workId: 'w7' },
			{ idempotencyKey: 'idem-1', tenantId: 't-acme', tags: ['kb'] }
		);
		expect(id).toBe('evt_1');
		const sent = client.sentEvents[0] as InngestSendEvent;
		expect(sent.name).toBe('ever.works/kb-embed-document');
		expect(sent.id).toBe('idem-1');
		expect(sent.data).toEqual({
			workId: 'w7',
			_ew: { tenantId: 't-acme', tags: ['kb'] }
		});
	});

	it('omits _ew when no dataMeta fields are set', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client });
		await factory.enqueue('evt', { x: 1 }, { idempotencyKey: 'idem' });
		const sent = client.sentEvents[0] as InngestSendEvent;
		expect(sent.data).toEqual({ x: 1 });
	});

	it('extraOverrides shallow-merge OVER translated top-level (operator wins)', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client });
		await factory.enqueue(
			'evt',
			{},
			{ idempotencyKey: 'idem-platform' },
			{ id: 'idem-operator', user: { uid: 'u' } }
		);
		const sent = client.sentEvents[0] as InngestSendEvent;
		expect(sent.id).toBe('idem-operator');
		expect(sent.user).toEqual({ uid: 'u' });
	});

	it('send() path is unchanged', async () => {
		const client = new FakeInngest();
		const factory = new InngestDispatcherFactory({ client });
		await factory.send('evt', { hello: 'world' });
		const sent = client.sentEvents[0] as InngestSendEvent;
		expect(sent).toEqual({ name: 'evt', data: { hello: 'world' } });
	});
});
