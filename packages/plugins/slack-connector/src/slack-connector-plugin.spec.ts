import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const postMessageMock = vi.fn();
const authTestMock = vi.fn();
const historyMock = vi.fn();
const permalinkMock = vi.fn();
const ctorMock = vi.fn();

vi.mock('@slack/web-api', () => ({
	WebClient: class {
		constructor(token: string) {
			ctorMock(token);
		}
		chat = { postMessage: postMessageMock, getPermalink: permalinkMock };
		auth = { test: authTestMock };
		conversations = { history: historyMock };
	}
}));

import { SlackConnectorPlugin, slackTsToIso, isoToSlackTs } from './slack-connector-plugin.js';
import { computeSlackSignature, verifySlackSignature } from './slack-signature.js';

const TARGET = { botToken: 'xoxb-123', defaultChannelId: 'C0123456789' };

describe('SlackConnectorPlugin', () => {
	let plugin: SlackConnectorPlugin;

	beforeEach(() => {
		plugin = new SlackConnectorPlugin();
		postMessageMock.mockReset();
		authTestMock.mockReset();
		historyMock.mockReset();
		permalinkMock.mockReset();
		ctorMock.mockReset();
	});

	it('declares the connector + connector-slack + event-source capabilities and bidirectional metadata', () => {
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-slack');
		expect(plugin.capabilities).toContain('event-source');
		expect(plugin.providerName).toBe('slack');
		expect(plugin.connector.direction).toBe('bidirectional');
		expect(plugin.connector.transport).toBe('webhook');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.richOutbound).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(true);
		expect(plugin.connector.flags.reply).toBe(true);
	});

	it('marks botToken + signingSecret as x-secret in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.botToken['x-secret']).toBe(true);
		expect(props.signingSecret['x-secret']).toBe(true);
		expect(plugin.settingsSchema.required).toContain('botToken');
	});

	describe('verifyConnection', () => {
		it('returns valid + details when auth.test succeeds', async () => {
			authTestMock.mockResolvedValueOnce({
				team_id: 'T1',
				team: 'Acme',
				user_id: 'U1',
				url: 'https://acme.slack.com'
			});
			const res = await plugin.verifyConnection(TARGET, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ teamId: 'T1', botUserId: 'U1' });
			expect(ctorMock).toHaveBeenCalledWith('xoxb-123');
		});

		it('returns invalid without calling Slack when botToken is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/botToken/);
			expect(authTestMock).not.toHaveBeenCalled();
		});

		it('returns invalid and surfaces the Slack error when auth.test fails', async () => {
			authTestMock.mockRejectedValueOnce({ data: { error: 'invalid_auth' } });
			const res = await plugin.verifyConnection(TARGET, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/invalid_auth/);
		});
	});

	describe('send', () => {
		it('posts text + blocks via chat.postMessage and returns the message ts', async () => {
			postMessageMock.mockResolvedValueOnce({ ok: true, channel: 'C0123456789', ts: '1700000000.000100' });
			const res = await plugin.send(
				{
					text: 'build is green',
					rich: { kind: 'slack-blocks', payload: [{ type: 'section' }] },
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: TARGET
				},
				{ connectorId: 'conn-1' }
			);
			expect(res.providerMessageId).toBe('1700000000.000100');
			expect(res.provider).toBe('slack-connector');
			expect(ctorMock).toHaveBeenCalledWith('xoxb-123');
			const args = postMessageMock.mock.calls[0][0];
			expect(args.channel).toBe('C0123456789');
			expect(args.text).toBe('build is green');
			expect(args.blocks).toEqual([{ type: 'section' }]);
		});

		it('throws when no channel id can be resolved', async () => {
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-nochan',
						attribution: { userId: 'u1' },
						target: { botToken: 'xoxb-123' }
					},
					{}
				)
			).rejects.toThrow(/channel id is required/);
			expect(postMessageMock).not.toHaveBeenCalled();
		});

		it('throws and surfaces the Slack error on a postMessage failure', async () => {
			postMessageMock.mockRejectedValueOnce({ data: { error: 'channel_not_found' } });
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'ref-err', attribution: { userId: 'u1' }, target: TARGET },
					{ connectorId: 'conn-1' }
				)
			).rejects.toThrow(/Slack chat\.postMessage failed: channel_not_found/);
		});

		it('hits the idempotency cache on a repeated messageRef', async () => {
			postMessageMock.mockResolvedValue({ ok: true, channel: 'C0123456789', ts: '1700000000.000200' });
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: TARGET
			};
			await plugin.send(input, { connectorId: 'conn-1' });
			await plugin.send(input, { connectorId: 'conn-1' });
			expect(postMessageMock).toHaveBeenCalledTimes(1);
		});

		it('resolves a per-send channelId override ahead of defaultChannelId', async () => {
			postMessageMock.mockResolvedValueOnce({ ok: true, channel: 'C999', ts: '1700000000.000300' });
			await plugin.send(
				{
					text: 'hi',
					messageRef: 'ref-override',
					attribution: { userId: 'u1' },
					target: { botToken: 'xoxb-123', channelId: 'C999', defaultChannelId: 'C0123456789' }
				},
				{ connectorId: 'conn-1' }
			);
			expect(postMessageMock.mock.calls[0][0].channel).toBe('C999');
		});

		it('posts into a thread when the target carries a threadTs', async () => {
			postMessageMock.mockResolvedValueOnce({ ok: true, ts: '1700000000.000400' });
			await plugin.send(
				{
					text: 'threaded',
					messageRef: 'ref-thread',
					attribution: { userId: 'u1' },
					target: { ...TARGET, threadTs: '1699999999.000001' }
				},
				{ connectorId: 'conn-1' }
			);
			expect(postMessageMock.mock.calls[0][0].thread_ts).toBe('1699999999.000001');
		});
	});

	describe('signature helpers (HMAC v0)', () => {
		const SECRET = 's3cr3t';
		const BODY = '{"type":"event_callback"}';
		const NOW_MS = 1_700_000_000_000;
		const TS = String(Math.floor(NOW_MS / 1000));

		it('accepts a correctly signed delivery inside the tolerance window', () => {
			const signature = computeSlackSignature(SECRET, TS, BODY);
			const res = verifySlackSignature({
				rawBody: BODY,
				timestamp: TS,
				signature,
				signingSecret: SECRET,
				nowMs: NOW_MS
			});
			expect(res.valid).toBe(true);
			// Sanity-check the wire format against a hand-rolled digest.
			const digest = createHmac('sha256', SECRET).update(`v0:${TS}:${BODY}`).digest('hex');
			expect(signature).toBe(`v0=${digest}`);
		});

		it('rejects a tampered body (signature mismatch)', () => {
			const signature = computeSlackSignature(SECRET, TS, BODY);
			const res = verifySlackSignature({
				rawBody: BODY + 'x',
				timestamp: TS,
				signature,
				signingSecret: SECRET,
				nowMs: NOW_MS
			});
			expect(res).toEqual({ valid: false, reason: 'signature-mismatch' });
		});

		it('rejects a stale timestamp outside the ±300s window', () => {
			const staleTs = String(Math.floor(NOW_MS / 1000) - 301);
			const signature = computeSlackSignature(SECRET, staleTs, BODY);
			const res = verifySlackSignature({
				rawBody: BODY,
				timestamp: staleTs,
				signature,
				signingSecret: SECRET,
				nowMs: NOW_MS
			});
			expect(res).toEqual({ valid: false, reason: 'stale-timestamp' });
		});

		it('fails closed when the signing secret or headers are missing', () => {
			const signature = computeSlackSignature(SECRET, TS, BODY);
			expect(
				verifySlackSignature({
					rawBody: BODY,
					timestamp: TS,
					signature,
					signingSecret: undefined,
					nowMs: NOW_MS
				})
			).toEqual({ valid: false, reason: 'missing-signing-secret' });
			expect(
				verifySlackSignature({
					rawBody: BODY,
					timestamp: undefined,
					signature,
					signingSecret: SECRET,
					nowMs: NOW_MS
				})
			).toEqual({ valid: false, reason: 'missing-headers' });
		});
	});

	describe('inbound (Events API)', () => {
		const SECRET = 'signing-secret';

		function signedRequest(bodyObj: unknown, nowMs = Date.now()) {
			const rawBody = JSON.stringify(bodyObj);
			const ts = String(Math.floor(nowMs / 1000));
			return {
				rawBody,
				headers: {
					'x-slack-request-timestamp': ts,
					'x-slack-signature': computeSlackSignature(SECRET, ts, rawBody)
				}
			};
		}

		it('verifyInbound accepts a freshly signed delivery and fails closed without a secret', async () => {
			const req = signedRequest({ type: 'event_callback' });
			const ok = await plugin.verifyInbound(req, { settings: { signingSecret: SECRET } });
			expect(ok.valid).toBe(true);

			const closed = await plugin.verifyInbound(req, { settings: {} });
			expect(closed.valid).toBe(false);
			expect(closed.reason).toBe('missing-signing-secret');
		});

		it('handleChallenge echoes url_verification and ignores other payloads', () => {
			const challenge = plugin.handleChallenge({
				rawBody: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
				headers: {}
			});
			expect(challenge).toEqual({ status: 200, body: { challenge: 'abc123' } });

			expect(
				plugin.handleChallenge({ rawBody: JSON.stringify({ type: 'event_callback' }), headers: {} })
			).toBeNull();
			expect(plugin.handleChallenge({ rawBody: 'not-json', headers: {} })).toBeNull();
		});

		it('parseInbound normalizes app_mention events and skips bot-authored messages', async () => {
			const mention = await plugin.parseInbound(
				{
					rawBody: JSON.stringify({
						type: 'event_callback',
						event_id: 'Ev123',
						event: {
							type: 'app_mention',
							user: 'U777',
							text: '<@UBOT> hello',
							channel: 'C42',
							ts: '1700000100.000200',
							thread_ts: '1700000000.000100'
						}
					}),
					headers: {}
				},
				{}
			);
			expect(mention).toHaveLength(1);
			expect(mention[0]).toMatchObject({
				kind: 'message',
				externalConversationId: 'C42:1700000000.000100',
				externalUserId: 'U777',
				providerEventId: 'Ev123'
			});

			const botMessage = await plugin.parseInbound(
				{
					rawBody: JSON.stringify({
						type: 'event_callback',
						event: { type: 'message', bot_id: 'B1', text: 'from a bot', channel: 'C42', ts: '1.2' }
					}),
					headers: {}
				},
				{}
			);
			expect(botMessage).toHaveLength(0);
		});

		it('reply posts into the originating thread via chat.postMessage', async () => {
			postMessageMock.mockResolvedValueOnce({ ok: true, ts: '1700000200.000300' });
			const res = await plugin.reply(
				{
					externalConversationId: 'C42:1700000000.000100',
					text: 'answer',
					inReplyToProviderEventId: 'Ev123'
				},
				{ target: { botToken: 'xoxb-123' } }
			);
			expect(res.providerMessageId).toBe('1700000200.000300');
			const args = postMessageMock.mock.calls[0][0];
			expect(args.channel).toBe('C42');
			expect(args.thread_ts).toBe('1700000000.000100');
			expect(args.text).toBe('answer');
		});
	});

	describe('pullEvents (event source)', () => {
		const SETTINGS = { botToken: 'xoxb-123', eventChannelIds: 'C1, C2' };

		beforeEach(() => {
			authTestMock.mockResolvedValue({ ok: true, user_id: 'UBOT' });
			permalinkMock.mockResolvedValue({ ok: true, permalink: 'https://ws.slack.com/archives/C1/p1' });
		});

		it('throws EventSourceNotConfiguredError without a botToken', async () => {
			await expect(plugin.pullEvents({ since: '2026-01-01T00:00:00.000Z', settings: {} })).rejects.toMatchObject({
				name: 'EventSourceNotConfiguredError'
			});
			expect(historyMock).not.toHaveBeenCalled();
		});

		it('returns an empty result when no channels are configured (outbound-only setup)', async () => {
			const res = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				settings: { botToken: 'xoxb-123' }
			});
			expect(res.events).toEqual([]);
			expect(res.nextCursor).toBeUndefined();
			expect(historyMock).not.toHaveBeenCalled();
		});

		it('normalizes messages into envelopes (kind, identity, occurredAt, permalink, payload)', async () => {
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [{ type: 'message', user: 'U1', text: 'plain message', ts: '1700000000.000100', team: 'T1' }]
			});
			const res = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				settings: { botToken: 'xoxb-123', eventChannelIds: 'C1' }
			});
			expect(res.events).toHaveLength(1);
			const envelope = res.events[0];
			expect(envelope.source).toBe('slack-connector');
			expect(envelope.kind).toBe('slack.message');
			expect(envelope.sourceEventId).toBe('C1:1700000000.000100');
			expect(envelope.occurredAt).toBe(slackTsToIso('1700000000.000100'));
			expect(envelope.sourceUrl).toBe('https://ws.slack.com/archives/C1/p1');
			expect(envelope.actor).toMatchObject({ externalId: 'U1' });
			expect(envelope.subject).toEqual({ type: 'channel', externalId: 'C1' });
			expect(envelope.payload).toMatchObject({ channel: 'C1', ts: '1700000000.000100', teamId: 'T1' });
			// The watermark is forwarded as Slack's `oldest`.
			expect(historyMock.mock.calls[0][0].oldest).toBe(isoToSlackTs('2026-01-01T00:00:00.000Z'));
		});

		it('classifies bot-mention messages as slack.mention', async () => {
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [{ type: 'message', user: 'U1', text: 'hey <@UBOT> do a thing', ts: '2.1' }]
			});
			const res = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				settings: { botToken: 'xoxb-123', eventChannelIds: 'C1' }
			});
			expect(res.events).toHaveLength(1);
			expect(res.events[0].kind).toBe('slack.mention');
		});

		it('skips bot-authored and subtype messages (never re-ingests its own replies)', async () => {
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [
					{ type: 'message', bot_id: 'B1', text: 'bot noise', ts: '3.1' },
					{ type: 'message', user: 'UBOT', text: 'my own reply', ts: '3.2' },
					{ type: 'message', subtype: 'channel_join', user: 'U9', ts: '3.3' },
					{ type: 'message', user: 'U1', text: 'human words', ts: '3.4' }
				]
			});
			const res = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				settings: { botToken: 'xoxb-123', eventChannelIds: 'C1' }
			});
			expect(res.events).toHaveLength(1);
			expect(res.events[0].payload.text).toBe('human words');
		});

		it('pages via the returned cursor: Slack next_cursor first, then the next channel', async () => {
			// Page 1 of C1 has more.
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [{ type: 'message', user: 'U1', text: 'a', ts: '4.1' }],
				response_metadata: { next_cursor: 'slack-cursor-2' }
			});
			const first = await plugin.pullEvents({ since: '2026-01-01T00:00:00.000Z', settings: SETTINGS });
			expect(first.nextCursor).toBe(JSON.stringify({ c: 'C1', n: 'slack-cursor-2' }));

			// Page 2 of C1 completes → advance to C2.
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [{ type: 'message', user: 'U1', text: 'b', ts: '4.2' }]
			});
			const second = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				cursor: first.nextCursor,
				settings: SETTINGS
			});
			expect(historyMock.mock.calls[1][0]).toMatchObject({ channel: 'C1', cursor: 'slack-cursor-2' });
			expect(second.nextCursor).toBe(JSON.stringify({ c: 'C2' }));

			// C2 completes → sweep done, no cursor.
			historyMock.mockResolvedValueOnce({ ok: true, messages: [] });
			const third = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				cursor: second.nextCursor,
				settings: SETTINGS
			});
			expect(historyMock.mock.calls[2][0]).toMatchObject({ channel: 'C2' });
			expect(third.nextCursor).toBeUndefined();
		});

		it('tolerates permalink failures (drops sourceUrl) and truncates oversized text', async () => {
			permalinkMock.mockRejectedValue(new Error('permalink boom'));
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [{ type: 'message', user: 'U1', text: 'x'.repeat(5000), ts: '5.1' }]
			});
			const res = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				settings: { botToken: 'xoxb-123', eventChannelIds: 'C1' }
			});
			expect(res.events).toHaveLength(1);
			expect(res.events[0].sourceUrl).toBeUndefined();
			expect((res.events[0].payload.text as string).length).toBe(4000);
		});

		it('returns events oldest-first even though Slack history is newest-first', async () => {
			historyMock.mockResolvedValueOnce({
				ok: true,
				messages: [
					{ type: 'message', user: 'U1', text: 'newest', ts: '9.2' },
					{ type: 'message', user: 'U1', text: 'oldest', ts: '9.1' }
				]
			});
			const res = await plugin.pullEvents({
				since: '2026-01-01T00:00:00.000Z',
				settings: { botToken: 'xoxb-123', eventChannelIds: 'C1' }
			});
			expect(res.events.map((e) => e.payload.text)).toEqual(['oldest', 'newest']);
		});
	});
});
