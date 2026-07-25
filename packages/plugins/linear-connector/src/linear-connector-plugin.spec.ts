import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	LinearConnectorPlugin,
	clampBackfillDays,
	LINEAR_EVENT_TEXT_MAX_CHARS,
	LINEAR_BACKFILL_MAX_PAGES
} from './linear-connector-plugin.js';

const viewerMock = vi.fn();
const issuesMock = vi.fn();
const commentsMock = vi.fn();
const createCommentMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestLinearConnectorPlugin extends LinearConnectorPlugin {
	protected override createClient(apiKey: string) {
		clientFactoryMock(apiKey);
		return {
			get viewer() {
				return viewerMock();
			},
			issues: issuesMock,
			comments: commentsMock,
			createComment: createCommentMock
		};
	}
}

const SETTINGS = { apiKey: 'lin_api_secret_123' };

function emptyPage() {
	return { nodes: [], pageInfo: { hasNextPage: false } };
}

describe('LinearConnectorPlugin', () => {
	let plugin: TestLinearConnectorPlugin;

	beforeEach(() => {
		plugin = new TestLinearConnectorPlugin();
		viewerMock.mockReset();
		issuesMock.mockReset();
		commentsMock.mockReset();
		createCommentMock.mockReset();
		clientFactoryMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + connector-linear + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('linear-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-linear');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('linear');
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

	describe('verifyConnection', () => {
		it('returns valid + viewer details when the viewer lookup succeeds', async () => {
			viewerMock.mockResolvedValueOnce({ id: 'user-1', name: 'Ada', email: 'ada@acme.dev' });
			const res = await plugin.verifyConnection({ apiKey: 'lin_api_x' }, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ viewerId: 'user-1', viewerName: 'Ada' });
			expect(clientFactoryMock).toHaveBeenCalledWith('lin_api_x');
		});

		it('returns invalid without calling the API when apiKey is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/apiKey/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('creates a comment on the resolved issue and returns its id', async () => {
			createCommentMock.mockResolvedValueOnce({ success: true, comment: Promise.resolve({ id: 'comment-9' }) });
			const res = await plugin.send(
				{
					text: 'hello from the platform',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { issueId: 'issue-7' }
				},
				options
			);
			expect(createCommentMock).toHaveBeenCalledWith({ issueId: 'issue-7', body: 'hello from the platform' });
			expect(res.provider).toBe('linear-connector');
			expect(res.providerMessageId).toBe('comment-9');
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			createCommentMock.mockResolvedValue({ success: true, comment: Promise.resolve({ id: 'comment-1' }) });
			const payload = {
				text: 'once only',
				messageRef: 'ref-dup',
				attribution: { userId: 'u1' },
				target: { issueId: 'issue-1' }
			};
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(createCommentMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws a clear error when no issue id can be resolved', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, options)
			).rejects.toThrow(/issue id is required/);
			expect(createCommentMock).not.toHaveBeenCalled();
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when apiKey is missing', async () => {
			await expect(plugin.pullEvents({ since: new Date(0).toISOString(), settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(issuesMock).not.toHaveBeenCalled();
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			issuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			const filter = issuesMock.mock.calls[0][0].filter;
			expect(filter.updatedAt.gte.toISOString()).toBe('2026-07-25T12:00:00.000Z');
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			issuesMock.mockResolvedValue(emptyPage());
			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(issuesMock.mock.calls[0][0].filter.updatedAt.gte.toISOString()).toBe('2026-06-25T12:00:00.000Z');

			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 500 }
			});
			expect(issuesMock.mock.calls[1][0].filter.updatedAt.gte.toISOString()).toBe('2026-04-26T12:00:00.000Z');
		});

		it('a non-first pull keeps the platform watermark as the window', async () => {
			issuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(issuesMock.mock.calls[0][0].filter.updatedAt.gte.toISOString()).toBe('2026-07-20T00:00:00.000Z');
		});

		it('normalizes issues into linear.issue envelopes with subject, sourceUrl and capped payload', async () => {
			issuesMock.mockResolvedValueOnce({
				nodes: [
					{
						id: 'iss-1',
						identifier: 'ENG-42',
						title: 'Fix the flux capacitor',
						description: 'd'.repeat(LINEAR_EVENT_TEXT_MAX_CHARS + 100),
						url: 'https://linear.app/acme/issue/ENG-42',
						createdAt: new Date('2026-07-21T10:00:00.000Z'),
						updatedAt: new Date('2026-07-22T10:00:00.000Z')
					}
				],
				pageInfo: { hasNextPage: false }
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('linear-connector');
			expect(env.kind).toBe('linear.issue');
			expect(env.sourceEventId).toBe('iss-1:2026-07-22T10:00:00.000Z');
			expect(env.occurredAt).toBe('2026-07-22T10:00:00.000Z');
			expect(env.subject).toEqual({ type: 'issue', externalId: 'iss-1', title: 'Fix the flux capacitor' });
			expect(env.sourceUrl).toBe('https://linear.app/acme/issue/ENG-42');
			expect(env.payload.changeType).toBe('created');
			expect((env.payload.description as string).length).toBe(LINEAR_EVENT_TEXT_MAX_CHARS);
			// The API key must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.apiKey);
		});

		it('passes the team filter when teamIds is configured', async () => {
			issuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, teamIds: 'team-a, team-b' }
			});
			expect(issuesMock.mock.calls[0][0].filter.team).toEqual({ id: { in: ['team-a', 'team-b'] } });
		});

		it('pages issues via the SDK cursor and keeps the SAME window across pages', async () => {
			issuesMock.mockResolvedValueOnce({
				nodes: [],
				pageInfo: { hasNextPage: true, endCursor: 'page-2' }
			});
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(first.nextCursor).toBeDefined();
			const parsed = JSON.parse(first.nextCursor as string);
			expect(parsed).toMatchObject({ p: 'issues', n: 'page-2', s: '2026-07-20T00:00:00.000Z' });

			issuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			const args = issuesMock.mock.calls[1][0];
			expect(args.after).toBe('page-2');
			expect(args.filter.updatedAt.gte.toISOString()).toBe('2026-07-20T00:00:00.000Z');
		});

		it('advances issues → comments → done across the sweep', async () => {
			issuesMock.mockResolvedValueOnce(emptyPage());
			const afterIssues = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(JSON.parse(afterIssues.nextCursor as string).p).toBe('comments');

			commentsMock.mockResolvedValueOnce(emptyPage());
			const afterComments = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterIssues.nextCursor,
				settings: SETTINGS
			});
			expect(commentsMock).toHaveBeenCalledTimes(1);
			expect(afterComments.nextCursor).toBeUndefined();
		});

		it('normalizes comments with the awaited parent issue as subject', async () => {
			commentsMock.mockResolvedValueOnce({
				nodes: [
					{
						id: 'com-1',
						body: 'b'.repeat(LINEAR_EVENT_TEXT_MAX_CHARS + 5),
						url: 'https://linear.app/acme/issue/ENG-42#comment-com-1',
						createdAt: '2026-07-22T11:00:00.000Z',
						updatedAt: '2026-07-22T11:00:00.000Z',
						issue: Promise.resolve({
							id: 'iss-1',
							identifier: 'ENG-42',
							title: 'Fix the flux capacitor',
							url: 'https://linear.app/acme/issue/ENG-42'
						})
					}
				],
				pageInfo: { hasNextPage: false }
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: JSON.stringify({ p: 'comments', s: '2026-07-20T00:00:00.000Z', b: 0 }),
				settings: SETTINGS
			});
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.kind).toBe('linear.comment');
			expect(env.subject).toEqual({ type: 'issue', externalId: 'iss-1', title: 'Fix the flux capacitor' });
			expect(env.sourceUrl).toBe('https://linear.app/acme/issue/ENG-42#comment-com-1');
			expect((env.payload.body as string).length).toBe(LINEAR_EVENT_TEXT_MAX_CHARS);
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			issuesMock.mockResolvedValueOnce({
				nodes: [],
				pageInfo: { hasNextPage: true, endCursor: 'more-issues' }
			});
			// Backfill sweep, one page short of the bound: this page exhausts it.
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					p: 'issues',
					n: 'page-n',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: LINEAR_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			// Budget hit mid-issues: jump to the comments phase instead of paging on.
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed.p).toBe('comments');
			expect(parsed.n).toBeUndefined();
			expect(parsed.b).toBe(0);
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			issuesMock.mockResolvedValueOnce(emptyPage());
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: SETTINGS
			});
			expect(issuesMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});
	});
});
