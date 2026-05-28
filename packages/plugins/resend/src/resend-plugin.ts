import { Resend } from 'resend';
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
	const fromEnv = process.env.RESEND_API_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('Resend plugin requires `apiKey` setting or RESEND_API_KEY env var.');
}

/**
 * Resend outbound email plugin, built on the official `resend` SDK.
 * Idempotency is handled by Resend natively via the `idempotencyKey`
 * request option (keyed on `EmailSendInput.messageRef`), backed by a
 * local cache so repeated refs short-circuit without a network call.
 */
export class ResendPlugin implements IEmailOutboundPlugin {
	readonly id = 'resend';
	readonly name = 'Resend';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'email-provider';
	readonly capabilities = [PLUGIN_CAPABILITIES.EMAIL_OUTBOUND] as const;
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: { type: 'string', 'x-secret': true, 'x-envVar': 'RESEND_API_KEY' },
			defaultSenderDomain: { type: 'string' }
		},
		required: ['apiKey']
	};

	async onLoad(): Promise<void> {
		// No-op — Resend plugin has no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, EmailSendResult>();

	async sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult> {
		const cached = this.idempotencyCache.get(input.messageRef);
		if (cached) return cached;

		const resend = new Resend(resolveApiKey(options));
		const fromField = input.fromName ? `${input.fromName} <${input.from}>` : input.from;

		const { data, error } = await resend.emails.send(
			{
				from: fromField,
				to: [...input.to],
				cc: input.cc ? [...input.cc] : undefined,
				bcc: input.bcc ? [...input.bcc] : undefined,
				subject: input.subject,
				text: input.bodyText,
				html: input.bodyHtml,
				replyTo: input.replyTo,
				tags: input.metadata
					? Object.entries(input.metadata).map(([name, value]) => ({ name, value }))
					: undefined,
				attachments: input.attachments?.map((a) => ({
					filename: a.filename,
					content: a.content,
					contentType: a.mimeType,
					contentId: a.cid
				}))
			},
			{ idempotencyKey: input.messageRef }
		);

		if (error) {
			throw new Error(`Resend send failed (${error.name}): ${error.message}`);
		}

		const result: EmailSendResult = {
			provider: this.id,
			providerMessageId: data?.id ?? `resend-${input.messageRef}`,
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
		// Resend verifies sending domains, not individual addresses. We
		// emit a token + return it; the platform-side verify route uses
		// it to flip `verified` once the operator clicks the confirmation.
		const verificationToken = `rs-${Math.random().toString(36).slice(2)}${Date.now()}`;
		return {
			address,
			verificationToken,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
		};
	}
}

export const resendPlugin = new ResendPlugin();
