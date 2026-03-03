import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';
import type {
	AiModel,
	AiModelCapabilities,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse,
	PluginContext,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	PluginSettings,
	ConfigurationMode
} from '@ever-works/plugin';
import type { AiOperationsConfig } from '@ever-works/plugin/ai';

/**
 * Mistral AI provider plugin
 *
 * Provides AI capabilities through the Mistral API, which offers
 * high-performance language models optimized for efficiency and quality.
 *
 * Uses 'user-required' configuration mode - each user must provide
 * their own Mistral API key.
 */
export class MistralPlugin extends BaseAiProvider {
	readonly id = 'mistral';
	readonly name = 'Mistral';
	readonly version = '1.0.0';

	readonly providerType = 'mistral';
	readonly providerName = 'Mistral';

	readonly configurationMode: ConfigurationMode = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Mistral API Key',
				description: 'Connects to Mistral to access their AI models',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_MISTRAL_API_KEY'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'mistral-small-latest',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_MISTRAL_DEFAULT_MODEL'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'mistral-small-latest',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_MISTRAL_SIMPLE_MODEL'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'mistral-medium-latest',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_MISTRAL_MEDIUM_MODEL'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'mistral-large-latest',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_MISTRAL_COMPLEX_MODEL'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Custom API endpoint for proxies or compatible services',
				default: 'https://api.mistral.ai/v1',
				'x-envVar': 'PLUGIN_MISTRAL_BASE_URL',
				'x-hidden': true
			},
			temperature: {
				type: 'number',
				title: 'Temperature',
				description: 'Lower values give consistent output, higher values add variety',
				default: 0.7,
				minimum: 0,
				maximum: 2,
				'x-hidden': true
			},
			maxTokens: {
				type: 'number',
				title: 'Max Tokens',
				description: 'Limits the length of each AI-generated response',
				default: 4096,
				'x-hidden': true
			}
		},
		required: ['apiKey', 'defaultModel']
	};

	// Lifecycle hooks

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);

		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'mistral-small-latest',
			baseURL: 'https://api.mistral.ai/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'mistral'
		});

		context.logger.log('Mistral Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	// BaseAiProvider abstract implementations

	protected getDefaultModelId(): string {
		return 'mistral-small-latest';
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('Mistral plugin not loaded');
		}

		const config = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, config);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Mistral plugin not loaded');
		}

		const config = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, config);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('Mistral plugin not loaded');
		}

		return this.aiOps.createEmbedding(options);
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Mistral plugin not loaded');
		}

		return this.aiOps.listModels(this.resolveConfig(settings));
	}

	async isAvailable(settings?: PluginSettings): Promise<boolean> {
		if (!this.aiOps) {
			return false;
		}

		try {
			const result = await this.aiOps.testConnection(this.resolveConfig(settings));
			return result.success;
		} catch {
			return false;
		}
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

	// Health check

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Mistral plugin is ready',
			checkedAt: Date.now()
		};
	}

	// Manifest

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Access high-performance AI models from Mistral with optimized efficiency and quality',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is Mistral?',
				'',
				'Mistral AI is a leading AI company that develops high-performance language models optimized for efficiency, speed, and quality. Their models range from compact and fast to large and highly capable, all accessible through an OpenAI-compatible API.',
				'',
				'## Why use it?',
				'',
				'- **High performance** — Mistral models deliver strong results across reasoning, coding, and multilingual tasks',
				'- **Cost efficient** — competitive pricing with models optimized for different complexity levels',
				'- **Vision support** — Pixtral models support image understanding alongside text',
				'- **European AI** — built by a European company with a focus on open and transparent AI development',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled, Mistral handles content creation, item descriptions, categorization, and summarization during directory generation. It also powers the conversational AI assistant and structured data extraction. You can configure three model tiers — simple, standard, and complex — to balance cost and output quality across different pipeline steps.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [console.mistral.ai](https://console.mistral.ai)',
				'2. Generate an API key from the Mistral console',
				'3. Enter the key in the **Mistral API Key** field below',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			homepage: 'https://mistral.ai',
			icon: {
				type: 'svg',
				value: `<svg width="365" height="258" viewBox="0 0 365 258" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="Mistral AI Logo"><path d="M104.107 0H52.0525V51.57H104.107V0Z" fill="#FFD800"/><path d="M312.351 0H260.296V51.57H312.351V0Z" fill="#FFD800"/><path d="M156.161 51.5701H52.0525V103.14H156.161V51.5701Z" fill="#FFAF00"/><path d="M312.353 51.5701H208.244V103.14H312.353V51.5701Z" fill="#FFAF00"/><path d="M312.356 103.14H52.0525V154.71H312.356V103.14Z" fill="#FF8205"/><path d="M104.107 154.71H52.0525V206.28H104.107V154.71Z" fill="#FA500F"/><path d="M208.228 154.711H156.174V206.281H208.228V154.711Z" fill="#FA500F"/><path d="M312.351 154.711H260.296V206.281H312.351V154.711Z" fill="#FA500F"/><path d="M156.195 206.312H0V257.882H156.195V206.312Z" fill="#E10500"/><path d="M364.439 206.312H208.244V257.882H364.439V206.312Z" fill="#E10500"/></g></svg>`
			}
		};
	}

	// Protected helpers

	/**
	 * Resolve configuration from plugin settings (user > admin > plugin defaults).
	 */
	protected override resolveConfig(settings?: PluginSettings): Partial<AiOperationsConfig> {
		const s = settings ?? {};
		const config: Partial<AiOperationsConfig> = {};

		if (s.apiKey && typeof s.apiKey === 'string') {
			config.apiKey = s.apiKey;
		}

		if (s.baseUrl && typeof s.baseUrl === 'string') {
			config.baseURL = s.baseUrl;
		}

		if (typeof s.temperature === 'number') {
			config.temperature = s.temperature;
		}

		if (typeof s.maxTokens === 'number') {
			config.maxTokens = s.maxTokens;
		}

		return config;
	}
}

export default MistralPlugin;
