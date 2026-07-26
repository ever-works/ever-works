import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	JiraConnectorPlugin,
	adfToText,
	buildJql,
	clampBackfillDays,
	normalizeBaseUrl,
	resolveProjectKeys,
	toJqlDateTime,
	JIRA_BACKFILL_MAX_PAGES,
	JIRA_EVENT_TEXT_MAX_CHARS
} from './jira-connector-plugin.js';

const getCurrentUserMock = vi.fn();
const searchIssuesMock = vi.fn();
const addCommentMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestJiraConnectorPlugin extends JiraConnectorPlugin {
	protected override createClient(credentials: { baseUrl: string; email: string; apiToken: string }) {
		clientFactoryMock(credentials);
		return {
			getCurrentUser: getCurrentUserMock,
			searchIssues: searchIssuesMock,
			addComment: addCommentMock
		};
	}
}

const SETTINGS = {
	baseUrl: 'https://acme.atlassian.net',
	email: 'ada@acme.dev',
	apiToken: 'jira_token_secret_123'
};

function emptyPage() {
	return { issues: [] };
}

function adf(text: string) {
	return {
		type: 'doc',
		version: 1,
		content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
	};
}

describe('JiraConnectorPlugin', () => {
	let plugin: TestJiraConnectorPlugin;

	beforeEach(() => {
		plugin = new TestJiraConnectorPlugin();
		getCurrentUserMock.mockReset();
		searchIssuesMock.mockReset();
		addCommentMock.mockReset();
		clientFactoryMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('jira-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('jira');
		expect(plugin.connector.direction).toBe('outbound');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks apiToken as x-secret and bounds backfillDays to 0–90 in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.apiToken['x-secret']).toBe(true);
		expect(plugin.settingsSchema.required).toEqual(expect.arrayContaining(['baseUrl', 'email', 'apiToken']));
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

	describe('normalizeBaseUrl (SSRF guard on the user-supplied site URL)', () => {
		it('accepts an https site and returns its origin without any path', () => {
			expect(normalizeBaseUrl('https://acme.atlassian.net/jira/software')).toBe('https://acme.atlassian.net');
		});

		it('rejects non-https, embedded credentials, loopback and private hosts', () => {
			expect(normalizeBaseUrl('http://acme.atlassian.net')).toBeUndefined();
			expect(normalizeBaseUrl('https://user:pass@acme.atlassian.net')).toBeUndefined();
			expect(normalizeBaseUrl('https://localhost')).toBeUndefined();
			expect(normalizeBaseUrl('https://127.0.0.1')).toBeUndefined();
			expect(normalizeBaseUrl('https://10.1.2.3')).toBeUndefined();
			expect(normalizeBaseUrl('https://192.168.0.5')).toBeUndefined();
			expect(normalizeBaseUrl('https://169.254.169.254')).toBeUndefined();
			expect(normalizeBaseUrl('https://jira.internal')).toBeUndefined();
			expect(normalizeBaseUrl('not a url')).toBeUndefined();
			expect(normalizeBaseUrl(undefined)).toBeUndefined();
		});
	});

	describe('JQL construction', () => {
		it('renders the watermark as the yyyy-MM-dd HH:mm literal JQL accepts', () => {
			expect(toJqlDateTime('2026-07-20T09:05:00.000Z')).toBe('2026-07-20 09:05');
		});

		it('is bounded and ordered, and only whitelisted project keys reach the query', () => {
			expect(buildJql('2026-07-20T00:00:00.000Z', [])).toBe('updated >= "2026-07-20 00:00" ORDER BY updated ASC');
			expect(buildJql('2026-07-20T00:00:00.000Z', ['ENG', 'OPS'])).toBe(
				'updated >= "2026-07-20 00:00" AND project in (ENG, OPS) ORDER BY updated ASC'
			);
		});

		it('drops injection attempts from the project filter instead of interpolating them', () => {
			expect(resolveProjectKeys({ projectKeys: 'ENG, OPS' })).toEqual(['ENG', 'OPS']);
			// A tampered entry fails as a whole — it must not shed its
			// punctuation and smuggle a bare `OR` into the query.
			expect(resolveProjectKeys({ projectKeys: 'ENG) OR (1=1' })).toEqual([]);
			expect(resolveProjectKeys({ projectKeys: 'ENG, OPS) OR (1=1' })).toEqual(['ENG']);
			expect(resolveProjectKeys({ projectKeys: '"; DROP' })).toEqual([]);
			expect(resolveProjectKeys({})).toEqual([]);
		});
	});

	it('adfToText flattens an Atlassian Document Format tree to plain text', () => {
		expect(adfToText(adf('hello world'))).toBe('hello world');
		expect(adfToText('already plain')).toBe('already plain');
		expect(adfToText(undefined)).toBe('');
		expect(adfToText(null)).toBe('');
	});

	describe('verifyConnection', () => {
		it('returns valid + current-user details when the lookup succeeds', async () => {
			getCurrentUserMock.mockResolvedValueOnce({ accountId: 'acc-1', displayName: 'Ada' });
			const res = await plugin.verifyConnection({}, { settings: SETTINGS });
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({
				site: 'https://acme.atlassian.net',
				accountId: 'acc-1',
				displayName: 'Ada'
			});
		});

		it('returns invalid without calling the API when credentials are incomplete', async () => {
			const res = await plugin.verifyConnection({}, { settings: { baseUrl: SETTINGS.baseUrl } });
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/apiToken/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});

		it('returns invalid for a non-https site URL without calling the API', async () => {
			const res = await plugin.verifyConnection(
				{},
				{ settings: { ...SETTINGS, baseUrl: 'http://acme.atlassian.net' } }
			);
			expect(res.valid).toBe(false);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('creates a comment on the resolved issue and returns its id', async () => {
			addCommentMock.mockResolvedValueOnce({ id: '10101' });
			const res = await plugin.send(
				{
					text: 'hello from the platform',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { issueKey: 'ENG-42' }
				},
				options
			);
			expect(addCommentMock).toHaveBeenCalledWith({
				issueIdOrKey: 'ENG-42',
				comment: 'hello from the platform'
			});
			expect(res.provider).toBe('jira-connector');
			expect(res.providerMessageId).toBe('10101');
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			addCommentMock.mockResolvedValue({ id: '1' });
			const payload = {
				text: 'once only',
				messageRef: 'ref-dup',
				attribution: { userId: 'u1' },
				target: { issueKey: 'ENG-1' }
			};
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(addCommentMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws a clear error when no issue key can be resolved', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, options)
			).rejects.toThrow(/issue key is required/);
			expect(addCommentMock).not.toHaveBeenCalled();
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when credentials are missing', async () => {
			await expect(plugin.pullEvents({ since: new Date(0).toISOString(), settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(searchIssuesMock).not.toHaveBeenCalled();
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			searchIssuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			expect(searchIssuesMock.mock.calls[0][0].jql).toContain('updated >= "2026-07-25 12:00"');
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			searchIssuesMock.mockResolvedValue(emptyPage());
			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(searchIssuesMock.mock.calls[0][0].jql).toContain('updated >= "2026-06-25 12:00"');

			await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 500 }
			});
			expect(searchIssuesMock.mock.calls[1][0].jql).toContain('updated >= "2026-04-26 12:00"');
		});

		it('a non-first pull keeps the platform watermark as the window', async () => {
			searchIssuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(searchIssuesMock.mock.calls[0][0].jql).toContain('updated >= "2026-07-20 00:00"');
		});

		it('normalizes issues into jira.issue envelopes with subject, sourceUrl, workHint and capped payload', async () => {
			searchIssuesMock.mockResolvedValueOnce({
				issues: [
					{
						id: '10001',
						key: 'ENG-42',
						fields: {
							summary: 'Fix the flux capacitor',
							description: adf('d'.repeat(JIRA_EVENT_TEXT_MAX_CHARS + 100)),
							created: '2026-07-21T10:00:00.000Z',
							updated: '2026-07-22T10:00:00.000Z',
							project: { key: 'ENG', name: 'Engineering' },
							status: { name: 'In Progress' },
							issuetype: { name: 'Bug' }
						}
					}
				]
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('jira-connector');
			expect(env.kind).toBe('jira.issue');
			expect(env.sourceEventId).toBe('10001:2026-07-22T10:00:00.000Z');
			expect(env.occurredAt).toBe('2026-07-22T10:00:00.000Z');
			expect(env.subject).toEqual({
				type: 'issue',
				externalId: '10001',
				title: 'Fix the flux capacitor'
			});
			expect(env.workHint).toEqual({
				kind: 'tracker-team',
				externalId: 'ENG',
				label: 'Engineering'
			});
			expect(env.sourceUrl).toBe('https://acme.atlassian.net/browse/ENG-42');
			expect(env.payload.changeType).toBe('created');
			expect(env.payload.status).toBe('In Progress');
			expect((env.payload.description as string).length).toBe(JIRA_EVENT_TEXT_MAX_CHARS);
			// The API token must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.apiToken);
		});

		it('emits jira.comment envelopes only for comments that changed inside the window', async () => {
			searchIssuesMock.mockResolvedValueOnce({
				issues: [
					{
						id: '10001',
						key: 'ENG-42',
						fields: {
							summary: 'Fix the flux capacitor',
							created: '2026-01-01T00:00:00.000Z',
							updated: '2026-07-22T11:00:00.000Z',
							project: { key: 'ENG' },
							comment: {
								comments: [
									{
										id: '900',
										body: adf('ancient history'),
										created: '2026-01-02T00:00:00.000Z',
										updated: '2026-01-02T00:00:00.000Z'
									},
									{
										id: '901',
										body: adf('b'.repeat(JIRA_EVENT_TEXT_MAX_CHARS + 5)),
										created: '2026-07-22T11:00:00.000Z',
										updated: '2026-07-22T11:00:00.000Z',
										author: { displayName: 'Ada', accountId: 'acc-1' }
									}
								]
							}
						}
					}
				]
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			const comments = res.events.filter((e) => e.kind === 'jira.comment');
			expect(comments).toHaveLength(1);
			const env = comments[0];
			expect(env.sourceEventId).toBe('901:2026-07-22T11:00:00.000Z');
			expect(env.actor).toEqual({ name: 'Ada', externalId: 'acc-1' });
			expect(env.subject).toEqual({
				type: 'issue',
				externalId: '10001',
				title: 'Fix the flux capacitor'
			});
			expect(env.workHint).toEqual({ kind: 'tracker-team', externalId: 'ENG' });
			expect(env.sourceUrl).toBe('https://acme.atlassian.net/browse/ENG-42?focusedCommentId=901');
			expect((env.payload.body as string).length).toBe(JIRA_EVENT_TEXT_MAX_CHARS);
			// The issue envelope rides along in the same page.
			expect(res.events.filter((e) => e.kind === 'jira.issue')).toHaveLength(1);
		});

		it('pages via the API page token and keeps the SAME window across pages', async () => {
			searchIssuesMock.mockResolvedValueOnce({ issues: [], nextPageToken: 'page-2' });
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(first.nextCursor).toBeDefined();
			expect(JSON.parse(first.nextCursor as string)).toMatchObject({
				n: 'page-2',
				s: '2026-07-20T00:00:00.000Z'
			});

			searchIssuesMock.mockResolvedValueOnce(emptyPage());
			const second = await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			const args = searchIssuesMock.mock.calls[1][0];
			expect(args.nextPageToken).toBe('page-2');
			expect(args.jql).toContain('updated >= "2026-07-20 00:00"');
			expect(second.nextCursor).toBeUndefined();
		});

		it('bounds backfill sweeps to the page budget', async () => {
			searchIssuesMock.mockResolvedValueOnce({ issues: [], nextPageToken: 'more' });
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					n: 'page-n',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: JIRA_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			// Budget spent: the sweep ends rather than paging on.
			expect(res.nextCursor).toBeUndefined();
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			searchIssuesMock.mockResolvedValueOnce(emptyPage());
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: SETTINGS
			});
			expect(searchIssuesMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});

		it('passes the project filter when projectKeys is configured', async () => {
			searchIssuesMock.mockResolvedValueOnce(emptyPage());
			await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: { ...SETTINGS, projectKeys: 'ENG, OPS' }
			});
			expect(searchIssuesMock.mock.calls[0][0].jql).toContain('project in (ENG, OPS)');
		});
	});
});
