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
	AiModelCapabilities
} from '@ever-works/plugin';

/**
 * Groq AI provider plugin
 *
 * Provides AI capabilities through Groq's ultra-fast inference API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class GroqPlugin extends BaseAiProvider {
	readonly id = 'groq';
	readonly name = 'Groq';
	readonly version = '1.0.0';
	readonly providerType = 'groq';
	readonly providerName = 'Groq';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Groq API Key',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				default: 'meta-llama/llama-4-scout-17b-16e-instruct',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				default: 'llama-3.1-8b-instant',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				default: 'meta-llama/llama-4-scout-17b-16e-instruct',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				default: 'llama-3.3-70b-versatile',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				default: 'https://api.groq.com/openai/v1',
				'x-hidden': true
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
			model: 'meta-llama/llama-4-scout-17b-16e-instruct',
			baseURL: 'https://api.groq.com/openai/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'groq'
		});
		context.logger.log('Groq Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Groq Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Groq Plugin disabled');
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
		return config;
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('Groq plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Groq plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by Groq');
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Groq plugin not loaded');
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
			maxContextLength: 128000
		};
	}

	protected getDefaultModelId(): string {
		return 'meta-llama/llama-4-scout-17b-16e-instruct';
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey || typeof settings.apiKey !== 'string') {
			errors.push({
				path: 'apiKey',
				message: 'Groq API key is required'
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
			message: 'Groq plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Groq AI provider for ultra-fast chat completions',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoInstall: false,
			autoEnable: false,
			visibility: 'public',
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 33 33" fill="currentColor"><path d="M16.5 0C7.387 0 0 7.387 0 16.5S7.387 33 16.5 33 33 25.613 33 16.5 25.613 0 16.5 0zm7.5 22.5-4.5-4.5L15 22.5 7.5 15l4.5-4.5L16.5 15 21 10.5l4.5 4.5-1.5 1.5z"/></svg>',
				backgroundColor: '#F55036'
			}
		};
	}
}

export default GroqPlugin;
