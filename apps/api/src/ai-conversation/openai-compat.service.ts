import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService, type FacadeOptions } from '@ever-works/agent/facades';
import { WorkRepository } from '@ever-works/agent/database';
import {
    KbMentionResolverService,
    formatKbContext,
    parseKbMentions,
} from '@ever-works/agent/services';
import type { KbDocumentBodyDto } from '@ever-works/contracts';
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
    end(payload?: string): void;
    headersSent: boolean;
    destroyed: boolean;
    writableEnded: boolean;
    status(code: number): void;
    setHeader(name: string, value: string): void;
    destroy(error?: Error): void;
};

/**
 * EW-641 Phase 2/c row 34d — citation marker prompt template.
 *
 * Appended to the `<kb>...</kb>` system message that row 34c injects
 * when `@kb:` mentions resolve to docs. Tells the LLM to reference
 * KB material inline using the row 17 `kb:{class}/{slug}` token
 * format — the same shape the user-side `@kb:` mention parser
 * understands — so:
 *  - row 35's hover-card UI can detect `kb:{class}/{slug}` tokens
 *    in the rendered assistant response and resolve them to docs
 *    via the same KB endpoints the workbench uses,
 *  - users see consistent citation shape on both sides of the
 *    conversation,
 *  - the format round-trips cleanly: paste a citation back at the
 *    model, the row 34a parser picks it up again as `@kb:...`.
 *
 * Exported so the spec can assert verbatim presence in the
 * injected system message without duplicating the string.
 */
export const KB_CITATION_INSTRUCTION =
    'When citing material from a KB document above, reference it inline using the format `kb:{class}/{slug}` (e.g. `kb:brand/voice`). Use the exact class and slug shown in each document heading.';

@Injectable()
export class OpenAiCompatService {
    private readonly logger = new Logger(OpenAiCompatService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly workRepository: WorkRepository,
        private readonly kbMentionResolver: KbMentionResolverService,
    ) {}

    /**
     * Handle a non-streaming chat completion request.
     */
    async handleCompletion(
        dto: OpenAiChatCompletionRequestDto,
        facadeOptions: FacadeOptions,
    ): Promise<OpenAiChatCompletionResponse> {
        const resolved = await this.resolveWorkContext(facadeOptions);
        const baseOptions = this.mapToInternalOptions(dto);
        const options = await this.injectKbContext(baseOptions, resolved);

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
        const resolved = await this.resolveWorkContext(facadeOptions);
        const baseOptions = this.mapToInternalOptions(dto);
        const options = await this.injectKbContext(baseOptions, resolved);

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

    private async resolveWorkContext(options: FacadeOptions): Promise<FacadeOptions> {
        if (options.workId) return options;

        const works = await this.workRepository.findByUser(options.userId);
        if (works.length > 0) {
            return { ...options, workId: works[0].id };
        }

        return options;
    }

    /**
     * EW-641 Phase 2/c row 34c — scan the latest user message for `@kb:`
     * mentions (row 34a `parseKbMentions`), resolve each against the
     * Knowledge Base (row 34b `KbMentionResolverService.resolveMentions`),
     * and prepend a `<kb>...</kb>` system message (row 31 `formatKbContext`)
     * carrying the resolved docs so the LLM has them in context.
     *
     * Layout choice: we **prepend** a fresh system message at index 0
     * rather than mutating an existing system message in-place. Both
     * OpenAI- and Anthropic-compatible providers tolerate multiple
     * system messages (or the gateway flattens them); inserting at
     * the head also keeps the user's own carefully-crafted system
     * prompt (if any) intact and downstream of the KB context.
     *
     * Idempotence: row 17's mention picker writes the raw `@kb:` token
     * into the user message; the LLM doesn't see anything special on
     * its end. The injected `<kb>` block is what carries the document
     * text. Citations on the response come from row 34d (system-prompt
     * instruction OR deterministic post-process).
     *
     * Degraded paths (all yield the unmodified `options`):
     *  - no `workId` resolvable (anonymous / no work scope) — can't
     *    look up docs anyway,
     *  - latest user message is missing or non-string content (v1
     *    only scans string content; content-part arrays are a v2
     *    concern),
     *  - no `@kb:` mentions parsed,
     *  - all mentions resolve to `null` documents (404 / forbidden /
     *    resolver-error — row 34b already swallowed those gracefully).
     *
     * The whole thing is wrapped in try/catch so a KB hiccup never
     * breaks the chat completion request — the conversation continues
     * exactly as it would have without the KB feature.
     */
    private async injectKbContext(
        options: ChatCompletionOptions,
        facadeOptions: FacadeOptions,
    ): Promise<ChatCompletionOptions> {
        const { workId, userId } = facadeOptions;
        if (!workId || !userId) return options;

        // v1 only scans string-content user messages. content-part
        // arrays (vision / multimodal) are a v2 concern; document
        // the limitation inline so a future contributor knows where
        // to extend.
        const latestUser = this.findLatestUserStringMessage(options.messages);
        if (!latestUser) return options;

        try {
            const mentions = parseKbMentions(latestUser);
            if (mentions.length === 0) return options;

            const resolved = await this.kbMentionResolver.resolveMentions(workId, userId, mentions);
            const docs: KbDocumentBodyDto[] = resolved
                .map((r) => r.document)
                .filter((d): d is KbDocumentBodyDto => d !== null);

            if (docs.length === 0) return options;

            const kbBlock = formatKbContext(docs);
            // EW-641 Phase 2/c row 34d — citation marker prompt.
            // Tell the LLM to cite material from the injected docs
            // using the row 17 `kb:{class}/{slug}` token format so
            // the row 35 hover-card UI can resolve + tooltip them
            // in the rendered assistant response. The marker is
            // the same shape the user-side `@kb:` mention parser
            // already understands — round-tripping cleanly between
            // user input and assistant output.
            const kbContent = `${kbBlock}\n\n${KB_CITATION_INSTRUCTION}`;
            const kbSystemMessage: ChatMessage = {
                role: 'system',
                content: kbContent,
            };

            return {
                ...options,
                messages: [kbSystemMessage, ...options.messages],
            };
        } catch (err) {
            // Any unexpected failure → log + carry on with the
            // unmodified options. The user's conversation continues;
            // the LLM just doesn't get the extra KB grounding.
            this.logger.warn(
                `KB context injection failed for work=${workId}: ${(err as Error).message}. Continuing without injected KB.`,
            );
            return options;
        }
    }

    /**
     * Find the most recent user-role message whose `content` is a
     * plain string. Walks from the end so a multi-turn conversation
     * picks up the just-sent user message, ignoring earlier turns.
     */
    private findLatestUserStringMessage(messages: ReadonlyArray<ChatMessage>): string | null {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== 'user') continue;
            if (typeof m.content === 'string') return m.content;
            // Non-string user content (content parts / multimodal) —
            // skip in v1; row 34c v2 would walk the content parts and
            // scan each `text` part. Documented limitation, not a bug.
            return null;
        }
        return null;
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
