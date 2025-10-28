import { Injectable, Logger } from '@nestjs/common';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import {
    type BaseMessage,
    type MessageType,
    mapChatMessagesToStoredMessages,
    HumanMessage,
    AIMessage,
    SystemMessage,
    FunctionMessage,
    ToolMessage,
} from '@langchain/core/messages';
import { ChatHistoryRepository } from '../database/repositories/chat-history.repository';
import { ChatMessage, MessageRole } from '../entities/chat-message.entity';

export interface TypeORMChatMessageHistoryInput {
    sessionId: string;
    userId?: string;
    metadata?: Record<string, any>;
}

/**
 * TypeORM-based chat message history implementation
 * Compatible with LangChain's BaseListChatMessageHistory
 */
@Injectable()
export class TypeORMChatMessageHistory extends BaseListChatMessageHistory {
    lc_namespace = ['langchain', 'stores', 'message', 'typeorm'];

    private readonly logger = new Logger(TypeORMChatMessageHistory.name);
    private sessionId: string;
    private metadata?: Record<string, any>;

    constructor(
        private readonly chatHistoryRepository: ChatHistoryRepository,
        input: TypeORMChatMessageHistoryInput,
    ) {
        super();
        this.sessionId = input.sessionId;
        this.metadata = input.metadata;
    }

    /**
     * Get all messages for the session
     */
    async getMessages(): Promise<BaseMessage[]> {
        try {
            const messages = await this.chatHistoryRepository.getMessages(this.sessionId);
            return this.convertToLangChainMessages(messages);
        } catch (error) {
            this.logger.error(`Error getting messages for session ${this.sessionId}:`, error);
            return [];
        }
    }

