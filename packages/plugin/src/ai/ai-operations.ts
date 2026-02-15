/**
 * Shared AI operations wrapping LangChain's ChatOpenAI and OpenAIEmbeddings.
 * All AI provider plugins delegate to this class rather than using LangChain directly.
 *
 * This follows the same pattern as GitOperations in packages/plugin/src/git/git-operations.ts.
 */
import type { ZodType } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage, type AIMessageChunk } from '@langchain/core/messages';
import type {
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	ChatMessage,
	EmbeddingOptions,
	EmbeddingResponse,
	AiModel,
	AskJsonCompletionResponse
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

	/** Per-model cache of params the provider has rejected (e.g. temperature, reasoning). */
	private readonly rejectedParams = new Map<string, Set<string>>();

	/**
	 * Create a chat completion using LangChain's ChatOpenAI.
	 * Plain text only — for structured JSON output, use `askJson` instead.
	 */
	async createChatCompletion(
		options: ChatCompletionOptions,
		configOverrides?: Partial<AiOperationsConfig>
	): Promise<ChatCompletionResponse> {
		const config = this.mergeConfig(configOverrides);
		const model = options.model || config.model;

		return this.withParamRetry(model, async (skip) => {
			const llm = this.createChatModel(config, model, options, skip);
			const tracker = new TokenUsageTracker();
			const messages = this.toLangChainMessages(options.messages);

			const response = await llm.invoke(messages, { callbacks: [tracker] });
			const content = typeof response.content === 'string' ? response.content : '';

			return {
				id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
				model,
				created: Date.now(),
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content },
						finishReason: 'stop'
					}
				],
				usage: this.mapTokenUsage(tracker)
			};
		});
	}

	/** Structured JSON output. Falls back to raw invoke + jsonrepair on failure. */
	async askJson(
		prompt: string,
		schema: ZodType,
		configOverrides?: Partial<AiOperationsConfig>,
		options?: { temperature?: number; maxTokens?: number }
	): Promise<AskJsonCompletionResponse> {
		const config = this.mergeConfig(configOverrides);
		const model = config.model;

		return this.withParamRetry(model, async (skip) => {
			const llm = this.createChatModel(
				config,
				model,
				{
					messages: [],
					temperature: options?.temperature,
					maxTokens: options?.maxTokens
				} as ChatCompletionOptions,
				skip
			);

			const tracker = new TokenUsageTracker();
			const result = skip.has('structured_output')
				? await this.invokeWithJsonRepair(llm, prompt, schema, tracker)
				: await this.invokeStructured(llm, prompt, schema, model, tracker);

			return { result, model, usage: this.mapTokenUsage(tracker) };
		});
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
		const messages = this.toLangChainMessages(options.messages);

		const skip = new Set(this.rejectedParams.get(model));
		let stream: AsyncIterable<AIMessageChunk>;
		try {
			stream = await this.createChatModel(config, model, options, skip).stream(messages);
		} catch (error) {
			const param = this.parseRejectedParam(error);
			if (!param || skip.has(param)) throw error;
			skip.add(param);
			this.rejectedParams.set(model, new Set(skip));
			stream = await this.createChatModel(config, model, options, skip).stream(messages);
		}

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

	/** Attempt structured output; re-throw cacheable rejections, fall back to jsonrepair for other errors. */
	private async invokeStructured(
		llm: ChatOpenAI,
		prompt: string,
		schema: ZodType,
		model: string,
		tracker: TokenUsageTracker
	): Promise<unknown> {
		try {
			return await llm.withStructuredOutput(schema).invoke([new HumanMessage(prompt)], {
				callbacks: [tracker]
			});
		} catch (error) {
			if (this.parseRejectedParam(error)) throw error;

			console.warn(
				`[AiOperations] Structured output failed for model "${model}", falling back to jsonrepair:`,
				error instanceof Error ? error.message : error
			);
			return this.invokeWithJsonRepair(llm, prompt, schema, tracker);
		}
	}

	/** Raw invoke → jsonrepair → zod parse. */
	private async invokeWithJsonRepair(
		llm: ChatOpenAI,
		prompt: string,
		schema: ZodType,
		tracker: TokenUsageTracker
	): Promise<unknown> {
		const raw = await llm.invoke([new HumanMessage(prompt)], { callbacks: [tracker] });
		const content = typeof raw.content === 'string' ? raw.content : '';
		return schema.parse(JSON.parse(jsonrepair(content)));
	}

	private mergeConfig(overrides?: Partial<AiOperationsConfig>): AiOperationsConfig {
		if (!overrides) return this.defaultConfig;
		return { ...this.defaultConfig, ...overrides };
	}

	private createChatModel(
		config: AiOperationsConfig,
		model: string,
		options?: ChatCompletionOptions,
		skip?: Set<string>
	): ChatOpenAI {
		const modelKwargs: Record<string, unknown> = {};

		if (!skip?.has('reasoning')) {
			const reasoningConfig = getReasoningConfig(config.providerType, model);
			if (reasoningConfig) Object.assign(modelKwargs, reasoningConfig);
		}

		if (options?.responseFormat) {
			modelKwargs.response_format = options.responseFormat;
		}

		const temperature = skip?.has('temperature') ? undefined : (options?.temperature ?? config.temperature);

		return new ChatOpenAI({
			apiKey: config.apiKey,
			model,
			temperature,
			maxTokens: options?.maxTokens ?? config.maxTokens,
			...(config.baseURL && { configuration: { baseURL: config.baseURL } }),
			...(Object.keys(modelKwargs).length > 0 && { modelKwargs })
		});
	}

	/**
	 * Generic retry: if the API rejects an unsupported parameter, rebuild
	 * the model without it and retry once. Handles temperature, reasoning,
	 * etc. across all providers/models in one place.
	 *
	 * Uses a per-model cache so the same param is never sent twice.
	 */
	private async withParamRetry<T>(model: string, operation: (skip: Set<string>) => Promise<T>): Promise<T> {
		const skip = new Set(this.rejectedParams.get(model));
		try {
			return await operation(skip);
		} catch (error) {
			const param = this.parseRejectedParam(error);
			if (param && !skip.has(param)) {
				skip.add(param);
				this.rejectedParams.set(model, new Set(skip));
				return operation(skip);
			}
			throw error;
		}
	}

	private mapTokenUsage(tracker: TokenUsageTracker) {
		const usage = tracker.usage;
		if (usage.totalTokens === 0) return undefined;
		return {
			promptTokens: usage.inputTokens,
			completionTokens: usage.outputTokens,
			totalTokens: usage.totalTokens
		};
	}

	private parseRejectedParam(error: unknown): string | undefined {
		if (!(error instanceof Error)) return undefined;
		const msg = error.message.toLowerCase();
		if (msg.includes("'temperature'") || msg.includes('"temperature"')) return 'temperature';
		if (msg.includes("'reasoning'") || msg.includes("'reasoning_effort'")) return 'reasoning';
		if (msg.includes('json_schema') || msg.includes('response_format') || msg.includes('structured output'))
			return 'structured_output';
		return undefined;
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
