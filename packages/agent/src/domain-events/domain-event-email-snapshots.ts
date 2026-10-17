import {
    RECIPIENT_EVENT_VISIBILITY,
    type IntegrationEmailAttachmentDto,
    type IntegrationEmailMessageDto,
} from '@ever-works/contracts';
import type { EntityManager } from 'typeorm';
import { EmailMessage } from '../entities/email-message.entity';
import { Organization } from '../entities/organization.entity';
import { type AggregateSnapshot, webAppOrigin } from './domain-event-snapshots';

/**
 * EW-P4-2 — agent email snapshots: the `data` of `email.message.*` events and
 * the body of `GET /api/integrations/v1/email/messages[/:id]`
 * (`resources/email-message.schema.json`).
 *
 * Kept out of `domain-event-snapshots.ts` so the email slice does not touch the
 * P1/P2 builders.
 */

/**
 * The largest text + HTML (UTF-8 bytes) an EVENT carries; above it the event
 * sends `text: null, html: null, bodyOmitted: true` and `GET` returns the
 * bodies (a newsletter's HTML would otherwise ride every status change).
 */
export const EMAIL_EVENT_BODY_MAX_BYTES = 256 * 1024;

const iso = (value: Date | string | null | undefined): string | null =>
    value ? new Date(value).toISOString() : null;
const isoRequired = (value: Date | string | null | undefined): string =>
    iso(value) ?? new Date(0).toISOString();

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

function attachmentsOf(row: EmailMessage): IntegrationEmailAttachmentDto[] {
    if (!Array.isArray(row.attachments)) return [];
    return row.attachments.map((attachment) => {
        const out: IntegrationEmailAttachmentDto = {
            filename: String(attachment.filename ?? ''),
            mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
            size: Number(attachment.size) || 0,
            stored: attachment.stored === true,
        };
        return attachment.reason ? { ...out, reason: String(attachment.reason) } : out;
    });
}

/**
 * One message as the integration DTO. Bcc, provider metadata, the approval
 * bookkeeping and the failure reason are never exposed. `forEvent` applies
 * the event body limit.
 */
export function toIntegrationEmailMessageDto(
    row: EmailMessage,
    organizationId: string,
    options: { forEvent?: boolean } = {},
): IntegrationEmailMessageDto {
    const text = row.bodyText ?? '';
    const html = row.bodyHtml ?? null;
    const omit =
        options.forEvent === true &&
        Buffer.byteLength(text, 'utf8') + Buffer.byteLength(html ?? '', 'utf8') >
            EMAIL_EVENT_BODY_MAX_BYTES;
    const origin = webAppOrigin();
    const dto: IntegrationEmailMessageDto = {
        id: row.id,
        organizationId,
        version: Number((row as { version?: number }).version) || 1,
        createdAt: isoRequired(row.createdAt),
        updatedAt: isoRequired((row as { updatedAt?: Date }).updatedAt ?? row.createdAt),
        ownerUserId: row.userId,
        agentId: row.agentId ?? null,
        taskId: row.taskId ?? null,
        conversationId: row.conversationId ?? null,
        direction: row.direction,
        status: row.status ?? null,
        deliveryStatus: row.deliveryStatus ?? null,
        from: row.from,
        to: strings(row.toAddresses),
        cc: strings(row.ccAddresses),
        subject: row.subject,
        text: omit ? null : text,
        html: omit ? null : html,
        messageId: row.messageIdHeader ?? null,
        inReplyTo: row.inReplyTo ?? null,
        references: strings(row.references),
        attachments: attachmentsOf(row),
        sentAt: iso(row.sentAt),
        receivedAt: iso(row.receivedAt),
        webUrl:
            origin && row.agentId
                ? `${origin}/agents/${row.agentId}/inbox/${encodeURIComponent(row.id)}`
                : null,
    };
    return omit ? { ...dto, bodyOmitted: true } : dto;
}

/**
 * `email_message` snapshot. A message outside any organization answers `null`
 * (nothing recorded: the integration feed is per organization). Recorded
 * `recipient`-scoped (`RECIPIENT_EVENT_VISIBILITY`): one person's mailbox,
 * served only to a key that also holds `email:read`, never to a user-owned
 * webhook subscription.
 */
export async function buildEmailMessageSnapshot(
    manager: EntityManager,
    id: string,
): Promise<AggregateSnapshot<IntegrationEmailMessageDto> | null> {
    const row = await manager.getRepository(EmailMessage).findOne({ where: { id } });
    if (!row?.organizationId) return null;
    let tenantId = row.tenantId ?? null;
    if (!tenantId) {
        const org = await manager
            .getRepository(Organization)
            .findOne({ where: { id: row.organizationId }, select: ['id', 'tenantId'] });
        tenantId = org?.tenantId ?? null;
    }
    return {
        dto: toIntegrationEmailMessageDto(row, row.organizationId, { forEvent: true }),
        tenantId,
        organizationId: row.organizationId,
        visibility: RECIPIENT_EVENT_VISIBILITY,
    };
}
