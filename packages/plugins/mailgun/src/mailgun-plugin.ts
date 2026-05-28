import { createHmac, timingSafeEqual } from 'node:crypto';
import Mailgun from 'mailgun.js';
import formData from 'form-data';
import type {
	IEmailOutboundPlugin,
	IEmailInboundPlugin,
	EmailSendInput,
	EmailSendResult,
	EmailInboundMessage,
	EmailOptions,
	EmailVerification,
	PluginCategory,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

function resolveApiKey(options: EmailOptions): string {
	const fromSettings = options.settings?.apiKey;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.MAILGUN_API_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('Mailgun plugin requires `apiKey` setting or MAILGUN_API_KEY env var.');
}

function resolveDomain(options: EmailOptions): string {
	const fromSettings = options.settings?.domain;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.MAILGUN_DOMAIN;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('Mailgun plugin requires `domain` setting or MAILGUN_DOMAIN env var.');
}

function resolveApiUrl(options: EmailOptions): string {
	const region = (options.settings?.region ?? process.env.MAILGUN_REGION ?? 'us') as string;
	return region.toLowerCase() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
}

/** Inbound/webhook HMAC signing key — distinct from the send API key. */
function resolveSigningKey(options: EmailOptions): string | undefined {
	const fromSettings = options.settings?.webhookSigningKey;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Mailgun delivers webhooks as JSON OR form-urlencoded; decode both. */
function decodeBody(rawBody: Buffer): Record<string, unknown> {
	const text = rawBody.toString('utf8');
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		const out: Record<string, unknown> = {};
		for (const [k, v] of new URLSearchParams(text)) out[k] = v;
		return out;
	}
}

interface MailgunSignature {
	readonly timestamp: string;
	readonly token: string;
	readonly signature: string;
}

/** Pull the {timestamp, token, signature} triple from either webhook shape. */
function extractSignature(body: Record<string, unknown>): MailgunSignature | null {
	const nested = body.signature;
	if (nested && typeof nested === 'object') {
		const s = nested as Record<string, unknown>;
		if (typeof s.timestamp === 'string' && typeof s.token === 'string' && typeof s.signature === 'string') {
			return { timestamp: s.timestamp, token: s.token, signature: s.signature };
		}
	}
	const { timestamp, token, signature } = body;
	if (typeof timestamp === 'string' && typeof token === 'string' && typeof signature === 'string') {
		return { timestamp, token, signature };
	}
	return null;
}

/**
 * Mailgun email provider plugin (outbound + inbound).
 *
 * Outbound uses the official `mailgun.js` SDK (Messages API, US/EU
 * regions). Inbound verifies the Mailgun HMAC-SHA256 signature
 * (`HMAC(signingKey, timestamp + token)`) with Node `crypto` — Mailgun
 * ships no SDK helper for inbound-route parsing/verification — and
 * decodes the parsed message.
 */
export class MailgunPlugin implements IEmailOutboundPlugin, IEmailInboundPlugin {
	readonly id = 'mailgun';
	readonly name = 'Mailgun';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'email-provider';
	readonly capabilities = [PLUGIN_CAPABILITIES.EMAIL_OUTBOUND, PLUGIN_CAPABILITIES.EMAIL_INBOUND] as const;
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: { type: 'string', 'x-secret': true, 'x-envVar': 'MAILGUN_API_KEY' },
			domain: { type: 'string', 'x-envVar': 'MAILGUN_DOMAIN' },
			region: { type: 'string', enum: ['us', 'eu'], default: 'us', 'x-envVar': 'MAILGUN_REGION' },
			webhookSigningKey: {
				type: 'string',
				'x-secret': true,
				'x-envVar': 'MAILGUN_WEBHOOK_SIGNING_KEY'
			}
		},
		required: ['apiKey', 'domain']
	};

	async onLoad(): Promise<void> {
		// No-op — Mailgun plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, EmailSendResult>();

	async sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult> {
		const cached = this.idempotencyCache.get(input.messageRef);
		if (cached) return cached;

		const apiKey = resolveApiKey(options);
		const domain = resolveDomain(options);
		const mailgun = new Mailgun(formData);
		const mg = mailgun.client({ username: 'api', key: apiKey, url: resolveApiUrl(options) });

		// Mailgun custom variables (`v:<name>`) carry our attribution metadata.
		const customVars: Record<string, string> = {};
		for (const [k, v] of Object.entries(input.metadata ?? {})) customVars[`v:${k}`] = v;

		let id: string;
		try {
			const res = await mg.messages.create(domain, {
				from: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
				to: [...input.to],
				cc: input.cc?.length ? [...input.cc] : undefined,
				bcc: input.bcc?.length ? [...input.bcc] : undefined,
				subject: input.subject,
				text: input.bodyText,
				html: input.bodyHtml,
				'h:Reply-To': input.replyTo,
				...customVars
			});
			// Mailgun ids are angle-bracketed Message-Ids; strip for storage.
			id = (res.id ?? `mailgun-${input.messageRef}`).replace(/^<|>$/g, '');
		} catch (err) {
			const e = err as { status?: number; message?: string; details?: string };
			throw new Error(
				`Mailgun send failed (${e.status ?? 'error'}): ${e.details ?? e.message ?? 'unknown error'}`
			);
		}

		const result: EmailSendResult = {
			provider: this.id,
			providerMessageId: id,
			accepted: [...input.to],
			rejected: []
		};
		this.idempotencyCache.set(input.messageRef, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}

	async verifyAddress(address: string, _options: EmailOptions): Promise<EmailVerification> {
		// Mailgun verifies sending domains, not individual addresses. We
		// emit a token; the platform-side verify route flips `verified`
		// once the operator clicks the confirmation.
		const verificationToken = `mg-${Math.random().toString(36).slice(2)}${Date.now()}`;
		return {
			address,
			verificationToken,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
		};
	}

	verifyWebhookSignature(rawBody: Buffer, _headers: Readonly<Record<string, string>>, options: EmailOptions): void {
		const signingKey = resolveSigningKey(options);
		if (!signingKey) return; // No key configured — operator opt-in to signature checking.
		const sig = extractSignature(decodeBody(rawBody));
		if (!sig) {
			throw new Error('Mailgun inbound: missing timestamp/token/signature.');
		}
		const expected = createHmac('sha256', signingKey).update(`${sig.timestamp}${sig.token}`).digest('hex');
		const a = Buffer.from(expected);
		const b = Buffer.from(sig.signature);
		if (a.length !== b.length || !timingSafeEqual(a, b)) {
			throw new Error('Mailgun inbound: signature mismatch.');
		}
	}

	async parseInboundWebhook(
		rawBody: Buffer,
		_headers: Readonly<Record<string, string>>,
		_options: EmailOptions
	): Promise<EmailInboundMessage> {
		const body = decodeBody(rawBody);
		const str = (k: string): string | undefined => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
		const recipient = str('recipient') ?? str('To') ?? '';
		const messageId = (str('Message-Id') ?? str('message-id') ?? `mailgun-${Date.now()}`).replace(/^<|>$/g, '');
		const tsSeconds = Number(str('timestamp'));
		return {
			provider: this.id,
			providerMessageId: messageId,
			from: str('sender') ?? str('from') ?? '',
			to: recipient ? recipient.split(',').map((s) => s.trim()) : [],
			subject: str('subject') ?? '',
			bodyText: str('body-plain') ?? str('stripped-text') ?? '',
			bodyHtml: str('body-html') ?? str('stripped-html'),
			attachments: [],
			receivedAt: Number.isFinite(tsSeconds) && tsSeconds > 0 ? new Date(tsSeconds * 1000) : new Date(),
			metadata: {
				recipient,
				signatureVerified: Boolean(resolveSigningKey(_options))
			}
		};
	}
}

export const mailgunPlugin = new MailgunPlugin();
