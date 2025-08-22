import { Injectable, Logger } from '@nestjs/common';
import { AiService } from './ai.service';
import {
    TypeORMChatHistoryService,
    TypeORMChatMessageHistory,
} from './typeorm-chat-history.service';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';

export interface ConversationOptions {
    role?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    context?: string;
    rules?: string[];
    useDefaultSystemPrompt?: boolean;
    messageLimit?: number;
    userId?: string;
    metadata?: Record<string, any>;
}

export interface ConversationResponse {
    response: string;
    success: boolean;
    error?: string;
    metadata?: {
        model?: string;
        provider?: string;
        tokensUsed?: number;
        sessionId?: string;
        messageCount?: number;
    };
}

export interface StreamChunk {
    content: string;
    done: boolean;
    metadata?: Record<string, any>;
}

@Injectable()
export class AiConversationService {
    private readonly logger = new Logger(AiConversationService.name);
    private readonly defaultSystemPrompt = `You are a helpful AI assistant. You provide accurate, thoughtful, and well-structured responses.

Core principles:
- Be concise yet comprehensive
- Provide accurate information
- Admit when you're uncertain
- Focus on being helpful and constructive
- Use clear and professional language`;

    constructor(
        private readonly aiService: AiService,
        private readonly chatHistoryService: TypeORMChatHistoryService,
    ) {}

    /**
     * Start a new conversation session
     */
    async startConversation(userId?: string, metadata?: Record<string, any>): Promise<string> {
        const sessionId = this.generateSessionId();
        await this.chatHistoryService.getOrCreateChatHistory(sessionId, userId, metadata);
        return sessionId;
    }

    /**
     * Send a message in a conversation with history
     */
    async sendMessage(
        sessionId: string,
        message: string,
        options: ConversationOptions = {},
    ): Promise<ConversationResponse> {
        try {
            if (!this.aiService.isAiConfigured()) {
                return {
                    success: false,
                    response: '',
                    error: 'AI service is not configured. Please configure an AI provider.',
                };
            }

            const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(
                sessionId,
                options.userId,
                options.metadata,
            );

            // Build messages array
            const messages = await this.buildMessages(chatHistory, message, options);

            // Get LLM instance
            const llm =
                options.temperature !== undefined
                    ? this.aiService.createLlmWithTemperature(options.temperature)
                    : this.aiService.getLlm();

            if (options.maxTokens) {
                llm.maxTokens = options.maxTokens;
            }

            // Invoke the LLM
            const response = await llm.invoke(messages);
            const responseContent =
                typeof response.content === 'string'
                    ? response.content
                    : JSON.stringify(response.content);

            // Save messages to history
            await chatHistory.addMessage(new HumanMessage(message));
            await chatHistory.addMessage(new AIMessage(responseContent));

            // Get message count
            const messageCount = await chatHistory.getMessageCount();

            return {
                success: true,
                response: responseContent,
                metadata: {
                    model: llm.model || 'unknown',
                    provider: this.aiService.getServiceConfig().defaultProvider,
                    sessionId,
                    messageCount,
                },
            };
        } catch (error) {
            this.logger.error(`Error sending message in session ${sessionId}:`, error);
            return {
                success: false,
                response: '',
                error: error.message || 'Failed to send message',
            };
        }
    }

    /**
     * Stream a message response
     */
    async *streamMessage(
        sessionId: string,
        message: string,
        options: ConversationOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
        try {
            if (!this.aiService.isAiConfigured()) {
                yield {
                    content: '',
                    done: true,
                    metadata: { error: 'AI service is not configured' },
                };
                return;
            }

            const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(
                sessionId,
                options.userId,
                options.metadata,
            );

            // Build messages array
            const messages = await this.buildMessages(chatHistory, message, options);

            // Get LLM instance with streaming enabled
            const llm =
                options.temperature !== undefined
                    ? this.aiService.createLlmWithTemperature(options.temperature)
                    : this.aiService.getLlm();

            if (options.maxTokens) {
                llm.maxTokens = options.maxTokens;
            }

            // Stream the response
            const stream = await llm.pipe(new StringOutputParser()).stream(messages);

            let fullResponse = '';
            for await (const chunk of stream) {
                fullResponse += chunk;
                yield {
                    content: chunk,
                    done: false,
                };
            }

            // Save the complete interaction to history
            await chatHistory.addMessage(new HumanMessage(message));
            await chatHistory.addMessage(new AIMessage(fullResponse));

            // Send final chunk with metadata
            const messageCount = await chatHistory.getMessageCount();
            yield {
                content: '',
                done: true,
                metadata: {
                    sessionId,
                    messageCount,
                    totalLength: fullResponse.length,
                },
            };
        } catch (error) {
            this.logger.error(`Error streaming message in session ${sessionId}:`, error);
            yield {
                content: '',
                done: true,
                metadata: { error: error.message },
            };
        }
    }

