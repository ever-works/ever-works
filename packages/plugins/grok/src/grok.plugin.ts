import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';
import type {
	PluginContext,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
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
 * Grok (xAI) AI provider plugin
 *
 * Provides AI capabilities through xAI's Grok models via their OpenAI-compatible API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class GrokPlugin extends BaseAiProvider {
	readonly id = 'grok';
	readonly name = 'Grok (xAI)';
	readonly version = '1.0.0';
	readonly providerType = 'grok';
	readonly providerName = 'xAI';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'xAI API Key',
				description: 'Connects to xAI for Grok-powered content generation and chat',
				'x-secret': true,
				'x-envVar': 'XAI_API_KEY',
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'grok-2-latest',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'grok-2-latest',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'grok-2-latest',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'grok-2-latest',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Custom API endpoint for proxies or compatible services',
				default: 'https://api.x.ai/v1',
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

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'grok-2-latest',
			baseURL: 'https://api.x.ai/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'grok'
		});
		context.logger.log('Grok Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('Grok plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Grok plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by Grok');
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Grok plugin not loaded');
		}
		return this.aiOps.listModels(this.resolveConfig(settings));
	}

	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 131072
		};
	}

	protected getDefaultModelId(): string {
		return 'grok-2-latest';
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Grok plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Use xAI Grok models for irreverent, real-time-aware content generation',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			uiHints: {
				completionFields: ['apiKey', 'defaultModel'],
				includeInOnboarding: true,
				onboardingPriority: 3,
				onboardingDescription: 'Bring your own xAI API key to use Grok for content generation across your works'
			},
			readme: [
				'## What is the Grok plugin?',
				'',
				"This plugin connects Ever Works to xAI's Grok models via the OpenAI-compatible xAI API. Grok is known for its real-time awareness and direct, unfiltered tone, which makes it a useful choice for content that needs to feel current and conversational.",
				'',
				'## Why use it?',
				'',
				'- **Long context window** — process up to 131,072 tokens of source material per request',
				'- **Vision support** — Grok can analyze images alongside text prompts',
				'- **Tool calling and structured output** — fits into the same agent patterns as OpenAI and Anthropic',
				'- **OpenAI-compatible API** — drops into the existing Ever Works AI pipeline without bespoke transport',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, Grok handles content generation during work creation, powers the conversational AI assistant, and performs structured data extraction. You can assign different Grok models to simple, standard, and complex task tiers.',
				'',
				'## Getting started',
				'',
				'1. Obtain an API key from [console.x.ai](https://console.x.ai)',
				'2. Enable the Grok plugin on this page',
				'3. Enter your API key in the settings below',
				'4. Select your preferred Grok models for each task complexity level'
			].join('\n'),
			homepage: 'https://x.ai',
			icon: {
				type: 'svg',
				darkValue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M9.27 15.29 18.36 3h-2.3l-7.94 10.74L3.27 3H1l8.81 11.91L1 21h2.3l7.71-10.45L17.39 21H21z"/></svg>`,
				value: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000000"><path d="M9.27 15.29 18.36 3h-2.3l-7.94 10.74L3.27 3H1l8.81 11.91L1 21h2.3l7.71-10.45L17.39 21H21z"/></svg>`
			}
		};
	}
}

export default GrokPlugin;
