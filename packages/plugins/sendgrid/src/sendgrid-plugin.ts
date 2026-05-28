import type {
	IEmailOutboundPlugin,
	EmailSendInput,
	EmailSendResult,
	EmailOptions,
	EmailVerification,
	PluginCategory,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

const SENDGRID_API_BASE = 'https://api.sendgrid.com';

function resolveApiKey(options: EmailOptions): string {
	const fromSettings = options.settings?.apiKey;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.SENDGRID_API_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('SendGrid plugin requires `apiKey` setting or SENDGRID_API_KEY env var.');
}

interface SendGridErrorResponse {
	readonly errors?: readonly { readonly message: string; readonly field?: string }[];
}

/**
 * SendGrid outbound email plugin. Direct fetch against the SendGrid v3
 * Mail Send API — no `@sendgrid/mail` dependency, so the plugin keeps
 * zero runtime deps beyond `@ever-works/plugin`.
 *
 * SendGrid returns `202 Accepted` with an empty body on success; the
 * provider message id is surfaced via the `X-Message-Id` response
 * header. Errors come back as `{ errors: [{ message, field }] }`.
 */
export class SendGridPlugin implements IEmailOutboundPlugin {
	readonly id = 'sendgrid';
	readonly name = 'SendGrid';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'email-provider';
	readonly capabilities = [PLUGIN_CAPABILITIES.EMAIL_OUTBOUND] as const;
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: { type: 'string', 'x-secret': true, 'x-envVar': 'SENDGRID_API_KEY' },
			defaultSenderDomain: { type: 'string' }
		},
		required: ['apiKey']
	};

	async onLoad(): Promise<void> {
		// No-op — SendGrid plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, EmailSendResult>();

	async sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult> {
		const cached = this.idempotencyCache.get(input.messageRef);
		if (cached) return cached;

		const apiKey = resolveApiKey(options);
		const content: { type: string; value: string }[] = [{ type: 'text/plain', value: input.bodyText }];
		if (input.bodyHtml) content.push({ type: 'text/html', value: input.bodyHtml });

		const body = {
			personalizations: [
				{
					to: input.to.map((email) => ({ email })),
					cc: input.cc?.length ? input.cc.map((email) => ({ email })) : undefined,
					bcc: input.bcc?.length ? input.bcc.map((email) => ({ email })) : undefined
				}
			],
			from: input.fromName ? { email: input.from, name: input.fromName } : { email: input.from },
			reply_to: input.replyTo ? { email: input.replyTo } : undefined,
			subject: input.subject,
			content,
			custom_args: input.metadata ? { ...input.metadata } : undefined,
			attachments: input.attachments?.map((a) => ({
				content: a.content,
				filename: a.filename,
				type: a.mimeType,
				disposition: a.cid ? 'inline' : 'attachment',
				content_id: a.cid
			}))
		};

		const response = await fetch(`${SENDGRID_API_BASE}/v3/mail/send`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			let message = 'unknown error';
			try {
				const data = (await response.json()) as SendGridErrorResponse;
				message = data.errors?.map((e) => e.message).join('; ') ?? message;
			} catch {
				// Non-JSON error body — keep the generic message.
			}
			throw new Error(`SendGrid send failed (${response.status}): ${message}`);
		}

		const messageId = response.headers.get('x-message-id') ?? `sendgrid-${input.messageRef}`;
		const result: EmailSendResult = {
			provider: this.id,
			providerMessageId: messageId,
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
		// SendGrid verifies sender identities / domains, not arbitrary
		// addresses. We emit a token + return it; the platform-side verify
		// route flips `verified` once the operator clicks the confirmation.
		const verificationToken = `sg-${Math.random().toString(36).slice(2)}${Date.now()}`;
		return {
			address,
			verificationToken,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
		};
	}
}

export const sendgridPlugin = new SendGridPlugin();
