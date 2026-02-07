import { BasePlugin } from './base-plugin.js';
import type {
	IAiProviderPlugin,
	AiProviderType,
	AiModel,
	AiModelCapabilities,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse
} from '../contracts/capabilities/ai-provider.interface.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';
import type { PluginSettings } from '../settings/settings.types.js';
import type { AiOperationsConfig } from '../ai/ai-operations.js';

/**
 * Abstract base class for AI provider plugins
 * Provides common functionality and sensible defaults
 */
export abstract class BaseAiProvider extends BasePlugin implements IAiProviderPlugin {
	readonly category: PluginCategory = 'ai-provider';
	readonly capabilities: readonly string[] = ['ai-provider'];

	/** Provider type - must be implemented */
	abstract readonly providerType: AiProviderType;

	/** Provider display name - must be implemented */
	abstract readonly providerName: string;

	/**
	 * Create a chat completion
	 * Must be implemented by subclasses
	 */
	abstract createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse>;

	/**
	 * Resolve plugin settings into AiOperations config overrides.
	 * Standard plugins (openai, anthropic, google, groq, ollama) use this directly.
	 * OpenRouter overrides it to handle provider-specific mapping.
	 */
	protected resolveConfig(settings?: PluginSettings): Partial<AiOperationsConfig> {
		const s = settings ?? {};
		const config: Partial<AiOperationsConfig> = {};
		if (s.apiKey) config.apiKey = s.apiKey as string;
		if (s.defaultModel) config.model = s.defaultModel as string;
		if (s.baseUrl) config.baseURL = s.baseUrl as string;
		if (s.temperature !== undefined) config.temperature = s.temperature as number;
		if (s.maxTokens !== undefined) config.maxTokens = s.maxTokens as number;
		return config;
	}

	/**
	 * List available models
	 * Must be implemented by subclasses
	 */
	abstract listModels(settings?: PluginSettings): Promise<readonly AiModel[]>;

	/**
	 * Get a specific model
	 * Default implementation uses listModels
	 */
	async getModel(modelId: string, settings?: PluginSettings): Promise<AiModel | null> {
		const models = await this.listModels(settings);
		return models.find((m) => m.id === modelId) || null;
	}

	/**
	 * Check if the provider is available
	 * Default implementation tries to list models
	 */
	async isAvailable(settings?: PluginSettings): Promise<boolean> {
		try {
			await this.listModels(settings);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get provider capabilities
	 * Default implementation returns conservative defaults
	 */
	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: false,
			supportsStreaming: false,
			supportsToolCalling: false,
			supportsVision: false,
			maxContextLength: 4096
		};
	}

	/**
	 * Create a streaming chat completion
	 * Optional - subclasses can override if streaming is supported
	 */
	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		// Default: fall back to non-streaming and yield single result
		const response = await this.createChatCompletion(options);
		yield {
			id: response.id,
			model: response.model,
			created: response.created,
			choices: response.choices.map((choice) => ({
				index: choice.index,
				delta: choice.message,
				finishReason: choice.finishReason
			}))
		};
	}

	/**
	 * Create embeddings
	 * Optional - subclasses can override if embeddings are supported
	 */
	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by this provider');
	}

	/**
	 * Validate API key
	 * Optional - subclasses can override
	 */
	async validateApiKey(settings?: PluginSettings): Promise<boolean> {
		return this.isAvailable(settings);
	}

	// Helper methods

	/**
	 * Get default model ID for this provider
	 */
	protected abstract getDefaultModelId(): string;

	/**
	 * Get model ID from options or use default
	 */
	protected getModelId(options: ChatCompletionOptions): string {
		return options.model || this.getDefaultModelId();
	}

	/**
	 * Create a unique response ID
	 */
	protected createResponseId(): string {
		return `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	}

	/**
	 * Count approximate tokens in text (rough estimate)
	 * Override for more accurate counting
	 */
	protected countTokens(text: string): number {
		// Rough estimate: ~4 characters per token
		return Math.ceil(text.length / 4);
	}

	/**
	 * Format messages for logging (redact sensitive content)
	 */
	protected formatMessagesForLog(options: ChatCompletionOptions): string {
		return `${options.messages.length} messages, model: ${options.model || 'default'}`;
	}
}
