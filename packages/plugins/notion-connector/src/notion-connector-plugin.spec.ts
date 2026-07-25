import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	NotionConnectorPlugin,
	clampBackfillDays,
	extractPageTitle,
	NOTION_BACKFILL_MAX_PAGES
} from './notion-connector-plugin.js';

const usersMeMock = vi.fn();
const searchMock = vi.fn();
const databasesQueryMock = vi.fn();
const commentsCreateMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestNotionConnectorPlugin extends NotionConnectorPlugin {
	protected override createClient(apiKey: string) {
		clientFactoryMock(apiKey);
		return {
			users: { me: usersMeMock },
			search: searchMock,
			databases: { query: databasesQueryMock },
			comments: { create: commentsCreateMock }
		};
	}
}

const SETTINGS = { apiKey: 'ntn_secret_abc' };

function makePage(id: string, lastEdited: string, created = lastEdited, title = 'Doc') {
	return {
		object: 'page',
		id,
		url: `https://www.notion.so/${id}`,
		created_time: created,
		last_edited_time: lastEdited,
		properties: { Name: { type: 'title', title: [{ plain_text: title }] } }
	};
}

describe('NotionConnectorPlugin', () => {
	let plugin: TestNotionConnectorPlugin;

	beforeEach(() => {
		plugin = new TestNotionConnectorPlugin();
		usersMeMock.mockReset();
		searchMock.mockReset();
		databasesQueryMock.mockReset();
		commentsCreateMock.mockReset();
		clientFactoryMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + connector-notion + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('notion-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-notion');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('notion');
		expect(plugin.connector.direction).toBe('outbound');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks apiKey as x-secret and bounds backfillDays to 0–90 in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.apiKey['x-secret']).toBe(true);
		expect(plugin.settingsSchema.required).toContain('apiKey');
		expect(props.backfillDays.default).toBe(0);
		expect(props.backfillDays.maximum).toBe(90);
		expect(clampBackfillDays(120)).toBe(90);
		expect(clampBackfillDays(-1)).toBe(0);
	});

	it('extractPageTitle reads the title-typed property and tolerates junk', () => {
		expect(extractPageTitle(makePage('p1', '2026-07-20T00:00:00.000Z', undefined as never, 'Hello'))).toBe('Hello');
		expect(extractPageTitle({ properties: {} })).toBeUndefined();
		expect(extractPageTitle({})).toBeUndefined();
	});

	describe('verifyConnection', () => {
		it('returns valid + bot details when users.me succeeds', async () => {
			usersMeMock.mockResolvedValueOnce({ id: 'bot-1', name: 'Works Bot' });
			const res = await plugin.verifyConnection({ apiKey: 'ntn_x' }, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ botId: 'bot-1', botName: 'Works Bot' });
			expect(clientFactoryMock).toHaveBeenCalledWith('ntn_x');
		});

		it('returns invalid without calling the API when apiKey is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/apiKey/);
			expect(usersMeMock).not.toHaveBeenCalled();
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('appends a comment to the resolved page and returns its id', async () => {
			commentsCreateMock.mockResolvedValueOnce({ id: 'comment-3' });
			const res = await plugin.send(
				{
					text: 'note from the platform',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { pageId: 'page-5' }
				},
				options
			);
			expect(commentsCreateMock).toHaveBeenCalledWith({
				parent: { page_id: 'page-5' },
				rich_text: [{ type: 'text', text: { content: 'note from the platform' } }]
			});
			expect(res.provider).toBe('notion-connector');
			expect(res.providerMessageId).toBe('comment-3');
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			commentsCreateMock.mockResolvedValue({ id: 'comment-1' });
			const payload = {
				text: 'once only',
				messageRef: 'ref-dup',
				attribution: { userId: 'u1' },
				target: { pageId: 'page-1' }
			};
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(commentsCreateMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('fails with a clear, actionable error when the token lacks comment capabilities', async () => {
			commentsCreateMock.mockRejectedValueOnce(
				Object.assign(new Error('Insufficient permissions for this endpoint.'), {
					code: 'restricted_resource'
				})
			);
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'r', attribution: { userId: 'u1' }, target: { pageId: 'page-1' } },
					options
				)
			).rejects.toThrow(/Insert comments/);
		});

		it('throws a clear error when no page id can be resolved', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, options)
			).rejects.toThrow(/page id is required/);
			expect(commentsCreateMock).not.toHaveBeenCalled();
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when apiKey is missing', async () => {
			await expect(plugin.pullEvents({ since: new Date(0).toISOString(), settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(searchMock).not.toHaveBeenCalled();
		});

		it('first pull with backfill off searches with a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			searchMock.mockResolvedValueOnce({
				results: [
					makePage('new-page', '2026-07-25T13:00:00.000Z'),
					makePage('old-page', '2026-07-01T00:00:00.000Z')
				],
				has_more: true,
				next_cursor: 'more'
			});
			const res = await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			// Only the in-window page lands; the older result ends the sweep.
			expect(res.events).toHaveLength(1);
			expect(res.events[0].payload.pageId).toBe('new-page');
			expect(res.nextCursor).toBeUndefined();
		});

		it('first pull with backfillDays widens the window (clamped) and pages further back', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			searchMock.mockResolvedValueOnce({
				results: [makePage('p1', '2026-07-10T00:00:00.000Z')],
				has_more: true,
				next_cursor: 'cursor-2'
			});
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(res.events).toHaveLength(1);
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed).toMatchObject({ m: 'search', n: 'cursor-2', s: '2026-06-25T12:00:00.000Z', f: 1, b: 1 });
		});

		it('normalizes pages into notion.page envelopes with subject, sourceUrl and changeType', async () => {
			searchMock.mockResolvedValueOnce({
				results: [
					makePage('p-new', '2026-07-24T10:00:00.000Z', '2026-07-24T09:00:00.000Z', 'Fresh page'),
					makePage('p-edit', '2026-07-24T11:00:00.000Z', '2026-01-01T00:00:00.000Z', 'Old page')
				],
				has_more: false,
				next_cursor: null
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(2);
			const fresh = res.events[0];
			expect(fresh.kind).toBe('notion.page');
			expect(fresh.sourceEventId).toBe('p-new:2026-07-24T10:00:00.000Z');
			expect(fresh.subject).toEqual({ type: 'page', externalId: 'p-new', title: 'Fresh page' });
			expect(fresh.sourceUrl).toBe('https://www.notion.so/p-new');
			expect(fresh.payload.changeType).toBe('created');
			expect(res.events[1].payload.changeType).toBe('edited');
			// The API key must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.apiKey);
		});

		it('queries configured databases with a server-side last_edited_time filter', async () => {
			databasesQueryMock.mockResolvedValueOnce({
				results: [makePage('row-1', '2026-07-24T10:00:00.000Z')],
				has_more: false,
				next_cursor: null
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, databaseIds: 'db-a, db-b' }
			});
			expect(searchMock).not.toHaveBeenCalled();
			const args = databasesQueryMock.mock.calls[0][0];
			expect(args.database_id).toBe('db-a');
			expect(args.filter).toEqual({
				timestamp: 'last_edited_time',
				last_edited_time: { on_or_after: '2026-07-20T00:00:00.000Z' }
			});
			expect(res.events[0].payload.databaseId).toBe('db-a');
			// db-a exhausted → advance to db-b with a reset page counter.
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed).toMatchObject({ m: 'db', d: 'db-b', s: '2026-07-20T00:00:00.000Z', b: 0 });
			expect(parsed.n).toBeUndefined();
		});

		it('pages a database via Notion cursors, keeping the SAME window across pages', async () => {
			databasesQueryMock.mockResolvedValueOnce({
				results: [],
				has_more: true,
				next_cursor: 'db-page-2'
			});
			const first = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, databaseIds: 'db-a' }
			});
			const parsed = JSON.parse(first.nextCursor as string);
			expect(parsed).toMatchObject({ m: 'db', d: 'db-a', n: 'db-page-2', s: '2026-07-20T00:00:00.000Z' });

			databasesQueryMock.mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });
			const second = await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: { ...SETTINGS, databaseIds: 'db-a' }
			});
			const args = databasesQueryMock.mock.calls[1][0];
			expect(args.start_cursor).toBe('db-page-2');
			expect(args.filter.last_edited_time.on_or_after).toBe('2026-07-20T00:00:00.000Z');
			expect(second.nextCursor).toBeUndefined();
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			databasesQueryMock.mockResolvedValueOnce({
				results: [],
				has_more: true,
				next_cursor: 'even-more'
			});
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					m: 'db',
					d: 'db-a',
					n: 'page-n',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: NOTION_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, databaseIds: 'db-a, db-b', backfillDays: 90 }
			});
			// Budget hit mid-database: advance to db-b instead of paging on.
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed).toMatchObject({ m: 'db', d: 'db-b', b: 0 });
			expect(parsed.n).toBeUndefined();
		});

		it('returns no events for a db sweep with no configured databases left', async () => {
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: JSON.stringify({ m: 'db', d: 'gone-db', s: '2026-07-20T00:00:00.000Z' }),
				settings: SETTINGS // databaseIds cleared since the sweep started
			});
			expect(res.events).toEqual([]);
			expect(res.nextCursor).toBeUndefined();
			expect(databasesQueryMock).not.toHaveBeenCalled();
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			searchMock.mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: '}}}garbage',
				settings: SETTINGS
			});
			expect(searchMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});
	});
});
