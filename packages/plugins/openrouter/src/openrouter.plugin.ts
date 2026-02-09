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
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_OPENROUTER_API_KEY'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'openai/gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_OPENROUTER_DEFAULT_MODEL'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'openai/gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_OPENROUTER_SIMPLE_MODEL'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'moonshotai/kimi-k2.5',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_OPENROUTER_MEDIUM_MODEL'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'moonshotai/kimi-k2.5',
				'x-widget': 'model-select',
				'x-scope': 'global',
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

	async onUnload(): Promise<void> {
		this.aiOps = null;
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

		const config = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, config);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
		}

		const config = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, config);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
		}

		return this.aiOps.createEmbedding(options);
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('OpenRouter plugin not loaded');
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
			homepage: 'https://openrouter.ai',
			icon: {
				type: 'svg',
				value: `<svg width="100%" height="100%" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" class="size-4" fill="currentColor" stroke="currentColor" aria-label="Logo"><g clip-path="url(#clip0_205_3)"><path d="M3 248.945C18 248.945 76 236 106 219C136 202 136 202 198 158C276.497 102.293 332 120.945 423 120.945" stroke-width="90"></path><path d="M511 121.5L357.25 210.268L357.25 32.7324L511 121.5Z"></path><path d="M0 249C15 249 73 261.945 103 278.945C133 295.945 133 295.945 195 339.945C273.497 395.652 329 377 420 377" stroke-width="90"></path><path d="M508 376.445L354.25 287.678L354.25 465.213L508 376.445Z"></path></g><title style="display:none">OpenRouter</title><defs><clipPath id="clip0_205_3"><rect width="512" height="512" fill="white"></rect></clipPath></defs></svg>`,
				backgroundColor: '#94A3B8'
			}
		};
	}

	// Protected helpers

	/**
	 * Resolve configuration from plugin settings (user > admin > plugin defaults).
	 * OpenRouter overrides the base implementation to use stricter type checks.
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

export default OpenRouterPlugin;
