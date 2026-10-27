import { createHash, createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EverEmailRouterPlugin } from './ever-email-router-plugin.js';

const SECRET = 'router-secret-0123456789-abcdef';
const RECIPIENT = 'Agent.Smith@Ever.Email';

/** A multipart message: text + html + one attachment, threading headers, a forged A-R. */
const MIME = [
	'Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=forged.example',
	'From: "Ada Lovelace" <ada@example.com>',
	'To: "Smith, Agent" <agent.smith@ever.email>, Bob <bob@example.org>',
	'Cc: carol@example.net',
	'Subject: Quarterly report',
	'Date: Tue, 27 Oct 2026 10:00:00 +0000',
	'Message-ID: <msg-1@example.com>',
	'In-Reply-To: <parent@example.com>',
	'References: <root@example.com> <parent@example.com>',
	'MIME-Version: 1.0',
	'Content-Type: multipart/mixed; boundary="mixed"',
	'',
	'--mixed',
	'Content-Type: multipart/alternative; boundary="alt"',
	'',
	'--alt',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hello plain',
	'--alt',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>Hello html</p>',
	'--alt--',
	'--mixed',
	'Content-Type: text/csv; name="report.csv"',
	'Content-Disposition: attachment; filename="report.csv"',
	'Content-ID: <att-1@example.com>',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from('a,b\n1,2\n').toString('base64'),
	'--mixed--',
	''
].join('\r\n');

const CF_AUTH =
	'mx.cloudflare.net; dkim=pass (2048-bit key) header.d=example.com header.i=@example.com; spf=pass smtp.mailfrom=bounce@mail.example.com; dmarc=pass header.from=example.com';

function body(overrides: Record<string, unknown> = {}, mime = MIME): Buffer {
	return Buffer.from(
		JSON.stringify({
			raw: Buffer.from(mime).toString('base64'),
			envelope: { from: 'bounce@mail.example.com', to: [RECIPIENT] },
			authenticationResults: CF_AUTH,
			...overrides
		})
	);
}

function sign(raw: Buffer, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
	const v1 = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
	return `t=${t},v1=${v1}`;
}

