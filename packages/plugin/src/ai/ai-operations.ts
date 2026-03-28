/**
 * Shared AI operations wrapping LangChain's ChatOpenAI and OpenAIEmbeddings.
 * All AI provider plugins delegate to this class rather than using LangChain directly.
 *
 * This follows the same pattern as GitOperations in packages/plugin/src/git/git-operations.ts.
 */
import type { ZodType } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import {
	HumanMessage,
	SystemMessage,
	AIMessage,
	ToolMessage,
	type AIMessageChunk,
	type BaseMessage
} from '@langchain/core/messages';
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
			const baseLlm = this.createChatModel(config, model, options, skip);
			const llm = this.bindTools(baseLlm, options, skip);
			const tracker = new TokenUsageTracker();
			const messages = this.toLangChainMessages(options.messages);

			const response = await llm.invoke(messages, { callbacks: [tracker] });
			const content = typeof response.content === 'string' ? response.content : '';

			// Extract tool calls from LangChain response
			const toolCalls = response.tool_calls?.length
				? response.tool_calls.map((tc) => ({
						id: tc.id ?? `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
						type: 'function' as const,
						function: {
							name: tc.name,
							arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
						}
					}))
				: undefined;

			const hasToolCalls = toolCalls && toolCalls.length > 0;

			return {
				id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
				model,
				created: Date.now(),
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant' as const,
							content,
							...(hasToolCalls && { toolCalls })
						},
						finishReason: hasToolCalls ? ('tool_calls' as const) : ('stop' as const)
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
			const baseLlm = this.createChatModel(config, model, options, skip);
			const llm = this.bindTools(baseLlm, options, skip);
			stream = await llm.stream(messages);
		} catch (error) {
			const param = this.parseRejectedParam(error);
			if (!param || skip.has(param)) throw error;
			skip.add(param);
			this.rejectedParams.set(model, new Set(skip));
			const baseLlm = this.createChatModel(config, model, options, skip);
			const llm = this.bindTools(baseLlm, options, skip);
			stream = await llm.stream(messages);
		}

		let hadToolCalls = false;
		let isFirstChunk = true;
		const seenToolCallIds = new Map<number, string>();

		for await (const chunk of stream) {
			const content = typeof chunk.content === 'string' ? chunk.content : '';

			const toolCallChunks = chunk.tool_call_chunks?.length
				? chunk.tool_call_chunks.map((tc) => {
						const idx = tc.index ?? seenToolCallIds.size;
						const isNew = !seenToolCallIds.has(idx);
						if (isNew && tc.id) seenToolCallIds.set(idx, tc.id);

						return {
							index: idx,
							id: isNew ? tc.id || `call_${Date.now()}_${idx}` : undefined,
							type: isNew ? ('function' as const) : undefined,
							function: {
								name: isNew ? (tc.name ?? '') : undefined,
								arguments: tc.args ?? ''
							}
						};
					})
				: undefined;

			if (toolCallChunks?.length) hadToolCalls = true;

			const delta: Record<string, unknown> = {};
			if (isFirstChunk) {
				delta.role = 'assistant';
				isFirstChunk = false;
			}
			if (content) delta.content = content;
			if (toolCallChunks?.length) delta.toolCalls = toolCallChunks;

			yield {
				id: `chatcmpl-${Date.now()}`,
				model,
				created: Date.now(),
				choices: [
					{
						index: 0,
						delta: delta as Partial<ChatMessage>,
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
					finishReason: hadToolCalls ? 'tool_calls' : 'stop'
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

	/**
	 * Bind tools to a ChatOpenAI model when tool definitions are provided.
	 * Uses llm.bind() with OpenAI-format tools to ensure the `type: 'function'`
	 * wrapper is always present in the API request.
	 */
	private bindTools(llm: ChatOpenAI, options?: ChatCompletionOptions, skip?: Set<string>): ChatOpenAI {
		if (!options?.tools?.length || skip?.has('tools')) {
			return llm;
		}

		const tools = options.tools.map((t) => ({
			type: 'function' as const,
			function: {
				name: t.function.name,
				description: t.function.description ?? '',
				parameters: t.function.parameters ?? {}
			}
		}));

		const bindArgs: Record<string, unknown> = { tools };
		if (options.toolChoice) {
			bindArgs.tool_choice = options.toolChoice;
		}

		return llm.bind(bindArgs) as unknown as ChatOpenAI;
	}

	private parseRejectedParam(error: unknown): string | undefined {
		if (!(error instanceof Error)) return undefined;
		const msg = error.message.toLowerCase();
		if (msg.includes("'temperature'") || msg.includes('"temperature"')) return 'temperature';
		if (msg.includes("'reasoning'") || msg.includes("'reasoning_effort'")) return 'reasoning';
		if (msg.includes('json_schema') || msg.includes('response_format') || msg.includes('structured output'))
			return 'structured_output';
		if (msg.includes("'tools'") || msg.includes('"tools"') || msg.includes('tool_choice')) return 'tools';
		return undefined;
	}

	private toLangChainMessages(messages: readonly ChatMessage[]): BaseMessage[] {
		return messages.map((msg) => {
			const content = typeof msg.content === 'string' ? msg.content : '';
			switch (msg.role) {
				case 'system':
					return new SystemMessage(content);
				case 'assistant': {
					const aiMsg = new AIMessage({ content });
					if (msg.toolCalls?.length) {
						aiMsg.tool_calls = msg.toolCalls.map((tc) => ({
							id: tc.id,
							name: tc.function.name,
							args: this.safeParseJson(tc.function.arguments),
							type: 'tool_call' as const
						}));
					}
					return aiMsg;
				}
				case 'tool':
					return new ToolMessage({
						content,
						tool_call_id: msg.toolCallId ?? ''
					});
				case 'user':
				default:
					return new HumanMessage(content);
			}
		});
	}

	private safeParseJson(value: string): Record<string, unknown> {
		try {
			return JSON.parse(value);
		} catch {
			return {};
		}
	}
}
