import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, type FindOptionsWhere } from 'typeorm';
import type { EmailMessageStatus } from '@ever-works/contracts';
import { EmailMessage, EmailMessageDirection } from '../../entities/email-message.entity';

/**
 * AW-05 — which sends a ceiling window counts: one Agent's (`agentId`) or a
 * whole account's (`userId`). Exactly one should be set.
 */
export interface EmailSendWindowFilter {
    agentId?: string;
    userId?: string;
}

export interface EmailMessageQueryOptions {
    direction?: EmailMessageDirection;
    agentId?: string;
    taskId?: string;
    conversationId?: string;
    emailAddressId?: string;
    limit?: number;
    offset?: number;
}

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Repository for `email_messages`. Both directions live in the same
 * table — direction discriminator + indexed `(userId, agentId,
 * createdAt)` keeps the per-Agent inbox query cheap.
 */
@Injectable()
export class EmailMessageRepository {
    constructor(
        @InjectRepository(EmailMessage)
        private readonly repository: Repository<EmailMessage>,
    ) {}

    create(entry: Partial<EmailMessage>): EmailMessage {
        return this.repository.create(entry);
    }

    async save(entry: EmailMessage): Promise<EmailMessage> {
        return this.repository.save(entry);
    }

    async findById(id: string): Promise<EmailMessage | null> {
        return this.repository.findOne({ where: { id } });
    }

    // Security: tenant-scoped single-message lookup. Service-layer callers that
    // resolve a message on behalf of an authenticated user MUST use this instead
    // of the unscoped findById so another tenant's message body/subject/recipients
    // can never be returned (IDOR). The unscoped findById is retained for internal
    // system paths keyed on a trusted id (e.g. provider delivery-status callbacks).
    async findByIdAndUserId(id: string, userId: string): Promise<EmailMessage | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findByProviderMessageId(
        pluginId: string,
        providerMessageId: string,
    ): Promise<EmailMessage | null> {
        return this.repository.findOne({
            where: { pluginId, providerMessageId },
        });
    }

    async findByUser(
        userId: string,
        options: EmailMessageQueryOptions = {},
    ): Promise<EmailMessage[]> {
        const qb = this.repository.createQueryBuilder('m').where('m.userId = :userId', { userId });
        if (options.direction)
            qb.andWhere('m.direction = :direction', { direction: options.direction });
        if (options.agentId) qb.andWhere('m.agentId = :agentId', { agentId: options.agentId });
        if (options.taskId) qb.andWhere('m.taskId = :taskId', { taskId: options.taskId });
        if (options.conversationId)
            qb.andWhere('m.conversationId = :conversationId', {
                conversationId: options.conversationId,
            });
        if (options.emailAddressId)
            qb.andWhere('m.emailAddressId = :emailAddressId', {
                emailAddressId: options.emailAddressId,
            });
        qb.orderBy('m.createdAt', 'DESC')
            .skip(options.offset ?? 0)
            .take(Math.min(options.limit ?? 50, 100));
        return qb.getMany();
    }

    async updateDeliveryStatus(id: string, deliveryStatus: string): Promise<void> {
        await this.repository.update({ id }, { deliveryStatus });
    }

    // ── AW-05 — send ceilings + draft lifecycle ─────────────────────

    /**
     * Outbound messages that actually went out (`sentAt` set) since `since`.
     * A draft, a discarded draft and a refused send have no `sentAt`, so none
     * of them spends capacity.
     */
    async countOutboundSentSince(filter: EmailSendWindowFilter, since: Date): Promise<number> {
        return this.repository.count({ where: this.sentWindowWhere(filter, since) });
    }

    /** Send times inside the window, oldest first — used to say when capacity returns. */
    async listOutboundSentAtSince(
        filter: EmailSendWindowFilter,
        since: Date,
        limit = 1000,
    ): Promise<Date[]> {
        const rows = await this.repository.find({
            select: { id: true, sentAt: true },
            where: this.sentWindowWhere(filter, since),
            order: { sentAt: 'ASC' },
            take: Math.max(1, Math.min(limit, 10_000)),
        });
        return rows.map((row) => row.sentAt).filter((value): value is Date => !!value);
    }

    /** Every recipient (to + cc + bcc) an Agent reached since `since`. */
    async listOutboundRecipientsSince(
        agentId: string,
        since: Date,
        limit = 500,
    ): Promise<string[]> {
        const rows = await this.repository.find({
            select: { id: true, toAddresses: true, ccAddresses: true, bccAddresses: true },
            where: this.sentWindowWhere({ agentId }, since),
            order: { sentAt: 'DESC' },
            take: Math.max(1, Math.min(limit, 5_000)),
        });
        const recipients: string[] = [];
        for (const row of rows) {
            recipients.push(
                ...(row.toAddresses ?? []),
                ...(row.ccAddresses ?? []),
                ...(row.bccAddresses ?? []),
            );
        }
        return recipients;
    }

    /**
     * Compare-and-set on `status`: move a row from one of `from` to `to`,
     * applying `patch` in the same UPDATE. Returns the number of rows that
     * moved — `0` means somebody else moved it first. Every race guard on the
     * draft lifecycle is built on this.
     */
    async transitionStatus(
        id: string,
        from: readonly EmailMessageStatus[],
        to: EmailMessageStatus,
        patch: Partial<
            Pick<
                EmailMessage,
                | 'approvedById'
                | 'approvedAt'
                | 'failureReason'
                | 'approvalId'
                | 'providerMessageId'
                | 'sentAt'
                | 'deliveryStatus'
                | 'pluginId'
            >
        > = {},
    ): Promise<number> {
        const result = await this.repository.update(
            { id, status: In([...from]) },
            { ...patch, status: to },
        );
        return result.affected ?? 0;
    }

    private sentWindowWhere(
        filter: EmailSendWindowFilter,
        since: Date,
    ): FindOptionsWhere<EmailMessage> {
        if (!filter.agentId && !filter.userId) {
            // Never count across every account: a window with no owner is a bug.
            throw new Error('EmailMessageRepository: a send window needs an agentId or a userId.');
        }
        const where: FindOptionsWhere<EmailMessage> = {
            direction: 'outbound',
            sentAt: MoreThanOrEqual(since),
        };
        if (filter.agentId) where.agentId = filter.agentId;
        if (filter.userId) where.userId = filter.userId;
        return where;
    }
}