describe('EverEmailRouterPlugin', () => {
	let plugin: EverEmailRouterPlugin;
	const settings = { inboundWebhookSecret: SECRET };

	beforeEach(() => {
		plugin = new EverEmailRouterPlugin();
		delete process.env.EVER_EMAIL_ROUTER_SECRET;
	});

	afterEach(() => {
		delete process.env.EVER_EMAIL_ROUTER_SECRET;
	});

	it('declares email-inbound only, opts into the counts ack, and keeps its secret admin-only', () => {
		expect(plugin.id).toBe('ever-email-router');
		expect(plugin.category).toBe('email-provider');
		expect([...plugin.capabilities]).toEqual(['email-inbound']);
		expect(plugin.inboundAck).toBe('counts');
		expect(plugin.settingsSchema.properties?.inboundWebhookSecret).toMatchObject({
			'x-secret': true,
			'x-envVar': 'EVER_EMAIL_ROUTER_SECRET',
			'x-adminOnly': true
		});
	});

	describe('verifyWebhookSignature', () => {
		it('accepts a valid signature over the exact raw body', () => {
			const raw = body();
			expect(() =>
				plugin.verifyWebhookSignature(raw, { 'x-ever-email-signature': sign(raw) }, { settings })
			).not.toThrow();
		});

		it('accepts the EVER_EMAIL_ROUTER_SECRET env fallback and any header case', () => {
			process.env.EVER_EMAIL_ROUTER_SECRET = SECRET;
			const raw = body();
			expect(() => plugin.verifyWebhookSignature(raw, { 'X-Ever-Email-Signature': sign(raw) }, {})).not.toThrow();
		});

		it('accepts one matching v1 among several (secret rotation)', () => {
			const raw = body();
			const t = Math.floor(Date.now() / 1000);
			const good = sign(raw, SECRET, t).split(',')[1];
			const other = sign(raw, 'another-secret-0123456789-xyz', t).split(',')[1];
			expect(() =>
				plugin.verifyWebhookSignature(
					raw,
					{ 'x-ever-email-signature': `t=${t},${other},${good}` },
					{ settings }
				)
			).not.toThrow();
		});

		it('rejects a signature made with another secret', () => {
			const raw = body();
			expect(() =>
				plugin.verifyWebhookSignature(
					raw,
					{ 'x-ever-email-signature': sign(raw, 'wrong-secret-0123456789-abcdef') },
					{ settings }
				)
			).toThrow(/signature mismatch/);
		});

		it('rejects a tampered body (one changed byte)', () => {
			const raw = body();
			const signature = sign(raw);
			const tampered = Buffer.from(raw);
			tampered[tampered.length - 2] ^= 1;
			expect(() =>
				plugin.verifyWebhookSignature(tampered, { 'x-ever-email-signature': signature }, { settings })
			).toThrow(/signature mismatch/);
		});

		it('rejects a body re-serialized with the same JSON content (bytes, not values, are signed)', () => {
			const raw = body();
			const signature = sign(raw);
			const reformatted = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2));
			expect(() =>
				plugin.verifyWebhookSignature(reformatted, { 'x-ever-email-signature': signature }, { settings })
			).toThrow(/signature mismatch/);
		});

		it('rejects a stale or future timestamp (more than 300 s away)', () => {
			const raw = body();
			const now = Math.floor(Date.now() / 1000);
			for (const t of [now - 301, now + 301]) {
				expect(() =>
					plugin.verifyWebhookSignature(raw, { 'x-ever-email-signature': sign(raw, SECRET, t) }, { settings })
				).toThrow(/outside the accepted window/);
			}
		});

		it('rejects a missing or malformed signature header', () => {
			const raw = body();
			expect(() => plugin.verifyWebhookSignature(raw, {}, { settings })).toThrow(/missing/);
			const t = Math.floor(Date.now() / 1000);
			const v1 = sign(raw, SECRET, t).split('v1=')[1];
			for (const header of [`v1=${v1}`, `t=${t}`, `t=abc,v1=${v1}`, `t=${t},v1=${v1.toUpperCase()}`, 'garbage']) {
				expect(() =>
					plugin.verifyWebhookSignature(raw, { 'x-ever-email-signature': header }, { settings })
				).toThrow();
			}
		});

		it('fails closed with no secret, or one shorter than 24 characters', () => {
			const raw = body();
			expect(() => plugin.verifyWebhookSignature(raw, { 'x-ever-email-signature': sign(raw) }, {})).toThrow(
				/refusing the webhook/
			);
			const short = 'short-secret-1234567890';
			expect(short.length).toBe(23);
			expect(() =>
				plugin.verifyWebhookSignature(
					raw,
					{ 'x-ever-email-signature': sign(raw, short) },
					{ settings: { inboundWebhookSecret: short } }
				)
			).toThrow(/refusing the webhook/);
		});
	});

	describe('extractInboundRecipients', () => {
		it('names the lower-cased first envelope recipient', () => {
			expect(plugin.extractInboundRecipients(body(), {})).toEqual(['agent.smith@ever.email']);
		});

		it('never reads the sender-written To header', () => {
			const raw = body({ envelope: { from: 'x@example.com', to: [] } });
			expect(plugin.extractInboundRecipients(raw, {})).toEqual([]);
		});

		it('answers [] for a body it cannot read, never throwing', () => {
			expect(plugin.extractInboundRecipients(Buffer.from('not json'), {})).toEqual([]);
			expect(plugin.extractInboundRecipients(Buffer.from('[1,2]'), {})).toEqual([]);
			expect(plugin.extractInboundRecipients(Buffer.from('{"envelope":{"to":"a@b"}}'), {})).toEqual([]);
		});
	});

	describe('parseInboundWebhook', () => {
		it('maps the RFC 5322 message: addresses, subject, bodies, threading ids and the attachment', async () => {
			const message = await plugin.parseInboundWebhook(body(), {}, { settings });
			expect(message.provider).toBe('ever-email-router');
			expect(message.from).toBe('ada@example.com');
			expect(message.to).toEqual(['agent.smith@ever.email', 'bob@example.org']);
			expect(message.cc).toEqual(['carol@example.net']);
			expect(message.subject).toBe('Quarterly report');
			expect(message.bodyText.trim()).toBe('Hello plain');
			expect(message.bodyHtml?.trim()).toBe('<p>Hello html</p>');
			expect(message.messageIdHeader).toBe('msg-1@example.com');
			expect(message.inReplyTo).toBe('parent@example.com');
			expect(message.references).toEqual(['root@example.com', 'parent@example.com']);
			expect(message.attachments).toEqual([
				{
					filename: 'report.csv',
					mimeType: 'text/csv',
					content: Buffer.from('a,b\n1,2\n').toString('base64'),
					cid: 'att-1@example.com'
				}
			]);
			expect(message.receivedAt).toBeInstanceOf(Date);
			expect(message.metadata).toMatchObject({
				recipient: 'agent.smith@ever.email',
				envelope: { from: 'bounce@mail.example.com', to: ['agent.smith@ever.email'] },
				fromName: 'Ada Lovelace'
			});
		});

		it('maps Cloudflare Authentication-Results into the verdict fields the trust module reads', async () => {
			const message = await plugin.parseInboundWebhook(body(), {}, { settings });
			expect(message.metadata).toMatchObject({
				authenticationResults: CF_AUTH,
				dmarc: 'pass',
				spf: 'pass',
				spfDomain: 'mail.example.com',
				dkim: 'pass',
				dkimDomain: 'example.com'
			});
		});

		it("puts the router's Authentication-Results on top and drops the message's own", async () => {
			const message = await plugin.parseInboundWebhook(body(), {}, { settings });
			const headers = message.metadata.headers as Array<{ Name: string; Value: string }>;
			const authResults = headers.filter((h) => h.Name.toLowerCase() === 'authentication-results');
			expect(authResults).toEqual([{ Name: 'Authentication-Results', Value: CF_AUTH }]);
			expect(headers[0]).toEqual({ Name: 'Authentication-Results', Value: CF_AUTH });
			expect(headers).toContainEqual({ Name: 'Subject', Value: 'Quarterly report' });
		});

		it('reports no verdict fields (and no Authentication-Results header) when the router sent none', async () => {
			const message = await plugin.parseInboundWebhook(body({ authenticationResults: undefined }), {}, {});
			expect(message.metadata).not.toHaveProperty('dmarc');
			expect(message.metadata).not.toHaveProperty('dkim');
			const headers = message.metadata.headers as Array<{ Name: string }>;
			expect(headers.some((h) => h.Name.toLowerCase() === 'authentication-results')).toBe(false);
		});

		it('prefers a DKIM pass aligned with From over a failing or unaligned signature', async () => {
			const auth =
				'mx.cloudflare.net; dkim=fail header.d=lists.example.org; dkim=pass header.d=other.example; dkim=pass header.d=example.com; spf=softfail smtp.mailfrom=example.com';
			const message = await plugin.parseInboundWebhook(body({ authenticationResults: auth }), {}, {});
			expect(message.metadata).toMatchObject({
				dkim: 'pass',
				dkimDomain: 'example.com',
				spf: 'softfail',
				spfDomain: 'example.com'
			});
			expect(message.metadata).not.toHaveProperty('dmarc');
		});

		it('ignores a header.d inside an RFC 8601 comment', async () => {
			const auth = 'mx.cloudflare.net; dkim=fail (header.d=example.com spoof) header.d=evil.example';
			const message = await plugin.parseInboundWebhook(body({ authenticationResults: auth }), {}, {});
			expect(message.metadata).toMatchObject({ dkim: 'fail', dkimDomain: 'evil.example' });
		});

		it('keys providerMessageId on sha256(Message-ID) plus the recipient', async () => {
			const message = await plugin.parseInboundWebhook(body(), {}, {});
			const digest = createHash('sha256').update('msg-1@example.com').digest('hex');
			expect(message.providerMessageId).toBe(`${digest}:agent.smith@ever.email`);
		});

		it('gives the same message to two recipients two different providerMessageIds', async () => {
			const first = await plugin.parseInboundWebhook(body(), {}, {});
			const second = await plugin.parseInboundWebhook(
				body({ envelope: { from: 'bounce@mail.example.com', to: ['other@ever.email'] } }),
				{},
				{}
			);
			expect(first.providerMessageId).not.toBe(second.providerMessageId);
			expect(second.providerMessageId.endsWith(':other@ever.email')).toBe(true);
		});

		it('hashes the raw message when it has no Message-ID', async () => {
			const mime = 'From: ada@example.com\r\nTo: agent.smith@ever.email\r\nSubject: no id\r\n\r\nbody\r\n';
			const message = await plugin.parseInboundWebhook(body({}, mime), {}, {});
			const digest = createHash('sha256').update(Buffer.from(mime)).digest('hex');
			expect(message.providerMessageId).toBe(`${digest}:agent.smith@ever.email`);
			expect(message.messageIdHeader).toBeUndefined();
		});

		it('keeps providerMessageId within the 200-character column for a very long recipient', async () => {
			const long = `${'x'.repeat(180)}@ever.email`;
			const message = await plugin.parseInboundWebhook(
				body({ envelope: { from: 'a@example.com', to: [long] } }),
				{},
				{}
			);
			expect(message.providerMessageId.length).toBeLessThanOrEqual(200);
		});

		it('falls back to the envelope recipient as `to` for a Bcc delivery', async () => {
			const mime = 'From: ada@example.com\r\nTo: undisclosed-recipients:;\r\nSubject: bcc\r\n\r\nbody\r\n';
			const message = await plugin.parseInboundWebhook(body({}, mime), {}, {});
			expect(message.to).toEqual(['agent.smith@ever.email']);
		});

		it('refuses a body with no raw message or no envelope recipient', async () => {
			await expect(plugin.parseInboundWebhook(body({ raw: '' }), {}, {})).rejects.toThrow(/raw/);
			await expect(
				plugin.parseInboundWebhook(body({ envelope: { from: 'a@b.c', to: [] } }), {}, {})
			).rejects.toThrow(/envelope/);
		});
	});
});
