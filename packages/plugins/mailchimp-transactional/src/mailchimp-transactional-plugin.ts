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

const MANDRILL_API_BASE = 'https://mandrillapp.com/api/1.0';

function resolveApiKey(options: EmailOptions): string {
	const fromSettings = options.settings?.apiKey;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env.MANDRILL_API_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	throw new Error('Mailchimp Transactional plugin requires `apiKey` setting or MANDRILL_API_KEY env var.');
}

interface MandrillRecipientResult {
	readonly email: string;
	readonly status: 'sent' | 'queued' | 'scheduled' | 'rejected' | 'invalid';
	readonly _id?: string;
	readonly reject_reason?: string | null;
}

interface MandrillErrorResponse {
	readonly status?: 'error';
	readonly code?: number;
	readonly name?: string;
	readonly message?: string;
}

const ACCEPTED = new Set(['sent', 'queued', 'scheduled']);

/**
 * Mailchimp Transactional (formerly Mandrill) outbound email plugin.
 * Direct fetch against the Mandrill JSON API — no `@mailchimp/...`
 * dependency, so the plugin keeps zero runtime deps beyond
 * `@ever-works/plugin`.
 *
 * NOTE: this is the *transactional* product (per-message API at
 * mandrillapp.com), NOT the Mailchimp Marketing/campaigns API.
 */
export class MailchimpTransactionalPlugin implements IEmailOutboundPlugin {
	readonly id = 'mailchimp-transactional';
	readonly name = 'Mailchimp Transactional';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'email-provider';
	readonly capabilities = [PLUGIN_CAPABILITIES.EMAIL_OUTBOUND] as const;
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: { type: 'string', 'x-secret': true, 'x-envVar': 'MANDRILL_API_KEY' },
			defaultSenderDomain: { type: 'string' }
		},
		required: ['apiKey']
	};

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	private readonly idempotencyCache = new Map<string, EmailSendResult>();

	async sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult> {
		const cached = this.idempotencyCache.get(input.messageRef);
		if (cached) return cached;

		const apiKey = resolveApiKey(options);
		const to = [
			...input.to.map((email) => ({ email, type: 'to' as const })),
			...(input.cc ?? []).map((email) => ({ email, type: 'cc' as const })),
			...(input.bcc ?? []).map((email) => ({ email, type: 'bcc' as const }))
		];
		const headers = input.replyTo ? { 'Reply-To': input.replyTo } : undefined;

		const body = {
			key: apiKey,
			message: {
				from_email: input.from,
				from_name: input.fromName,
				to,
				subject: input.subject,
				text: input.bodyText,
				html: input.bodyHtml,
				headers,
				metadata: input.metadata,
				attachments: input.attachments?.map((a) => ({
					type: a.mimeType,
					name: a.filename,
					content: a.content
				}))
			}
		};

		const response = await fetch(`${MANDRILL_API_BASE}/messages/send.json`, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		const data = (await response.json().catch(() => ({}))) as
			| readonly MandrillRecipientResult[]
			| MandrillErrorResponse;

		const isArray = Array.isArray(data);
		if (!response.ok || (!isArray && (data as MandrillErrorResponse).status === 'error')) {
			const err = data as MandrillErrorResponse;
			throw new Error(
				`Mailchimp Transactional send failed (${response.status} / ${err.name ?? 'error'}): ${
					err.message ?? 'unknown error'
				}`
			);
		}

		const results: readonly MandrillRecipientResult[] = isArray ? data : [];
		const accepted = results.filter((r) => ACCEPTED.has(r.status)).map((r) => r.email);
		const rejected = results
			.filter((r) => !ACCEPTED.has(r.status))
			.map((r) => ({ address: r.email, reason: r.reject_reason ?? r.status }));
		const firstId = results.find((r) => r._id)?._id;

		const result: EmailSendResult = {
			provider: this.id,
			providerMessageId: firstId ?? `mandrill-${input.messageRef}`,
			accepted: accepted.length ? accepted : [...input.to],
			rejected
		};
		this.idempotencyCache.set(input.messageRef, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}

	async verifyAddress(address: string, _options: EmailOptions): Promise<EmailVerification> {
		// Mandrill verifies sending domains, not individual addresses. We
		// emit a token; the platform-side verify route flips `verified`
		// once the operator clicks the confirmation.
		const verificationToken = `mc-${Math.random().toString(36).slice(2)}${Date.now()}`;
		return {
			address,
			verificationToken,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
		};
	}
}

export const mailchimpTransactionalPlugin = new MailchimpTransactionalPlugin();
