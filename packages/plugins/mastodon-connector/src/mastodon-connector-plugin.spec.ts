import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	MastodonConnectorPlugin,
	clampBackfillDays,
	resolveCredentials,
	resolveVisibility,
	stripStatusHtml,
	MASTODON_EVENT_TEXT_MAX_CHARS,
	MASTODON_PULL_PAGE_SIZE,
	MASTODON_BACKFILL_MAX_PAGES
} from './mastodon-connector-plugin.js';

const verifyCredentialsMock = vi.fn();
const statusesCreateMock = vi.fn();
const notificationsListMock = vi.fn();
const accountStatusesListMock = vi.fn();
const selectMock = vi.fn();
const clientFactoryMock = vi.fn();

/** Subclass overriding the client seam so no real SDK call ever happens. */
class TestMastodonConnectorPlugin extends MastodonConnectorPlugin {
	protected override createClient(instanceUrl: string, accessToken: string) {
		clientFactoryMock(instanceUrl, accessToken);
		return {
			v1: {
				accounts: {
					verifyCredentials: verifyCredentialsMock,
					$select: (id: string) => {
						selectMock(id);
						return { statuses: { list: accountStatusesListMock } };
					}
				},
				statuses: { create: statusesCreateMock },
				notifications: { list: notificationsListMock }
			}
		};
	}
}

const SETTINGS = { instanceUrl: 'https://mastodon.social', accessToken: 'mast-secret-token' };

