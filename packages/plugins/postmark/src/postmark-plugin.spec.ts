import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostmarkPlugin } from './postmark-plugin.js';

describe('PostmarkPlugin', () => {
	let plugin: PostmarkPlugin;

	beforeEach(() => {
		plugin = new PostmarkPlugin();
		process.env.POSTMARK_API_KEY = 'test-key';
	});

	it('declares email-outbound + email-inbound capabilities', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.capabilities).toContain('email-inbound');
	});

	describe('sendEmail', () => {
		it('POSTs to /email and returns providerMessageId on success', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ MessageID: 'pm-123', ErrorCode: 0 })
			} as Response);

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
			expect(fetchMock).toHaveBeenCalledWith(
				'https://api.postmarkapp.com/email',
				expect.objectContaining({ method: 'POST' })
			);
			fetchMock.mockRestore();
		});

		it('throws when Postmark returns an error', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 422,
				json: async () => ({ MessageID: '', ErrorCode: 405, Message: 'Invalid sender' })
			} as Response);

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
			).rejects.toThrow(/Postmark send failed/);
		});

		it('returns the cached result for a repeated messageRef (idempotency)', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ MessageID: 'pm-cache', ErrorCode: 0 })
			} as Response);

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
			expect(fetchMock).toHaveBeenCalledTimes(1);
			fetchMock.mockRestore();
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
	});
});
