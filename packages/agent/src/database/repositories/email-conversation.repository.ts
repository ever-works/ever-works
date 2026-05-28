import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailConversation } from '../../entities/email-conversation.entity';

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Repository for `email_conversations`. Keyed by `(agentId, threadKey)`
 * — the inbound dispatcher derives `threadKey` from `In-Reply-To` or
 * normalized subject before calling `findOrCreate`.
 */
@Injectable()
export class EmailConversationRepository {
    constructor(
        @InjectRepository(EmailConversation)
        private readonly repository: Repository<EmailConversation>,
    ) {}

    create(entry: Partial<EmailConversation>): EmailConversation {
        return this.repository.create(entry);
    }

    async save(entry: EmailConversation): Promise<EmailConversation> {
        return this.repository.save(entry);
    }

    async findById(id: string): Promise<EmailConversation | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByThreadKey(
        agentId: string,
        threadKey: string,
    ): Promise<EmailConversation | null> {
        return this.repository.findOne({ where: { agentId, threadKey } });
    }

    async findByAgent(agentId: string, limit = 50): Promise<EmailConversation[]> {
        return this.repository.find({
            where: { agentId },
            order: { lastMessageAt: 'DESC', createdAt: 'DESC' },
            take: limit,
        });
    }

    async touchLastMessageAt(id: string, lastMessageAt: Date): Promise<void> {
        await this.repository.update({ id }, { lastMessageAt });
    }
}
