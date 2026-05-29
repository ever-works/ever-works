import type { IPlugin } from '../plugin.interface.js';
import type { PluginPricing } from '../pricing.types.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Notifications v2 — Email Providers (EW-650).
 *
 * Plugins that send / receive transactional + agent-driven email
 * implement one or both of the interfaces below and declare the
 * matching capability constants `EMAIL_OUTBOUND` / `EMAIL_INBOUND`
 * from `facade-capabilities.ts`.
 *
 * See `docs/specs/features/email-providers/spec.md` §3 for the
 * canonical contract description. Implementations live as standalone
 * packages under `packages/plugins/<name>/` (postmark, resend,
 * mailgun, sendgrid, …) — never inlined into the agent / api code.
 *
 * The canonical DTO shapes (`EmailSendInput`, `EmailSendResult`,
 * `EmailInboundMessage`, `EmailAttachment`, `EmailDeliveryEvent`,
 * `EmailVerification`) live in this file so plugin packages and the
 * agent / api facades share a single source of truth.
 */

/**
 * Per-call attribution + facade-resolved settings handed to every
 * outbound plugin call. Mirrors the `ScreenshotOptions.settings`
 * pattern — the plugin uses the resolved settings instead of its
 * own stored defaults.
 */
export interface EmailOptions {
	/** User attribution (for spend roll-ups + audit logs). */
	readonly userId?: string;
	/** Work attribution (per-Work plugin scope + spend roll-up). */
	readonly workId?: string;
	/** Agent attribution (per-Agent spend roll-up). */
	readonly agentId?: string;
	/** Task attribution (per-Task spend roll-up). */
	readonly taskId?: string;
	/**
	 * Resolved settings handed in by `EmailFacadeService`. Plugins
	 * should use these instead of their stored defaults. Mirrors the
	 * `ScreenshotOptions.settings` pattern.
	 */
	readonly settings?: PluginSettings;
}

/**
 * Inline attachment shape — base64 content + filename + MIME. We
 * stay close to the wire shapes Postmark / Mailgun / Sendgrid
 * accept so plugins don't have to re-shape it.
 */
export interface EmailAttachment {
	readonly filename: string;
	readonly mimeType: string;
	/** Base64-encoded content. */
	readonly content: string;
	/** Optional Content-ID for inline embedding. */
	readonly cid?: string;
}

/**
 * Canonical send input — handed to every outbound plugin. The
 * facade fills `messageRef` (idempotency key) and resolves
 * `from` / `fromName` from the tenant address record.
 */
export interface EmailSendInput {
	/** RFC 5321 mailbox the message originates from. */
	readonly from: string;
	/** Optional display name shown next to `from`. */
	readonly fromName?: string;
	readonly to: readonly string[];
	readonly cc?: readonly string[];
	readonly bcc?: readonly string[];
	readonly subject: string;
	readonly bodyText: string;
	readonly bodyHtml?: string;
	readonly replyTo?: string;
	readonly attachments?: readonly EmailAttachment[];
	/** Forwarded to provider tags (Postmark Tag, Mailgun v:variable, …). */
	readonly metadata?: Readonly<Record<string, string>>;
	/**
	 * Idempotency key — REQUIRED when invoked via the agent-run path.
	 * Plugins MUST de-dupe on this value across retries so a flaky
	 * webhook ack doesn't double-deliver mail.
	 */
	readonly messageRef: string;
}

/**
 * Canonical send result. `accepted` + `rejected` mirror SMTP RCPT
 * semantics — even a 250-accepted message can have per-recipient
 * rejections (e.g. one address blacklisted at the provider).
 */
export interface EmailSendResult {
	readonly provider: string;
	readonly providerMessageId: string;
	readonly accepted: readonly string[];
	readonly rejected: readonly { address: string; reason: string }[];
}

/**
 * Inbound message as parsed by `IEmailInboundPlugin.parseInboundWebhook`.
 * The webhook controller hands `rawBody` + `headers` to the plugin and
 * receives this canonical shape back — the rest of the platform never
 * sees provider-specific webhook JSON.
 */
