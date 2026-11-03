import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../../entities/conversation.entity';
import {
    ConversationMessage,
    ConversationMessageRole,
} from '../../entities/conversation-message.entity';

export interface CreateConversationInput {
    userId: string;
    title?: string;
    providerId?: string;
    model?: string;
}

export interface AppendMessageInput {
    conversationId: string;
    role: ConversationMessageRole;
    content: string;
    parts?: unknown[];
    model?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

@Injectable()
export class ConversationRepository {
    constructor(
        @InjectRepository(Conversation)
        private readonly conversationRepo: Repository<Conversation>,
        @InjectRepository(ConversationMessage)
        private readonly messageRepo: Repository<ConversationMessage>,
    ) {}

    async create(input: CreateConversationInput): Promise<Conversation> {
        const conversation = this.conversationRepo.create(input);
        return this.conversationRepo.save(conversation);
    }

    async findById(id: string, userId?: string): Promise<Conversation | null> {
        return this.conversationRepo.findOne({
            where: { id, ...(userId && { userId }) },
            relations: ['messages'],
            order: { messages: { createdAt: 'ASC' } },
        });
    }

    async findByUser(
        userId: string,
        options?: { limit?: number; offset?: number },
    ): Promise<{ conversations: Conversation[]; total: number }> {
        const [conversations, total] = await this.conversationRepo.findAndCount({
            where: { userId },
            order: { updatedAt: 'DESC' },
            take: options?.limit ?? 50,
            skip: options?.offset ?? 0,
            select: ['id', 'title', 'providerId', 'model', 'createdAt', 'updatedAt'],
        });

        return { conversations, total };
    }

    async appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
        const message = this.messageRepo.create(input);
        const saved = await this.messageRepo.save(message);

        // Touch the conversation's updatedAt
        await this.conversationRepo.update(input.conversationId, { updatedAt: new Date() });

        return saved;
    }

    async appendMessages(messages: AppendMessageInput[]): Promise<ConversationMessage[]> {
        if (messages.length === 0) return [];

        // Save messages sequentially with explicit timestamps to guarantee ordering.
        // Batch save can assign the same createdAt to all rows, breaking ORDER BY on reload.
        const saved: ConversationMessage[] = [];
        const baseTime = Date.now();
        for (let i = 0; i < messages.length; i++) {
            const entity = this.messageRepo.create({
                ...messages[i],
                createdAt: new Date(baseTime + i),
            });
            saved.push(await this.messageRepo.save(entity));
        }

        const conversationId = messages[0].conversationId;
        await this.conversationRepo.update(conversationId, { updatedAt: new Date() });

        return saved;
    }

    async updateTitle(
        id: string,
        userId: string,
        title: string,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        await this.conversationRepo.update(
            { id, userId },
            { title, ...(metadata && { metadata }) },
        );
    }

    /**
     * Update the model a conversation is currently pinned to.
     *
     * Deliberately NARROWER than a general-purpose update: `providerId` is
     * NOT settable here. A conversation records the provider it was STARTED
     * with and that record is immutable (the PATCH DTO refuses the field
     * outright — see `UpdateConversationDto`), because the provider is the
     * thread's identity: switching it mid-thread would rewrite history for
     * messages an entirely different vendor produced.
     *
     * The MODEL is not identity — it is a dial the user turns inside one
     * thread ("same provider, think harder"), and the per-message `model`
     * column keeps the audit trail of what actually served each turn. So
     * this column tracks the CURRENT pin, and exists so re-opening a
     * conversation restores the model the user last chose for it instead of
     * silently falling back to whatever the browser last used.
     *
     * `null` clears the pin, which means "resolve the provider's configured
     * default" — not "no model".
     */
    async updateModel(id: string, userId: string, model: string | null): Promise<void> {
        // `null` (not `undefined`) is what makes TypeORM emit `SET model = NULL`;
        // `undefined` is treated as "leave this column alone", which would make
        // clearing the pin silently no-op.
        await this.conversationRepo.update({ id, userId }, { model });
    }

    async delete(id: string, userId: string): Promise<boolean> {
        const result = await this.conversationRepo.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    async deleteAllByUser(userId: string): Promise<number> {
        const result = await this.conversationRepo.delete({ userId });
        return result.affected ?? 0;
    }
}
