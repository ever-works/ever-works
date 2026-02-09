import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';
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
				description: 'Connects to Anthropic for content generation and chat',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'claude-sonnet-4-5-20250514',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'claude-haiku-4-5-20251001',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'claude-sonnet-4-5-20250929',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'claude-sonnet-4-5-20250514',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Custom API endpoint for proxies or compatible services',
				default: 'https://api.anthropic.com/v1/',
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

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('Anthropic plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Anthropic plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by Anthropic');
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Anthropic plugin not loaded');
		}
		return this.aiOps.listModels(this.resolveConfig(settings));
	}

	async isAvailable(settings?: PluginSettings): Promise<boolean> {
		if (!this.aiOps) {
			return false;
		}
		const result = await this.aiOps.testConnection(this.resolveConfig(settings));
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
			homepage: 'https://console.anthropic.com',
			icon: {
				type: 'svg',
				darkValue: `<svg version="1.1" id="Layer_1" xmlns:x="ns_extend;" xmlns:i="ns_ai;" xmlns:graph="ns_graphs;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 92.2 65" style="enable-background:new 0 0 92.2 65;" xml:space="preserve"><style type="text/css"> .st0{fill:#FFFFFF;} </style><metadata><sfw xmlns="ns_sfw;"><slices></slices><sliceSourceBounds bottomLeftOrigin="true" height="65" width="92.2" x="-43.7" y="-98"></sliceSourceBounds></sfw></metadata><path class="st0" d="M66.5,0H52.4l25.7,65h14.1L66.5,0z M25.7,0L0,65h14.4l5.3-13.6h26.9L51.8,65h14.4L40.5,0C40.5,0,25.7,0,25.7,0z M24.3,39.3l8.8-22.8l8.8,22.8H24.3z"></path></svg>`,
				value: `<svg version="1.1" id="Layer_1" xmlns:x="ns_extend;" xmlns:i="ns_ai;" xmlns:graph="ns_graphs;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 92.2 65" style="enable-background:new 0 0 92.2 65;" xml:space="preserve"><style type="text/css"> .st0{fill:#181818;} </style><metadata><sfw xmlns="ns_sfw;"><slices></slices><sliceSourceBounds bottomLeftOrigin="true" height="65" width="92.2" x="-43.7" y="-98"></sliceSourceBounds></sfw></metadata><path class="st0" d="M66.5,0H52.4l25.7,65h14.1L66.5,0z M25.7,0L0,65h14.4l5.3-13.6h26.9L51.8,65h14.4L40.5,0C40.5,0,25.7,0,25.7,0z M24.3,39.3l8.8-22.8l8.8,22.8H24.3z"></path></svg>`
			}
		};
	}
}

export default AnthropicPlugin;
