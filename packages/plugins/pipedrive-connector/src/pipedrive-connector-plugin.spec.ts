import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	PipedriveConnectorPlugin,
	asEntityType,
	clampBackfillDays,
	isoToPipedriveTime,
	pipedriveTimeToIso,
	resolveEntityTypes,
	PIPEDRIVE_EVENT_TEXT_MAX_CHARS,
	PIPEDRIVE_BACKFILL_MAX_PAGES,
	PIPEDRIVE_ENTITY_TYPES
} from './pipedrive-connector-plugin.js';

const getCurrentUserMock = vi.fn();
const getRecentsMock = vi.fn();
const addNoteMock = vi.fn();
const addRecordMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestPipedriveConnectorPlugin extends PipedriveConnectorPlugin {
	protected override createClient(apiToken: string) {
		clientFactoryMock(apiToken);
		return {
			getCurrentUser: getCurrentUserMock,
			getRecents: getRecentsMock,
			addNote: addNoteMock,
			addRecord: addRecordMock
		};
	}
}

const SETTINGS = { apiToken: 'pd-secret-token' };

function emptyPage() {
	return { data: [], additional_data: { pagination: { more_items_in_collection: false } } };
}

describe('PipedriveConnectorPlugin', () => {
	let plugin: TestPipedriveConnectorPlugin;

	beforeEach(() => {
		plugin = new TestPipedriveConnectorPlugin();
		getCurrentUserMock.mockReset();
		getRecentsMock.mockReset();
		addNoteMock.mockReset();
		addRecordMock.mockReset();
		clientFactoryMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + connector-pipedrive + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('pipedrive-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-pipedrive');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('pipedrive');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.outboundRecord).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks apiToken as x-secret and bounds backfillDays to 0–90 in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.apiToken['x-secret']).toBe(true);
		expect(props.apiToken['x-envVar']).toBe('PIPEDRIVE_API_TOKEN');
		expect(plugin.settingsSchema.required).toContain('apiToken');
		expect(props.backfillDays.minimum).toBe(0);
		expect(props.backfillDays.maximum).toBe(90);
	});

	it('clampBackfillDays clamps to the 0–90 range and treats garbage as off', () => {
		expect(clampBackfillDays(0)).toBe(0);
		expect(clampBackfillDays(14)).toBe(14);
		expect(clampBackfillDays(500)).toBe(90);
		expect(clampBackfillDays('nope')).toBe(0);
	});

	it('resolveEntityTypes keeps sweep order, drops unknowns and defaults to all three', () => {
		expect(resolveEntityTypes(undefined)).toEqual([...PIPEDRIVE_ENTITY_TYPES]);
		expect(resolveEntityTypes({ entityTypes: 'organizations, deals' })).toEqual(['deals', 'organizations']);
		expect(resolveEntityTypes({ entityTypes: 'nope' })).toEqual([...PIPEDRIVE_ENTITY_TYPES]);
	});

	it('asEntityType narrows only known types', () => {
		expect(asEntityType('Deals')).toBe('deals');
		expect(asEntityType('leads')).toBeUndefined();
		expect(asEntityType(42)).toBeUndefined();
	});

	it('parses Pipedrive UTC timestamps without drifting to local time', () => {
		expect(pipedriveTimeToIso('2026-07-22 10:00:00')).toBe('2026-07-22T10:00:00.000Z');
		expect(pipedriveTimeToIso('2026-07-22T10:00:00Z')).toBe('2026-07-22T10:00:00.000Z');
		expect(pipedriveTimeToIso('garbage')).toBe('1970-01-01T00:00:00.000Z');
		expect(pipedriveTimeToIso(undefined)).toBe('1970-01-01T00:00:00.000Z');
	});

	it('isoToPipedriveTime renders the since_timestamp form the API expects', () => {
		expect(isoToPipedriveTime('2026-07-22T10:00:00.000Z')).toBe('2026-07-22 10:00:00');
		expect(isoToPipedriveTime('nonsense')).toBe('1970-01-01 00:00:00');
	});

	describe('verifyConnection', () => {
		it('returns the current-user details', async () => {
			getCurrentUserMock.mockResolvedValueOnce({
				data: { id: 7, name: 'Ada', company_name: 'Acme', company_domain: 'acme' }
			});
			const res = await plugin.verifyConnection({ apiToken: 'pd-x' }, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ userId: '7', userName: 'Ada', companyDomain: 'acme' });
			expect(clientFactoryMock).toHaveBeenCalledWith('pd-x');
		});

		it('degrades loudly (never silently) when the token is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/apiToken/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});

		it('surfaces the Pipedrive error payload when the probe fails', async () => {
			getCurrentUserMock.mockRejectedValueOnce({ response: { data: { error: 'invalid api token' } } });
			const res = await plugin.verifyConnection({ apiToken: 'pd-x' }, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/invalid api token/);
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('adds a note bound to the resolved deal', async () => {
			addNoteMock.mockResolvedValueOnce({ data: { id: 99 } });
			const res = await plugin.send(
				{
					text: 'call summary',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { recordId: '501' }
				},
				options
			);
			expect(addNoteMock).toHaveBeenCalledWith({ content: 'call summary', deal_id: 501 });
			expect(res.providerMessageId).toBe('99');
			expect(res.provider).toBe('pipedrive-connector');
		});

		it('binds the note to the requested entity type', async () => {
			addNoteMock.mockResolvedValueOnce({ data: { id: 100 } });
			await plugin.send(
				{
					text: 'note',
					messageRef: 'ref-2',
					attribution: { userId: 'u1' },
					target: { recordId: '7', recordType: 'organizations' }
				},
				options
			);
			expect(addNoteMock).toHaveBeenCalledWith({ content: 'note', org_id: 7 });
		});

		it('falls back to the configured default deal id', async () => {
			addNoteMock.mockResolvedValueOnce({ data: { id: 101 } });
			await plugin.send(
				{ text: 'note', messageRef: 'ref-3', attribution: { userId: 'u1' } },
				{ ...options, settings: { ...SETTINGS, defaultDealId: '12' } }
			);
			expect(addNoteMock).toHaveBeenCalledWith({ content: 'note', deal_id: 12 });
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			addNoteMock.mockResolvedValue({ data: { id: 1 } });
			const payload = {
				text: 'once only',
				messageRef: 'ref-dup',
				attribution: { userId: 'u1' },
				target: { recordId: '5' }
			};
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(addNoteMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws a clear error when no record id can be resolved', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, options)
			).rejects.toThrow(/record id is required/);
			expect(addNoteMock).not.toHaveBeenCalled();
		});

		it('throws when the API token is missing instead of silently no-oping', async () => {
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'r', attribution: { userId: 'u1' }, target: { recordId: '1' } },
					{ connectorId: 'c' }
				)
			).rejects.toThrow(/API token is required/);
		});
	});

	describe('createRecord', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('creates the record for the requested collection', async () => {
			addRecordMock.mockResolvedValueOnce({ data: { id: 321 } });
			const res = await plugin.createRecord(
				{ collection: 'persons', fields: { name: 'Ada' }, idempotencyKey: 'k-1' },
				options
			);
			expect(addRecordMock).toHaveBeenCalledWith('persons', { name: 'Ada' });
			expect(res).toEqual({ provider: 'pipedrive-connector', recordId: '321' });
		});

		it('rejects an unsupported collection loudly', async () => {
			await expect(
				plugin.createRecord({ collection: 'leads', fields: {}, idempotencyKey: 'k' }, options)
			).rejects.toThrow(/unsupported collection 'leads'/);
			expect(addRecordMock).not.toHaveBeenCalled();
		});

		it('is idempotent on idempotencyKey', async () => {
			addRecordMock.mockResolvedValue({ data: { id: 1 } });
			const input = { collection: 'deals', fields: { title: 'x' }, idempotencyKey: 'dup' };
			const first = await plugin.createRecord(input, options);
			const second = await plugin.createRecord(input, options);
			expect(addRecordMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws when Pipedrive returns no record id', async () => {
			addRecordMock.mockResolvedValueOnce({ data: {} });
			await expect(
				plugin.createRecord({ collection: 'deals', fields: {}, idempotencyKey: 'k' }, options)
			).rejects.toThrow(/no record id/);
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when the token is missing', async () => {
			await expect(plugin.pullEvents({ since: new Date(0).toISOString(), settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(getRecentsMock).not.toHaveBeenCalled();
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			getRecentsMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			expect(getRecentsMock.mock.calls[0][0]).toMatchObject({
				since_timestamp: '2026-07-25 12:00:00',
				items: 'deal'
			});
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			getRecentsMock.mockResolvedValue(emptyPage());
			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(getRecentsMock.mock.calls[0][0].since_timestamp).toBe('2026-06-25 12:00:00');

			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 500 }
			});
			expect(getRecentsMock.mock.calls[1][0].since_timestamp).toBe('2026-04-26 12:00:00');
		});

		it('a non-first pull keeps the platform watermark as the window', async () => {
			getRecentsMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(getRecentsMock.mock.calls[0][0].since_timestamp).toBe('2026-07-20 00:00:00');
		});

		it('normalizes recents into typed envelopes with subject, deep link and capped fields', async () => {
			getRecentsMock.mockResolvedValueOnce({
				data: [
					{
						item: 'deal',
						id: 501,
						data: {
							id: 501,
							title: 'Q3 renewal',
							status: 'open',
							value: 12000,
							currency: 'USD',
							address: 'a'.repeat(PIPEDRIVE_EVENT_TEXT_MAX_CHARS + 10),
							add_time: '2026-07-21 10:00:00',
							update_time: '2026-07-22 10:00:00',
							owner_id: { id: 3, name: 'Ada' }
						}
					}
				],
				additional_data: { pagination: { more_items_in_collection: false } }
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, companyDomain: 'acme' }
			});
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('pipedrive-connector');
			expect(env.kind).toBe('pipedrive.deal');
			expect(env.sourceEventId).toBe('deals:501:2026-07-22T10:00:00.000Z');
			expect(env.occurredAt).toBe('2026-07-22T10:00:00.000Z');
			expect(env.subject).toEqual({ type: 'crm-record', externalId: '501', title: 'Q3 renewal' });
			expect(env.sourceUrl).toBe('https://acme.pipedrive.com/deal/501');
			expect(env.payload.changeType).toBe('created');
			const fields = env.payload.fields as Record<string, unknown>;
			expect(fields.value).toBe(12000);
			// Nested expansions (owner_id object) and non-whitelisted fields are dropped.
			expect(fields.owner_id).toBeUndefined();
			expect(fields.address).toBeUndefined();
			// The API token must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.apiToken);
		});

		it('omits the deep link when no companyDomain is configured', async () => {
			getRecentsMock.mockResolvedValueOnce({
				data: [{ item: 'deal', id: 1, data: { id: 1, update_time: '2026-07-22 10:00:00' } }],
				additional_data: { pagination: { more_items_in_collection: false } }
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events[0].sourceUrl).toBeUndefined();
		});

		it('pages within an entity type and keeps the SAME window across pages', async () => {
			getRecentsMock.mockResolvedValueOnce({
				data: [],
				additional_data: { pagination: { more_items_in_collection: true, next_start: 50 } }
			});
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			const parsed = JSON.parse(first.nextCursor as string);
			expect(parsed).toMatchObject({ t: 'deals', n: 50, s: '2026-07-20T00:00:00.000Z' });

			getRecentsMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			expect(getRecentsMock.mock.calls[1][0]).toMatchObject({
				start: 50,
				since_timestamp: '2026-07-20 00:00:00'
			});
		});

		it('advances deals → persons → organizations → done across the sweep', async () => {
			getRecentsMock.mockResolvedValue(emptyPage());
			const afterDeals = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(JSON.parse(afterDeals.nextCursor as string).t).toBe('persons');

			const afterPersons = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterDeals.nextCursor,
				settings: SETTINGS
			});
			expect(JSON.parse(afterPersons.nextCursor as string).t).toBe('organizations');
			expect(getRecentsMock.mock.calls[1][0].items).toBe('person');

			const afterOrgs = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterPersons.nextCursor,
				settings: SETTINGS
			});
			expect(afterOrgs.nextCursor).toBeUndefined();
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			getRecentsMock.mockResolvedValueOnce({
				data: [],
				additional_data: { pagination: { more_items_in_collection: true, next_start: 900 } }
			});
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					t: 'deals',
					n: 850,
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: PIPEDRIVE_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed.t).toBe('persons');
			expect(parsed.n).toBeUndefined();
			expect(parsed.b).toBe(0);
		});

		it('restarts at the first type when the cursor names a type dropped from settings', async () => {
			getRecentsMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: JSON.stringify({ t: 'organizations', n: 10, s: '2026-07-20T00:00:00.000Z' }),
				settings: { ...SETTINGS, entityTypes: 'deals' }
			});
			expect(getRecentsMock.mock.calls[0][0].items).toBe('deal');
			expect(getRecentsMock.mock.calls[0][0].start).toBeUndefined();
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			getRecentsMock.mockResolvedValueOnce(emptyPage());
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: SETTINGS
			});
			expect(getRecentsMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});

		it('skips a recents entry with no resolvable id', async () => {
			getRecentsMock.mockResolvedValueOnce({
				data: [{ item: 'deal', data: { title: 'orphan' } }],
				additional_data: { pagination: { more_items_in_collection: false } }
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toEqual([]);
		});
	});
});
