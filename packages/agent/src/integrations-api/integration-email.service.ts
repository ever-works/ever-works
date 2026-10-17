import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { IntegrationEmailMessageDto } from '@ever-works/contracts';
import { DataSource } from 'typeorm';
import { toIntegrationEmailMessageDto } from '../domain-events/domain-event-email-snapshots';
import { AgentEmailAssignment } from '../entities/agent-email-assignment.entity';
import { EmailMessage } from '../entities/email-message.entity';
import { TenantEmailAddress } from '../entities/tenant-email-address.entity';
import { etagFor } from './if-match';
import { ResourceNotFoundError } from './integration-api.errors';
import { type KeysetPage, type KeysetQuery, readKeysetPage } from './keyset-cursor';

/** `GET /email/messages` filters (contract v1 B.6 "Email"); the route validates the vocabularies. */
export interface IntegrationEmailListQuery extends KeysetQuery {
    readonly agentId?: string | null;
    readonly direction?: 'inbound' | 'outbound' | null;
    readonly statuses?: readonly string[];
}

export interface IntegrationEmailMessage {
    readonly dto: IntegrationEmailMessageDto;
    readonly etag: string;
}

/** The address an Agent receives mail on (its first inbound assignment), or why it has none. */
export type AgentInboundAddress =
    | { readonly ok: true; readonly address: TenantEmailAddress }
    | { readonly ok: false; readonly reason: string };

/**
 * Agent email reads of `/api/integrations/v1` (EW-P4-2, contract v1 B.6
 * "Email"): the messages of the pinned organization — mail its Agents received
 * and sent or drafted — keyset-paged by `(updatedAt, id)`. A message outside
 * any organization is never served; another organization's answers
 * `404 not_found`. The DTO is the `email.message.*` event mapper (full bodies
 * on a read). Recipient-scoped like the Inbox: the route needs `email:read`.
 */
@Injectable()
export class IntegrationEmailService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async list(
        organizationId: string,
        query: IntegrationEmailListQuery,
    ): Promise<KeysetPage<IntegrationEmailMessageDto>> {
        const qb = this.dataSource
            .getRepository(EmailMessage)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        if (query.agentId) qb.andWhere('row.agentId = :agentId', { agentId: query.agentId });
        if (query.direction) {
            qb.andWhere('row.direction = :direction', { direction: query.direction });
        }
        const statuses = query.statuses ?? [];
        if (statuses.length > 0) {
            qb.andWhere('row.status IN (:...statuses)', { statuses: [...statuses] });
        }
        const page = await readKeysetPage(qb, 'row', query);
        return {
            data: page.data.map((row) => toIntegrationEmailMessageDto(row, organizationId)),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    async get(organizationId: string, id: string): Promise<IntegrationEmailMessage> {
        const row = await this.dataSource.getRepository(EmailMessage).findOne({ where: { id } });
        if (!row || !row.organizationId || row.organizationId !== organizationId) {
            throw new ResourceNotFoundError('email_message', id);
        }
        const dto = toIntegrationEmailMessageDto(row, organizationId);
        return { dto, etag: etagFor(dto.version) };
    }

    /**
     * EW-P4-1 — where `POST /email/inbound` delivers an Agent's mail: the
     * address of its first inbound assignment (lowest priority, as the provider
     * path picks), which must be active and accept inbound mail. The dispatcher
     * then re-checks it exactly as for provider mail.
     */
    async inboundAddressOf(agentId: string): Promise<AgentInboundAddress> {
        const assignments = await this.dataSource.getRepository(AgentEmailAssignment).find({
            where: { agentId, direction: 'inbound' },
            order: { priority: 'ASC', createdAt: 'ASC' },
            relations: ['emailAddress'],
        });
        const usable = assignments.find(
            (assignment) =>
                assignment.emailAddress &&
                !assignment.emailAddress.disabledAt &&
                (assignment.emailAddress.direction === 'inbound' ||
                    assignment.emailAddress.direction === 'both'),
        );
        if (!usable?.emailAddress) {
            return {
                ok: false,
                reason:
                    assignments.length === 0
                        ? 'The agent has no inbound email assignment; assign it an inbound address in Ever Works first.'
                        : 'The agent has no active inbound address.',
            };
        }
        return { ok: true, address: usable.emailAddress };
    }

    /** An existing message with this provider id (a replayed push), if any. */
    async findPushed(
        organizationId: string,
        pluginId: string,
        providerMessageId: string,
    ): Promise<EmailMessage | null> {
        return this.dataSource
            .getRepository(EmailMessage)
            .findOne({ where: { organizationId, pluginId, providerMessageId } });
    }
}

/**
 * The provider message id of an integration-pushed email: stable per key,
 * pinned organization and RFC Message-ID (or, without one, per
 * Idempotency-Key), so a retried push finds the message it already delivered
 * (`uq_email_messages_provider_message`), and one key pushing the same mail
 * into two organizations delivers it to each.
 */
export function integrationProviderMessageId(
    keyId: string,
    organizationId: string,
    dedupeKey: string,
): string {
    return `integration-${createHash('sha256')
        .update(`${keyId}:${organizationId}:${dedupeKey}`)
        .digest('hex')
        .slice(0, 48)}`;
}
