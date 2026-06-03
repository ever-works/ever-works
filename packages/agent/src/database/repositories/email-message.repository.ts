import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailMessage, EmailMessageDirection } from '../../entities/email-message.entity';

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
}
