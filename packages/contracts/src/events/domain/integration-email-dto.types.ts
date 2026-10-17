/**
 * EW-P4-2 — the email message DTO of the integration contract v1 (B.6 "Email"):
 * the `data` of `email.message.*` events and the body of
 * `GET /email/messages[/:id]`. Recipient-scoped like the Inbox: served only to
 * a key that also holds `email:read` (`recipientScopeForEventType`).
 *
 * Kept apart from `integration-dto.types.ts` so the email slice does not touch
 * the P1/P2 resource types.
 */

/** One attachment as recorded on its message (metadata only; the bytes stay in Ever Works). */
export interface IntegrationEmailAttachmentDto {
	readonly filename: string;
	readonly mimeType: string;
	readonly size: number;
	/** The bytes were stored in Ever Works (else `reason` says why not). */
	readonly stored: boolean;
	readonly reason?: string | null;
}

/**
 * One agent email (`email_messages`): mail an agent received (`inbound`) or
 * sent / drafted (`outbound`). Its owner is the agent's owner; Bcc is never
 * exposed.
 */
export interface IntegrationEmailMessageDto {
	readonly id: string;
	readonly organizationId: string;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** The person the mailbox belongs to (the agent's owner). */
	readonly ownerUserId: string;
	readonly agentId: string | null;
	/** The Task the message spawned or joined. */
	readonly taskId: string | null;
	readonly conversationId: string | null;
	readonly direction: 'inbound' | 'outbound';
	/** Lifecycle (`received`, `draft`, `sending`, `sent`, `failed`, `discarded`, …; open set). */
	readonly status: string | null;
	/** Provider telemetry (`delivered`, `bounced`, `opened`, …; open set). */
	readonly deliveryStatus: string | null;
	readonly from: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	/** Plain-text body; `null` with `bodyOmitted` only in an event over the event body limit. */
	readonly text: string | null;
	/** HTML body as received or sent (never rendered by Ever Works for a consumer: sanitize it). */
	readonly html: string | null;
	readonly bodyOmitted?: true;
	/** RFC 5322 Message-ID / In-Reply-To / References, bare (no angle brackets). */
	readonly messageId: string | null;
	readonly inReplyTo: string | null;
	readonly references: readonly string[];
	readonly attachments: readonly IntegrationEmailAttachmentDto[];
	readonly sentAt: string | null;
	readonly receivedAt: string | null;
	readonly webUrl?: string | null;
}
