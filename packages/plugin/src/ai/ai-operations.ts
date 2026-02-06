/**
 * Shared AI operations wrapping LangChain's ChatOpenAI and OpenAIEmbeddings.
 * All AI provider plugins delegate to this class rather than using LangChain directly.
 *
 * This follows the same pattern as GitOperations in packages/plugin/src/git/git-operations.ts.
 */
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type {
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	ChatMessage,
	EmbeddingOptions,
	EmbeddingResponse,
	AiModel
} from '../contracts/capabilities/ai-provider.interface.js';
import { TokenUsageTracker } from './token-usage.tracker.js';
import { getReasoningConfig } from './reasoning.utils.js';

export interface AiOperationsConfig {
	apiKey: string;
	model: string;
	baseURL?: string;
	temperature?: number;
	maxTokens?: number;
	providerType: string;
	embeddingModel?: string;
}

export class AiOperations {
	constructor(private defaultConfig: AiOperationsConfig) {}

	/**
	 * Create a chat completion using LangChain's ChatOpenAI.
	 */
	async createChatCompletion(
		options: ChatCompletionOptions,
		configOverrides?: Partial<AiOperationsConfig>
	): Promise<ChatCompletionResponse> {
		const config = this.mergeConfig(configOverrides);
		const model = options.model || config.model;
		const llm = this.createChatModel(config, model, options);
		const tracker = new TokenUsageTracker();
		const messages = this.toLangChainMessages(options.messages);

		const response = await llm.invoke(messages, { callbacks: [tracker] });

		const usage = tracker.usage.totalTokens > 0 ? tracker.usage : undefined;

		return {
			id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
			model,
			created: Date.now(),
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: typeof response.content === 'string' ? response.content : ''
					},
					finishReason: 'stop'
				}
			],
			usage: usage
				? {
						promptTokens: usage.inputTokens,
						completionTokens: usage.outputTokens,
						totalTokens: usage.totalTokens
					}
				: undefined
		};
	}

	/**
	 * Create a streaming chat completion.
	 */
	async *createStreamingChatCompletion(
		options: ChatCompletionOptions,
		configOverrides?: Partial<AiOperationsConfig>
	): AsyncIterable<ChatCompletionChunk> {
		const config = this.mergeConfig(configOverrides);
		const model = options.model || config.model;
		const llm = this.createChatModel(config, model, options);
		const messages = this.toLangChainMessages(options.messages);

		const stream = await llm.stream(messages);

		for await (const chunk of stream) {
			const content = typeof chunk.content === 'string' ? chunk.content : '';
			yield {
				id: `chatcmpl-${Date.now()}`,
				model,
				created: Date.now(),
				choices: [
					{
						index: 0,
						delta: { role: 'assistant', content },
						finishReason: null
					}
				]
			};
		}

		// Final chunk with finish reason
		yield {
			id: `chatcmpl-${Date.now()}`,
			model,
			created: Date.now(),
			choices: [
				{
					index: 0,
					delta: {},
					finishReason: 'stop'
				}
			]
		};
	}

	/**
	 * Create embeddings using LangChain's OpenAIEmbeddings.
	 */
	async createEmbedding(
		options: EmbeddingOptions,
		configOverrides?: Partial<AiOperationsConfig>
	): Promise<EmbeddingResponse> {
		const config = this.mergeConfig(configOverrides);
		const model = options.model || config.embeddingModel;

		if (!model) {
			throw new Error('Embedding model must be specified in options or config');
		}

		const embeddings = new OpenAIEmbeddings({
			apiKey: config.apiKey,
			model,
			...(config.baseURL && { configuration: { baseURL: config.baseURL } })
		});

		const inputs = Array.isArray(options.input) ? options.input : [options.input];
		const vectors = await embeddings.embedDocuments(inputs as string[]);

		return {
			model,
			embeddings: vectors
		};
	}

	/**
	 * List available models by calling the provider's /v1/models endpoint.
	 */
	async listModels(configOverrides?: Partial<AiOperationsConfig>): Promise<AiModel[]> {
		const config = this.mergeConfig(configOverrides);

		if (!config.baseURL) {
			throw new Error('baseURL is required to list models');
		}

		const modelsUrl = `${config.baseURL.replace(/\/+$/, '')}/models`;

		const response = await fetch(modelsUrl, {
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error(`Failed to list models: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as { data?: Array<Record<string, unknown>> };
		const models = data.data || [];

		return models.map((m) => ({
			id: String(m.id || ''),
			name: String(m.name || m.id || ''),
			description: m.description ? String(m.description) : undefined,
			capabilities: {
				supportsStructuredOutput: true,
				supportsStreaming: true,
				supportsToolCalling: true,
				supportsVision: false,
				maxContextLength: typeof m.context_length === 'number' ? m.context_length : 128000,
				maxOutputTokens: typeof m.max_output_tokens === 'number' ? m.max_output_tokens : undefined
			},
			inputCostPer1k:
				typeof m.pricing === 'object' && m.pricing !== null
					? Number((m.pricing as Record<string, unknown>).prompt) * 1000 || undefined
					: undefined,
			outputCostPer1k:
				typeof m.pricing === 'object' && m.pricing !== null
					? Number((m.pricing as Record<string, unknown>).completion) * 1000 || undefined
					: undefined
		}));
	}

	/**
	 * Test connection to the provider with a simple prompt.
	 */
	async testConnection(
		configOverrides?: Partial<AiOperationsConfig>
	): Promise<{ success: boolean; responseTime: number; error?: string }> {
		const startTime = Date.now();

		try {
			const config = this.mergeConfig(configOverrides);
			const llm = this.createChatModel(config, config.model);

			await llm.invoke([new HumanMessage('Respond with just "OK" to confirm you are working.')]);

			return {
				success: true,
				responseTime: Date.now() - startTime
			};
		} catch (error) {
			return {
				success: false,
				responseTime: Date.now() - startTime,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Update the default configuration.
	 */
	updateConfig(newConfig: Partial<AiOperationsConfig>): void {
		this.defaultConfig = { ...this.defaultConfig, ...newConfig };
	}

	// ========================================================================
	// Private helpers
	// ========================================================================

	private mergeConfig(overrides?: Partial<AiOperationsConfig>): AiOperationsConfig {
		if (!overrides) return this.defaultConfig;
		return { ...this.defaultConfig, ...overrides };
	}

	private createChatModel(config: AiOperationsConfig, model: string, options?: ChatCompletionOptions): ChatOpenAI {
		const reasoningConfig = getReasoningConfig(config.providerType, model);

		return new ChatOpenAI({
			apiKey: config.apiKey,
			model,
			temperature: options?.temperature ?? config.temperature,
			maxTokens: options?.maxTokens ?? config.maxTokens,
			...(config.baseURL && { configuration: { baseURL: config.baseURL } }),
			...(reasoningConfig && { modelKwargs: reasoningConfig })
		});
	}

	private toLangChainMessages(messages: readonly ChatMessage[]): Array<HumanMessage | SystemMessage | AIMessage> {
		return messages.map((msg) => {
			const content = typeof msg.content === 'string' ? msg.content : '';
			switch (msg.role) {
				case 'system':
					return new SystemMessage(content);
				case 'assistant':
					return new AIMessage(content);
				case 'user':
				default:
					return new HumanMessage(content);
			}
		});
	}
}
