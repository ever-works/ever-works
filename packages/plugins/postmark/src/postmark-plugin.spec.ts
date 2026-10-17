import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sendEmailMock = vi.fn();

vi.mock('postmark', () => ({
	ServerClient: class {
		sendEmail = sendEmailMock;
	}
}));

import { PostmarkPlugin } from './postmark-plugin.js';

describe('PostmarkPlugin', () => {
	let plugin: PostmarkPlugin;

	beforeEach(() => {
		plugin = new PostmarkPlugin();
		process.env.POSTMARK_API_KEY = 'test-key';
		sendEmailMock.mockReset();
	});

	it('declares email-outbound + email-inbound capabilities', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.capabilities).toContain('email-inbound');
	});

	describe('sendEmail', () => {
		it('sends via the postmark SDK and returns providerMessageId on success', async () => {
			sendEmailMock.mockResolvedValueOnce({ MessageID: 'pm-123', ErrorCode: 0 });

			const result = await plugin.sendEmail(
				{
					from: 'a@example.com',
					to: ['b@example.com'],
					subject: 'hi',
					bodyText: 'hi',
					messageRef: 'ref-1'
				},
				{ userId: 'user-1' }
			);

			expect(result.providerMessageId).toBe('pm-123');
			expect(result.accepted).toEqual(['b@example.com']);
			const msg = sendEmailMock.mock.calls[0][0];
			expect(msg.To).toBe('b@example.com');
			expect(msg.TextBody).toBe('hi');
		});

		it('throws when the postmark SDK rejects the send', async () => {
			sendEmailMock.mockRejectedValueOnce({ code: 405, message: 'Invalid sender' });

			await expect(
				plugin.sendEmail(
					{
						from: 'a@example.com',
						to: ['b@example.com'],
						subject: 'hi',
						bodyText: 'hi',
						messageRef: 'ref-2'
					},
					{ userId: 'user-1' }
				)
			).rejects.toThrow(/Postmark send failed \(405\): Invalid sender/);
		});

		it('returns the cached result for a repeated messageRef (idempotency)', async () => {
			sendEmailMock.mockResolvedValue({ MessageID: 'pm-cache', ErrorCode: 0 });

			const input = {
				from: 'a@example.com',
				to: ['b@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				messageRef: 'ref-cache'
			};
			const r1 = await plugin.sendEmail(input, { userId: 'u' });
			const r2 = await plugin.sendEmail(input, { userId: 'u' });
			expect(r1).toEqual(r2);
			expect(sendEmailMock).toHaveBeenCalledTimes(1);
		});

		it('does NOT serve a cached result across different userIds (tenant isolation)', async () => {
			// Security: the local idempotency cache key is scoped by
			// options.userId/workId — the same messageRef from two different
			// users must trigger two real sends, never leak user A's cached
			// result to B.
			sendEmailMock.mockResolvedValue({ MessageID: 'pm-scoped', ErrorCode: 0 });

			const input = {
				from: 'a@example.com',
				to: ['b@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				messageRef: 'ref-shared'
			};
			await plugin.sendEmail(input, { userId: 'user-a' });
			await plugin.sendEmail(input, { userId: 'user-b' });
			expect(sendEmailMock).toHaveBeenCalledTimes(2);
		});
	});

	// EW-P4-3 — RFC threading.
	describe('RFC threading headers', () => {
		it('forwards EmailSendInput.headers as Postmark Headers', async () => {
			sendEmailMock.mockResolvedValueOnce({ MessageID: 'pm-1', ErrorCode: 0 });
			await plugin.sendEmail(
				{
					from: 'a@example.com',
					to: ['b@example.com'],
					subject: 'Re: hi',
					bodyText: 'hi',
					messageRef: 'ref-thread',
					headers: {
						'Message-ID': '<out-1@acme.test>',
						'In-Reply-To': '<in-1@client.test>',
						References: '<root@client.test> <in-1@client.test>'
					}
				},
				{ userId: 'user-1' }
			);
			expect(sendEmailMock.mock.calls[0][0].Headers).toEqual([
				{ Name: 'Message-ID', Value: '<out-1@acme.test>' },
				{ Name: 'In-Reply-To', Value: '<in-1@client.test>' },
				{ Name: 'References', Value: '<root@client.test> <in-1@client.test>' }
			]);
		});

		it('sends no Headers when none are given', async () => {
			sendEmailMock.mockResolvedValueOnce({ MessageID: 'pm-2', ErrorCode: 0 });
			await plugin.sendEmail(
				{ from: 'a@example.com', to: ['b@example.com'], subject: 's', bodyText: 'b', messageRef: 'ref-none' },
				{ userId: 'user-1' }
			);
			expect(sendEmailMock.mock.calls[0][0].Headers).toBeUndefined();
		});

		it('parses Message-ID / In-Reply-To / References from the inbound Headers (case-insensitive)', async () => {
			const msg = await plugin.parseInboundWebhook(
				Buffer.from(
					JSON.stringify({
						MessageID: 'postmark-own-id',
						From: 'x@y.test',
						To: 'agent@acme.test',
						Subject: 'Re: hi',
						Date: '2026-10-15T10:00:00Z',
						Headers: [
							{ Name: 'message-id', Value: '<reply-2@client.test>' },
							{ Name: 'In-Reply-To', Value: '<out-1@acme.test>' },
							{ Name: 'References', Value: '<root@client.test>\r\n <out-1@acme.test>' }
						]
					})
				),
				{},
				{}
			);
			expect(msg.providerMessageId).toBe('postmark-own-id');
			expect(msg.messageIdHeader).toBe('reply-2@client.test');
			expect(msg.inReplyTo).toBe('out-1@acme.test');
			expect(msg.references).toEqual(['root@client.test', 'out-1@acme.test']);
		});

		it('parses Cc from CcFull, or from the raw Cc header (EW-P4-3)', async () => {
			const full = await plugin.parseInboundWebhook(
				Buffer.from(
					JSON.stringify({
						MessageID: 'm1',
						From: 'x@y.test',
						To: 'a@b.test',
						CcFull: [{ Email: 'c1@b.test', Name: 'C One' }, { Email: 'c2@b.test' }],
						Subject: 's',
						Date: '2026-10-15T10:00:00Z'
					})
				),
				{},
				{}
			);
			expect(full.cc).toEqual(['c1@b.test', 'c2@b.test']);
			const raw = await plugin.parseInboundWebhook(
				Buffer.from(
					JSON.stringify({
						MessageID: 'm2',
						From: 'x@y.test',
						To: 'a@b.test',
						Cc: '"C One" <c1@b.test>, c2@b.test',
						Subject: 's',
						Date: '2026-10-15T10:00:00Z'
					})
				),
				{},
				{}
			);
			expect(raw.cc).toEqual(['c1@b.test', 'c2@b.test']);
		});

		// Review (#2612): a quoted display name may contain a comma.
		it('keeps a quoted display name with a comma in one Cc mailbox', async () => {
			const msg = await plugin.parseInboundWebhook(
				Buffer.from(
					JSON.stringify({
						MessageID: 'm3',
						From: 'x@y.test',
						To: 'a@b.test',
						Cc: '"Doe, John" <john@example.com>, jane@example.com, "a\\"b, c" <q@example.com>',
						Subject: 's',
						Date: '2026-10-15T10:00:00Z'
					})
				),
				{},
				{}
			);
			expect(msg.cc).toEqual(['john@example.com', 'jane@example.com', 'q@example.com']);
		});

		it('splits a hostile Cc header in linear time', async () => {
			const started = Date.now();
			await plugin.parseInboundWebhook(
				Buffer.from(
					JSON.stringify({
						MessageID: 'm4',
						From: 'x@y.test',
						To: 'a@b.test',
						Cc: '"'.repeat(100_000) + '<'.repeat(100_000),
						Subject: 's',
						Date: '2026-10-15T10:00:00Z'
					})
				),
				{},
				{}
			);
			expect(Date.now() - started).toBeLessThan(2000);
		});

		it('leaves the threading fields out when the headers are absent', async () => {
			const msg = await plugin.parseInboundWebhook(
				Buffer.from(
					JSON.stringify({
						MessageID: 'm',
						From: 'x@y.test',
						To: 'a@b.test',
						Subject: 's',
						Date: '2026-10-15T10:00:00Z'
					})
				),
				{},
				{}
			);
			expect(msg.messageIdHeader).toBeUndefined();
			expect(msg.inReplyTo).toBeUndefined();
			expect(msg.references).toBeUndefined();
		});
	});

	describe('parseInboundWebhook', () => {
		it('decodes Postmark Inbound JSON into canonical shape', async () => {
			const payload = {
				MessageID: 'pm-inbound-1',
				From: 'sender@example.com',
				FromName: 'Sender',
				ToFull: [{ Email: 'inbox@acme.com', Name: 'Inbox' }],
				Subject: 'Re: Hello',
				TextBody: 'plain body',
				HtmlBody: '<p>html body</p>',
				Date: '2026-05-28T10:00:00Z',
				Headers: [{ Name: 'X-Test', Value: 'yes' }],
				SpamScore: 0.1
			};
			const result = await plugin.parseInboundWebhook(Buffer.from(JSON.stringify(payload)), {}, {});
			expect(result.providerMessageId).toBe('pm-inbound-1');
			expect(result.from).toBe('sender@example.com');
			expect(result.to).toEqual(['inbox@acme.com']);
			expect(result.subject).toBe('Re: Hello');
			expect(result.bodyText).toBe('plain body');
			expect(result.bodyHtml).toBe('<p>html body</p>');
		});

		// The owner lookup (extractInboundRecipients) and the parsed `to` must
		// name the same mailboxes, on the raw `To` fallback too.
		it('reports the same bare recipient as extractInboundRecipients on the To fallback', async () => {
			const raw = Buffer.from(
				JSON.stringify({
					MessageID: 'pm-inbound-2',
					From: 'sender@example.com',
					To: '"Acme Inbox" <inbox@acme.com>',
					Subject: 's',
					Date: '2026-05-28T10:00:00Z'
				})
			);
			const result = await plugin.parseInboundWebhook(raw, {}, {});
			expect(result.to).toEqual(['inbox@acme.com']);
			expect(result.to).toEqual(plugin.extractInboundRecipients(raw, {}));
		});
	});

	describe('extractInboundRecipients', () => {
		it('returns ToFull emails as bare addresses', () => {
			const payload = { ToFull: [{ Email: 'inbox@acme.com' }, { Email: 'team@acme.com' }] };
			expect(plugin.extractInboundRecipients(Buffer.from(JSON.stringify(payload)), {})).toEqual([
				'inbox@acme.com',
				'team@acme.com'
			]);
		});

		it('strips the display name from the raw To header fallback', () => {
			const payload = { To: '"Acme Inbox" <inbox@acme.com>' };
			expect(plugin.extractInboundRecipients(Buffer.from(JSON.stringify(payload)), {})).toEqual([
				'inbox@acme.com'
			]);
		});

		it('returns [] on malformed JSON (never throws)', () => {
			expect(plugin.extractInboundRecipients(Buffer.from('not json'), {})).toEqual([]);
		});

		/**
		 * CodeQL js/polynomial-redos. The `To` fallback used to be read with `/<([^>]+)>/`, which
		 * backtracks quadratically over a run of `<` that never closes. The header is written by
		 * whoever sent the mail and is read here BEFORE the webhook is authenticated (and
		 * authentication is an operator opt-in for Postmark), so one POST could pin the event loop.
		 *
		 * Sized, not tightly timed: at 200 000 characters the regex needs ~40 s on a dev box and the
		 * scan milliseconds, so a 2 s bound can be failed neither by a CPU-throttled CI runner nor
		 * passed by the regex. Only `extractInboundRecipients` is timed — the webhook body is encoded
		 * first. (A "< 200 ms" at 50 000 was one scheduler stall from red — develop CI, 2026-10-09.)
		 */
		const recipientsOf = (to: string) =>
			plugin.extractInboundRecipients(Buffer.from(JSON.stringify({ To: to })), {});

		it.each([
			['a run of "<" that never closes', '<'.repeat(200_000)],
			['"<" followed by a run of "<="', `<${'<='.repeat(100_000)}`]
		])('reads %s in linear time', (_label, hostile) => {
			const body = Buffer.from(JSON.stringify({ To: hostile }));

			const started = performance.now();
			const recipients = plugin.extractInboundRecipients(body, {});
			const elapsedMs = performance.now() - started;

			expect(recipients).toEqual([hostile]);
			expect(elapsedMs).toBeLessThan(2_000);
		});

		// The rewrite must name exactly the mailbox the regex named.
		it.each([
			['a@b.test', ['a@b.test']],
			['"Name" <a@b.test>', ['a@b.test']],
			['<> <a@b.test>', ['a@b.test']],
			['<<a@b.test>', ['<a@b.test']],
			['<a@b.test', ['<a@b.test']],
			['x <  spaced@b.test  >', ['spaced@b.test']],
			['<a@b.test> <c@d.test>', ['a@b.test']],
			['a>b <c@d.test>', ['c@d.test']],
			['<>', ['<>']],
			['<\n>', []]
		])('parses the To fallback %j as the angle-address regex did', (to, expected) => {
			expect(recipientsOf(to)).toEqual(expected);
		});
	});

	describe('verifyWebhookSignature', () => {
		it('throws on Authorization header mismatch when secret is set', () => {
			expect(() =>
				plugin.verifyWebhookSignature(
					Buffer.from(''),
					{ authorization: 'Basic xxx' },
					{ settings: { inboundWebhookSecret: 'super-secret' } }
				)
			).toThrow(/signature mismatch/);
		});

		// EW-P4-3 — with no secret configured an inbound webhook is REFUSED
		// (it used to be accepted with a warning: anyone who knew the public
		// URL could inject mail). Only the explicit operator opt-out accepts it.
		describe('with no secret configured', () => {
			const savedSecret = process.env.POSTMARK_INBOUND_SECRET;
			const savedOptOut = process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;

			beforeEach(() => {
				delete process.env.POSTMARK_INBOUND_SECRET;
				delete process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
			});

			afterEach(() => {
				if (savedSecret === undefined) delete process.env.POSTMARK_INBOUND_SECRET;
				else process.env.POSTMARK_INBOUND_SECRET = savedSecret;
				if (savedOptOut === undefined) delete process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
				else process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = savedOptOut;
			});

			it('refuses an unsigned webhook', () => {
				expect(() => plugin.verifyWebhookSignature(Buffer.from(''), {}, { settings: {} })).toThrow(
					/refusing an unsigned webhook/
				);
			});

			it('refuses a webhook carrying an Authorization header it cannot check', () => {
				expect(() =>
					plugin.verifyWebhookSignature(
						Buffer.from(''),
						{ authorization: `Basic ${Buffer.from('postmark:guess').toString('base64')}` },
						{ settings: {} }
					)
				).toThrow(/refusing an unsigned webhook/);
			});

			it.each(['TRUE', '1', 'yes', ' true', ''])(
				'stays secure when EMAIL_INBOUND_ALLOW_UNSIGNED is %j (only the exact string "true" opts out)',
				(value) => {
					process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = value;
					expect(() => plugin.verifyWebhookSignature(Buffer.from(''), {}, { settings: {} })).toThrow(
						/refusing an unsigned webhook/
					);
				}
			);

			it('accepts — and warns the operator — only with EMAIL_INBOUND_ALLOW_UNSIGNED=true', () => {
				process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = 'true';
				const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
				try {
					expect(() => plugin.verifyWebhookSignature(Buffer.from(''), {}, { settings: {} })).not.toThrow();
					expect(warnSpy).toHaveBeenCalledTimes(1);
					expect(warnSpy.mock.calls[0][0]).toMatch(/WITHOUT signature verification/);
				} finally {
					warnSpy.mockRestore();
				}
			});

			it('verifies with the env secret when POSTMARK_INBOUND_SECRET is set', () => {
				process.env.POSTMARK_INBOUND_SECRET = 'env-secret';
				const good = `Basic ${Buffer.from('postmark:env-secret').toString('base64')}`;
				expect(() =>
					plugin.verifyWebhookSignature(Buffer.from(''), { authorization: good }, { settings: {} })
				).not.toThrow();
				expect(() => plugin.verifyWebhookSignature(Buffer.from(''), {}, { settings: {} })).toThrow(
					/missing or malformed Authorization header/
				);
			});
		});

		it('accepts a correctly signed webhook (Basic postmark:<secret>)', () => {
			const good = `Basic ${Buffer.from('postmark:super-secret').toString('base64')}`;
			expect(() =>
				plugin.verifyWebhookSignature(
					Buffer.from(''),
					{ authorization: good },
					{ settings: { inboundWebhookSecret: 'super-secret' } }
				)
			).not.toThrow();
		});

		it('the opt-out never weakens a configured secret: a missing signature still throws', () => {
			const saved = process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
			process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = 'true';
			try {
				expect(() =>
					plugin.verifyWebhookSignature(
						Buffer.from(''),
						{},
						{ settings: { inboundWebhookSecret: 'super-secret' } }
					)
				).toThrow(/missing or malformed Authorization header/);
			} finally {
				if (saved === undefined) delete process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
				else process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = saved;
			}
		});

		it('does NOT warn when a secret IS configured (verification path is exercised)', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				// Mismatch still throws; the point is that the unsigned-accept
				// warning is NOT emitted on the verifying path.
				expect(() =>
					plugin.verifyWebhookSignature(
						Buffer.from(''),
						{ authorization: 'Basic xxx' },
						{ settings: { inboundWebhookSecret: 'super-secret' } }
					)
				).toThrow(/signature mismatch/);
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				warnSpy.mockRestore();
			}
		});
	});
});
