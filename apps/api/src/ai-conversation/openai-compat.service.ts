import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService, type FacadeOptions } from '@ever-works/agent/facades';
import { DirectoryRepository, ConversationRepository } from '@ever-works/agent/database';
import type {
    ChatMessage,
    ChatCompletionOptions,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ToolDefinition,
} from '@ever-works/plugin';
import type { Response } from 'express';
import type {
    OpenAiChatCompletionRequestDto,
    OpenAiMessageDto,
    OpenAiChatCompletionResponse,
    OpenAiChatCompletionChunkResponse,
} from './dto/openai-compat.dto';

@Injectable()
export class OpenAiCompatService {
    private readonly logger = new Logger(OpenAiCompatService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly conversationRepo: ConversationRepository,
    ) {}

    /**
     * Handle a non-streaming chat completion request.
     */
    async handleCompletion(
        dto: OpenAiChatCompletionRequestDto,
        facadeOptions: FacadeOptions,
    ): Promise<OpenAiChatCompletionResponse> {
        const resolved = await this.resolveDirectoryContext(facadeOptions);
        const options = this.mapToInternalOptions(dto);

        const response = await this.aiFacade.createChatCompletion(options, resolved);

        return this.mapToOpenAiResponse(response);
    }

    /**
     * Handle a streaming chat completion request.
     * Creates/reuses a conversation, streams SSE, then persists messages.
     */
    async handleStreamingCompletion(
        dto: OpenAiChatCompletionRequestDto,
        facadeOptions: FacadeOptions,
        res: Response,
        persistence?: { userId: string; conversationId?: string; providerId?: string },
    ): Promise<void> {
        const resolved = await this.resolveDirectoryContext(facadeOptions);
        const options = this.mapToInternalOptions(dto);

        // Ensure a conversation exists before streaming
        let conversationId = persistence?.conversationId;
        let isNewConversation = false;

        if (persistence?.userId && !conversationId) {
            const conversation = await this.conversationRepo.create({
                userId: persistence.userId,
                providerId: persistence.providerId,
                model: dto.model,
            });
            conversationId = conversation.id;
            isNewConversation = true;
        }

        // Send conversation ID to the frontend
        if (conversationId) {
            res.setHeader('X-Conversation-Id', conversationId);
        }

        let assistantContent = '';

        try {
            const stream = this.aiFacade.createStreamingChatCompletion(
                { ...options, stream: true },
                resolved,
            );

            let toolCallIndex = 0;

            for await (const chunk of stream) {
                const sseChunk = this.mapToOpenAiStreamChunk(chunk, toolCallIndex);
                res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);

                const delta = chunk.choices[0]?.delta;
                if (delta?.content && typeof delta.content === 'string') {
                    assistantContent += delta.content;
                }
                if (delta?.toolCalls?.length) {
                    toolCallIndex += delta.toolCalls.length;
                }
            }

            res.write('data: [DONE]\n\n');
        } catch (error) {
            this.logger.error('Streaming completion error', error);

            const errorChunk: OpenAiChatCompletionChunkResponse = {
                id: `chatcmpl-err-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: dto.model ?? 'default',
                choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.write(`data: [DONE]\n\n`);
        } finally {
            res.end();
        }

        // Persist messages in background
        if (conversationId && persistence?.userId && assistantContent) {
            this.persistMessages(
                dto,
                conversationId,
                persistence.userId,
                assistantContent,
                isNewConversation,
            ).catch((err) => this.logger.error('Failed to persist messages', err));
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Conversation persistence
    // ────────────────────────────────────────────────────────────────

    private async persistMessages(
        dto: OpenAiChatCompletionRequestDto,
        conversationId: string,
        userId: string,
        assistantContent: string,
        isNewConversation: boolean,
    ): Promise<void> {
        const lastUserMsg = [...dto.messages].reverse().find((m) => m.role === 'user');

        const messagesToPersist = [];

        if (lastUserMsg) {
            messagesToPersist.push({
                conversationId,
                role: 'user' as const,
                content: lastUserMsg.content ?? '',
            });
        }

        messagesToPersist.push({
            conversationId,
            role: 'assistant' as const,
            content: assistantContent,
            model: dto.model ?? undefined,
        });

        await this.conversationRepo.appendMessages(messagesToPersist);

        if (isNewConversation && lastUserMsg?.content) {
            const title = this.generateTitle(lastUserMsg.content);
            await this.conversationRepo.updateTitle(conversationId, userId, title);
        }
    }

    private generateTitle(userMessage: string): string {
        const maxLen = 60;
        if (userMessage.length <= maxLen) return userMessage;
        const truncated = userMessage.substring(0, maxLen);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 20 ? truncated.substring(0, lastSpace) : truncated) + '...';
    }

    // ────────────────────────────────────────────────────────────────
    // Mapping: OpenAI wire format → internal types
    // ────────────────────────────────────────────────────────────────

    private mapToInternalOptions(dto: OpenAiChatCompletionRequestDto): ChatCompletionOptions {
        const messages = this.mapToInternalMessages(dto.messages);

        const tools: ToolDefinition[] | undefined = dto.tools?.map((t) => ({
            type: 'function' as const,
            function: {
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
            },
        }));

        // "auto" means let AiFacadeService resolve the model from plugin settings
        const model = dto.model === 'auto' ? undefined : dto.model;

        return {
            model,
            messages,
            temperature: dto.temperature,
            maxTokens: dto.max_tokens,
            topP: dto.top_p,
            frequencyPenalty: dto.frequency_penalty,
            presencePenalty: dto.presence_penalty,
            stop: dto.stop,
            stream: dto.stream,
            tools,
            toolChoice: dto.tool_choice,
            responseFormat: dto.response_format,
            user: dto.user,
        };
    }

    private mapToInternalMessages(messages: OpenAiMessageDto[]): ChatMessage[] {
        return messages.map((msg): ChatMessage => {
            const content = msg.content ?? '';

            // Assistant message with tool calls
            if (msg.role === 'assistant' && msg.tool_calls?.length) {
                return {
                    role: 'assistant',
                    content,
                    toolCalls: msg.tool_calls.map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: {
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        },
                    })),
                };
            }

            // Tool result message
            if (msg.role === 'tool') {
                return {
                    role: 'tool',
                    content,
                    toolCallId: msg.tool_call_id,
                };
            }

            // Standard message (system, user, assistant without tools)
            return {
                role: msg.role as ChatMessage['role'],
                content,
                ...(msg.name && { name: msg.name }),
            };
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Mapping: internal types → OpenAI wire format
    // ────────────────────────────────────────────────────────────────

    private mapToOpenAiResponse(response: ChatCompletionResponse): OpenAiChatCompletionResponse {
        return {
            id: response.id,
            object: 'chat.completion',
            created: Math.floor(response.created / 1000),
            model: response.model,
            choices: response.choices.map((choice) => {
                const message = choice.message;
                const content = typeof message.content === 'string' ? message.content : null;

                return {
                    index: choice.index,
                    message: {
                        role: 'assistant' as const,
                        content,
                        ...(message.toolCalls?.length && {
                            tool_calls: message.toolCalls.map((tc) => ({
                                id: tc.id,
                                type: 'function' as const,
                                function: {
                                    name: tc.function.name,
                                    arguments: tc.function.arguments,
                                },
                            })),
                        }),
                    },
                    finish_reason: choice.finishReason,
                };
            }),
            ...(response.usage && {
                usage: {
                    prompt_tokens: response.usage.promptTokens,
                    completion_tokens: response.usage.completionTokens,
                    total_tokens: response.usage.totalTokens,
                },
            }),
        };
    }

    private mapToOpenAiStreamChunk(
        chunk: ChatCompletionChunk,
        toolCallBaseIndex: number,
    ): OpenAiChatCompletionChunkResponse {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        const mappedDelta: OpenAiChatCompletionChunkResponse['choices'][0]['delta'] = {};

        if (delta?.role) {
            mappedDelta.role = 'assistant';
        }

        if (delta?.content !== undefined) {
            const content = typeof delta.content === 'string' ? delta.content : null;
            if (content) mappedDelta.content = content;
        }

        if (delta?.toolCalls?.length) {
            mappedDelta.tool_calls = delta.toolCalls.map((tc, i) => ({
                index: toolCallBaseIndex + i,
                ...(tc.id && { id: tc.id }),
                ...(tc.type && { type: tc.type }),
                function: {
                    ...(tc.function.name && { name: tc.function.name }),
                    ...(tc.function.arguments && { arguments: tc.function.arguments }),
                },
            }));
        }

        return {
            id: chunk.id,
            object: 'chat.completion.chunk',
            created: Math.floor(chunk.created / 1000),
            model: chunk.model,
            choices: [
                {
                    index: choice?.index ?? 0,
                    delta: mappedDelta,
                    finish_reason: choice?.finishReason ?? null,
                },
            ],
        };
    }

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    private async resolveDirectoryContext(options: FacadeOptions): Promise<FacadeOptions> {
        if (options.directoryId) return options;

        const directories = await this.directoryRepository.findByUser(options.userId);
        if (directories.length > 0) {
            return { ...options, directoryId: directories[0].id };
        }

        return options;
    }
}
