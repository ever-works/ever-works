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
 * Ollama AI provider plugin
 *
 * Provides AI capabilities through a local Ollama server.
 * Uses 'user-required' configuration mode - users can configure their Ollama server URL.
 * Ollama typically does not require authentication.
 */
export class OllamaPlugin extends BaseAiProvider {
	readonly id = 'ollama';
	readonly name = 'Ollama';
	readonly version = '1.0.0';
	readonly providerType = 'ollama';
	readonly providerName = 'Ollama';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Usually not needed; only for secured Ollama instances',
				default: 'ollama',
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'llama3.3',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'llama3.2',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'llama3.3',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'llama3.3',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				title: 'Ollama Server URL',
				description: 'Address of your Ollama instance (default: localhost:11434)',
				default: 'http://localhost:11434/v1',
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
		required: []
	};

	private aiOps: AiOperations | null = null;

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: 'ollama',
			model: 'llama3.3',
			baseURL: 'http://localhost:11434/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'ollama'
		});
		context.logger.log('Ollama Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Ollama Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Ollama Plugin disabled');
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
			throw new Error('Ollama plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Ollama plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('Ollama plugin not loaded');
		}
		return this.aiOps.createEmbedding(options);
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Ollama plugin not loaded');
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
		return 'llama3.3';
	}

	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		// Ollama has no required fields - defaults work out of the box
		return {
			valid: true
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Ollama plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Connect to an Ollama instance for private, self-hosted AI inference',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is the Ollama plugin?',
				'',
				'This plugin connects Ever Works to an Ollama server for AI inference. Ollama hosts open-source models such as Llama, Mistral, Gemma, and others behind a local or remote API. Because you control the server, your data stays within your infrastructure.',
				'',
				'## Why use it?',
				'',
				'- **Data privacy** — requests are processed by your Ollama instance, keeping sensitive content off third-party servers',
				'- **No API costs** — run unlimited requests against your own infrastructure',
				'- **Open-source models** — choose from a wide range of community and foundation models',
				'- **Embedding support** — models such as nomic-embed-text enable semantic search within your directories',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, Ever Works routes content generation, conversational AI, and embedding requests to your Ollama instance. The plugin is used during directory generation to produce item descriptions, summaries, and categorizations. You can assign different models to simple, standard, and complex task tiers to balance speed and quality.',
				'',
				'## Getting started',
				'',
				'1. Install and run Ollama ([ollama.com](https://ollama.com)) or connect to an existing instance',
				'2. Ensure at least one model is available (e.g. `ollama pull llama3.3`)',
				'3. Enable the Ollama plugin and set the **Base URL** to your Ollama server address',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 2.862 1.782 5.37 3.478 7.128.386.4.776.78 1.147 1.126a2 2 0 0 0-1.358 1.632l-.018.23v.134a2 2 0 0 0 1.933 2.003l.22-.003h3.197a2 2 0 0 0 2.152-1.886l.001-.233-.018-.231a2 2 0 0 0-1.356-1.631c.37-.346.76-.726 1.145-1.126C17.218 14.37 19 11.862 19 9a7 7 0 0 0-7-7zm-2.5 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
				backgroundColor: '#000000'
			}
		};
	}
}

export default OllamaPlugin;
