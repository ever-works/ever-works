import { z } from 'zod';
import { BasePlugin } from './base-plugin.js';
import type { ConnectionValidationResult } from '../contracts/plugin.interface.js';
import type {
	IAiProviderPlugin,
	AiProviderType,
	AiModel,
	AiModelCapabilities,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse,
	AskJsonCompletionOptions,
	AskJsonCompletionResponse
} from '../contracts/capabilities/ai-provider.interface.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';
import type { PluginSettings } from '../settings/settings.types.js';
import type { AiOperations, AiOperationsConfig } from '../ai/ai-operations.js';

export abstract class BaseAiProvider extends BasePlugin implements IAiProviderPlugin {
	readonly category: PluginCategory = 'ai-provider';
	readonly capabilities: readonly string[] = ['ai-provider'];

	abstract readonly providerType: AiProviderType;
	abstract readonly providerName: string;

	protected aiOps: AiOperations | null = null;

	abstract createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse>;

	async askJson(prompt: string, options?: AskJsonCompletionOptions): Promise<AskJsonCompletionResponse> {
		if (!this.aiOps) throw new Error('Plugin not loaded');
		const resolvedConfig = this.resolveConfig(options?.settings);
		if (options?.model) resolvedConfig.model = options.model;
		return this.aiOps.askJson(prompt, options?.schema ?? z.object({}), resolvedConfig, {
			temperature: options?.temperature,
			maxTokens: options?.maxTokens
		});
	}

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

	abstract listModels(settings?: PluginSettings): Promise<readonly AiModel[]>;

	async getModel(modelId: string, settings?: PluginSettings): Promise<AiModel | null> {
		const models = await this.listModels(settings);
		return models.find((m) => m.id === modelId) || null;
	}

	/** Uses aiOps.testConnection() when loaded; falls back to listModels(). Override for non-standard auth. */
	async isAvailable(settings?: PluginSettings): Promise<boolean> {
		if (this.aiOps) {
			const result = await this.aiOps.testConnection(this.resolveConfig(settings));
			return result.success;
		}
		try {
			await this.listModels(settings);
			return true;
		} catch {
			return false;
		}
	}

	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: false,
			supportsStreaming: false,
			supportsToolCalling: false,
			supportsVision: false,
			maxContextLength: 4096
		};
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		// Default: fall back to non-streaming
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

	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by this provider');
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const available = await this.isAvailable(settings);
		return available
			? { success: true, message: `${this.providerName} connection verified.` }
			: {
					success: false,
					message: `${this.providerName} connection failed. Check your credentials and try again.`
				};
	}

	protected abstract getDefaultModelId(): string;
}
