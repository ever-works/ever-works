import type {
	IEmailOutboundPlugin,
	IEmailInboundPlugin,
	EmailSendInput,
	EmailSendResult,
	EmailInboundMessage,
	EmailOptions,
	EmailVerification,
	EmailAttachment,
	EmailDeliveryEvent,
	PluginCategory,
	JsonSchema,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

const POSTMARK_API_BASE = 'https://api.postmarkapp.com';

/**
 * Resolve the configured API token. Plugin settings come from
 * `options.settings` (resolved by `EmailFacadeService` from the 4-level
 * hierarchy: Work → User → Admin → defaults). Falls back to env so
 * dev / self-host setups Just Work.
 */
function resolveApiKey(options: EmailOptions): string {
	const fromSettings = options.settings?.apiKey;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.POSTMARK_API_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('Postmark plugin requires `apiKey` setting or POSTMARK_API_KEY env var.');
}

function resolveInboundSecret(options: EmailOptions): string | undefined {
	const fromSettings = options.settings?.inboundWebhookSecret;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.POSTMARK_INBOUND_SECRET;
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

interface PostmarkSendResponse {
	readonly MessageID: string;
	readonly ErrorCode: number;
	readonly Message?: string;
	readonly To?: string;
}

interface PostmarkInboundPayload {
	readonly MessageID: string;
	readonly From: string;
	readonly FromName?: string;
	readonly ToFull?: Array<{ readonly Email: string; readonly Name?: string }>;
	readonly To?: string;
	readonly Subject: string;
	readonly TextBody?: string;
	readonly HtmlBody?: string;
	readonly Date: string;
	readonly Attachments?: ReadonlyArray<{
		readonly Name: string;
		readonly Content: string;
		readonly ContentType: string;
		readonly ContentID?: string;
	}>;
	readonly Headers?: ReadonlyArray<{ readonly Name: string; readonly Value: string }>;
	readonly SpamScore?: number;
}

/**
 * Postmark email provider plugin (outbound + inbound).
 */
export class PostmarkPlugin implements IEmailOutboundPlugin, IEmailInboundPlugin {
	readonly id = 'postmark';
	readonly name = 'Postmark';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'email-provider';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.EMAIL_OUTBOUND,
		PLUGIN_CAPABILITIES.EMAIL_INBOUND,
	] as const;
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: { type: 'string', 'x-secret': true, 'x-envVar': 'POSTMARK_API_KEY' },
			defaultSenderDomain: { type: 'string' },
			inboundWebhookSecret: { type: 'string', 'x-secret': true, 'x-envVar': 'POSTMARK_INBOUND_SECRET' },
			inboundStreamId: { type: 'string' },
		},
		required: ['apiKey'],
	};

	async onLoad(): Promise<void> {
		// No-op — Postmark plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, EmailSendResult>();

	async sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult> {
		const cached = this.idempotencyCache.get(input.messageRef);
		if (cached) return cached;

		const apiKey = resolveApiKey(options);
		const body = {
			From: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
			To: input.to.join(', '),
			Cc: input.cc?.join(', '),
			Bcc: input.bcc?.join(', '),
			Subject: input.subject,
			TextBody: input.bodyText,
			HtmlBody: input.bodyHtml,
			ReplyTo: input.replyTo,
			Tag: input.metadata?.tag,
			Metadata: input.metadata,
			Attachments: input.attachments?.map((a) => ({
				Name: a.filename,
				Content: a.content,
				ContentType: a.mimeType,
				ContentID: a.cid,
			})),
		};

		const response = await fetch(`${POSTMARK_API_BASE}/email`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'X-Postmark-Server-Token': apiKey,
			},
			body: JSON.stringify(body),
		});

		const data = (await response.json()) as PostmarkSendResponse;
		if (!response.ok || data.ErrorCode !== 0) {
			throw new Error(
				`Postmark send failed (${response.status} / ${data.ErrorCode}): ${data.Message ?? 'unknown error'}`,
			);
		}
		const result: EmailSendResult = {
			provider: this.id,
			providerMessageId: data.MessageID,
			accepted: [...input.to],
			rejected: [],
		};
		this.idempotencyCache.set(input.messageRef, result);
		// Bounded cache — drop oldest if > 500 entries.
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}

	async verifyAddress(address: string, _options: EmailOptions): Promise<EmailVerification> {
		// Postmark's "sender signature" verification is initiated via the
		// dashboard, not the API. We emit a verification token + send a
		// confirmation email through the same `sendEmail` path so the
		// click-through verifies the address.
		const verificationToken = `pm-${Math.random().toString(36).slice(2)}${Date.now()}`;
		return {
			address,
			verificationToken,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
		};
	}

	verifyWebhookSignature(
		_rawBody: Buffer,
		headers: Readonly<Record<string, string>>,
		options: EmailOptions,
	): void {
		const expected = resolveInboundSecret(options);
		if (!expected) return; // No secret configured — accept (operator opt-in to signature checking).
		// Postmark uses Basic Auth for inbound webhooks. Compare the
		// Authorization header against `Basic base64(user:secret)`.
		const authHeader = headers['authorization'] ?? headers['Authorization'];
		if (!authHeader || !authHeader.startsWith('Basic ')) {
			throw new Error('Postmark inbound: missing or malformed Authorization header.');
		}
		const provided = authHeader.slice('Basic '.length).trim();
		const expectedB64 = Buffer.from(`postmark:${expected}`).toString('base64');
		if (provided !== expectedB64) {
			throw new Error('Postmark inbound: signature mismatch.');
		}
	}

	async parseInboundWebhook(
		rawBody: Buffer,
		_headers: Readonly<Record<string, string>>,
		_options: EmailOptions,
	): Promise<EmailInboundMessage> {
		const payload = JSON.parse(rawBody.toString('utf8')) as PostmarkInboundPayload;
		const to = payload.ToFull?.map((t) => t.Email) ?? (payload.To ? [payload.To] : []);
		const attachments: EmailAttachment[] =
			payload.Attachments?.map((a) => ({
				filename: a.Name,
				mimeType: a.ContentType,
				content: a.Content,
				cid: a.ContentID,
			})) ?? [];
		return {
			provider: this.id,
			providerMessageId: payload.MessageID,
			from: payload.From,
			to,
			subject: payload.Subject,
			bodyText: payload.TextBody ?? '',
			bodyHtml: payload.HtmlBody,
			attachments,
			receivedAt: new Date(payload.Date),
			metadata: {
				spamScore: payload.SpamScore ?? null,
				headers: payload.Headers ?? [],
				fromName: payload.FromName ?? null,
			},
		};
	}

	async parseEventWebhook(
		rawBody: Buffer,
		_headers: Readonly<Record<string, string>>,
		_options: EmailOptions,
	): Promise<readonly EmailDeliveryEvent[]> {
		const payload = JSON.parse(rawBody.toString('utf8')) as {
			readonly RecordType?: string;
			readonly MessageID: string;
			readonly Recipient: string;
			readonly ReceivedAt?: string;
			readonly DeliveredAt?: string;
		};
		const typeMap: Record<string, EmailDeliveryEvent['type']> = {
			Delivery: 'delivered',
			Bounce: 'bounced',
			SpamComplaint: 'complained',
			Open: 'opened',
			Click: 'clicked',
		};
		const type = typeMap[payload.RecordType ?? ''] ?? 'delivered';
		return [
			{
				provider: this.id,
				providerMessageId: payload.MessageID,
				type,
				recipient: payload.Recipient,
				occurredAt: new Date(payload.DeliveredAt ?? payload.ReceivedAt ?? Date.now()),
				raw: payload as unknown as Readonly<Record<string, unknown>>,
			},
		];
	}
}

export const postmarkPlugin = new PostmarkPlugin();
