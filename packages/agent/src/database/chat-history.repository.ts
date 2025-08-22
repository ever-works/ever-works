import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { ChatMessage } from '../entities/chat-message.entity';

@Injectable()
export class ChatHistoryRepository {
    constructor(
        @InjectRepository(ChatHistory)
        private readonly historyRepository: Repository<ChatHistory>,

        @InjectRepository(ChatMessage)
        private readonly messageRepository: Repository<ChatMessage>,
    ) {}

    /**
     * Create a new chat history session
     */
    async createSession(
        sessionId: string,
        userId?: string,
        metadata?: Record<string, any>,
    ): Promise<ChatHistory> {
        const history = this.historyRepository.create({
            sessionId,
            userId,
            metadata,
            isActive: true,
        });

        return await this.historyRepository.save(history);
    }

    /**
     * Find chat history by session ID
     */
    async findBySessionId(sessionId: string): Promise<ChatHistory | null> {
        return await this.historyRepository.findOne({
            where: { sessionId },
            relations: ['messages'],
            order: {
                messages: {
                    orderIndex: 'ASC',
                    createdAt: 'ASC',
                },
            },
        });
    }

    /**
     * Find chat history by ID
     */
    async findById(id: string): Promise<ChatHistory | null> {
        return await this.historyRepository.findOne({
            where: { id },
            relations: ['messages'],
            order: {
                messages: {
                    orderIndex: 'ASC',
                    createdAt: 'ASC',
                },
            },
        });
    }

    /**
     * Find all chat histories for a user
     */
    async findByUserId(userId: string, limit?: number): Promise<ChatHistory[]> {
        const query = this.historyRepository
            .createQueryBuilder('history')
            .where('history.userId = :userId', { userId })
            .orderBy('history.updatedAt', 'DESC');

        if (limit) {
            query.limit(limit);
        }

        return await query.getMany();
    }

    /**
     * Get messages for a session
     */
    async getMessages(sessionId: string): Promise<ChatMessage[]> {
        const history = await this.findBySessionId(sessionId);
        return history?.messages || [];
    }

    /**
     * Add a message to the chat history
     */
    async addMessage(sessionId: string, message: Partial<ChatMessage>): Promise<ChatMessage> {
        // Find or create history
        let history = await this.findBySessionId(sessionId);

        if (!history) {
            history = await this.createSession(sessionId);
        }

        // Get the next order index
        const lastMessage = await this.messageRepository.findOne({
            where: { chatHistoryId: history.id },
            order: { orderIndex: 'DESC' },
        });

        const orderIndex = lastMessage ? lastMessage.orderIndex + 1 : 0;

        // Create and save the message
        const chatMessage = this.messageRepository.create({
            ...message,
            chatHistoryId: history.id,
            orderIndex,
        });

        const savedMessage = await this.messageRepository.save(chatMessage);

        // Update the history's updatedAt timestamp
        await this.historyRepository.update(history.id, {
            updatedAt: new Date(),
        });

        return savedMessage;
    }

    /**
     * Add multiple messages in batch
     */
    async addMessages(sessionId: string, messages: Partial<ChatMessage>[]): Promise<ChatMessage[]> {
        // Find or create history
        let history = await this.findBySessionId(sessionId);

        if (!history) {
            history = await this.createSession(sessionId);
        }

        // Get the starting order index
        const lastMessage = await this.messageRepository.findOne({
            where: { chatHistoryId: history.id },
            order: { orderIndex: 'DESC' },
        });

        let orderIndex = lastMessage ? lastMessage.orderIndex + 1 : 0;

        // Create messages with sequential order indices
        const chatMessages = messages.map((message) =>
            this.messageRepository.create({
                ...message,
                chatHistoryId: history.id,
                orderIndex: orderIndex++,
            }),
        );

        const savedMessages = await this.messageRepository.save(chatMessages);

        // Update the history's updatedAt timestamp
        await this.historyRepository.update(history.id, {
            updatedAt: new Date(),
        });

        return savedMessages;
    }

    /**
     * Clear all messages for a session
     */
    async clearMessages(sessionId: string): Promise<void> {
        const history = await this.findBySessionId(sessionId);

        if (history) {
            await this.messageRepository.delete({ chatHistoryId: history.id });

            // Update the history's updatedAt timestamp
            await this.historyRepository.update(history.id, {
                updatedAt: new Date(),
            });
        }
    }

    /**
     * Delete a chat history session and all its messages
     */
    async deleteSession(sessionId: string): Promise<boolean> {
        const history = await this.findBySessionId(sessionId);

        if (history) {
            await this.historyRepository.remove(history);
            return true;
        }

        return false;
    }

    /**
     * Update session metadata
     */
    async updateSessionMetadata(
        sessionId: string,
        metadata: Record<string, any>,
    ): Promise<ChatHistory | null> {
        const history = await this.findBySessionId(sessionId);

        if (history) {
            history.metadata = { ...history.metadata, ...metadata };
            return await this.historyRepository.save(history);
        }

        return null;
    }

    /**
     * Set session title
     */
    async setSessionTitle(sessionId: string, title: string): Promise<void> {
        const history = await this.findBySessionId(sessionId);

        if (history) {
            await this.historyRepository.update(history.id, { title });
        }
    }

    /**
     * Mark session as inactive
     */
    async deactivateSession(sessionId: string): Promise<void> {
        const history = await this.findBySessionId(sessionId);

        if (history) {
            await this.historyRepository.update(history.id, { isActive: false });
        }
    }

    /**
     * Get recent active sessions for a user
     */
    async getRecentActiveSessions(userId: string, limit = 10): Promise<ChatHistory[]> {
        return await this.historyRepository.find({
            where: { userId, isActive: true },
            order: { updatedAt: 'DESC' },
            take: limit,
        });
    }

    /**
     * Prune old messages (keep only the last N messages)
     */
    async pruneMessages(sessionId: string, keepLast: number): Promise<void> {
        const history = await this.findBySessionId(sessionId);

        if (!history) return;

        const messages = await this.messageRepository.find({
            where: { chatHistoryId: history.id },
            order: { orderIndex: 'DESC' },
        });

        if (messages.length > keepLast) {
            const messagesToDelete = messages.slice(keepLast);
            await this.messageRepository.remove(messagesToDelete);
        }
    }

    /**
     * Get message count for a session
     */
    async getMessageCount(sessionId: string): Promise<number> {
        const history = await this.findBySessionId(sessionId);

        if (!history) return 0;

        return await this.messageRepository.count({
            where: { chatHistoryId: history.id },
        });
    }
}