    /**
     * Build messages array with proper context and limits
     */
    private async buildMessages(
        chatHistory: TypeORMChatMessageHistory,
        currentMessage: string,
        options: ConversationOptions,
    ): Promise<BaseMessage[]> {
        const messages: BaseMessage[] = [];

        // Add system message
        const systemContent = this.buildSystemMessage(options);
        if (systemContent) {
            messages.push(new SystemMessage(systemContent));
        }

        // Get historical messages
        const historicalMessages = await chatHistory.getMessages();

        // Apply message limit if specified
        let messagesToInclude = historicalMessages;
        if (options.messageLimit && options.messageLimit > 0) {
            // Keep only the last N messages (N pairs of user/assistant messages)
            const startIndex = Math.max(0, historicalMessages.length - options.messageLimit * 2);
            messagesToInclude = historicalMessages.slice(startIndex);
        }

        // Add historical messages
        messages.push(...messagesToInclude);

        // Add current message
        messages.push(new HumanMessage(currentMessage));

        return messages;
    }

    /**
     * Build system message from options
     */
    private buildSystemMessage(options: ConversationOptions): string {
        const parts: string[] = [];

        // Use custom or default system prompt
        if (options.systemPrompt) {
            parts.push(options.systemPrompt);
        } else if (options.useDefaultSystemPrompt !== false) {
            parts.push(this.defaultSystemPrompt);
        }

        // Add role if specified
        if (options.role) {
            parts.push(`You are acting as: ${options.role}`);
        }

        // Add rules if specified
        if (options.rules && options.rules.length > 0) {
            parts.push('Please follow these rules:');
            options.rules.forEach((rule, index) => {
                parts.push(`${index + 1}. ${rule}`);
            });
        }

        // Add context if provided
        if (options.context) {
            parts.push(`Context: ${options.context}`);
        }

        return parts.join('\n\n');
    }

    /**
     * Get conversation history with message limit
     */
    async getConversationHistory(
        sessionId: string,
        userId?: string,
        limit?: number,
    ): Promise<{
        sessionId: string;
        messages: BaseMessage[];
        context: Record<string, any>;
        totalMessages: number;
    }> {
        const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(sessionId, userId);
        const allMessages = await chatHistory.getMessages();
        const context = await chatHistory.getContext();

        let messages = allMessages;
        if (limit && limit > 0) {
            messages = allMessages.slice(-limit);
        }

        return {
            sessionId,
            messages,
            context,
            totalMessages: allMessages.length,
        };
    }

    /**
     * Clear conversation history
     */
    async clearConversation(sessionId: string): Promise<void> {
        await this.chatHistoryService.clearSession(sessionId);
    }

    /**
     * Delete conversation
     */
    async deleteConversation(sessionId: string): Promise<boolean> {
        return await this.chatHistoryService.deleteSession(sessionId);
    }

    /**
     * List user conversations
     */
    async listUserConversations(
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
        return await this.chatHistoryService.listUserSessions(userId, limit);
    }

    /**
     * Set conversation title
     */
    async setConversationTitle(sessionId: string, title: string): Promise<void> {
        const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(sessionId);
        await chatHistory.setTitle(title);
    }

    /**
     * Update conversation context/metadata
     */
    async updateConversationContext(
        sessionId: string,
        context: Record<string, any>,
    ): Promise<void> {
        const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(sessionId);
        await chatHistory.setContext(context);
    }

    /**
     * Generate a unique session ID
     */
    private generateSessionId(): string {
        return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * Prune old messages from a conversation
     */
    async pruneConversationMessages(sessionId: string, keepLast: number): Promise<void> {
        const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(sessionId);
        await chatHistory.pruneMessages(keepLast);
    }

    /**
     * Get conversation statistics
     */
    async getConversationStats(sessionId: string): Promise<{
        messageCount: number;
        firstMessage?: Date;
        lastMessage?: Date;
        context: Record<string, any>;
    }> {
        const chatHistory = await this.chatHistoryService.getOrCreateChatHistory(sessionId);
        const messages = await chatHistory.getMessages();
        const context = await chatHistory.getContext();

        return {
            messageCount: messages.length,
            firstMessage: messages[0]?.additional_kwargs?.timestamp as Date,
            lastMessage: messages[messages.length - 1]?.additional_kwargs?.timestamp as Date,
            context,
        };
    }
}
