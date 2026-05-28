import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MailchimpTransactionalPlugin } from './mailchimp-transactional-plugin.js';

describe('MailchimpTransactionalPlugin', () => {
	let plugin: MailchimpTransactionalPlugin;

	beforeEach(() => {
		plugin = new MailchimpTransactionalPlugin();
		process.env.MANDRILL_API_KEY = 'test-key';
	});

	it('declares the email-outbound capability', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.id).toBe('mailchimp-transactional');
	});

	it('POSTs to /messages/send.json with the key in the body and reads _id', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => [{ email: 'b@example.com', status: 'sent', _id: 'mand-1' }]
		} as Response);

		const result = await plugin.sendEmail(
			{
				from: 'a@example.com',
				to: ['b@example.com'],
				cc: ['c@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				messageRef: 'ref-1'
			},
			{ userId: 'u' }
		);

		expect(result.providerMessageId).toBe('mand-1');
		expect(result.accepted).toContain('b@example.com');
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/messages/send.json');
		const sent = JSON.parse((init as RequestInit).body as string);
		expect(sent.key).toBe('test-key');
		expect(sent.message.to).toEqual([
			{ email: 'b@example.com', type: 'to' },
			{ email: 'c@example.com', type: 'cc' }
		]);
		fetchMock.mockRestore();
	});

	it('surfaces per-recipient rejections in the result', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => [
				{ email: 'ok@example.com', status: 'queued', _id: 'mand-2' },
				{ email: 'bad@example.com', status: 'rejected', reject_reason: 'hard-bounce' }
			]
		} as Response);

		const result = await plugin.sendEmail(
			{
				from: 'a@x.com',
				to: ['ok@example.com', 'bad@example.com'],
				subject: 's',
				bodyText: 't',
				messageRef: 'r2'
			},
			{ userId: 'u' }
		);
		expect(result.accepted).toEqual(['ok@example.com']);
		expect(result.rejected).toEqual([{ address: 'bad@example.com', reason: 'hard-bounce' }]);
	});

	it('throws on a Mandrill error envelope', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 500,
			json: async () => ({ status: 'error', code: -1, name: 'Invalid_Key', message: 'Invalid API key' })
		} as Response);

		await expect(
			plugin.sendEmail(
				{ from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-err' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/Invalid_Key.*Invalid API key/);
	});

	it('serves a repeated messageRef from the idempotency cache', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => [{ email: 'b@x.com', status: 'sent', _id: 'mand-cache' }]
		} as Response);
		const input = { from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-cache' };
		await plugin.sendEmail(input, { userId: 'u' });
		await plugin.sendEmail(input, { userId: 'u' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockRestore();
	});
});
