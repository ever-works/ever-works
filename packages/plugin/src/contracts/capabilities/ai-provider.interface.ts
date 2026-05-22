import type { ZodType } from 'zod';
import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * AI provider type identifier.
 * Any string is valid — new providers can be added as plugins
 * without modifying this type.
 */
export type AiProviderType = string;

/**
 * AI model capabilities
 */
export interface AiModelCapabilities {
	/** Supports structured JSON output */
	readonly supportsStructuredOutput: boolean;
	/** Supports streaming responses */
	readonly supportsStreaming: boolean;
	/** Supports function/tool calling */
	readonly supportsToolCalling: boolean;
	/** Supports vision/image input */
	readonly supportsVision: boolean;
	/** Maximum context window length in tokens */
	readonly maxContextLength: number;
	/** Maximum output tokens */
	readonly maxOutputTokens?: number;
}

/**
 * AI model information
 */
export interface AiModel {
	/** Model identifier */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Model description */
	readonly description?: string;
	/** Model capabilities */
	readonly capabilities: AiModelCapabilities;
	/** Cost per 1K input tokens */
	readonly inputCostPer1k?: number;
	/** Cost per 1K output tokens */
	readonly outputCostPer1k?: number;
	/** Whether model is deprecated */
	readonly deprecated?: boolean;
}

/**
 * Chat message role
 */
export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'function' | 'tool';

/**
 * Chat message content part
 */
export type ChatMessageContent =
	| string
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/**
 * Chat message
 */
export interface ChatMessage {
	readonly role: ChatMessageRole;
	readonly content: string | readonly ChatMessageContent[];
	readonly name?: string;
	readonly functionCall?: FunctionCall;
	readonly toolCalls?: readonly ToolCall[];
	/** Tool call ID — required for messages with role 'tool' to reference the originating tool call */
	readonly toolCallId?: string;
}

/**
 * Function call
 */
export interface FunctionCall {
	readonly name: string;
	readonly arguments: string;
}

/**
 * Tool call
 */
export interface ToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: FunctionCall;
}

/**
 * Tool definition
 */
export interface ToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description?: string;
		readonly parameters?: Record<string, unknown>;
	};
}

/**
 * Chat completion options
 */
export interface ChatCompletionOptions {
	/** Model to use */
	readonly model?: string;
	/** Messages */
	readonly messages: readonly ChatMessage[];
	/** Temperature (0-2) */
	readonly temperature?: number;
	/** Maximum tokens to generate */
	readonly maxTokens?: number;
	/** Top P sampling */
	readonly topP?: number;
	/** Frequency penalty */
	readonly frequencyPenalty?: number;
	/** Presence penalty */
	readonly presencePenalty?: number;
	/** Stop sequences */
	readonly stop?: readonly string[];
	/** Enable streaming */
	readonly stream?: boolean;
	/** Tools available */
	readonly tools?: readonly ToolDefinition[];
	/** Tool choice */
	readonly toolChoice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
	/** Response format */
	readonly responseFormat?: { type: 'text' | 'json_object' };
	/** Seed for reproducibility */
	readonly seed?: number;
	/** User identifier for tracking */
	readonly user?: string;
	/**
	 * Resolved settings for this operation.
	 * Passed by the facade with user/work-scoped settings.
	 * Plugins should use these settings instead of their stored defaults.
	 */
	readonly settings?: PluginSettings;
}

/**
 * Options for structured JSON output
 */
export interface AskJsonCompletionOptions {
	readonly model?: string;
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** Zod schema for structured output — passed directly to LangChain */
	readonly schema?: ZodType;
	readonly settings?: PluginSettings;
}

/**
 * Response from structured JSON output
 */
export interface AskJsonCompletionResponse {
	readonly result: unknown;
	readonly model: string;
	readonly usage?: TokenUsage;
}

/**
 * Chat completion response
 */
export interface ChatCompletionResponse {
	/** Response ID */
	readonly id: string;
	/** Model used */
	readonly model: string;
	/** Completion choices */
	readonly choices: readonly ChatCompletionChoice[];
	/** Token usage */
	readonly usage?: TokenUsage;
	/** Response timestamp */
	readonly created: number;
}

/**
 * Chat completion choice
 */
export interface ChatCompletionChoice {
	/** Choice index */
	readonly index: number;
	/** Response message */
	readonly message: ChatMessage;
	/** Finish reason */
	readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * Token usage information
 */
export interface TokenUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
}

/**
 * Streaming chunk
 */
export interface ChatCompletionChunk {
	readonly id: string;
	readonly model: string;
	readonly choices: readonly ChatCompletionChunkChoice[];
	readonly created: number;
}

