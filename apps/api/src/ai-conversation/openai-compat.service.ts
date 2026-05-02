import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService, type FacadeOptions } from '@ever-works/agent/facades';
import { DirectoryRepository } from '@ever-works/agent/database';
import type {
    ChatMessage,
    ChatCompletionOptions,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ToolDefinition,
} from '@ever-works/plugin';
import type {
    OpenAiChatCompletionRequestDto,
    OpenAiMessageDto,
    OpenAiChatCompletionResponse,
    OpenAiChatCompletionChunkResponse,
} from './dto/openai-compat.dto';

type StreamingResponse = {
    write(chunk: string): void;
    end(): void;
};

@Injectable()
export class OpenAiCompatService {
    private readonly logger = new Logger(OpenAiCompatService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly directoryRepository: DirectoryRepository,
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
        res: StreamingResponse,
    ): Promise<void> {
        const resolved = await this.resolveDirectoryContext(facadeOptions);
        const options = this.mapToInternalOptions(dto);

        try {
            const stream = this.aiFacade.createStreamingChatCompletion(
                { ...options, stream: true },
                resolved,
            );

            for await (const chunk of stream) {
                const sseChunk = this.mapToOpenAiStreamChunk(chunk);
                res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
            }

            res.write('data: [DONE]\n\n');
        } catch (error) {
            this.logger.error('Streaming completion error', error);

            const message = this.sanitizeErrorMessage(error);
            if (!res.headersSent) {
                res.status(502);
                res.setHeader('Content-Type', 'application/json');
                res.end(
                    JSON.stringify({
                        error: {
                            message,
                            type: 'provider_error',
                            code: 'ai_provider_error',
                        },
                    }),
                );
                return;
            }

            res.destroy(error instanceof Error ? error : new Error(message));
        } finally {
            if (!res.destroyed && !res.writableEnded) {
                res.end();
            }
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

    /**
     * Extract an actionable error message while stripping sensitive data.
     * Keeps: status codes, model names, "invalid key", "rate limit", "not found" etc.
     * Strips: URLs, API keys, tokens, stack traces.
     */
    private sanitizeErrorMessage(error: unknown): string {
        if (!(error instanceof Error)) return 'Something went wrong. Please try again.';

        let msg = error.message;

        // Strip anything that looks like a key/token (long alphanumeric strings)
        msg = msg.replace(/\b(sk-|key-|token-|Bearer\s+)[A-Za-z0-9_-]{10,}\b/gi, '[redacted]');

        // Truncate to reasonable length
        if (msg.length > 300) {
            msg = msg.substring(0, 300) + '...';
        }

        return msg;
    }
}