    /**
     * Add a message to the session
     */
    async addMessage(message: BaseMessage): Promise<void> {
        try {
            const storedMessage = this.convertToStoredMessage(message);
            await this.chatHistoryRepository.addMessage(this.sessionId, storedMessage);
        } catch (error) {
            this.logger.error(`Error adding message to session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Add multiple messages to the session
     */
    async addMessages(messages: BaseMessage[]): Promise<void> {
        try {
            const storedMessages = messages.map((msg) => this.convertToStoredMessage(msg));
            await this.chatHistoryRepository.addMessages(this.sessionId, storedMessages);
        } catch (error) {
            this.logger.error(`Error adding messages to session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Clear all messages for the session
     */
    async clear(): Promise<void> {
        try {
            await this.chatHistoryRepository.clearMessages(this.sessionId);
        } catch (error) {
            this.logger.error(`Error clearing messages for session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Delete the entire session
     */
    async deleteSession(): Promise<void> {
        try {
            await this.chatHistoryRepository.deleteSession(this.sessionId);
        } catch (error) {
            this.logger.error(`Error deleting session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Convert TypeORM ChatMessage to LangChain BaseMessage
     */
    private convertToLangChainMessages(messages: ChatMessage[]): BaseMessage[] {
        return messages.map((msg) => {
            const baseProps: any = {
                content: msg.content,
                additional_kwargs: msg.additionalKwargs || {},
            };

            baseProps.additional_kwargs.timestamp = msg.createdAt.toISOString();
            baseProps.additional_kwargs.created_at = msg.createdAt.toISOString();
            baseProps.additional_kwargs.createdAt = msg.createdAt.toISOString();
            baseProps.additional_kwargs.time = msg.createdAt.toISOString();

            // Add function_call and tool_calls to additional_kwargs for AI messages
            if (msg.role === 'assistant') {
                if (msg.functionCall) {
                    baseProps.additional_kwargs.function_call = msg.functionCall;
                }
                if (msg.toolCalls) {
                    baseProps.additional_kwargs.tool_calls = msg.toolCalls;
                }
            }

            switch (msg.role) {
                case 'user':
                    return new HumanMessage(baseProps);
                case 'assistant':
                    return new AIMessage(baseProps);
                case 'system':
                    return new SystemMessage(baseProps);
                case 'function':
                    return new FunctionMessage({
                        ...baseProps,
                        name: msg.name || 'function',
                    });
                case 'tool':
                    return new ToolMessage({
                        ...baseProps,
                        tool_call_id: msg.metadata?.tool_call_id || '',
                        name: msg.name,
                    });
                default:
                    return new HumanMessage(baseProps);
            }
        });
    }

    /**
     * Convert LangChain BaseMessage to TypeORM ChatMessage
     */
    private convertToStoredMessage(message: BaseMessage): Partial<ChatMessage> {
        const storedMessages = mapChatMessagesToStoredMessages([message]);
        const stored = storedMessages[0];

        let role: MessageRole = 'user';
        let functionCall = undefined;
        let toolCalls = undefined;
        let name = undefined;

        // Use getType() method which is the non-deprecated way
        const messageType = message.getType ? message.getType() : this.inferMessageType(message);

        // Determine role and extract specific fields
        if (messageType === 'human') {
            role = 'user';
        } else if (messageType === 'ai') {
            role = 'assistant';
            const aiMessage = message as AIMessage;
            // Extract function_call and tool_calls from additional_kwargs
            const additionalKwargs = aiMessage.additional_kwargs || {};
            functionCall = additionalKwargs.function_call;
            toolCalls = additionalKwargs.tool_calls;
        } else if (messageType === 'system') {
            role = 'system';
        } else if (messageType === 'function') {
            role = 'function';
            name = (message as FunctionMessage).name;
        } else if (messageType === 'tool') {
            role = 'tool';
            const toolMessage = message as ToolMessage;
            name = toolMessage.name;
        }

        return {
            role,
            content:
                typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content),
            additionalKwargs: message.additional_kwargs,
            functionCall,
            toolCalls,
            name,
            metadata: {
                ...stored.data,
                messageType,
            },
        };
    }

    /**
     * Infer message type using instanceof checks as fallback
     */
    private inferMessageType(message: BaseMessage): MessageType {
        if (message instanceof HumanMessage) return 'human';
        if (message instanceof AIMessage) return 'ai';
        if (message instanceof SystemMessage) return 'system';
        if (message instanceof FunctionMessage) return 'function';
        if (message instanceof ToolMessage) return 'tool';
        return 'human'; // default fallback
    }

    /**
     * Prune old messages, keeping only the last N
     */
    async pruneMessages(keepLast: number): Promise<void> {
        try {
            await this.chatHistoryRepository.pruneMessages(this.sessionId, keepLast);
        } catch (error) {
            this.logger.error(`Error pruning messages for session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Get message count for the session
     */
    async getMessageCount(): Promise<number> {
        try {
            return await this.chatHistoryRepository.getMessageCount(this.sessionId);
        } catch (error) {
            this.logger.error(`Error getting message count for session ${this.sessionId}:`, error);
            return 0;
        }
    }

    /**
     * Update session metadata
     */
    async updateMetadata(metadata: Record<string, any>): Promise<void> {
        try {
            await this.chatHistoryRepository.updateSessionMetadata(this.sessionId, metadata);
            this.metadata = { ...this.metadata, ...metadata };
        } catch (error) {
            this.logger.error(`Error updating metadata for session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Set session title
     */
    async setTitle(title: string): Promise<void> {
        try {
            await this.chatHistoryRepository.setSessionTitle(this.sessionId, title);
        } catch (error) {
            this.logger.error(`Error setting title for session ${this.sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Get context (metadata) for the session
     */
    async getContext(): Promise<Record<string, any>> {
        try {
            const history = await this.chatHistoryRepository.findBySessionId(this.sessionId);
            return history?.metadata || {};
        } catch (error) {
            this.logger.error(`Error getting context for session ${this.sessionId}:`, error);
            return {};
        }
    }

    /**
     * Set context (metadata) for the session
     */
    async setContext(context: Record<string, any>): Promise<void> {
        try {
            await this.chatHistoryRepository.updateSessionMetadata(this.sessionId, context);
            this.metadata = context;
        } catch (error) {
            this.logger.error(`Error setting context for session ${this.sessionId}:`, error);
            throw error;
        }
    }
}

/**
 * Service for creating TypeORM chat history instances
 */
@Injectable()
export class TypeORMChatHistoryService {
    private readonly logger = new Logger(TypeORMChatHistoryService.name);

    constructor(private readonly chatHistoryRepository: ChatHistoryRepository) {}

    /**
     * Create a new chat history instance
     */
    createChatHistory(input: TypeORMChatMessageHistoryInput): TypeORMChatMessageHistory {
        return new TypeORMChatMessageHistory(this.chatHistoryRepository, input);
    }

    /**
     * Get or create a chat history instance
     */
    async getOrCreateChatHistory(
        sessionId: string,
        userId?: string,
        metadata?: Record<string, any>,
    ): Promise<TypeORMChatMessageHistory> {
        // Ensure session exists in database
        let history = await this.chatHistoryRepository.findBySessionId(sessionId);

        if (!history) {
            history = await this.chatHistoryRepository.createSession(sessionId, userId, metadata);
            this.logger.log(`Created new chat history session: ${sessionId}`);
        }

        return this.createChatHistory({ sessionId, userId, metadata });
    }

    /**
     * List all sessions for a user
     */
    async listUserSessions(
        userId: string,
        limit?: number,
    ): Promise<
        Array<{
            sessionId: string;
            title?: string;
            createdAt: Date;
            updatedAt: Date;
            messageCount: number;
        }>
    > {
        const histories = await this.chatHistoryRepository.findByUserId(userId, limit);

        const sessions = [];
        for (const history of histories) {
            const messageCount = await this.chatHistoryRepository.getMessageCount(
                history.sessionId,
            );

            sessions.push({
                sessionId: history.sessionId,
                title: history.title,
                createdAt: history.createdAt,
                updatedAt: history.updatedAt,
                messageCount,
            });
        }

        return sessions;
    }

    /**
     * Get recent active sessions for a user
     */
    async getRecentActiveSessions(userId: string, limit = 10) {
        return await this.chatHistoryRepository.getRecentActiveSessions(userId, limit);
    }

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<boolean> {
        return await this.chatHistoryRepository.deleteSession(sessionId);
    }

    /**
     * Clear all messages in a session
     */
    async clearSession(sessionId: string): Promise<void> {
        await this.chatHistoryRepository.clearMessages(sessionId);
    }

    /**
     * Deactivate a session
     */
    async deactivateSession(sessionId: string): Promise<void> {
        await this.chatHistoryRepository.deactivateSession(sessionId);
    }
}
