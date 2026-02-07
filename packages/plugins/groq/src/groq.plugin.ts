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
 * Groq AI provider plugin
 *
 * Provides AI capabilities through Groq's ultra-fast inference API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class GroqPlugin extends BaseAiProvider {
	readonly id = 'groq';
	readonly name = 'Groq';
	readonly version = '1.0.0';
	readonly providerType = 'groq';
	readonly providerName = 'Groq';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Groq API Key',
				description: 'Connects to Groq for fast AI content generation and chat',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'meta-llama/llama-4-scout-17b-16e-instruct',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'llama-3.1-8b-instant',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'meta-llama/llama-4-scout-17b-16e-instruct',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'llama-3.3-70b-versatile',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'Custom API endpoint for proxies or compatible services',
				default: 'https://api.groq.com/openai/v1',
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
			model: 'meta-llama/llama-4-scout-17b-16e-instruct',
			baseURL: 'https://api.groq.com/openai/v1',
			temperature: 0.7,
			maxTokens: 4096,
			providerType: 'groq'
		});
		context.logger.log('Groq Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Groq Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Groq Plugin disabled');
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
			throw new Error('Groq plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('Groq plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
		throw new Error('Embeddings not supported by Groq');
	}

	async listModels(): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('Groq plugin not loaded');
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
		return 'meta-llama/llama-4-scout-17b-16e-instruct';
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey || typeof settings.apiKey !== 'string') {
			errors.push({
				path: 'apiKey',
				message: 'Groq API key is required'
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
			message: 'Groq plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Ultra-fast AI inference for rapid content generation and processing',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is the Groq plugin?',
				'',
				'Groq provides ultra-fast AI inference using custom LPU (Language Processing Unit) hardware. It runs open-source models such as Llama and Mixtral at significantly higher speeds than conventional cloud providers.',
				'',
				'## Why use it?',
				'',
				"- **Exceptional speed** — responses arrive in milliseconds thanks to Groq's purpose-built hardware",
				'- **Open-source models** — access Llama, Mixtral, and other leading open-weight models',
				'- **Free tier available** — generous free usage limits for evaluation and small-scale use',
				'- **Rapid iteration** — fast inference enables quick experimentation when refining directory content',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, Groq handles content generation during directory creation and powers the conversational AI assistant. It is particularly effective for directories with many items where generation speed is a priority. Note that Groq does not currently support embedding models.',
				'',
				'## Getting started',
				'',
				'1. Obtain a free API key from [console.groq.com](https://console.groq.com/keys)',
				'2. Enable the Groq plugin on this page',
				'3. Enter your API key in the settings below',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			homepage: 'https://console.groq.com',
			icon: {
				type: 'svg',
				value: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" width="33" height="33" viewBox="0 0 33 33"><g clip-path="url(#a)"><path fill="#F43E01" d="M.54.39h32v32h-32z"/><path fill="#fff" d="m18.445 4.406-9.468 13.74 7.341.665-1.69 9.578 9.469-13.74-7.342-.664 1.69-9.579Z"/></g><defs><clipPath id="a"><path fill="#fff" d="M.54.39h32v32h-32z"/></clipPath></defs></svg>`
			}
		};
	}
}

export default GroqPlugin;
