import type { AiModel } from '../contracts/capabilities/ai-provider.interface.js';
import type { FacadeOptions } from './facade-options.interface.js';

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
	readonly defaultModel?: string;
	/** Model for simple tasks (fast, economical) */
	readonly simpleModel?: string;
	/** Model for medium complexity tasks (balanced) */
	readonly mediumModel?: string;
	/** Model for complex tasks (high quality) */
	readonly complexModel?: string;
}

export interface AskJsonOptions {
	/** Temperature for response generation (0-2) */
	readonly temperature?: number;
	/** Template variables to substitute */
	readonly variables?: Record<string, string>;
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
export interface IAiFacade {
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
	 *     }
	 * );
	 * ```
	 */
	askJson<T>(
		promptTemplate: string,
		schema: SchemaType<T>,
		options?: AskJsonOptions,
		facadeOptions?: FacadeOptions
	): Promise<AskJsonResponse<T>>;

	/**
	 * Check if AI service is configured and available.
	 */
	isConfigured(): boolean;

	/**
	 * Test the AI provider connection.
	 * Returns health check result with success status and response time.
	 */
	testConnection(facadeOptions?: FacadeOptions): Promise<{
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
	getAvailableModels(facadeOptions?: FacadeOptions): Promise<readonly AiModel[]>;
}
