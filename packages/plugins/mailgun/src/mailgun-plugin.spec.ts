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

	// The owner lookup (extractInboundRecipients) and the parsed `to` must name
	// the same mailboxes: a display-name token kept in `to` matches no address.
	it('parseInboundWebhook reports the same bare recipients as extractInboundRecipients', async () => {
		const form = new URLSearchParams({
			sender: 'human@example.com',
			To: 'Attacker <attacker@a.test>, victim@v.test,  "Ops" <ops@o.test> ',
			subject: 's',
			'body-plain': 'b'
		});
		const raw = Buffer.from(form.toString());
		const msg = await plugin.parseInboundWebhook(raw, {}, { userId: 'u' });
		expect(msg.to).toEqual(['attacker@a.test', 'victim@v.test', 'ops@o.test']);
		expect(msg.to).toEqual(plugin.extractInboundRecipients(raw, {}));
	});

	/**
	 * CodeQL js/polynomial-redos. The mailbox used to be pulled out with `/<([^>]+)>/`, which
	 * backtracks quadratically over a run of `<` that never closes: every `<` restarts a scan
	 * to the end of the string. The `To` header is written by whoever sent the mail, and
	 * `extractInboundRecipients` reads it BEFORE the webhook signature is checked, so a single
	 * unauthenticated POST could pin the API's event loop (50 000 characters took ~2.4 s).
	 */
	describe('recipient parsing on hostile headers', () => {
		const recipientsOf = (to: string) =>
			plugin.extractInboundRecipients(Buffer.from(JSON.stringify({ To: to })), {});

		it.each([
			['a run of "<" that never closes', '<'.repeat(50_000)],
			['"<" followed by a run of "<="', `<${'<='.repeat(25_000)}`]
		])('reads %s in linear time', (_label, hostile) => {
			const started = performance.now();
			const recipients = recipientsOf(hostile);
			const elapsedMs = performance.now() - started;

			expect(recipients).toEqual([hostile]);
			expect(elapsedMs).toBeLessThan(200);
		});

		// The rewrite must name exactly the mailboxes the regex named.
		it.each([
			['a@b.test', ['a@b.test']],
			['"Name" <a@b.test>', ['a@b.test']],
			['Name <a@b.test>, c@d.test', ['a@b.test', 'c@d.test']],
			['<> <a@b.test>', ['a@b.test']],
			['<<a@b.test>', ['<a@b.test']],
			['<a@b.test', ['<a@b.test']],
			['x <  spaced@b.test  >', ['spaced@b.test']],
			['<a@b.test> <c@d.test>', ['a@b.test']],
			['a>b <c@d.test>', ['c@d.test']],
			['<>', ['<>']],
			['<\n>', []],
			['Team <ops@o.test> , <> , "X" <<x@y.test>', ['ops@o.test', '<>', '<x@y.test']]
		])('parses %j as the angle-address regex did', (to, expected) => {
			expect(recipientsOf(to)).toEqual(expected);
		});
	});
});
