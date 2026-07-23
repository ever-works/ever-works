import { describe, expect, it, vi } from 'vitest';
import type { JobEnqueueOptions } from '@ever-works/plugin';
import { mapEnqueueOptions } from '../pgboss-enqueue-options.js';
import { PgBossDispatcherFactory } from '../pgboss-dispatcher-factory.js';
import type { PgBossInstance, PgBossJobView } from '../pgboss-types.js';

describe('mapEnqueueOptions (EW-742 P4 T31 pg-boss stamping)', () => {
	it('translates idempotencyKey → sendOptions.singletonKey', () => {
		expect(mapEnqueueOptions({ idempotencyKey: 'idem-1' })).toEqual({
			sendOptions: { singletonKey: 'idem-1', singletonSeconds: 21_600 },
			metaForPayload: {}
		});
	});

	it('translates maxDurationSeconds → sendOptions.expireInSeconds', () => {
		expect(mapEnqueueOptions({ maxDurationSeconds: 600 })).toEqual({
			sendOptions: { expireInSeconds: 600 },
			metaForPayload: {}
		});
	});

	it('translates tenantId / concurrencyKey / tags / machineHint → payload._ew namespace', () => {
		const out = mapEnqueueOptions({
			tenantId: 't-acme',
			concurrencyKey: 'work-7',
			tags: ['kb'],
			machineHint: 'small-2x'
		});
		expect(out).toEqual({
			sendOptions: {},
			metaForPayload: {
				_ew: {
					tenantId: 't-acme',
					concurrencyKey: 'work-7',
					tags: ['kb'],
					machineHint: 'small-2x'
				}
			}
		});
	});

	it('omits the _ew namespace entirely when no meta fields are set', () => {
		const out = mapEnqueueOptions({ idempotencyKey: 'idem' });
		expect(out.metaForPayload).toEqual({});
	});

	it('omits undefined fields (no noisy keys)', () => {
		const out = mapEnqueueOptions({ tenantId: 't' });
		expect(out.metaForPayload).toEqual({ _ew: { tenantId: 't' } });
		expect(out.sendOptions).toEqual({});
	});

	it('translates all fields together', () => {
		const opts: JobEnqueueOptions = {
			idempotencyKey: 'idem-A',
			tenantId: 'tenant-A',
			concurrencyKey: 'work-A',
			tags: ['kb'],
			maxDurationSeconds: 600,
			machineHint: 'medium-1x'
		};
		expect(mapEnqueueOptions(opts)).toEqual({
			sendOptions: { singletonKey: 'idem-A', expireInSeconds: 600, singletonSeconds: 21_600 },
			metaForPayload: {
				_ew: {
					tenantId: 'tenant-A',
					concurrencyKey: 'work-A',
					tags: ['kb'],
					machineHint: 'medium-1x'
				}
			}
		});
	});
});

describe('PgBossDispatcherFactory.enqueue (EW-742 P4 T31)', () => {
	class FakeBoss implements PgBossInstance {
		sendCalls: { name: string; data: unknown; options?: Readonly<Record<string, unknown>> }[] = [];
		async send(name: string, data: unknown, options?: Readonly<Record<string, unknown>>) {
			this.sendCalls.push({ name, data, options });
			return 'jb-1';
		}
		async work(
			_n: string,
			_o: Readonly<Record<string, unknown>>,
			_h: (j: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
		) {
			return 'sub-1';
		}
		async cancel() {
			// noop
		}
		async start() {
			return undefined;
		}
		async stop() {
			// noop
		}
	}

	it('translates JobEnqueueOptions onto sendOptions + payload._ew', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		const id = await factory.enqueue(
			'kb-embed',
			{ workId: 'w7' },
			{
				idempotencyKey: 'idem-1',
				tenantId: 't-acme',
				maxDurationSeconds: 900,
				tags: ['kb']
			}
		);
		expect(id).toBe('jb-1');
		expect(boss.sendCalls[0]).toEqual({
			name: 'kb-embed',
			data: {
				workId: 'w7',
				_ew: { tenantId: 't-acme', tags: ['kb'] }
			},
			options: { singletonKey: 'idem-1', expireInSeconds: 900, singletonSeconds: 21_600 }
		});
	});

	it('defaultSendOptions merge under translated sendOptions', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({
			boss,
			defaultSendOptions: { retryLimit: 3, expireInSeconds: 60 }
		});
		await factory.enqueue('q', { x: 1 }, { maxDurationSeconds: 900 });
		expect(boss.sendCalls[0].options).toEqual({
			retryLimit: 3,
			expireInSeconds: 900 // translation overrides the default
		});
	});

	it('extraOpts shallow-merge OVER translated sendOptions (operator wins)', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		await factory.enqueue(
			'q',
			{ x: 1 },
			{ idempotencyKey: 'idem-platform' },
			{ singletonKey: 'idem-operator', retryLimit: 5 }
		);
		expect(boss.sendCalls[0].options).toEqual({
			singletonKey: 'idem-operator',
			singletonSeconds: 21_600,
			retryLimit: 5
		});
	});

	it('send() path is unchanged — no JobEnqueueOptions translation', async () => {
		const boss = new FakeBoss();
		const sendSpy = vi.spyOn(boss, 'send');
		const factory = new PgBossDispatcherFactory({ boss });
		await factory.send('q', { x: 1 }, { singletonKey: 'raw' });
		expect(sendSpy).toHaveBeenCalledWith('q', { x: 1 }, { singletonKey: 'raw' });
	});

	it('null payload becomes {} + _ew namespace when present', async () => {
		const boss = new FakeBoss();
		const factory = new PgBossDispatcherFactory({ boss });
		await factory.enqueue('q', null, { tenantId: 't' });
		expect(boss.sendCalls[0].data).toEqual({ _ew: { tenantId: 't' } });
	});
});
