import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResendPlugin } from './resend-plugin.js';

describe('ResendPlugin', () => {
	let plugin: ResendPlugin;

	beforeEach(() => {
		plugin = new ResendPlugin();
		process.env.RESEND_API_KEY = 'test-key';
	});

	it('declares only email-outbound (inbound is private beta)', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.capabilities).not.toContain('email-inbound');
	});

	it('POSTs to /emails with Bearer auth and returns the id', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ id: 'rs-abc-123' }),
		} as Response);

		const result = await plugin.sendEmail(
			{
				from: 'a@example.com',
				to: ['b@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				messageRef: 'ref-1',
			},
			{ userId: 'user-1' },
		);

		expect(result.providerMessageId).toBe('rs-abc-123');
		const [, init] = fetchMock.mock.calls[0];
		const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toBe('Bearer test-key');
		expect(headers['Idempotency-Key']).toBe('ref-1');
		fetchMock.mockRestore();
	});

	it('throws when Resend returns an error', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 422,
			json: async () => ({ error: { statusCode: 422, message: 'Invalid sender' } }),
		} as Response);

		await expect(
			plugin.sendEmail(
				{
					from: 'a@example.com',
					to: ['b@example.com'],
					subject: 'hi',
					bodyText: 'hi',
					messageRef: 'ref-err',
				},
				{ userId: 'u' },
			),
		).rejects.toThrow(/Resend send failed/);
	});

	it('serves repeated messageRef from idempotency cache without re-calling fetch', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: 'rs-cache' }),
		} as Response);

		const input = {
			from: 'a@example.com',
			to: ['b@example.com'],
			subject: 'hi',
			bodyText: 'hi',
			messageRef: 'ref-cache',
		};
		await plugin.sendEmail(input, { userId: 'u' });
		await plugin.sendEmail(input, { userId: 'u' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockRestore();
	});
});
