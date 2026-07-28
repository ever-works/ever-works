import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	HubSpotConnectorPlugin,
	clampBackfillDays,
	objectMeta,
	recordTitle,
	resolveObjectTypes,
	HUBSPOT_EVENT_TEXT_MAX_CHARS,
	HUBSPOT_BACKFILL_MAX_PAGES,
	HUBSPOT_DEFAULT_OBJECT_TYPES
} from './hubspot-connector-plugin.js';

const createMock = vi.fn();
const getPageMock = vi.fn();
const doSearchMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestHubSpotConnectorPlugin extends HubSpotConnectorPlugin {
	protected override createClient(accessToken: string) {
		clientFactoryMock(accessToken);
		return {
			crm: {
				objects: {
					basicApi: { create: createMock, getPage: getPageMock },
					searchApi: { doSearch: doSearchMock }
				}
			}
		};
	}
}

const SETTINGS = { accessToken: 'pat-na1-secret-123' };

function emptyPage() {
	return { results: [] };
}

describe('HubSpotConnectorPlugin', () => {
	let plugin: TestHubSpotConnectorPlugin;

	beforeEach(() => {
		plugin = new TestHubSpotConnectorPlugin();
		createMock.mockReset();
		getPageMock.mockReset();
		doSearchMock.mockReset();
		clientFactoryMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + connector-hubspot + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('hubspot-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-hubspot');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('hubspot');
		expect(plugin.connector.direction).toBe('outbound');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.outboundRecord).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks accessToken as x-secret and bounds backfillDays to 0–90 in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.accessToken['x-secret']).toBe(true);
		expect(props.accessToken['x-envVar']).toBe('HUBSPOT_ACCESS_TOKEN');
		expect(plugin.settingsSchema.required).toContain('accessToken');
		expect(props.backfillDays.default).toBe(0);
		expect(props.backfillDays.minimum).toBe(0);
		expect(props.backfillDays.maximum).toBe(90);
	});

	it('clampBackfillDays clamps to the 0–90 range and treats garbage as off', () => {
		expect(clampBackfillDays(0)).toBe(0);
		expect(clampBackfillDays(-5)).toBe(0);
		expect(clampBackfillDays(30)).toBe(30);
		expect(clampBackfillDays(90.9)).toBe(90);
		expect(clampBackfillDays(500)).toBe(90);
		expect(clampBackfillDays('nope')).toBe(0);
		expect(clampBackfillDays(undefined)).toBe(0);
	});

	it('resolveObjectTypes defaults to contacts/companies/deals and parses a custom list', () => {
		expect(resolveObjectTypes(undefined)).toEqual([...HUBSPOT_DEFAULT_OBJECT_TYPES]);
		expect(resolveObjectTypes({ objectTypes: '   ' })).toEqual([...HUBSPOT_DEFAULT_OBJECT_TYPES]);
		expect(resolveObjectTypes({ objectTypes: 'deals, tickets' })).toEqual(['deals', 'tickets']);
	});

	it('objectMeta falls back to the generic custom-object shape', () => {
		expect(objectMeta('contacts').lastModifiedProperty).toBe('lastmodifieddate');
		expect(objectMeta('deals').lastModifiedProperty).toBe('hs_lastmodifieddate');
		const custom = objectMeta('p_widgets');
		expect(custom.kind).toBe('hubspot.record');
		expect(custom.noteAssociationTypeId).toBeUndefined();
	});

	it('recordTitle picks the per-type human label', () => {
		expect(recordTitle('contacts', { firstname: 'Ada', lastname: 'Lovelace' })).toBe('Ada Lovelace');
		expect(recordTitle('contacts', { email: 'ada@acme.dev' })).toBe('ada@acme.dev');
		expect(recordTitle('companies', { name: 'Acme' })).toBe('Acme');
		expect(recordTitle('deals', { dealname: 'Q3 renewal' })).toBe('Q3 renewal');
		expect(recordTitle('deals', {})).toBeUndefined();
	});

	describe('verifyConnection', () => {
		it('probes the first configured object type and returns its details', async () => {
			getPageMock.mockResolvedValueOnce({ results: [{ id: '1' }] });
			const res = await plugin.verifyConnection(
				{ accessToken: 'pat-x' },
				{ settings: { objectTypes: 'deals,contacts' } }
			);
			expect(res.valid).toBe(true);
			expect(getPageMock).toHaveBeenCalledWith('deals', 1);
			expect(res.details).toMatchObject({ probedObjectType: 'deals', sampled: 1 });
			expect(clientFactoryMock).toHaveBeenCalledWith('pat-x');
		});

		it('degrades loudly (never silently) when the token is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/accessToken/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});

		it('surfaces the HubSpot error body when the probe fails', async () => {
			getPageMock.mockRejectedValueOnce({ body: { message: 'missing scope crm.objects.contacts.read' } });
			const res = await plugin.verifyConnection({ accessToken: 'pat-x' }, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/missing scope/);
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('creates a note associated with the resolved CRM record', async () => {
			createMock.mockResolvedValueOnce({ id: 'note-9' });
			const res = await plugin.send(
				{
					text: 'call summary',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { associatedObjectId: '501', associatedObjectType: 'deals' }
				},
				options
			);
			expect(createMock).toHaveBeenCalledTimes(1);
			const [objectType, input] = createMock.mock.calls[0];
			expect(objectType).toBe('notes');
			expect(input.properties.hs_note_body).toBe('call summary');
			expect(input.associations[0].to.id).toBe('501');
			expect(input.associations[0].types[0].associationTypeId).toBe(214);
			expect(res.provider).toBe('hubspot-connector');
			expect(res.providerMessageId).toBe('note-9');
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			createMock.mockResolvedValue({ id: 'note-1' });
			const payload = {
				text: 'once only',
				messageRef: 'ref-dup',
				attribution: { userId: 'u1' },
				target: { associatedObjectId: '77' }
			};
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(createMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws a clear error when no CRM record id can be resolved', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, options)
			).rejects.toThrow(/CRM record id is required/);
			expect(createMock).not.toHaveBeenCalled();
		});

		it('refuses to write an orphan note for an object type without a note association', async () => {
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'r',
						attribution: { userId: 'u1' },
						target: { associatedObjectId: '9', associatedObjectType: 'p_widgets' }
					},
					options
				)
			).rejects.toThrow(/not supported for object type 'p_widgets'/);
			expect(createMock).not.toHaveBeenCalled();
		});

		it('throws when the access token is missing instead of silently no-oping', async () => {
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'r',
						attribution: { userId: 'u1' },
						target: { associatedObjectId: '9' }
					},
					{ connectorId: 'c' }
				)
			).rejects.toThrow(/access token is required/);
		});
	});

	describe('createRecord', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('creates the record for the requested collection and returns its id', async () => {
			createMock.mockResolvedValueOnce({ id: 'rec-42' });
			const res = await plugin.createRecord(
				{ collection: 'companies', fields: { name: 'Acme' }, idempotencyKey: 'k-1' },
				options
			);
			expect(createMock).toHaveBeenCalledWith('companies', { properties: { name: 'Acme' } });
			expect(res).toEqual({ provider: 'hubspot-connector', recordId: 'rec-42' });
		});

		it('is idempotent on idempotencyKey', async () => {
			createMock.mockResolvedValue({ id: 'rec-1' });
			const input = { collection: 'contacts', fields: { email: 'a@b.dev' }, idempotencyKey: 'dup' };
			const first = await plugin.createRecord(input, options);
			const second = await plugin.createRecord(input, options);
			expect(createMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws when HubSpot returns no record id', async () => {
			createMock.mockResolvedValueOnce({});
			await expect(
				plugin.createRecord({ collection: 'contacts', fields: {}, idempotencyKey: 'k' }, options)
			).rejects.toThrow(/no record id/);
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when the access token is missing', async () => {
			await expect(plugin.pullEvents({ since: new Date(0).toISOString(), settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(doSearchMock).not.toHaveBeenCalled();
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			doSearchMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			const [objectType, request] = doSearchMock.mock.calls[0];
			expect(objectType).toBe('contacts');
			expect(request.filterGroups[0].filters[0].value).toBe(String(Date.parse('2026-07-25T12:00:00.000Z')));
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			doSearchMock.mockResolvedValue(emptyPage());
			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(doSearchMock.mock.calls[0][1].filterGroups[0].filters[0].value).toBe(
				String(Date.parse('2026-06-25T12:00:00.000Z'))
			);

			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 500 }
			});
			expect(doSearchMock.mock.calls[1][1].filterGroups[0].filters[0].value).toBe(
				String(Date.parse('2026-04-26T12:00:00.000Z'))
			);
		});

		it('a non-first pull keeps the platform watermark as the window', async () => {
			doSearchMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(doSearchMock.mock.calls[0][1].filterGroups[0].filters[0].value).toBe(
				String(Date.parse('2026-07-20T00:00:00.000Z'))
			);
		});

		it('normalizes records into typed envelopes with subject, deep link and capped payload', async () => {
			doSearchMock.mockResolvedValueOnce({
				results: [
					{
						id: '1001',
						properties: {
							firstname: 'Ada',
							lastname: 'Lovelace',
							email: 'ada@acme.dev',
							company: 'c'.repeat(HUBSPOT_EVENT_TEXT_MAX_CHARS + 50),
							createdate: '2026-07-21T10:00:00.000Z',
							lastmodifieddate: '2026-07-22T10:00:00.000Z'
						},
						createdAt: new Date('2026-07-21T10:00:00.000Z'),
						updatedAt: new Date('2026-07-22T10:00:00.000Z')
					}
				]
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, portalId: '12345678' }
			});
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('hubspot-connector');
			expect(env.kind).toBe('hubspot.contact');
			expect(env.sourceEventId).toBe('contacts:1001:2026-07-22T10:00:00.000Z');
			expect(env.occurredAt).toBe('2026-07-22T10:00:00.000Z');
			expect(env.subject).toEqual({ type: 'crm-record', externalId: '1001', title: 'Ada Lovelace' });
			expect(env.sourceUrl).toBe('https://app.hubspot.com/contacts/12345678/record/0-1/1001');
			expect(env.payload.changeType).toBe('created');
			const properties = env.payload.properties as Record<string, string>;
			expect(properties.company.length).toBe(HUBSPOT_EVENT_TEXT_MAX_CHARS);
			// The access token must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.accessToken);
		});

		it('omits the deep link when no portalId is configured', async () => {
			doSearchMock.mockResolvedValueOnce({
				results: [{ id: '5', properties: {}, updatedAt: '2026-07-22T10:00:00.000Z' }]
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events[0].sourceUrl).toBeUndefined();
		});

		it('pages within an object type and keeps the SAME window across pages', async () => {
			doSearchMock.mockResolvedValueOnce({ results: [], paging: { next: { after: '50' } } });
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			const parsed = JSON.parse(first.nextCursor as string);
			expect(parsed).toMatchObject({ t: 'contacts', n: '50', s: '2026-07-20T00:00:00.000Z' });

			doSearchMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			const request = doSearchMock.mock.calls[1][1];
			expect(request.after).toBe('50');
			expect(request.filterGroups[0].filters[0].value).toBe(String(Date.parse('2026-07-20T00:00:00.000Z')));
		});

		it('advances contacts → companies → deals → done across the sweep', async () => {
			doSearchMock.mockResolvedValue(emptyPage());
			const afterContacts = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(JSON.parse(afterContacts.nextCursor as string).t).toBe('companies');

			const afterCompanies = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterContacts.nextCursor,
				settings: SETTINGS
			});
			expect(JSON.parse(afterCompanies.nextCursor as string).t).toBe('deals');

			const afterDeals = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterCompanies.nextCursor,
				settings: SETTINGS
			});
			expect(afterDeals.nextCursor).toBeUndefined();
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			doSearchMock.mockResolvedValueOnce({ results: [], paging: { next: { after: '900' } } });
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					t: 'contacts',
					n: '850',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: HUBSPOT_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			// Budget hit mid-contacts: jump to the next type instead of paging on.
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed.t).toBe('companies');
			expect(parsed.n).toBeUndefined();
			expect(parsed.b).toBe(0);
		});

		it('restarts at the first type when the cursor names a type dropped from settings', async () => {
			doSearchMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: JSON.stringify({ t: 'tickets', n: '10', s: '2026-07-20T00:00:00.000Z' }),
				settings: SETTINGS
			});
			const [objectType, request] = doSearchMock.mock.calls[0];
			expect(objectType).toBe('contacts');
			expect(request.after).toBeUndefined();
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			doSearchMock.mockResolvedValueOnce(emptyPage());
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: SETTINGS
			});
			expect(doSearchMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});
	});
});