/**
 * Streaming chunk choice
 */
export interface ChatCompletionChunkChoice {
	readonly index: number;
	readonly delta: Partial<ChatMessage>;
	readonly finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * Embedding options
 */
export interface EmbeddingOptions {
	/** Model to use */
	readonly model?: string;
	/** Text(s) to embed */
	readonly input: string | readonly string[];
	/** Embedding dimensions (if model supports) */
	readonly dimensions?: number;
}

/**
 * Embedding response
 */
export interface EmbeddingResponse {
	/** Model used */
	readonly model: string;
	/** Embeddings */
	readonly embeddings: readonly number[][];
	/** Token usage */
	readonly usage?: TokenUsage;
}

/**
 * AI provider plugin interface
 * Capability: 'ai-provider'
 */
export interface IAiProviderPlugin extends IPlugin {
	/** Provider type */
	readonly providerType: AiProviderType;
	/** Provider display name */
	readonly providerName: string;

	/**
	 * Create a chat completion
	 */
	createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse>;

	/**
	 * Structured JSON output — prompt in, parsed object out.
	 * Optional: plugins that don't implement this fall back to createChatCompletion.
	 */
	askJson?(prompt: string, options?: AskJsonCompletionOptions): Promise<AskJsonCompletionResponse>;

	/**
	 * Create a streaming chat completion.
	 * All AI providers must support streaming — use non-streaming fallback in BaseAiProvider if needed.
	 */
	createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk>;

	/**
	 * Create embeddings for one or more text inputs.
	 *
	 * Powers EW-641 Phase 2 (KB semantic retrieval) — the agent
	 * `KnowledgeBaseChunker` task fans chunk text out to whichever
	 * provider plugin the operator has configured for the `embedding`
	 * capability, then writes the returned vectors into
	 * `work_knowledge_chunk.embedding` (pgvector column) for RRF blend
	 * with lexical search at query time.
	 *
	 * **Optional capability.** Plugin authors implement this only when
	 * the upstream provider exposes a dedicated embeddings endpoint
	 * (OpenAI `text-embedding-3-small`, Cohere `embed-v3`, etc.).
	 * Providers that don't have one (e.g. Anthropic on the
	 * 2026-05-21 launch surface) leave it `undefined` and KB falls
	 * back to lexical-only retrieval — no semantic blend, but the
	 * search still returns results from the Postgres FTS index.
	 *
	 * **Fallback selection order** (resolved by
	 * `AiFacadeService.embed(input, opts)`):
	 *   1. The operator-pinned embedding provider, if configured
	 *      (`pluginSettings.embeddingProviderId`).
	 *   2. The first AI-provider plugin in the registry whose
	 *      `createEmbedding` is defined AND whose `isAvailable()`
	 *      resolves true.
	 *   3. If none qualifies, the facade throws
	 *      `EmbeddingNotConfiguredError`. KB retrieval catches that
	 *      and degrades to lexical-only — see
	 *      `KnowledgeBaseService.search` for the consumer-side gate.
	 *
	 * **Batch semantics.** Implementations MUST accept `input` as
	 * either a single string or an array — the response's
	 * `embeddings` array preserves input order with the same length
	 * (`embeddings[i]` is the vector for `input[i]`). Splitting +
	 * rejoining batches across multiple provider calls is the
	 * plugin's responsibility (not all providers accept the same
	 * batch size; OpenAI caps at 2048).
	 *
	 * **Dimension hint.** `options.dimensions`, when provided, asks
	 * the provider to return shorter vectors (OpenAI `dimensions`
	 * field). Plugins that can't honor the request SHOULD ignore it
	 * and return the model's native dimensionality — the consumer
	 * detects the mismatch and adapts the pgvector column rather
	 * than reject the response.
	 */
	createEmbedding?(options: EmbeddingOptions): Promise<EmbeddingResponse>;

	/**
	 * List available models
	 */
	listModels(settings?: PluginSettings): Promise<readonly AiModel[]>;

	/**
	 * Get a specific model
	 */
	getModel(modelId: string, settings?: PluginSettings): Promise<AiModel | null>;

	/**
	 * Check if the provider is available
	 */
	isAvailable(settings?: PluginSettings): Promise<boolean>;

	/**
	 * Get provider capabilities
	 */
	getCapabilities(): AiModelCapabilities;
}

/**
 * Type guard for AI provider plugins
 */
export function isAiProviderPlugin(plugin: IPlugin): plugin is IAiProviderPlugin {
	return plugin.capabilities.includes('ai-provider');
}
