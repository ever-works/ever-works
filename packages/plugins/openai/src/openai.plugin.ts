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
 * OpenAI AI provider plugin
 *
 * Provides AI capabilities through OpenAI's API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class OpenAiPlugin extends BaseAiProvider {
	readonly id = 'openai';
	readonly name = 'OpenAI';
	readonly version = '1.0.0';
	readonly providerType = 'openai';
	readonly providerName = 'OpenAI';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'OpenAI API Key',
				description: 'Connects to OpenAI for content generation and chat',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'gpt-4o-mini',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'gpt-4o',
				'x-widget': 'model-select',
				'x-scope': 'user'
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

	private aiOps: AiOperations | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'gpt-5-nano',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'openai'
		});
		context.logger.log('OpenAI Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('OpenAI Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('OpenAI Plugin disabled');
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
		if (settings.temperature !== undefined) config.temperature = settings.temperature as number;
		if (settings.maxTokens !== undefined) config.maxTokens = settings.maxTokens as number;
		return config;
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		return this.aiOps.createEmbedding(options);
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
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
		return 'gpt-5-nano';
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey || typeof settings.apiKey !== 'string') {
			errors.push({
				path: 'apiKey',
				message: 'OpenAI API key is required'
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
			message: 'OpenAI plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Use OpenAI models like GPT-4o for content generation and AI features',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is the OpenAI plugin?',
				'',
				"This plugin connects Ever Works directly to OpenAI's API, providing access to models such as GPT-4o, GPT-4o mini, and OpenAI's text-embedding models. Use it when you prefer a direct connection to OpenAI with your own API key.",
				'',
				'## Why use it?',
				'',
				'- **Direct API access** — connect to OpenAI without an intermediary for the lowest possible latency',
				'- **Latest models** — access new OpenAI releases as soon as they become available',
				'- **Embedding support** — use text-embedding-3-small or other models for semantic search within your directories',
				'- **Vision capabilities** — models with image understanding for richer content analysis',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, OpenAI handles content generation during directory creation, powers the conversational AI assistant, and produces embeddings for semantic search. You can assign different models to simple, standard, and complex task tiers to control cost and output quality.',
				'',
				'## Getting started',
				'',
				'1. Obtain an API key from [platform.openai.com](https://platform.openai.com/api-keys)',
				'2. Enable the OpenAI plugin on this page',
				'3. Enter your API key in the settings below',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 6.34c.19-.95.02-1.93-.47-2.76A3.67 3.67 0 0 0 9.38 1.7a3.59 3.59 0 0 0-2.7-1.2A3.67 3.67 0 0 0 3.2 3.54c-.98.17-1.84.72-2.4 1.53A3.67 3.67 0 0 0 1.26 9.6c-.18.95-.02 1.93.47 2.76a3.67 3.67 0 0 0 3.93 1.88 3.59 3.59 0 0 0 2.7 1.2 3.67 3.67 0 0 0 3.48-3.04c.98-.17 1.84-.72 2.4-1.53a3.67 3.67 0 0 0-.46-4.53zM8.36 14.1a2.74 2.74 0 0 1-1.76-.64l.09-.05 2.92-1.68c.15-.09.24-.25.24-.42V7.28l1.23.71s.02.01.02.03v3.41c0 1.47-1.23 2.67-2.74 2.67zm-5.9-2.45a2.68 2.68 0 0 1-.32-1.82l.09.05 2.92 1.69c.15.09.33.09.48 0l3.56-2.06v1.42s0 .03-.02.04l-2.95 1.7a2.76 2.76 0 0 1-3.76-1.02zm-.77-6.2A2.7 2.7 0 0 1 3.1 4.1v.1l-.01 3.37c0 .17.09.34.24.42l3.56 2.06-1.24.71-.02-.01-2.95-1.7a2.68 2.68 0 0 1-.99-3.61zm10.14 2.36L8.27 5.75l1.23-.71s.02-.01.03 0l2.95 1.7a2.68 2.68 0 0 1 .42 4.42v-3.47c0-.18-.1-.34-.25-.43l.18.1zm1.23-1.84-.09-.05-2.92-1.69a.47.47 0 0 0-.48 0L6.01 6.29V4.87l.02-.04 2.95-1.7a2.76 2.76 0 0 1 4.08 2.84zM5.37 8.72 4.14 8s0-.03.01-.04V4.55c0-1.48 1.24-2.68 2.75-2.68.56 0 1.1.17 1.56.48l-.09.05-2.92 1.68a.48.48 0 0 0-.24.43l.16 4.21zm.67-1.48L8 6.14l1.96 1.13v2.26L8 10.66l-1.96-1.13V7.24z"/></svg>',
				backgroundColor: '#000000'
			}
		};
	}
}

export default OpenAiPlugin;
