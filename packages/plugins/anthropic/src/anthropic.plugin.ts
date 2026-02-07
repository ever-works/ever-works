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
			homepage: 'https://console.anthropic.com',
			icon: {
				type: 'svg',
				value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Claude</title><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"></path></svg>`
			}
		};
	}
}

export default AnthropicPlugin;
