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
 * Anthropic AI provider plugin
 *
 * Provides AI capabilities through Anthropic's Claude API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class AnthropicPlugin extends BaseAiProvider {
	readonly id = 'anthropic';
	readonly name = 'Anthropic';
	readonly version = '1.0.0';
	readonly providerType = 'anthropic';
	readonly providerName = 'Anthropic';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Anthropic API Key',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				default: 'claude-sonnet-4-5-20250514',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				default: 'claude-haiku-4-5-20251001',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				default: 'claude-sonnet-4-5-20250929',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				default: 'claude-sonnet-4-5-20250514',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				default: 'https://api.anthropic.com/v1/',
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
			model: 'claude-sonnet-4-5-20250514',
			baseURL: 'https://api.anthropic.com/v1/',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'anthropic'
		});
		context.logger.log('Anthropic Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Anthropic Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Anthropic Plugin disabled');
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
			throw new Error('Anthropic plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Anthropic plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by Anthropic');
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Anthropic plugin not loaded');
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
			maxContextLength: 200000
		};
	}

	protected getDefaultModelId(): string {
		return 'claude-sonnet-4-5-20250514';
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey || typeof settings.apiKey !== 'string') {
			errors.push({
				path: 'apiKey',
				message: 'Anthropic API key is required'
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
			message: 'Anthropic plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Use Anthropic Claude models for thoughtful, detailed content generation',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is the Anthropic plugin?',
				'',
				"This plugin connects Ever Works to Anthropic's Claude models. Claude is recognized for producing well-structured, nuanced content and adhering closely to instructions, making it well-suited for directory descriptions and detailed content generation.",
				'',
				'## Why use it?',
				'',
				'- **High-quality output** — Claude produces clear, well-organized content with attention to detail',
				'- **Large context window** — process up to 200,000 tokens of source material per request',
				'- **Precise instruction following** — reliably adheres to formatting preferences and content guidelines',
				'- **Vision capabilities** — Claude can analyze images as part of the content generation process',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, Claude handles content generation during directory creation, powers the conversational AI assistant, and performs structured data extraction. You can assign different Claude models — Haiku for speed, Sonnet for balance, Opus for quality — to simple, standard, and complex task tiers.',
				'',
				'## Getting started',
				'',
				'1. Obtain an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)',
				'2. Enable the Anthropic plugin on this page',
				'3. Enter your API key in the settings below',
				'4. Select your preferred Claude models for each task complexity level'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H.001L6.57 3.522zm2.327 4.806L6.47 14.353h4.853L8.896 8.326z"/></svg>',
				backgroundColor: '#191919'
			}
		};
	}
}

export default AnthropicPlugin;
