import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

	// EW-P4-3 — with no signing key configured an inbound webhook is REFUSED
	// (it used to be accepted silently: anyone who knew the public URL could
	// inject mail). Only the explicit operator opt-out accepts it.
	describe('verifyWebhookSignature with no signing key configured', () => {
		const savedOptOut = process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
		const savedSigningKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
		const unsigned = Buffer.from(JSON.stringify({ timestamp: '1', token: 't', signature: 'whatever' }));

		beforeEach(() => {
			delete process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
			delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
		});

		afterEach(() => {
			if (savedOptOut === undefined) delete process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
			else process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = savedOptOut;
			if (savedSigningKey === undefined) delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
			else process.env.MAILGUN_WEBHOOK_SIGNING_KEY = savedSigningKey;
		});

		it('refuses an unsigned (or unverifiable) webhook', () => {
			expect(() => plugin.verifyWebhookSignature(unsigned, {}, { userId: 'u' })).toThrow(
				/refusing an unsigned webhook/
			);
			expect(() => plugin.verifyWebhookSignature(Buffer.from('recipient=a%40b.test'), {}, {})).toThrow(
				/refusing an unsigned webhook/
			);
		});

		it.each(['TRUE', '1', 'yes', ' true', ''])(
			'stays secure when EMAIL_INBOUND_ALLOW_UNSIGNED is %j (only the exact string "true" opts out)',
			(value) => {
				process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = value;
				expect(() => plugin.verifyWebhookSignature(unsigned, {}, { userId: 'u' })).toThrow(
					/refusing an unsigned webhook/
				);
			}
		);

		it('accepts — and warns the operator — only with EMAIL_INBOUND_ALLOW_UNSIGNED=true', () => {
			process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = 'true';
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				expect(() => plugin.verifyWebhookSignature(unsigned, {}, { userId: 'u' })).not.toThrow();
				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(warnSpy.mock.calls[0][0]).toMatch(/WITHOUT signature verification/);
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('verifies with the env key when MAILGUN_WEBHOOK_SIGNING_KEY is set', () => {
			process.env.MAILGUN_WEBHOOK_SIGNING_KEY = 'env-key';
			const timestamp = String(Math.floor(Date.now() / 1000));
			const token = 'tok';
			const signature = createHmac('sha256', 'env-key').update(`${timestamp}${token}`).digest('hex');
			const good = Buffer.from(JSON.stringify({ timestamp, token, signature }));
			expect(() => plugin.verifyWebhookSignature(good, {}, {})).not.toThrow();
			expect(() => plugin.verifyWebhookSignature(unsigned, {}, {})).toThrow(/signature mismatch/);
		});
	});

	it('the opt-out never weakens a configured signing key: a forged signature still throws', () => {
		const saved = process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
		process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = 'true';
		try {
			const opts = { userId: 'u', settings: { webhookSigningKey: 'sign-key' } };
			const forged = Buffer.from(JSON.stringify({ timestamp: '1', token: 't', signature: 'deadbeef' }));
			expect(() => plugin.verifyWebhookSignature(forged, {}, opts)).toThrow(/signature mismatch/);
			expect(() => plugin.verifyWebhookSignature(Buffer.from('{}'), {}, opts)).toThrow(
				/missing timestamp\/token\/signature/
			);
		} finally {
			if (saved === undefined) delete process.env.EMAIL_INBOUND_ALLOW_UNSIGNED;
			else process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = saved;
		}
	});

	it('verifyWebhookSignature accepts a valid HMAC and rejects a forged one', () => {
		const signingKey = 'sign-key';
		const timestamp = String(Math.floor(Date.now() / 1000));
		const token = 'abc123';
		const signature = createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex');
		const opts = { userId: 'u', settings: { webhookSigningKey: signingKey } };

		const good = Buffer.from(JSON.stringify({ signature: { timestamp, token, signature } }));
		expect(() => plugin.verifyWebhookSignature(good, {}, opts)).not.toThrow();

		const bad = Buffer.from(JSON.stringify({ signature: { timestamp, token, signature: 'deadbeef' } }));
		expect(() => plugin.verifyWebhookSignature(bad, {}, opts)).toThrow(/signature mismatch/);
	});

	// Review 2026-10-17 F56: the HMAC covers only timestamp + token, so a signature is
	// accepted only while fresh, and each token once.
	it('refuses a stale signature and a replayed token', () => {
		const signingKey = 'sign-key';
		const opts = { userId: 'u', settings: { webhookSigningKey: signingKey } };
		const signed = (timestamp: string, token: string) =>
			Buffer.from(
				JSON.stringify({
					timestamp,
					token,
					signature: createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex')
				})
			);
		const now = Math.floor(Date.now() / 1000);
		expect(() => plugin.verifyWebhookSignature(signed(String(now - 16 * 60), 'old'), {}, opts)).toThrow(
			/outside the accepted window/
		);
		expect(() => plugin.verifyWebhookSignature(signed(String(now + 10 * 60), 'ahead'), {}, opts)).toThrow(
			/outside the accepted window/
		);
		const fresh = signed(String(now), 'once');
		expect(() => plugin.verifyWebhookSignature(fresh, {}, opts)).not.toThrow();
		expect(() => plugin.verifyWebhookSignature(fresh, {}, opts)).toThrow(/token already used/);
		expect(() => plugin.verifyWebhookSignature(signed(String(now), 'other'), {}, opts)).not.toThrow();
	});

	// EW-P4-3 — RFC threading.
	it('forwards EmailSendInput.headers as h:<Name> parameters', async () => {
		createMock.mockResolvedValueOnce({ id: '<x@mg>', message: 'Queued.' });
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
			{ userId: 'u' }
		);
		const [, data] = createMock.mock.calls[0];
		expect(data['h:Message-ID']).toBe('<out-1@acme.test>');
		expect(data['h:In-Reply-To']).toBe('<in-1@client.test>');
		expect(data['h:References']).toBe('<root@client.test> <in-1@client.test>');
	});

	it('parses the threading headers from the forwarded fields', async () => {
		const form = new URLSearchParams({
			sender: 'x@y.test',
			recipient: 'agent@mg.example.com',
			subject: 'Re: hi',
			'Message-Id': '<reply-2@client.test>',
			'In-Reply-To': '<out-1@acme.test>',
			References: '<root@client.test> <out-1@acme.test>',
			timestamp: '1700000000'
		});
		const msg = await plugin.parseInboundWebhook(Buffer.from(form.toString()), {}, {});
		expect(msg.messageIdHeader).toBe('reply-2@client.test');
		expect(msg.inReplyTo).toBe('out-1@acme.test');
		expect(msg.references).toEqual(['root@client.test', 'out-1@acme.test']);
	});

	it('parses Cc into bare mailboxes (EW-P4-3)', async () => {
		const form = new URLSearchParams({
			sender: 'x@y.test',
			recipient: 'agent@mg.example.com',
			subject: 's',
			Cc: '"C One" <c1@b.test>, c2@b.test'
		});
		const msg = await plugin.parseInboundWebhook(Buffer.from(form.toString()), {}, {});
		expect(msg.cc).toEqual(['c1@b.test', 'c2@b.test']);
	});

	it('keeps a quoted display name with a comma in one Cc mailbox', async () => {
		const form = new URLSearchParams({
			sender: 'x@y.test',
			recipient: 'agent@mg.example.com',
			subject: 's',
			Cc: '"Doe, John" <john@example.com>, jane@example.com'
		});
		const msg = await plugin.parseInboundWebhook(Buffer.from(form.toString()), {}, {});
		expect(msg.cc).toEqual(['john@example.com', 'jane@example.com']);
	});

	it('falls back to message-headers for the threading headers', async () => {
		const form = new URLSearchParams({
			sender: 'x@y.test',
			recipient: 'agent@mg.example.com',
			subject: 'Re: hi',
			'message-headers': JSON.stringify([
				['Message-Id', '<reply-3@client.test>'],
				['In-Reply-To', '<out-1@acme.test>'],
				['References', '<out-1@acme.test>']
			])
		});
		const msg = await plugin.parseInboundWebhook(Buffer.from(form.toString()), {}, {});
		expect(msg.messageIdHeader).toBe('reply-3@client.test');
		expect(msg.inReplyTo).toBe('out-1@acme.test');
		expect(msg.references).toEqual(['out-1@acme.test']);
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
	 *
	 * Sized, not tightly timed: at 200 000 characters the regex needs ~40 s on a dev box and the
	 * scan milliseconds, so a 2 s bound can be failed neither by a CPU-throttled CI runner nor passed
	 * by the regex. Only `extractInboundRecipients` is timed — the webhook body is encoded first.
	 * (A "< 200 ms" at 50 000 was one scheduler stall from red — develop CI, 2026-10-09.)
	 */
	describe('recipient parsing on hostile headers', () => {
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
