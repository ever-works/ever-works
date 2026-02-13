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
 * Vercel AI Gateway provider plugin
 *
 * Provides AI capabilities through the Vercel AI Gateway, which provides
 * access to multiple AI model providers (OpenAI, Anthropic, Google, etc.)
 * through a single OpenAI-compatible API endpoint.
 *
 * Uses 'hybrid' configuration mode - admin can set a shared API key via
 * environment variable, and users can optionally override with their own.
 */
export class VercelAiGatewayPlugin extends BaseAiProvider {
	readonly id = 'vercel-ai-gateway';
	readonly name = 'Vercel AI Gateway';
	readonly version = '1.0.0';

	readonly providerType = 'vercel-ai-gateway';
	readonly providerName = 'Vercel AI Gateway';

	readonly configurationMode: ConfigurationMode = 'hybrid';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Vercel AI Gateway API Key',
				description: 'Connects to Vercel AI Gateway to access models from multiple providers',
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_VERCEL_AI_GATEWAY_API_KEY'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'openai/gpt-5.1',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_VERCEL_AI_GATEWAY_DEFAULT_MODEL'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'openai/gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_VERCEL_AI_GATEWAY_SIMPLE_MODEL'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'openai/gpt-4o',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_VERCEL_AI_GATEWAY_MEDIUM_MODEL'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'openai/gpt-5.1',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'PLUGIN_VERCEL_AI_GATEWAY_COMPLEX_MODEL'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Custom API endpoint for proxies or compatible services',
				default: 'https://ai-gateway.vercel.sh/v1',
				'x-envVar': 'PLUGIN_VERCEL_AI_GATEWAY_BASE_URL',
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
			model: 'openai/gpt-5-nano',
			baseURL: 'https://ai-gateway.vercel.sh/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'openai'
		});

		context.logger.log('Vercel AI Gateway Plugin loaded');
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
			throw new Error('Vercel AI Gateway plugin not loaded');
		}

		const config = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, config);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Vercel AI Gateway plugin not loaded');
		}

		const config = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, config);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('Vercel AI Gateway plugin not loaded');
		}

		return this.aiOps.createEmbedding(options);
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Vercel AI Gateway plugin not loaded');
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
				message: 'Vercel AI Gateway API key is required'
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
			message: 'Vercel AI Gateway plugin is ready',
			checkedAt: Date.now()
		};
	}

	// Manifest

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Access AI models from multiple providers through Vercel AI Gateway',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			visibility: 'public',
			defaultForCapabilities: [],
			readme: [
				'## What is Vercel AI Gateway?',
				'',
				'Vercel AI Gateway is a unified API endpoint that provides access to models from providers such as OpenAI, Anthropic, Google, and others through a single OpenAI-compatible API. Rather than managing separate accounts for each provider, you connect once and select any available model.',
				'',
				'## Why use it?',
				'',
				'- **Unified access** — switch between GPT-4o, Claude, Gemini, and others without managing separate provider accounts',
				'- **OpenAI-compatible** — uses the familiar OpenAI API format for easy integration',
				'- **Cost optimization** — assign economy models to simple tasks and premium models to complex ones',
				'- **Vercel integration** — seamlessly integrates with Vercel deployments and infrastructure',
				'',
				'## How it works in Ever Works',
				'',
				'Vercel AI Gateway handles content creation, item descriptions, categorization, and summarization during directory generation. It also powers the conversational AI assistant and structured data extraction. You can configure three model tiers — simple, standard, and complex — to balance cost and output quality across different pipeline steps.',
				'',
				'## Getting started',
				'',
				'1. Set up Vercel AI Gateway in your Vercel dashboard',
				'2. Generate an API key from the Vercel AI Gateway settings',
				'3. Enter the key in the **Vercel AI Gateway API Key** field below',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			homepage: 'https://vercel.com/docs/ai-gateway',
			icon: {
				type: 'lucide',
				value: 'Triangle',
				backgroundColor: '#000000'
			}
		};
	}

	// Protected helpers

	/**
	 * Resolve configuration from plugin settings (user > admin > plugin defaults).
	 * Vercel AI Gateway overrides the base implementation to use stricter type checks.
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

export default VercelAiGatewayPlugin;
