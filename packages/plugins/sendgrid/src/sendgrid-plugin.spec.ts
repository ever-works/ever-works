import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SendGridPlugin } from './sendgrid-plugin.js';

describe('SendGridPlugin', () => {
	let plugin: SendGridPlugin;

	beforeEach(() => {
		plugin = new SendGridPlugin();
		process.env.SENDGRID_API_KEY = 'test-key';
	});

	it('declares the email-outbound capability', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.category).toBe('email-provider');
	});

	it('POSTs to /v3/mail/send with Bearer auth and reads X-Message-Id', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 202,
			headers: new Headers({ 'x-message-id': 'sg-msg-123' }),
			json: async () => ({})
		} as Response);

		const result = await plugin.sendEmail(
			{
				from: 'a@example.com',
				to: ['b@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				bodyHtml: '<p>hi</p>',
				messageRef: 'ref-1'
			},
			{ userId: 'user-1' }
		);

		expect(result.providerMessageId).toBe('sg-msg-123');
		expect(result.accepted).toEqual(['b@example.com']);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/v3/mail/send');
		const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toBe('Bearer test-key');
		const sent = JSON.parse((init as RequestInit).body as string);
		expect(sent.personalizations[0].to).toEqual([{ email: 'b@example.com' }]);
		expect(sent.content).toEqual([
			{ type: 'text/plain', value: 'hi' },
			{ type: 'text/html', value: '<p>hi</p>' }
		]);
		fetchMock.mockRestore();
	});

	it('throws with the SendGrid error messages when the API rejects', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers(),
			json: async () => ({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] })
		} as Response);

		await expect(
			plugin.sendEmail(
				{
					from: 'a@example.com',
					to: ['b@example.com'],
					subject: 'hi',
					bodyText: 'hi',
					messageRef: 'ref-err'
				},
				{ userId: 'u' }
			)
		).rejects.toThrow(/SendGrid send failed \(403\): The from address/);
	});

	it('serves a repeated messageRef from the idempotency cache without re-calling fetch', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			status: 202,
			headers: new Headers({ 'x-message-id': 'sg-cache' }),
			json: async () => ({})
		} as Response);

		const input = {
			from: 'a@example.com',
			to: ['b@example.com'],
			subject: 'hi',
			bodyText: 'hi',
			messageRef: 'ref-cache'
		};
		await plugin.sendEmail(input, { userId: 'u' });
		await plugin.sendEmail(input, { userId: 'u' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockRestore();
	});

	it('throws a clear error when no API key is configured', async () => {
		delete process.env.SENDGRID_API_KEY;
		await expect(
			plugin.sendEmail(
				{ from: 'a@example.com', to: ['b@example.com'], subject: 's', bodyText: 't', messageRef: 'r' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/requires `apiKey`/);
	});
});
