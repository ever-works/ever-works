import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';
import type {
	AiModel,
	AiModelCapabilities,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse
} from '@ever-works/plugin';
import type {
	PluginContext,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	ConfigurationMode
} from '@ever-works/plugin';
import type { AiOperationsConfig } from '@ever-works/plugin/ai';

/**
 * OpenRouter AI provider plugin
 *
 * Provides AI capabilities through the OpenRouter API, which aggregates
 * multiple AI model providers (OpenAI, Anthropic, Google, etc.) behind
 * a single API endpoint.
 *
 * Uses 'hybrid' configuration mode - admin can set a shared API key via
 * environment variable, and users can optionally override with their own.
 */
export class OpenRouterPlugin extends BaseAiProvider {
	readonly id = 'openrouter';
	readonly name = 'OpenRouter';
	readonly version = '1.0.0';

	readonly providerType = 'openrouter';
	readonly providerName = 'OpenRouter';

	readonly configurationMode: ConfigurationMode = 'hybrid';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'OpenRouter API Key',
				description: 'Connects to OpenRouter to access models from multiple providers',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENROUTER_API_KEY'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'openai/gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENROUTER_DEFAULT_MODEL'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'openai/gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENROUTER_SIMPLE_MODEL'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'moonshotai/kimi-k2.5',
				'x-widget': 'model-select',
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENROUTER_MEDIUM_MODEL'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'moonshotai/kimi-k2.5',
				'x-widget': 'model-select',
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENROUTER_COMPLEX_MODEL'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Custom API endpoint for proxies or compatible services',
				default: 'https://openrouter.ai/api/v1',
				'x-envVar': 'PLUGIN_OPENROUTER_BASE_URL',
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
		required: ['apiKey']
	};

	private aiOps?: AiOperations;

	// Lifecycle hooks

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);

		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'openai/gpt-5-nano',
			baseURL: 'https://openrouter.ai/api/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'openrouter'
		});

		context.logger.log('OpenRouter Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		await super.onEnable(context);
		context.logger.log('OpenRouter Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		await super.onDisable(context);
		context.logger.log('OpenRouter Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.aiOps = undefined;
		await super.onUnload();
	}

	// BaseAiProvider abstract implementations

	protected getDefaultModelId(): string {
		return 'openai/gpt-5-nano';
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
		}

		const config = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, config);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
		}

		const config = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, config);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
		}

		return this.aiOps.createEmbedding(options);
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
		}

		return this.aiOps.listModels();
	}

	async isAvailable(): Promise<boolean> {
		if (!this.aiOps) {
			return false;
		}

		try {
			const result = await this.aiOps.testConnection();
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
			supportsVision: false,
			maxContextLength: 128000
		};
	}

	// Settings validation

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey || typeof settings.apiKey !== 'string') {
			errors.push({
				path: 'apiKey',
				message: 'OpenRouter API key is required'
			});
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	// Health check

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'OpenRouter plugin is ready',
			checkedAt: Date.now()
		};
	}

	// Manifest

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Access hundreds of AI models from top providers through a single connection',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'public',
			defaultForCapabilities: ['ai-provider'],
			readme: [
				'## What is OpenRouter?',
				'',
				'OpenRouter is an AI gateway that provides access to hundreds of models from providers such as OpenAI, Anthropic, Google, and Meta through a single API key. Rather than managing separate accounts for each provider, you connect once and select any available model.',
				'',
				'## Why use it?',
				'',
				'- **Unified access** — switch between GPT-4o, Claude, Gemini, Llama, and others without managing separate provider accounts',
				'- **Cost optimization** — assign economy models to simple tasks and premium models to complex ones',
				'- **Provider redundancy** — OpenRouter can automatically route to an alternative if a provider is unavailable',
				'- **Centralized billing** — track usage and spending across all models from a single dashboard',
				'',
				'## How it works in Ever Works',
				'',
				'OpenRouter is the default AI provider. During directory generation, it handles content creation, item descriptions, categorization, and summarization. It also powers the conversational AI assistant and structured data extraction. You can configure three model tiers — simple, standard, and complex — to balance cost and output quality across different pipeline steps.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [openrouter.ai](https://openrouter.ai)',
				'2. Generate an API key from the OpenRouter dashboard',
				'3. Enter the key in the **OpenRouter API Key** field below',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.22.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
				backgroundColor: '#94A3B8'
			}
		};
	}

	// Private helpers

	/**
	 * Resolve configuration from options.settings (user > admin > plugin defaults).
	 * When the facade calls createChatCompletion, it passes the resolved settings
	 * in options.settings. This method extracts relevant config overrides from those settings.
	 */
	private resolveConfig(options: ChatCompletionOptions): Partial<AiOperationsConfig> {
		const settings = options.settings;
		if (!settings) {
			return {};
		}

		const config: Partial<AiOperationsConfig> = {};

		if (settings.apiKey && typeof settings.apiKey === 'string') {
			config.apiKey = settings.apiKey;
		}

		if (settings.baseUrl && typeof settings.baseUrl === 'string') {
			config.baseURL = settings.baseUrl;
		}

		const temperature =
			options.temperature ?? (typeof settings.temperature === 'number' ? settings.temperature : undefined);
		if (temperature !== undefined) {
			config.temperature = temperature;
		}

		const maxTokens =
			options.maxTokens ?? (typeof settings.maxTokens === 'number' ? settings.maxTokens : undefined);
		if (maxTokens !== undefined) {
			config.maxTokens = maxTokens;
		}

		return config;
	}
}

export default OpenRouterPlugin;
