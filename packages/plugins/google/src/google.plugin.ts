import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations, type AiOperationsConfig } from '@ever-works/plugin/ai';
import type {
	PluginContext,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse,
	AiModel,
	AiModelCapabilities,
	AiProviderType
} from '@ever-works/plugin';

/**
 * Google Gemini AI provider plugin
 *
 * Provides AI capabilities through Google's Gemini API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class GooglePlugin extends BaseAiProvider {
	readonly id = 'google';
	readonly name = 'Google Gemini';
	readonly version = '1.0.0';
	readonly providerType: AiProviderType = 'google';
	readonly providerName = 'Google Gemini';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Google AI API Key',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				default: 'gemini-2.5-flash',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				default: 'gemini-2.0-flash',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				default: 'gemini-2.5-flash',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				default: 'gemini-2.5-pro',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				default: 'https://generativelanguage.googleapis.com/v1beta/openai/',
				'x-hidden': true
			},
			embeddingModel: {
				type: 'string',
				default: 'text-embedding-004',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			temperature: {
				type: 'number',
				default: 0.7,
				minimum: 0,
				maximum: 2,
				'x-hidden': true
			},
			maxTokens: {
				type: 'number',
				default: 4096,
				'x-hidden': true
			}
		},
		required: ['apiKey']
	};

	private aiOps: AiOperations | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'gemini-2.5-flash',
			baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'google',
			embeddingModel: 'text-embedding-004'
		});
		context.logger.log('Google Gemini Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Google Gemini Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Google Gemini Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	private resolveConfig(options: ChatCompletionOptions): Partial<AiOperationsConfig> {
		const settings = options.settings ?? {};
		const config: Partial<AiOperationsConfig> = {};
		if (settings.apiKey) config.apiKey = settings.apiKey as string;
		if (settings.defaultModel) config.model = settings.defaultModel as string;
		if (settings.baseUrl) config.baseURL = settings.baseUrl as string;
		if (settings.temperature !== undefined) config.temperature = settings.temperature as number;
		if (settings.maxTokens !== undefined) config.maxTokens = settings.maxTokens as number;
		if (settings.embeddingModel) config.embeddingModel = settings.embeddingModel as string;
		return config;
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('Google Gemini plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Google Gemini plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('Google Gemini plugin not loaded');
		}
		return this.aiOps.createEmbedding(options);
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Google Gemini plugin not loaded');
		}
		return this.aiOps.listModels();
	}

	async isAvailable(): Promise<boolean> {
		if (!this.aiOps) {
			return false;
		}
		const result = await this.aiOps.testConnection();
		return result.success;
	}

	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 1048576
		};
	}

	protected getDefaultModelId(): string {
		return 'gemini-2.5-flash';
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey || typeof settings.apiKey !== 'string') {
			errors.push({
				path: 'apiKey',
				message: 'Google AI API key is required'
			});
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Google Gemini plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Google Gemini AI provider for chat completions, embeddings, and more',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoInstall: true,
			autoEnable: true,
			visibility: 'public',
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m4 7.5 8 4.5m0 0 8-4.5M12 12v9" stroke="currentColor" stroke-width="1.5"/></svg>',
				backgroundColor: '#8E75B2'
			}
		};
	}
}

export default GooglePlugin;
