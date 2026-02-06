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
 * Ollama AI provider plugin
 *
 * Provides AI capabilities through a local Ollama server.
 * Uses 'user-required' configuration mode - users can configure their Ollama server URL.
 * Ollama typically does not require authentication.
 */
export class OllamaPlugin extends BaseAiProvider {
	readonly id = 'ollama';
	readonly name = 'Ollama';
	readonly version = '1.0.0';
	readonly providerType: AiProviderType = 'ollama';
	readonly providerName = 'Ollama';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Optional - Ollama typically does not require authentication',
				default: 'ollama',
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				default: 'llama3.3',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				default: 'llama3.2',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				default: 'llama3.3',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				default: 'llama3.3',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				title: 'Ollama Server URL',
				default: 'http://localhost:11434/v1',
				'x-hidden': true
			},
			embeddingModel: {
				type: 'string',
				default: 'nomic-embed-text',
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
		required: []
	};

	private aiOps: AiOperations | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: 'ollama',
			model: 'llama3.3',
			baseURL: 'http://localhost:11434/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'ollama',
			embeddingModel: 'nomic-embed-text'
		});
		context.logger.log('Ollama Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Ollama Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Ollama Plugin disabled');
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
			throw new Error('Ollama plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Ollama plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('Ollama plugin not loaded');
		}
		return this.aiOps.createEmbedding(options);
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Ollama plugin not loaded');
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
		return 'llama3.3';
	}

	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		// Ollama has no required fields - defaults work out of the box
		return {
			valid: true
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Ollama plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Ollama AI provider for local model inference',
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
				value: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 2.862 1.782 5.37 3.478 7.128.386.4.776.78 1.147 1.126a2 2 0 0 0-1.358 1.632l-.018.23v.134a2 2 0 0 0 1.933 2.003l.22-.003h3.197a2 2 0 0 0 2.152-1.886l.001-.233-.018-.231a2 2 0 0 0-1.356-1.631c.37-.346.76-.726 1.145-1.126C17.218 14.37 19 11.862 19 9a7 7 0 0 0-7-7zm-2.5 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
				backgroundColor: '#000000'
			}
		};
	}
}

export default OllamaPlugin;
