import { describe, it, expect, beforeEach, vi } from 'vitest';

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

		it('accepts when no secret configured', () => {
			expect(() => plugin.verifyWebhookSignature(Buffer.from(''), {}, { settings: {} })).not.toThrow();
		});

		it('warns the operator when accepting an unsigned inbound webhook (no secret configured)', () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				expect(() => plugin.verifyWebhookSignature(Buffer.from(''), {}, { settings: {} })).not.toThrow();
				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(warnSpy.mock.calls[0][0]).toMatch(/WITHOUT signature verification/);
			} finally {
				warnSpy.mockRestore();
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
