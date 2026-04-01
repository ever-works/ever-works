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

        // Save messages one by one to guarantee distinct createdAt timestamps
        // and preserve insertion order. Batch save assigns the same timestamp
        // to all messages, causing incorrect ordering on reload.
        const saved: ConversationMessage[] = [];
        for (const m of messages) {
            const entity = this.messageRepo.create(m);
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

    async delete(id: string, userId: string): Promise<boolean> {
        const result = await this.conversationRepo.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    async deleteAllByUser(userId: string): Promise<number> {
        const result = await this.conversationRepo.delete({ userId });
        return result.affected ?? 0;
    }
}
