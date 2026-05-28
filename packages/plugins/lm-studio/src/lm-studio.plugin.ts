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
 * LM Studio AI provider plugin
 *
 * Provides AI capabilities through a local (or remote) LM Studio server.
 * LM Studio exposes an OpenAI-compatible API on `/v1`, so it reuses the same
 * `AiOperations` (LangChain) backend as the other AI providers.
 *
 * Uses 'user-required' configuration mode - users point the plugin at their
 * LM Studio server URL. LM Studio does not authenticate by default, but the
 * OpenAI client requires a non-empty key, so `apiKey` defaults to a placeholder.
 *
 * Unlike Ollama, LM Studio has no canonical default model: the served model is
 * whatever the user has loaded in the app. The model fields therefore ship
 * without a hardcoded default and are populated by the `model-select` widget
 * once the connection is established and `listModels()` returns.
 */
export class LmStudioPlugin extends BaseAiProvider {
	readonly id = 'lm-studio';
	readonly name = 'LM Studio';
	readonly version = '1.0.0';
	readonly providerType = 'lm-studio';
	readonly providerName = 'LM Studio';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseUrl: {
				type: 'string',
				title: 'LM Studio Server URL',
				description: 'Address of your LM Studio server (e.g: http://localhost:1234/v1)',
				'x-scope': 'user'
			},
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Usually not needed; only for LM Studio instances placed behind an auth proxy',
				default: 'lm-studio',
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
			apiKey: 'lm-studio',
			model: this.getDefaultModelId(),
			baseURL: 'http://localhost:1234/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'lm-studio'
		});
		context.logger.log('LM Studio Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('LM Studio plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('LM Studio plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('LM Studio plugin not loaded');
		}
		return this.aiOps.createEmbedding(options);
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('LM Studio plugin not loaded');
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
			message: 'LM Studio plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Connect to an LM Studio server for private, self-hosted AI inference',
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
				'## What is the LM Studio plugin?',
				'',
				'This plugin connects Ever Works to an [LM Studio](https://lmstudio.ai) server for AI inference. LM Studio runs open-source models (Llama, Qwen, Mistral, Gemma, and others) locally and exposes them through an OpenAI-compatible API. Because the server runs on your own machine, your data never leaves your infrastructure.',
				'',
				'## Why use it?',
				'',
				'- **Data privacy** — requests are processed by your LM Studio instance, keeping sensitive content off third-party servers',
				'- **No API costs** — run unlimited requests against your own hardware',
				'- **Open-source models** — load any GGUF/MLX model supported by LM Studio',
				'- **Friendly UI** — manage and download models from the LM Studio desktop app',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, Ever Works routes content generation, conversational AI, and embedding requests to your LM Studio server. The plugin is used during work generation to produce item descriptions, summaries, and categorizations. You can assign different models to simple, standard, and complex task tiers to balance speed and quality.',
				'',
				'## Getting started',
				'',
				'1. Install LM Studio ([lmstudio.ai](https://lmstudio.ai)) and download at least one model',
				'2. Start the **Local Server** in LM Studio (Developer tab) — it listens on `http://localhost:1234` by default',
				'3. Enable the LM Studio plugin and set the **Base URL** to your server address (include the `/v1` suffix)',
				'4. Select your preferred model for each task complexity level'
			].join('\n'),
			homepage: 'https://lmstudio.ai',
			icon: {
				type: 'svg',
				value: `<svg fill="#000" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>LM Studio</title><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4.6 4.7v8.6a.6.6 0 0 0 .92.5l6.9-4.3a.6.6 0 0 0 0-1l-6.9-4.3a.6.6 0 0 0-.92.5z"/></svg>`,
				darkValue: `<svg fill="#fff" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>LM Studio</title><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4.6 4.7v8.6a.6.6 0 0 0 .92.5l6.9-4.3a.6.6 0 0 0 0-1l-6.9-4.3a.6.6 0 0 0-.92.5z"/></svg>`
			}
		};
	}
}

export default LmStudioPlugin;
