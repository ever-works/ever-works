import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { IntegrationInboxItemDto } from '@ever-works/contracts';
import { DataSource } from 'typeorm';
import { toIntegrationInboxItemDto } from '../domain-events/domain-event-snapshots';
import { InboxItem } from '../entities/inbox-item.entity';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { etagFor } from './if-match';
import { ResourceNotFoundError } from './integration-api.errors';
import { type KeysetPage, type KeysetQuery, readKeysetPage } from './keyset-cursor';

/**
 * `GET /inbox/items` (contract v1 B.6 "Inbox"): keyset paging plus the inbox
 * filters. The route validates `statuses` / `kinds` against the contracts'
 * `INBOX_ITEM_STATUSES` / `INBOX_ITEM_KINDS` before they get here.
 */
export interface IntegrationInboxListQuery extends KeysetQuery {
    /** Only the messages of this recipient. */
    readonly recipientUserId?: string | null;
    /** Only these statuses. Empty = every status except `archived` (unless `includeArchived`). */
    readonly statuses?: readonly string[];
    /** Only these kinds. Empty = every kind. */
    readonly kinds?: readonly string[];
    /** With no `statuses`, also list archived messages (default false, as every v1 list). */
    readonly includeArchived?: boolean;
}

/** One inbox message as the integration DTO, plus its `ETag`. */
export interface IntegrationInboxItem {
    readonly dto: IntegrationInboxItemDto;
    readonly etag: string;
    /** The recipient: replies and state changes act as this user only. */
    readonly recipientUserId: string;
}

/**
 * Inbox reads of `/api/integrations/v1` (EW-P3-1, contract v1 B.6 "Inbox").
 *
 * An inbox item is ONE human's message (its recipient), not an organization
 * resource: it has no visibility, owner or teams. The integration principal
 * reads every recipient's messages in its pinned organization — the contract's
 * "all recipients in pinned orgs" — and never a message outside any
 * organization (`organizationId` null, a personal-scope message) or in another
 * organization (`404 not_found` by id, like every v1 resource).
 *
 * The DTO is the `inbox.item.*` event `data` mapper (`toIntegrationInboxItemDto`),
 * so a read and the event of the same version are identical.
 */
@Injectable()
export class IntegrationInboxService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async list(
        organizationId: string,
        query: IntegrationInboxListQuery,
    ): Promise<KeysetPage<IntegrationInboxItemDto>> {
        const qb = this.dataSource
            .getRepository(InboxItem)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        if (query.recipientUserId) {
            qb.andWhere('row.userId = :recipientUserId', {
                recipientUserId: query.recipientUserId,
            });
        }
        const statuses = query.statuses ?? [];
        if (statuses.length > 0) {
            qb.andWhere('row.status IN (:...statuses)', { statuses: [...statuses] });
        } else if (!query.includeArchived) {
            qb.andWhere('row.status != :archived', { archived: 'archived' });
        }
        const kinds = query.kinds ?? [];
        if (kinds.length > 0) {
            qb.andWhere('row.kind IN (:...kinds)', { kinds: [...kinds] });
        }
        const page = await readKeysetPage(qb, 'row', query);
        return {
            data: page.data.map((row) => toIntegrationInboxItemDto(row)),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    /** One message of the pinned organization (`404 not_found` for any other). */
    async get(organizationId: string, id: string): Promise<IntegrationInboxItem> {
        const row = await this.dataSource.getRepository(InboxItem).findOne({ where: { id } });
        if (!row || !row.organizationId || row.organizationId !== organizationId) {
            throw new ResourceNotFoundError('inbox_item', id);
        }
        const dto = toIntegrationInboxItemDto(row);
        return { dto, etag: etagFor(dto.version), recipientUserId: row.userId };
    }

    /**
     * Works-security lane 3a — whether answering this item would DECIDE A MERGE:
     * an approval backed by a `merge_pull_request` proposal (an agent's pull
     * request landing on a real branch, a release promotion, a release revert
     * — all of them go through that one proposal type). An integration relays
     * such an answer only with the `merges:decide` scope.
     *
     * Fails CLOSED: a proposal that cannot be read, or no longer exists, counts
     * as a merge, so a lookup hiccup never relays a merge decision without the
     * scope. An approval with no proposal behind it, a question, an escalation
     * and a notice are never merges.
     */
    async isMergeApproval(
        dto: Pick<IntegrationInboxItemDto, 'kind' | 'proposalId'>,
    ): Promise<boolean> {
        if (dto.kind !== 'approval' || !dto.proposalId) return false;
        try {
            const row = await this.dataSource
                .getRepository(AgentActionProposal)
                .findOne({ where: { id: dto.proposalId }, select: ['id', 'actionType'] });
            return !row || row.actionType === 'merge_pull_request';
        } catch {
            return true;
        }
    }

    /**
     * Works-security lane 3a — record ON THE DECISION that an integration
     * relayed it: `payload.decisionRelay` on the decided proposal (the payload
     * is the proposal's free-form, display-and-audit column; no verifier binds
     * to it). Written only after the decision landed, and only when the decided
     * row really carries this recipient's decision, so an idempotent replay or
     * a lost race never rewrites somebody else's. Best-effort: the decision
     * stands whether or not the stamp could be written.
     */
    async recordRelayedDecision(
        proposalId: string,
        relay: { recipientUserId: string; integrationKeyId: string; integrationKind: string },
        now: Date = new Date(),
    ): Promise<boolean> {
        try {
            const repository = this.dataSource.getRepository(AgentActionProposal);
            const row = await repository.findOne({ where: { id: proposalId } });
            if (!row || row.status === 'pending' || row.decidedById !== relay.recipientUserId) {
                return false;
            }
            await repository.update(
                { id: proposalId },
                {
                    payload: {
                        ...(row.payload ?? {}),
                        decisionRelay: {
                            via: 'integration',
                            integrationKeyId: relay.integrationKeyId,
                            integrationKind: relay.integrationKind,
                            recordedAt: now.toISOString(),
                        },
                    },
                },
            );
            return true;
        } catch {
            return false;
        }
    }
}
