import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * AI provider types
 */
export type AiProviderType =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'groq'
	| 'openrouter'
	| 'ollama'
	| 'mistral'
	| 'cohere'
	| 'custom';

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
	/** JSON Schema for structured output */
	readonly jsonSchema?: Record<string, unknown>;
	/** Seed for reproducibility */
	readonly seed?: number;
	/** User identifier for tracking */
	readonly user?: string;
	/**
	 * Resolved settings for this operation.
	 * Passed by the facade with user/directory-scoped settings.
	 * Plugins should use these settings instead of their stored defaults.
	 */
	readonly settings?: PluginSettings;
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
	 * Create a streaming chat completion
	 */
	createStreamingChatCompletion?(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk>;

	/**
	 * Create embeddings
	 */
	createEmbedding?(options: EmbeddingOptions): Promise<EmbeddingResponse>;

	/**
	 * List available models
	 */
	listModels(): Promise<readonly AiModel[]>;

	/**
	 * Get a specific model
	 */
	getModel(modelId: string): Promise<AiModel | null>;

	/**
	 * Check if the provider is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Validate API key
	 */
	validateApiKey?(): Promise<boolean>;

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
