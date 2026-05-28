import { MailService } from '@sendgrid/mail';
import type { MailDataRequired } from '@sendgrid/mail';
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

function resolveApiKey(options: EmailOptions): string {
	const fromSettings = options.settings?.apiKey;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.SENDGRID_API_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('SendGrid plugin requires `apiKey` setting or SENDGRID_API_KEY env var.');
}

interface SendGridError {
	readonly code?: number;
	readonly response?: { readonly body?: { readonly errors?: readonly { readonly message: string }[] } };
	readonly message?: string;
}

/**
 * SendGrid outbound email plugin, built on the official `@sendgrid/mail`
 * SDK. A fresh `MailService` per send keeps the API key request-scoped
 * (multi-tenant safe) rather than mutating the package-level singleton.
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

		const client = new MailService();
		client.setApiKey(resolveApiKey(options));

		const message: MailDataRequired = {
			to: input.to as string[],
			cc: input.cc?.length ? (input.cc as string[]) : undefined,
			bcc: input.bcc?.length ? (input.bcc as string[]) : undefined,
			from: input.fromName ? { email: input.from, name: input.fromName } : input.from,
			replyTo: input.replyTo,
			subject: input.subject,
			text: input.bodyText,
			html: input.bodyHtml,
			customArgs: input.metadata ? { ...input.metadata } : undefined,
			attachments: input.attachments?.map((a) => ({
				content: a.content,
				filename: a.filename,
				type: a.mimeType,
				disposition: a.cid ? 'inline' : 'attachment',
				contentId: a.cid
			}))
		};

		let messageId: string;
		try {
			const [response] = await client.send(message, false);
			messageId = (response?.headers?.['x-message-id'] as string | undefined) ?? `sendgrid-${input.messageRef}`;
		} catch (err) {
			const e = err as SendGridError;
			const detail = e.response?.body?.errors?.map((x) => x.message).join('; ') ?? e.message ?? 'unknown error';
			throw new Error(`SendGrid send failed (${e.code ?? 'error'}): ${detail}`);
		}

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
		// addresses. We emit a token; the platform-side verify route flips
		// `verified` once the operator clicks the confirmation.
		const verificationToken = `sg-${Math.random().toString(36).slice(2)}${Date.now()}`;
		return {
			address,
			verificationToken,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
		};
	}
}

export const sendgridPlugin = new SendGridPlugin();
