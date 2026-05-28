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
 * vLLM AI provider plugin
 *
 * Provides AI capabilities through a self-hosted vLLM server. vLLM serves an
 * OpenAI-compatible API on `/v1`, so it reuses the same `AiOperations`
 * (LangChain) backend as the other AI providers.
 *
 * Uses 'user-required' configuration mode - users point the plugin at their
 * vLLM server URL. An unsecured vLLM server accepts any key, so `apiKey`
 * defaults to vLLM's documented `EMPTY` placeholder; when the server is
 * started with `--api-key`, users enter that token (stored encrypted via
 * `x-secret`).
 *
 * vLLM serves whatever model it was launched with (`--model ...`), so there is
 * no canonical default model. The model fields ship without a hardcoded
 * default and are populated by the `model-select` widget once the connection
 * is established and `listModels()` returns.
 */
export class VllmPlugin extends BaseAiProvider {
	readonly id = 'vllm';
	readonly name = 'vLLM';
	readonly version = '1.0.0';
	readonly providerType = 'vllm';
	readonly providerName = 'vLLM';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseUrl: {
				type: 'string',
				title: 'vLLM Server URL',
				description: 'Address of your vLLM OpenAI-compatible server (e.g: http://localhost:8000/v1)',
				'x-scope': 'user'
			},
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Only required if your vLLM server was started with --api-key; leave as EMPTY otherwise',
				default: 'EMPTY',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			embeddingModel: {
				type: 'string',
				title: 'Embedding Model',
				description: 'Model used for semantic search embeddings (only needed if you use KB search)',
				'x-widget': 'model-select',
				'x-scope': 'global'
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
		required: ['baseUrl', 'defaultModel']
	};

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: 'EMPTY',
			model: this.getDefaultModelId(),
			baseURL: 'http://localhost:8000/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'vllm'
		});
		context.logger.log('vLLM Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('vLLM plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('vLLM plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('vLLM plugin not loaded');
		}
		return this.aiOps.createEmbedding(options, this.resolveConfig(options.settings));
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('vLLM plugin not loaded');
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
			maxContextLength: 128000
		};
	}

	protected getDefaultModelId(): string {
		return 'local-model';
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'vLLM plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Connect to a self-hosted vLLM server for high-throughput, private AI inference',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			uiHints: {
				completionFields: ['defaultModel']
			},
			readme: [
				'## What is the vLLM plugin?',
				'',
				'This plugin connects Ever Works to a [vLLM](https://docs.vllm.ai) server for AI inference. vLLM is a high-throughput inference engine for open-source models, usually deployed on a GPU server. It exposes an OpenAI-compatible API, so Ever Works can use it for content generation, conversations, and embeddings.',
				'',
				'## Why use it?',
				'',
				'- **Data privacy** — requests are processed by your own vLLM server, keeping sensitive content off third-party servers',
				'- **No API costs** — run unlimited requests against your own GPU infrastructure',
				'- **High throughput** — vLLM is optimized for concurrent, batched inference (PagedAttention)',
				'- **Open-source models** — serve any model supported by vLLM',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, Ever Works routes content generation, conversational AI, and embedding requests to your vLLM server. The plugin is used during work generation to produce item descriptions, summaries, and categorizations. You can assign different models to simple, standard, and complex task tiers to balance speed and quality.',
				'',
				'## Getting started',
				'',
				'1. Start a vLLM OpenAI-compatible server: `vllm serve <model>` (listens on `http://localhost:8000` by default)',
				'2. If you secured it with `--api-key <token>`, have that token ready',
				'3. Enable the vLLM plugin and set the **Base URL** to your server address (include the `/v1` suffix)',
				'4. Enter the **API Key** if your server requires one (otherwise leave it as `EMPTY`)',
				'5. Select your preferred model for each task complexity level'
			].join('\n'),
			homepage: 'https://docs.vllm.ai',
			icon: {
				type: 'svg',
				value: `<svg fill="#000" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>vLLM</title><path d="M13.1 1.2 4.2 13.3a.7.7 0 0 0 .56 1.11h5.05l-1.02 8.3a.5.5 0 0 0 .9.36l8.9-12.1a.7.7 0 0 0-.56-1.11h-5.05l1.02-8.3a.5.5 0 0 0-.9-.36z"/></svg>`,
				darkValue: `<svg fill="#fff" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>vLLM</title><path d="M13.1 1.2 4.2 13.3a.7.7 0 0 0 .56 1.11h5.05l-1.02 8.3a.5.5 0 0 0 .9.36l8.9-12.1a.7.7 0 0 0-.56-1.11h-5.05l1.02-8.3a.5.5 0 0 0-.9-.36z"/></svg>`
			}
		};
	}
}

export default VllmPlugin;