describe('MastodonConnectorPlugin', () => {
	let plugin: TestMastodonConnectorPlugin;

	beforeEach(() => {
		plugin = new TestMastodonConnectorPlugin();
		verifyCredentialsMock.mockReset();
		statusesCreateMock.mockReset();
		notificationsListMock.mockReset();
		accountStatusesListMock.mockReset();
		selectMock.mockReset();
		clientFactoryMock.mockReset();
		verifyCredentialsMock.mockResolvedValue({ id: 'acct-1', acct: 'acme', displayName: 'Acme' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('declares the connector + connector-mastodon + event-source capabilities and poll metadata', () => {
		expect(plugin.id).toBe('mastodon-connector');
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-mastodon');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('mastodon');
		expect(plugin.connector.transport).toBe('poll');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks accessToken as x-secret and bounds backfillDays to 0–90 in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.accessToken['x-secret']).toBe(true);
		expect(props.accessToken['x-envVar']).toBe('MASTODON_ACCESS_TOKEN');
		expect(props.instanceUrl['x-secret']).toBeUndefined();
		expect(plugin.settingsSchema.required).toEqual(expect.arrayContaining(['instanceUrl', 'accessToken']));
		expect(props.backfillDays.maximum).toBe(90);
		expect(props.defaultVisibility.enum).toEqual(['public', 'unlisted', 'private', 'direct']);
	});

	it('clampBackfillDays clamps to the 0–90 range and treats garbage as off', () => {
		expect(clampBackfillDays(0)).toBe(0);
		expect(clampBackfillDays(45)).toBe(45);
		expect(clampBackfillDays(500)).toBe(90);
		expect(clampBackfillDays('nope')).toBe(0);
	});

	it('resolveVisibility accepts the documented values and falls back to public', () => {
		expect(resolveVisibility('unlisted')).toBe('unlisted');
		expect(resolveVisibility('DIRECT')).toBe('direct');
		expect(resolveVisibility('nonsense')).toBe('public');
		expect(resolveVisibility(undefined)).toBe('public');
	});

	it('stripStatusHtml turns status HTML into plain text', () => {
		expect(stripStatusHtml('<p>hello <a href="#">world</a></p>')).toBe('hello world');
		expect(stripStatusHtml('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
		expect(stripStatusHtml('a<br>b')).toBe('a\nb');
		expect(stripStatusHtml('&lt;script&gt; &amp; &quot;q&quot;')).toBe('<script> & "q"');
		expect(stripStatusHtml('<p></p>')).toBeUndefined();
		expect(stripStatusHtml(undefined)).toBeUndefined();
	});

	it('resolveCredentials requires BOTH instanceUrl and accessToken', () => {
		expect(resolveCredentials({}, { settings: SETTINGS })).toEqual(SETTINGS);
		expect(resolveCredentials({}, { settings: { instanceUrl: 'https://x.dev' } })).toBeUndefined();
		expect(resolveCredentials({}, { settings: { accessToken: 't' } })).toBeUndefined();
	});

	describe('verifyConnection', () => {
		it('returns the verified account details', async () => {
			const res = await plugin.verifyConnection({}, { settings: SETTINGS });
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ accountId: 'acct-1', acct: 'acme' });
			expect(clientFactoryMock).toHaveBeenCalledWith(SETTINGS.instanceUrl, SETTINGS.accessToken);
		});

		it('degrades loudly (never silently) when credentials are missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/instanceUrl and accessToken/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});

		it('refuses an SSRF-unsafe instance URL instead of calling it', async () => {
			const res = await plugin.verifyConnection(
				{},
				{ settings: { ...SETTINGS, instanceUrl: 'http://127.0.0.1:8080' } }
			);
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/unsafe instance URL/);
			expect(clientFactoryMock).not.toHaveBeenCalled();
		});
	});

	describe('send', () => {
		const options = { connectorId: 'conn-1', settings: SETTINGS };

		it('publishes a status with the configured visibility', async () => {
			statusesCreateMock.mockResolvedValueOnce({ id: 'status-9' });
			const res = await plugin.send(
				{ text: 'we shipped', messageRef: 'ref-1', attribution: { userId: 'u1' } },
				{ ...options, settings: { ...SETTINGS, defaultVisibility: 'unlisted' } }
			);
			expect(statusesCreateMock).toHaveBeenCalledWith({ status: 'we shipped', visibility: 'unlisted' });
			expect(res.providerMessageId).toBe('status-9');
			expect(res.provider).toBe('mastodon-connector');
		});

		it('threads a reply when the target carries inReplyToId', async () => {
			statusesCreateMock.mockResolvedValueOnce({ id: 'status-10' });
			await plugin.send(
				{
					text: 'thanks!',
					messageRef: 'ref-2',
					attribution: { userId: 'u1' },
					target: { inReplyToId: 'status-1' }
				},
				options
			);
			expect(statusesCreateMock.mock.calls[0][0].inReplyToId).toBe('status-1');
		});

		it('is idempotent on messageRef — a retry never double-posts', async () => {
			statusesCreateMock.mockResolvedValue({ id: 'status-1' });
			const payload = { text: 'once only', messageRef: 'ref-dup', attribution: { userId: 'u1' } };
			const first = await plugin.send(payload, options);
			const second = await plugin.send(payload, options);
			expect(statusesCreateMock).toHaveBeenCalledTimes(1);
			expect(second).toBe(first);
		});

		it('throws when credentials are missing instead of silently no-oping', async () => {
			await expect(
				plugin.send({ text: 'x', messageRef: 'r', attribution: { userId: 'u1' } }, { connectorId: 'c' })
			).rejects.toThrow(/instanceUrl and accessToken are required/);
			expect(statusesCreateMock).not.toHaveBeenCalled();
		});
	});

	describe('pullEvents', () => {
		it('throws EventSourceNotConfiguredError when the instance URL is missing', async () => {
			await expect(
				plugin.pullEvents({ since: new Date(0).toISOString(), settings: { accessToken: 't' } })
			).rejects.toMatchObject({ name: 'EventSourceNotConfiguredError' });
			expect(notificationsListMock).not.toHaveBeenCalled();
		});

		it('throws EventSourceNotConfiguredError when the access token is missing', async () => {
			await expect(
				plugin.pullEvents({ since: new Date(0).toISOString(), settings: { instanceUrl: 'https://x.dev' } })
			).rejects.toMatchObject({ name: 'EventSourceNotConfiguredError' });
		});

		it('first pull with backfill off uses a now-anchored window (no history)', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			notificationsListMock.mockResolvedValueOnce([
				{ id: 'n1', type: 'mention', createdAt: '2026-07-25T11:00:00.000Z' }
			]);
			const res = await plugin.pullEvents({ since: new Date(0).toISOString(), settings: SETTINGS });
			expect(res.events).toEqual([]);
			expect(JSON.parse(res.nextCursor as string).s).toBe('2026-07-25T12:00:00.000Z');
		});

		it('first pull with backfillDays widens the window, clamped to 90 days', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
			notificationsListMock.mockResolvedValue([]);
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				settings: { ...SETTINGS, backfillDays: 500 }
			});
			expect(JSON.parse(res.nextCursor as string).s).toBe('2026-04-26T12:00:00.000Z');
		});

		it('normalizes notifications into mastodon.notification envelopes with capped text', async () => {
			notificationsListMock.mockResolvedValueOnce([
				{
					id: 'n-1',
					type: 'mention',
					createdAt: '2026-07-22T10:00:00.000Z',
					account: { id: 'a-2', acct: 'fan@example.social', displayName: 'Fan', url: 'https://x/@fan' },
					status: {
						id: 's-1',
						url: 'https://mastodon.social/@fan/1',
						content: `<p>${'m'.repeat(MASTODON_EVENT_TEXT_MAX_CHARS + 40)}</p>`
					}
				}
			]);
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.source).toBe('mastodon-connector');
			expect(env.kind).toBe('mastodon.notification');
			expect(env.sourceEventId).toBe('notification:n-1');
			expect(env.actor).toEqual({ name: 'Fan', externalId: 'a-2' });
			expect(env.subject).toMatchObject({ type: 'status', externalId: 's-1' });
			expect(env.sourceUrl).toBe('https://mastodon.social/@fan/1');
			expect((env.payload.text as string).length).toBe(MASTODON_EVENT_TEXT_MAX_CHARS);
			// The access token must never leak into the envelope.
			expect(JSON.stringify(res.events)).not.toContain(SETTINGS.accessToken);
		});

		it('stops the page at the first item older than the window', async () => {
			notificationsListMock.mockResolvedValueOnce([
				{ id: 'n-new', type: 'favourite', createdAt: '2026-07-22T10:00:00.000Z' },
				{ id: 'n-old', type: 'favourite', createdAt: '2026-07-01T10:00:00.000Z' }
			]);
			const res = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			expect(res.events).toHaveLength(1);
			expect(JSON.parse(res.nextCursor as string).p).toBe('statuses');
		});

		it('pages by max_id while the page is full and keeps the SAME window', async () => {
			const fullPage = Array.from({ length: MASTODON_PULL_PAGE_SIZE }, (_, i) => ({
				id: `n-${i}`,
				type: 'mention',
				createdAt: '2026-07-22T10:00:00.000Z'
			}));
			notificationsListMock.mockResolvedValueOnce(fullPage);
			const first = await plugin.pullEvents({ since: '2026-07-20T00:00:00.000Z', settings: SETTINGS });
			const parsed = JSON.parse(first.nextCursor as string);
			expect(parsed).toMatchObject({
				p: 'notifications',
				n: `n-${MASTODON_PULL_PAGE_SIZE - 1}`,
				s: '2026-07-20T00:00:00.000Z'
			});

			notificationsListMock.mockResolvedValueOnce([]);
			await plugin.pullEvents({
				since: '2026-07-24T00:00:00.000Z', // a moved watermark must NOT shift the running sweep
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			expect(notificationsListMock.mock.calls[1][0].maxId).toBe(`n-${MASTODON_PULL_PAGE_SIZE - 1}`);
		});

		it('advances notifications → own statuses → done across the sweep', async () => {
			notificationsListMock.mockResolvedValueOnce([]);
			const afterNotifications = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				settings: SETTINGS
			});
			expect(JSON.parse(afterNotifications.nextCursor as string).p).toBe('statuses');

			accountStatusesListMock.mockResolvedValueOnce([]);
			const afterStatuses = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: afterNotifications.nextCursor,
				settings: SETTINGS
			});
			expect(selectMock).toHaveBeenCalledWith('acct-1');
			expect(afterStatuses.nextCursor).toBeUndefined();
		});

		it('normalizes own statuses into mastodon.status envelopes with engagement counts', async () => {
			accountStatusesListMock.mockResolvedValueOnce([
				{
					id: 's-9',
					uri: 'https://mastodon.social/users/acme/statuses/9',
					url: 'https://mastodon.social/@acme/9',
					content: '<p>release notes</p>',
					createdAt: '2026-07-22T09:00:00.000Z',
					visibility: 'public',
					repliesCount: 1,
					reblogsCount: 4,
					favouritesCount: 9,
					account: { id: 'acct-1', acct: 'acme' }
				}
			]);
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: JSON.stringify({ p: 'statuses', s: '2026-07-20T00:00:00.000Z', b: 0 }),
				settings: SETTINGS
			});
			expect(res.events).toHaveLength(1);
			const env = res.events[0];
			expect(env.kind).toBe('mastodon.status');
			expect(env.sourceEventId).toBe('status:s-9');
			expect(env.sourceUrl).toBe('https://mastodon.social/@acme/9');
			expect(env.payload).toMatchObject({ repliesCount: 1, reblogsCount: 4, favouritesCount: 9 });
			expect(env.payload.text).toBe('release notes');
		});

		it('throws loudly when the token resolves to no account in the statuses phase', async () => {
			verifyCredentialsMock.mockResolvedValueOnce({});
			await expect(
				plugin.pullEvents({
					since: '2026-07-20T00:00:00.000Z',
					cursor: JSON.stringify({ p: 'statuses', s: '2026-07-20T00:00:00.000Z', b: 0 }),
					settings: SETTINGS
				})
			).rejects.toMatchObject({ name: 'EventSourceNotConfiguredError' });
		});

		it('bounds backfill sweeps to the per-phase page budget', async () => {
			const fullPage = Array.from({ length: MASTODON_PULL_PAGE_SIZE }, (_, i) => ({
				id: `n-${i}`,
				type: 'mention',
				createdAt: '2026-06-01T10:00:00.000Z'
			}));
			notificationsListMock.mockResolvedValueOnce(fullPage);
			const res = await plugin.pullEvents({
				since: new Date(0).toISOString(),
				cursor: JSON.stringify({
					p: 'notifications',
					n: 'n-prev',
					s: '2026-05-01T00:00:00.000Z',
					f: 1,
					b: MASTODON_BACKFILL_MAX_PAGES - 1
				}),
				settings: { ...SETTINGS, backfillDays: 90 }
			});
			const parsed = JSON.parse(res.nextCursor as string);
			expect(parsed.p).toBe('statuses');
			expect(parsed.n).toBeUndefined();
			expect(parsed.b).toBe(0);
		});

		it('treats a malformed cursor as a fresh sweep instead of crashing', async () => {
			notificationsListMock.mockResolvedValueOnce([]);
			const res = await plugin.pullEvents({
				since: '2026-07-20T00:00:00.000Z',
				cursor: 'not-json{{{',
				settings: SETTINGS
			});
			expect(notificationsListMock).toHaveBeenCalledTimes(1);
			expect(res.events).toEqual([]);
		});
	});
});
