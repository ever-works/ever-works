import { z } from 'zod';
import { BasePlugin } from './base-plugin.js';
import type { ConnectionValidationResult, ModelValidationResult } from '../contracts/plugin.interface.js';
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
		// EW-641 Phase 2/a row 27 — propagate the embedding-model setting so
		// `aiOps.createEmbedding(options, resolvedConfig)` picks it up when
		// `options.model` is unset. Without this, OpenAI-style configs that
		// only declare `embeddingModel` in plugin settings (not in the
		// per-call options) would throw "Embedding model must be specified"
		// inside `AiOperations.createEmbedding`.
		if (s.embeddingModel) config.embeddingModel = s.embeddingModel as string;
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
		if (!this.aiOps) {
			const available = await this.isAvailable(settings);
			return available
				? { success: true, message: `${this.providerName} connection verified.` }
				: {
						success: false,
						message: `${this.providerName} connection failed. Check your credentials and try again.`
					};
		}

		const resolvedConfig = this.resolveConfig(settings);
		const defaultModel = (settings.defaultModel as string) || this.getDefaultModelId();

		const tiers: Array<{ tier: ModelValidationResult['tier']; model: string }> = [
			{ tier: 'default', model: defaultModel }
		];
		if (settings.simpleModel) tiers.push({ tier: 'simple', model: settings.simpleModel as string });
		if (settings.mediumModel) tiers.push({ tier: 'medium', model: settings.mediumModel as string });
		if (settings.complexModel) tiers.push({ tier: 'complex', model: settings.complexModel as string });

		// Deduplicate by model ID
		const seen = new Set<string>();
		const uniqueTiers = tiers.filter((t) => {
			if (seen.has(t.model)) return false;
			seen.add(t.model);
			return true;
		});

		const results: ModelValidationResult[] = await Promise.all(
			uniqueTiers.map(async ({ tier, model }) => {
				const result = await this.aiOps!.testConnection(resolvedConfig, model);
				return { tier, model, ...result };
			})
		);

		const allPassed = results.every((r) => r.success);
		const failedTiers = results.filter((r) => !r.success);

		let message: string;
		if (allPassed) {
			message = `${this.providerName} connection verified — ${results.length} model(s) tested successfully.`;
		} else {
			const failedNames = failedTiers.map((f) => `${f.tier} (${f.model})`).join(', ');
			message = `${this.providerName}: ${failedTiers.length} model(s) failed validation: ${failedNames}`;
		}

		return { success: allPassed, message, modelResults: results };
	}

	protected abstract getDefaultModelId(): string;
}
