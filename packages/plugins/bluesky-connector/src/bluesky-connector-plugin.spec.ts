import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	BlueskyConnectorPlugin,
	clampBackfillDays,
	postUrlFromAtUri,
	resolveCredentials,
	BLUESKY_EVENT_TEXT_MAX_CHARS,
	BLUESKY_BACKFILL_MAX_PAGES,
	BLUESKY_DEFAULT_SERVICE
} from './bluesky-connector-plugin.js';

const loginMock = vi.fn();
const postMock = vi.fn();
const listNotificationsMock = vi.fn();
const getAuthorFeedMock = vi.fn();
const agentFactoryMock = vi.fn();

/** Subclass overriding the agent seam so no real SDK call ever happens. */
class TestBlueskyConnectorPlugin extends BlueskyConnectorPlugin {
	protected override createAgent(service: string) {
		agentFactoryMock(service);
		return {
			login: loginMock,
			post: postMock,
			listNotifications: listNotificationsMock,
			getAuthorFeed: getAuthorFeedMock
		};
	}
}

const SETTINGS = { identifier: 'acme.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' };

function emptyNotifications() {
	return { data: { notifications: [] } };
}

function emptyFeed() {
	return { data: { feed: [] } };
}

describe('BlueskyConnectorPlugin', () => {
	let plugin: TestBlueskyConnectorPlugin;

	beforeEach(() => {
		plugin = new TestBlueskyConnectorPlugin();
		loginMock.mockReset();
		postMock.mockReset();
		listNotificationsMock.mockReset();
		getAuthorFeedMock.mockReset();
		agentFactoryMock.mockReset();
		loginMock.mockResolvedValue({ data: { did: 'did:plc:acme', handle: 'acme.bsky.social' } });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + connector-bluesky + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('bluesky-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-bluesky');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('bluesky');
		expect(plugin.connector.direction).toBe('outbound');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks appPassword as x-secret and bounds backfillDays to 0–90 in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.appPassword['x-secret']).toBe(true);
		expect(props.appPassword['x-envVar']).toBe('BLUESKY_APP_PASSWORD');
		expect(props.identifier['x-secret']).toBeUndefined();
		expect(plugin.settingsSchema.required).toEqual(expect.arrayContaining(['identifier', 'appPassword']));
		expect(props.backfillDays.default).toBe(0);
		expect(props.backfillDays.maximum).toBe(90);
	});

	it('clampBackfillDays clamps to the 0–90 range and treats garbage as off', () => {
		expect(clampBackfillDays(0)).toBe(0);
		expect(clampBackfillDays(-5)).toBe(0);
		expect(clampBackfillDays(30)).toBe(30);
		expect(clampBackfillDays(500)).toBe(90);
		expect(clampBackfillDays('nope')).toBe(0);
	});

	it('postUrlFromAtUri builds bsky.app permalinks and rejects non-post URIs', () => {
		expect(postUrlFromAtUri('at://did:plc:x/app.bsky.feed.post/3kabc', 'acme.bsky.social')).toBe(
			'https://bsky.app/profile/acme.bsky.social/post/3kabc'
		);
		expect(postUrlFromAtUri('at://did:plc:x/app.bsky.feed.post/3kabc')).toBe(
			'https://bsky.app/profile/did%3Aplc%3Ax/post/3kabc'
		);
		expect(postUrlFromAtUri('at://did:plc:x/app.bsky.graph.follow/3k')).toBeUndefined();
		expect(postUrlFromAtUri('https://example.com')).toBeUndefined();
		expect(postUrlFromAtUri(undefined)).toBeUndefined();
	});

	it('resolveCredentials requires BOTH identifier and appPassword and defaults the service', () => {
		expect(resolveCredentials({}, { settings: SETTINGS })).toEqual({
			...SETTINGS,
			service: BLUESKY_DEFAULT_SERVICE
		});
		expect(resolveCredentials({}, { settings: { identifier: 'a' } })).toBeUndefined();
		expect(resolveCredentials({}, { settings: { appPassword: 'p' } })).toBeUndefined();
		expect(resolveCredentials({ service: 'https://pds.acme.dev' }, { settings: SETTINGS })?.service).toBe(
			'https://pds.acme.dev'
		);
	});

	describe('verifyConnection', () => {
		it('logs in and returns the resolved did/handle', async () => {
			const res = await plugin.verifyConnection({}, { settings: SETTINGS });
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ did: 'did:plc:acme', handle: 'acme.bsky.social' });
			expect(agentFactoryMock).toHaveBeenCalledWith(BLUESKY_DEFAULT_SERVICE);
			expect(loginMock).toHaveBeenCalledWith({
				identifier: SETTINGS.identifier,
				password: SETTINGS.appPassword
			});
		});

		it('degrades loudly (never silently) when credentials are missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/identifier and appPassword/);
			expect(agentFactoryMock).not.toHaveBeenCalled();
		});

		it('refuses an SSRF-unsafe service URL instead of calling it', async () => {
			const res = await plugin.verifyConnection({ service: 'http://169.254.169.254' }, { settings: SETTINGS });
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/unsafe service URL/);
			expect(agentFactoryMock).not.toHaveBeenCalled();
		});

		it('reports a failed login', async () => {
			loginMock.mockRejectedValueOnce({ message: 'Invalid identifier or password' });
			const res = await plugin.verifyConnection({}, { settings: SETTINGS });
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/Invalid identifier or password/);
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('publishes a post and returns its AT-URI', async () => {
			postMock.mockResolvedValueOnce({ uri: 'at://did:plc:acme/app.bsky.feed.post/3k1', cid: 'cid1' });
			const res = await plugin.send(
				{ text: 'shipping today', messageRef: 'ref-1', attribution: { userId: 'u1' } },
				options
			);
			expect(postMock).toHaveBeenCalledTimes(1);
			expect(postMock.mock.calls[0][0].text).toBe('shipping today');
			expect(postMock.mock.calls[0][0].reply).toBeUndefined();
			expect(res.providerMessageId).toBe('at://did:plc:acme/app.bsky.feed.post/3k1');
			expect(res.provider).toBe('bluesky-connector');
		});

		it('threads a reply when the target carries replyToUri + replyToCid', async () => {
			postMock.mockResolvedValueOnce({ uri: 'at://did:plc:acme/app.bsky.feed.post/3k2' });
			await plugin.send(
				{
					text: 'thanks!',
					messageRef: 'ref-2',
					attribution: { userId: 'u1' },
					target: { replyToUri: 'at://did:plc:other/app.bsky.feed.post/parent', replyToCid: 'cid-parent' }
				},
				options
			);
			const record = postMock.mock.calls[0][0];
			expect(record.reply.parent).toEqual({
				uri: 'at://did:plc:other/app.bsky.feed.post/parent',
				cid: 'cid-parent'
			});
			// Root defaults to the parent when no explicit thread root is given.
			expect(record.reply.root).toEqual(record.reply.parent);
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			postMock.mockResolvedValue({ uri: 'at://did:plc:acme/app.bsky.feed.post/3k3' });
			const payload = { text: 'once only', messageRef: 'ref-dup', attribution: { userId: 'u1' } };
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(postMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws when credentials are missing instead of silently no-oping', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, { connectorId: 'c' })
			).rejects.toThrow(/identifier and appPassword are required/);
			expect(postMock).not.toHaveBeenCalled();
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when the identifier is missing', async () => {
			await expect(
				plugin.pullEvents({ since: new Date(0).toISOString(), settings: { appPassword: 'p' } })
			).rejects.toMatchObject({ name: 'EventSourceNotConfiguredError' });
			expect(listNotificationsMock).not.toHaveBeenCalled();
		});

		it('throws EventSourceNotConfiguredError when the app password is missing', async () => {
			await expect(
				plugin.pullEvents({ since: new Date(0).toISOString(), settings: { identifier: 'a' } })
			).rejects.toMatchObject({ name: 'EventSourceNotConfiguredError' });
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			listNotificationsMock.mockResolvedValueOnce({
				data: {
					notifications: [
						{ uri: 'at://did:plc:a/app.bsky.feed.post/old', indexedAt: '2026-07-25T11:00:00.000Z' }
					]
				}
			});
			const res = await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			// The single item predates `now`, so the window excludes it entirely.
			expect(res.events).toEqual([]);
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			listNotificationsMock.mockResolvedValue({
				data: {
					notifications: [
						{
							uri: 'at://did:plc:a/app.bsky.feed.post/x',
							reason: 'mention',
							indexedAt: '2026-07-01T00:00:00.000Z'
						}
					]
				}
			});
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 30 }
			});
			expect(res.events).toHaveLength(1);
			expect(JSON.parse(res.nextCursor as string).s).toBe('2026-06-25T12:00:00.000Z');
		});

		it('normalizes notifications into bluesky.notification envelopes with capped text', async () => {
			listNotificationsMock.mockResolvedValueOnce({
				data: {
					notifications: [
						{
							uri: 'at://did:plc:other/app.bsky.feed.post/3kmention',
							cid: 'cid-1',
							reason: 'mention',
							reasonSubject: 'at://did:plc:acme/app.bsky.feed.post/3kroot',
							author: { did: 'did:plc:other', handle: 'fan.bsky.social', displayName: 'Fan' },
							record: { text: 'm'.repeat(BLUESKY_EVENT_TEXT_MAX_CHARS + 20) },
							isRead: false,
							indexedAt: '2026-07-22T10:00:00.000Z'
						}
					]
				}
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('bluesky-connector');
			expect(env.kind).toBe('bluesky.notification');
			expect(env.sourceEventId).toBe(
				'at://did:plc:other/app.bsky.feed.post/3kmention:mention:2026-07-22T10:00:00.000Z'
			);
			expect(env.actor).toEqual({ name: 'Fan', externalId: 'did:plc:other' });
			expect(env.subject?.externalId).toBe('at://did:plc:acme/app.bsky.feed.post/3kroot');
			expect(env.sourceUrl).toBe('https://bsky.app/profile/fan.bsky.social/post/3kmention');
			expect((env.payload.text as string).length).toBe(BLUESKY_EVENT_TEXT_MAX_CHARS);
			expect(env.payload.reason).toBe('mention');
			// The app password must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.appPassword);
		});

		it('stops the notification page at the first item older than the window', async () => {
			listNotificationsMock.mockResolvedValueOnce({
				data: {
					notifications: [
						{
							uri: 'at://did:plc:a/app.bsky.feed.post/new',
							reason: 'reply',
							indexedAt: '2026-07-22T10:00:00.000Z'
						},
						{
							uri: 'at://did:plc:a/app.bsky.feed.post/old',
							reason: 'reply',
							indexedAt: '2026-07-01T10:00:00.000Z'
						}
					],
					cursor: 'page-2'
				}
			});
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(1);
			// Window exhausted → the phase ends rather than paging further back.
			expect(JSON.parse(res.nextCursor as string).p).toBe('author');
		});

		it('advances notifications → own posts → done across the sweep', async () => {
			listNotificationsMock.mockResolvedValueOnce(emptyNotifications());
			const afterNotifications = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: SETTINGS
			});
			expect(JSON.parse(afterNotifications.nextCursor as string).p).toBe('author');

			getAuthorFeedMock.mockResolvedValueOnce(emptyFeed());
			const afterAuthor = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterNotifications.nextCursor,
				settings: SETTINGS
			});
			expect(getAuthorFeedMock).toHaveBeenCalledTimes(1);
			expect(getAuthorFeedMock.mock.calls[0][0].actor).toBe('did:plc:acme');
			expect(afterAuthor.nextCursor).toBeUndefined();
		});

		it('normalizes own posts into bluesky.post envelopes with engagement counts', async () => {
			getAuthorFeedMock.mockResolvedValueOnce({
				data: {
					feed: [
						{
							post: {
								uri: 'at://did:plc:acme/app.bsky.feed.post/3kown',
								cid: 'cid-own',
								author: { did: 'did:plc:acme', handle: 'acme.bsky.social' },
								record: { text: 'we shipped', createdAt: '2026-07-22T09:00:00.000Z' },
								replyCount: 2,
								repostCount: 3,
								likeCount: 7,
								indexedAt: '2026-07-22T09:00:05.000Z'
							}
						}
					]
				}
			});
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: JSON.stringify({ p: 'author', s: '2026-07-20T00:00:00.000Z', b: 0 }),
				settings: SETTINGS
			});
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.kind).toBe('bluesky.post');
			expect(env.sourceUrl).toBe('https://bsky.app/profile/acme.bsky.social/post/3kown');
			expect(env.payload).toMatchObject({ replyCount: 2, repostCount: 3, likeCount: 7 });
		});

		it('keeps the SAME window across pages of a running sweep', async () => {
			listNotificationsMock.mockResolvedValueOnce({
				data: {
					notifications: [
						{
							uri: 'at://did:plc:a/app.bsky.feed.post/n1',
							reason: 'like',
							indexedAt: '2026-07-22T10:00:00.000Z'
						}
					],
					cursor: 'page-2'
				}
			});
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			const parsed = JSON.parse(first.nextCursor as string);
			expect(parsed).toMatchObject({ p: 'notifications', n: 'page-2', s: '2026-07-20T00:00:00.000Z' });

			listNotificationsMock.mockResolvedValueOnce(emptyNotifications());
			await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			expect(listNotificationsMock.mock.calls[1][0].cursor).toBe('page-2');
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			listNotificationsMock.mockResolvedValueOnce({
				data: {
					notifications: [
						{
							uri: 'at://did:plc:a/app.bsky.feed.post/n',
							reason: 'like',
							indexedAt: '2026-06-01T10:00:00.000Z'
						}
					],
					cursor: 'more'
				}
			});
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					p: 'notifications',
					n: 'page-n',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: BLUESKY_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed.p).toBe('author');
			expect(parsed.n).toBeUndefined();
			expect(parsed.b).toBe(0);
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			listNotificationsMock.mockResolvedValueOnce(emptyNotifications());
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: SETTINGS
			});
			expect(listNotificationsMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});
	});
});