export interface EmailInboundMessage {
	readonly provider: string;
	readonly providerMessageId: string;
	readonly from: string;
	readonly to: readonly string[];
	readonly subject: string;
	readonly bodyText: string;
	readonly bodyHtml?: string;
	readonly attachments?: readonly EmailAttachment[];
	readonly receivedAt: Date;
	/** Provider-specific metadata (spam score, DKIM result, …). */
	readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Delivery / engagement events surfaced by the provider's event
 * webhook (bounces, opens, clicks, complaints, deferrals).
 */
export interface EmailDeliveryEvent {
	readonly provider: string;
	readonly providerMessageId: string;
	readonly type:
		| 'accepted'
		| 'delivered'
		| 'bounced'
		| 'complained'
		| 'opened'
		| 'clicked'
		| 'deferred'
		| 'unsubscribed';
	readonly recipient: string;
	readonly occurredAt: Date;
	readonly raw?: Readonly<Record<string, unknown>>;
}

export interface EmailEventFilter {
	readonly providerMessageId?: string;
	readonly since?: Date;
	readonly until?: Date;
	readonly limit?: number;
}

/**
 * Result of triggering a verification flow on a tenant-managed address.
 * `verificationToken` is the token the user clicks back to confirm.
 */
export interface EmailVerification {
	readonly address: string;
	readonly verificationToken: string;
	readonly providerMessageId?: string;
	readonly expiresAt?: Date;
}

/**
 * Outbound capability — provider can send mail and (optionally) surface
 * delivery events. Maps to `PLUGIN_CAPABILITIES.EMAIL_OUTBOUND`.
 */
export interface IEmailOutboundPlugin extends IPlugin {
	sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult>;

	/**
	 * Trigger a verification email to `address`. Returns the token the
	 * caller will hand back through `GET /api/email/verify/:tokenId`.
	 */
	verifyAddress(address: string, options: EmailOptions): Promise<EmailVerification>;

	/**
	 * Async-iterate delivery / engagement events. Plugins that can't
	 * surface this (e.g. SMTP-only) MAY return an empty iterator.
	 */
	listDeliveryEvents?(filter: EmailEventFilter, options: EmailOptions): AsyncGenerator<EmailDeliveryEvent>;

	/**
	 * Optional per-send pricing. Returned cost is attributed to
	 * `PluginUsageEvent.costCents` on each `sendEmail` call. Plugins
	 * that don't implement this contribute units only (cost = 0).
	 */
	getPricing?(): PluginPricing | Promise<PluginPricing>;
}

/**
 * Inbound capability — provider exposes a public webhook that the
 * platform parses + signature-verifies. Maps to
 * `PLUGIN_CAPABILITIES.EMAIL_INBOUND`.
 */
export interface IEmailInboundPlugin extends IPlugin {
	/**
	 * Decode the provider's webhook payload into the canonical
	 * `EmailInboundMessage` shape. The webhook controller hands the
	 * raw body + headers in; plugins are responsible for parsing both
	 * JSON and signed form-data shapes.
	 */
	parseInboundWebhook(
		rawBody: Buffer,
		headers: Readonly<Record<string, string>>,
		options: EmailOptions
	): Promise<EmailInboundMessage>;

	/**
	 * Verify the provider's webhook signature. MUST throw on
	 * signature mismatch — the controller catches and 401s with
	 * empty body (don't leak which secret is wrong).
	 */
	verifyWebhookSignature(rawBody: Buffer, headers: Readonly<Record<string, string>>, options: EmailOptions): void;

	/**
	 * Optional: best-effort extraction of the recipient mailbox
	 * address(es) from the raw webhook payload, WITHOUT verifying the
	 * signature. The facade uses this to map an inbound webhook to its
	 * owning tenant address *before* signature verification, so a
	 * per-user `inboundWebhookSecret` is resolved at the right scope
	 * rather than only at admin/env scope. MUST NOT throw — return an
	 * empty array when the recipient can't be determined. Plugins that
	 * omit this fall back to admin/env-scoped secret resolution.
	 */
	extractInboundRecipients?(rawBody: Buffer, headers: Readonly<Record<string, string>>): readonly string[];

	/**
	 * Optional: decode a provider's delivery-event webhook (separate
	 * shape from inbound on most providers). Plugins that don't
	 * publish delivery events may omit this — the controller skips
	 * the route registration when undefined.
	 */
	parseEventWebhook?(
		rawBody: Buffer,
		headers: Readonly<Record<string, string>>,
		options: EmailOptions
	): Promise<readonly EmailDeliveryEvent[]>;
}

/**
 * Type guards — narrow an `IPlugin` to the email capability shapes.
 */
export function isEmailOutboundPlugin(plugin: IPlugin): plugin is IEmailOutboundPlugin {
	return plugin.capabilities.includes('email-outbound');
}

export function isEmailInboundPlugin(plugin: IPlugin): plugin is IEmailInboundPlugin {
	return plugin.capabilities.includes('email-inbound');
}
