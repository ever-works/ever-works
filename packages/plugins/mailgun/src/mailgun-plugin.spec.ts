import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MailgunPlugin } from './mailgun-plugin.js';

describe('MailgunPlugin', () => {
	let plugin: MailgunPlugin;

	beforeEach(() => {
		plugin = new MailgunPlugin();
		process.env.MAILGUN_API_KEY = 'test-key';
		process.env.MAILGUN_DOMAIN = 'mg.example.com';
		delete process.env.MAILGUN_REGION;
		delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
	});

	it('declares both email-outbound and email-inbound', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.capabilities).toContain('email-inbound');
	});

	it('POSTs form-encoded to the region+domain Messages endpoint with Basic auth', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ id: '<20260528.1@mg.example.com>', message: 'Queued. Thank you.' })
		} as Response);

		const result = await plugin.sendEmail(
			{
				from: 'a@example.com',
				fromName: 'Agent',
				to: ['b@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				messageRef: 'ref-1'
			},
			{ userId: 'u' }
		);

		expect(result.providerMessageId).toBe('20260528.1@mg.example.com');
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
		const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toBe(`Basic ${Buffer.from('api:test-key').toString('base64')}`);
		const form = new URLSearchParams((init as RequestInit).body as string);
		expect(form.get('from')).toBe('Agent <a@example.com>');
		expect(form.get('to')).toBe('b@example.com');
		fetchMock.mockRestore();
	});

	it('uses the EU base URL when region=eu', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ id: '<x@mg>' })
		} as Response);
		await plugin.sendEmail(
			{ from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-eu' },
			{ userId: 'u', settings: { apiKey: 'k', domain: 'mg.example.com', region: 'eu' } }
		);
		expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
		fetchMock.mockRestore();
	});

	it('throws when Mailgun rejects the send', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			json: async () => ({ message: 'Forbidden' })
		} as Response);
		await expect(
			plugin.sendEmail(
				{ from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-err' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/Mailgun send failed \(401\): Forbidden/);
	});

	it('verifyWebhookSignature is a no-op when no signing key is configured', () => {
		const body = Buffer.from(JSON.stringify({ timestamp: '1', token: 't', signature: 'whatever' }));
		expect(() => plugin.verifyWebhookSignature(body, {}, { userId: 'u' })).not.toThrow();
	});

	it('verifyWebhookSignature accepts a valid HMAC and rejects a forged one', () => {
		const signingKey = 'sign-key';
		const timestamp = '1700000000';
		const token = 'abc123';
		const signature = createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex');
		const opts = { userId: 'u', settings: { webhookSigningKey: signingKey } };

		const good = Buffer.from(JSON.stringify({ signature: { timestamp, token, signature } }));
		expect(() => plugin.verifyWebhookSignature(good, {}, opts)).not.toThrow();

		const bad = Buffer.from(JSON.stringify({ signature: { timestamp, token, signature: 'deadbeef' } }));
		expect(() => plugin.verifyWebhookSignature(bad, {}, opts)).toThrow(/signature mismatch/);
	});

	it('parses a form-urlencoded inbound payload into the canonical shape', async () => {
		const form = new URLSearchParams({
			sender: 'human@example.com',
			recipient: 'agent@mg.example.com',
			subject: 'Re: task',
			'body-plain': 'please proceed',
			'Message-Id': '<inbound-1@mg>',
			timestamp: '1700000000'
		});
		const msg = await plugin.parseInboundWebhook(Buffer.from(form.toString()), {}, { userId: 'u' });
		expect(msg.from).toBe('human@example.com');
		expect(msg.to).toEqual(['agent@mg.example.com']);
		expect(msg.subject).toBe('Re: task');
		expect(msg.bodyText).toBe('please proceed');
		expect(msg.providerMessageId).toBe('inbound-1@mg');
	});
});
