import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const createMock = vi.fn();
const clientMock = vi.fn(() => ({ messages: { create: createMock } }));

vi.mock('mailgun.js', () => ({
	default: class Mailgun {
		constructor(_formData: unknown) {}
		client = clientMock;
	}
}));
vi.mock('form-data', () => ({ default: class FormData {} }));

import { MailgunPlugin } from './mailgun-plugin.js';

describe('MailgunPlugin', () => {
	let plugin: MailgunPlugin;

	beforeEach(() => {
		plugin = new MailgunPlugin();
		process.env.MAILGUN_API_KEY = 'test-key';
		process.env.MAILGUN_DOMAIN = 'mg.example.com';
		delete process.env.MAILGUN_REGION;
		delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
		createMock.mockReset();
		clientMock.mockClear();
	});

	it('declares both email-outbound and email-inbound', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.capabilities).toContain('email-inbound');
	});

	it('sends via mailgun.js messages.create against the resolved domain', async () => {
		createMock.mockResolvedValueOnce({ id: '<20260528.1@mg.example.com>', message: 'Queued. Thank you.' });

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
		expect(clientMock).toHaveBeenCalledWith({ username: 'api', key: 'test-key', url: 'https://api.mailgun.net' });
		const [domain, data] = createMock.mock.calls[0];
		expect(domain).toBe('mg.example.com');
		expect(data.from).toBe('Agent <a@example.com>');
		expect(data.to).toEqual(['b@example.com']);
	});

	it('uses the EU base URL when region=eu', async () => {
		createMock.mockResolvedValueOnce({ id: '<x@mg>' });
		await plugin.sendEmail(
			{ from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-eu' },
			{ userId: 'u', settings: { apiKey: 'k', domain: 'mg.example.com', region: 'eu' } }
		);
		expect(clientMock.mock.calls[0][0]).toMatchObject({ url: 'https://api.eu.mailgun.net' });
	});

	it('serves a repeated messageRef from the idempotency cache without re-calling the SDK', async () => {
		createMock.mockResolvedValue({ id: '<cache@mg>' });
		const input = { from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-cache' };
		await plugin.sendEmail(input, { userId: 'u' });
		await plugin.sendEmail(input, { userId: 'u' });
		expect(createMock).toHaveBeenCalledTimes(1);
	});

	it('does NOT serve a cached result across different userIds (tenant isolation)', async () => {
		// Security: the local idempotency cache key is scoped by
		// options.userId/workId — the same messageRef from two different users
		// must trigger two real sends, never leak user A's cached result to B.
		createMock.mockResolvedValue({ id: '<scoped@mg>' });
		const input = { from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-shared' };
		await plugin.sendEmail(input, { userId: 'user-a' });
		await plugin.sendEmail(input, { userId: 'user-b' });
		expect(createMock).toHaveBeenCalledTimes(2);
	});

	it('throws when the Mailgun SDK rejects the send', async () => {
		createMock.mockRejectedValueOnce({ status: 401, message: 'Forbidden' });
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
