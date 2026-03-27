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

        let assistantContent = '';
        const assistantToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let hasResponse = false;

        try {
            const stream = this.aiFacade.createStreamingChatCompletion(
                { ...options, stream: true },
                resolved,
            );

            for await (const chunk of stream) {
                const sseChunk = this.mapToOpenAiStreamChunk(chunk);
                res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);

                const delta = chunk.choices[0]?.delta;
                if (delta?.content && typeof delta.content === 'string') {
                    assistantContent += delta.content;
                    hasResponse = true;
                }
                if (delta?.toolCalls?.length) {
                    for (const tc of delta.toolCalls) {
                        const existing = assistantToolCalls.find((t) => tc.id && t.id === tc.id);
                        if (existing) {
                            existing.arguments += tc.function.arguments ?? '';
                        } else if (tc.id) {
                            assistantToolCalls.push({
                                id: tc.id,
                                name: tc.function.name ?? '',
                                arguments: tc.function.arguments ?? '',
                            });
                        }
                    }
                    hasResponse = true;
                }
            }

            res.write('data: [DONE]\n\n');
        } catch (error) {
            this.logger.error('Streaming completion error', error);

            const errorChunk: OpenAiChatCompletionChunkResponse = {
                id: `chatcmpl-err-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: dto.model ?? 'auto',
                choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.write(`data: [DONE]\n\n`);
        } finally {
            res.end();
        }

        // Persist messages to the conversation (frontend creates it upfront)
        const conversationId = persistence?.conversationId;
        const userId = persistence?.userId;
        if (conversationId && userId && hasResponse) {
            this.persistMessages(
                dto,
                conversationId,
                userId,
                assistantContent,
                assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                facadeOptions,
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
        assistantToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<void> {
        const conversation = await this.conversationRepo.findById(conversationId, userId);
        if (!conversation) return;

        const existingCount = conversation.messages?.length ?? 0;
        const resolvedModel = dto.model === 'auto' ? undefined : (dto.model ?? undefined);

        // Persist all messages from the request that aren't already stored.
        // The SDK sends the full history each call. Skip the first N that match existing DB records.
        const newMessages = dto.messages.slice(existingCount);
        const messagesToPersist = newMessages.map((msg) => ({
            conversationId,
            role: (msg.role === 'tool' ? 'tool' : msg.role) as
                | 'user'
                | 'assistant'
                | 'system'
                | 'tool',
            content: msg.content ?? '',
            toolCalls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
            })),
            toolCallId: msg.tool_call_id,
        }));

        // Persist intermediate messages (user, tool calls, tool results)
        if (messagesToPersist.length > 0) {
            await this.conversationRepo.appendMessages(messagesToPersist);
        }

        // Persist the final assistant response from this streaming round
        await this.conversationRepo.appendMessage({
            conversationId,
            role: 'assistant',
            content: assistantContent,
            toolCalls: assistantToolCalls,
            model: resolvedModel,
        });

        // Title management
        const firstUserMsg = dto.messages.find((m) => m.role === 'user');
        if (!conversation.title && firstUserMsg?.content) {
            const title = this.truncateTitle(firstUserMsg.content);
            await this.conversationRepo.updateTitle(conversationId, userId, title);
        }

        const totalMessages = existingCount + messagesToPersist.length;
        if (totalMessages >= 4 && !conversation.metadata?.aiTitle) {
            this.generateAiTitle(
                conversationId,
                userId,
                dto.messages,
                assistantContent,
                facadeOptions,
            ).catch(() => {});
        }
    }

    private truncateTitle(text: string): string {
        const maxLen = 60;
        if (text.length <= maxLen) return text;
        const truncated = text.substring(0, maxLen);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 20 ? truncated.substring(0, lastSpace) : truncated) + '...';
    }

    private async generateAiTitle(
        conversationId: string,
        userId: string,
        messages: OpenAiChatCompletionRequestDto['messages'],
        lastAssistant: string,
        facadeOptions: FacadeOptions,
    ): Promise<void> {
        try {
            const resolved = await this.resolveDirectoryContext(facadeOptions);

            // Build a summary of the conversation for the AI
            const summary = messages
                .filter((m) => m.role === 'user' || m.role === 'assistant')
                .slice(-4)
                .map((m) => `${m.role}: ${(m.content ?? '').substring(0, 200)}`)
                .join('\n');

            const prompt = `${summary}\nassistant: ${lastAssistant.substring(0, 200)}`;

            const response = await this.aiFacade.createChatCompletion(
                {
                    messages: [
                        {
                            role: 'system',
                            content:
                                'Generate a short title (max 50 chars) for this conversation. Return ONLY the title, no quotes, no explanation.',
                        },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.3,
                    maxTokens: 30,
                },
                resolved,
            );

            const title = response.choices[0]?.message?.content;
            if (title && typeof title === 'string' && title.trim().length > 0) {
                await this.conversationRepo.updateTitle(
                    conversationId,
                    userId,
                    title.trim().substring(0, 100),
                    { aiTitle: true },
                );
            }
        } catch (err) {
            this.logger.debug('AI title generation failed, keeping existing title', err);
        }
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

    private mapToOpenAiStreamChunk(chunk: ChatCompletionChunk): OpenAiChatCompletionChunkResponse {
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
            // Pass through tool call chunks preserving the index/id/type structure from AiOperations.
            // The @ai-sdk/openai-compatible parser uses `id == null` to detect continuation chunks
            // vs new tool calls, so we must NOT add id/type/name to continuation chunks.
            mappedDelta.tool_calls = delta.toolCalls.map((tc) => {
                const chunk = tc as {
                    index?: number;
                    id?: string;
                    type?: string;
                    function: { name?: string; arguments?: string };
                };

                const entry: {
                    index: number;
                    id?: string;
                    type?: 'function';
                    function: { name?: string; arguments: string };
                } = {
                    index: chunk.index ?? 0,
                    function: { arguments: chunk.function.arguments ?? '' },
                };

                // Only include id/type/name on the first chunk of a tool call
                if (chunk.id) {
                    entry.id = chunk.id;
                    entry.type = 'function';
                    entry.function.name = chunk.function.name ?? '';
                }

                return entry;
            });
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
