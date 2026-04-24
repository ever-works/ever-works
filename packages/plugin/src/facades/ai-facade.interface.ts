import type {
	AiModel,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk
} from '../contracts/capabilities/ai-provider.interface.js';
import type { IBaseFacade } from './base-facade.interface.js';
import type { FacadeOptions } from './facade-options.interface.js';
import type { TemplateVariables } from '../helpers/template.utils.js';

/**
 * Task complexity levels for AI model routing.
 * Used to select appropriate model tier based on task requirements.
 */
export type TaskComplexity = 'simple' | 'medium' | 'complex';

export interface AiFacadeTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

export interface AiRoutingOptions {
	readonly complexity?: TaskComplexity;
	readonly taskId?: string;
	readonly autoEscalate?: boolean;
	readonly providerOverride?: string;
	/** Bypasses complexity-based routing */
	readonly modelOverride?: string;
}

/**
 * Model routing configuration for AI providers.
 * Configurable at user or directory level via plugin settings.
 *
 * Resolution priority: directory > user > admin > plugin defaults
 */
export interface AiModelRoutingSettings {
	/** Default model when no complexity specified */
	readonly defaultModel: string;
	/** Model for simple tasks (fast, economical) */
	readonly simpleModel?: string;
	/** Model for medium complexity tasks (balanced) */
	readonly mediumModel?: string;
	/** Model for complex tasks (high quality) */
	readonly complexModel?: string;
}

export interface AskJsonOptions<Template extends string = string> {
	/** Temperature for response generation (0-2) */
	readonly temperature?: number;
	/** Template variables to substitute */
	readonly variables?: TemplateVariables<Template>;
	/** Routing options for model selection */
	readonly routing?: AiRoutingOptions;
}

export interface AskJsonResponse<T> {
	/** Parsed result matching the schema */
	readonly result: T;
	/** Token usage statistics */
	readonly usage: AiFacadeTokenUsage | null;
	/** Estimated cost in USD */
	readonly cost: number | null;
	/** Provider plugin ID used for the request */
	readonly provider: string;
	/** Model used for the request */
	readonly model: string;
}

/**
 * Generic schema type that works with Zod or any schema validator.
 * Use ZodSchema<T> if zod is available.
 */
export interface SchemaType<T = unknown> {
	parse(data: unknown): T;
	safeParse(data: unknown): { success: boolean; data?: T; error?: unknown };
}

/**
 * AI Facade interface for pipeline steps.
 *
 * This is a simplified interface that steps use to interact with AI providers.
 * The actual implementation handles provider resolution, settings, and error handling.
 */
export interface AiProviderConfig {
	readonly providerId: string;
	readonly providerName: string;
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly defaultModel?: string;
	readonly routing: {
		readonly simpleModel?: string;
		readonly mediumModel?: string;
		readonly complexModel?: string;
	};
}

export interface IAiFacade extends IBaseFacade {
	/**
	 * Send a prompt and get a structured JSON response.
	 *
	 * This is the primary method used by pipeline steps for AI operations.
	 * It handles model routing, structured output, and usage tracking.
	 *
	 * @param promptTemplate - Prompt template with {variable} placeholders
	 * @param schema - Zod schema or compatible schema for response validation
	 * @param options - Optional configuration (temperature, variables, routing)
	 * @returns Structured response with result, usage, and cost
	 *
	 * @example
	 * ```typescript
	 * const { result, usage, cost } = await aiFacade.askJson(
	 *     'Analyze this text: {text}',
	 *     AnalysisSchema,
	 *     {
	 *         temperature: 0.1,
	 *         variables: { text: 'Hello world' },
	 *         routing: { complexity: 'simple' }
	 *     },
	 *     { userId: user.id, directoryId: directory.id }
	 * );
	 * ```
	 */
	askJson<T, Template extends string = string>(
		promptTemplate: Template,
		schema: SchemaType<T>,
		options: AskJsonOptions<Template> | undefined,
		facadeOptions: FacadeOptions
	): Promise<AskJsonResponse<T>>;

	/**
	 * Create a chat completion (non-streaming).
	 */
	createChatCompletion(options: ChatCompletionOptions, facadeOptions: FacadeOptions): Promise<ChatCompletionResponse>;

	/**
	 * Create a streaming chat completion.
	 */
	createStreamingChatCompletion(
		options: ChatCompletionOptions,
		facadeOptions: FacadeOptions
	): AsyncGenerator<ChatCompletionChunk>;

	/**
	 * Test the AI provider connection.
	 * Returns health check result with success status and response time.
	 */
	testConnection(facadeOptions: FacadeOptions): Promise<{
		success: boolean;
		provider: string;
		model: string;
		responseTime: number;
		error?: string;
	}>;

	/**
	 * Get available models from the configured AI provider.
	 * Used by UI to populate model selection dropdowns for routing configuration.
	 *
	 * @returns List of available models with their capabilities
	 */
	getAvailableModels(facadeOptions: FacadeOptions): Promise<readonly AiModel[]>;

	/**
	 * Get the resolved provider configuration including connection details and model routing.
	 */
	getProviderConfig(facadeOptions: FacadeOptions): Promise<AiProviderConfig>;

	/**
	 * Resolve model metadata for the configured provider or a shared catalog fallback.
	 * Returns `null` when metadata cannot be resolved.
	 */
	resolveModelMetadata(modelId: string, facadeOptions: FacadeOptions): Promise<AiModel | null>;

	/**
	 * Resolve context window size (tokens) for a model via provider metadata or catalog fallback.
	 * Never throws — returns a safe default (128K) on any failure.
	 */
	resolveModelContextLength(modelId: string, facadeOptions: FacadeOptions): Promise<number>;
}
