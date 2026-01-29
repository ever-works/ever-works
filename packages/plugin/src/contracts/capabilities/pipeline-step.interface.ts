import type { IPlugin } from '../plugin.interface.js';
import type { MutableGenerationContext } from '../../pipeline/generation-context.interface.js';
import type { PipelineStepDefinition } from '../../pipeline/step-definition.types.js';

/**
 * Pipeline step execution options
 */
export interface StepExecutionOptions {
	/** Timeout in milliseconds */
	readonly timeout?: number;
	/** Whether to skip on error */
	readonly skipOnError?: boolean;
	/** Custom step settings */
	readonly settings?: Record<string, unknown>;
	/** Signal for cancellation */
	readonly signal?: AbortSignal;
}

/**
 * Step progress callback
 */
export type StepProgressCallback = (progress: StepProgress) => void;

/**
 * Step progress information
 */
export interface StepProgress {
	/** Progress percentage (0-100) */
	readonly percent: number;
	/** Progress message */
	readonly message?: string;
	/** Items processed */
	readonly itemsProcessed?: number;
	/** Total items to process */
	readonly totalItems?: number;
}

/**
 * Pipeline step plugin interface
 * Capability: 'pipeline-step'
 */
export interface IPipelineStepPlugin extends IPlugin {
	/**
	 * Get step definition(s).
	 *
	 * For single-step plugins: Call with no arguments to get the step definition.
	 * For multi-step plugins: Call with stepId to get a specific step, or no arguments
	 * to get the first/primary step definition.
	 *
	 * @param stepId - Optional step ID for multi-step plugins
	 * @returns The step definition, or undefined if stepId not found
	 */
	getStepDefinition(stepId?: string): PipelineStepDefinition | undefined;

	/**
	 * Get all step definitions (for multi-step plugins).
	 * Single-step plugins should return an array with one element.
	 */
	getStepDefinitions?(): PipelineStepDefinition[];

	/**
	 * Execute the pipeline step
	 * @param context - Mutable generation context
	 * @param options - Execution options
	 * @param onProgress - Progress callback
	 * @returns Modified context
	 */
	execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext>;

	/**
	 * Check if the step can be skipped
	 * @param context - Current generation context
	 * @returns Whether the step can be skipped
	 */
	canSkip?(context: MutableGenerationContext): Promise<boolean>;

	/**
	 * Estimate step duration
	 * @param context - Current generation context
	 * @returns Estimated duration in milliseconds
	 */
	estimateDuration?(context: MutableGenerationContext): Promise<number>;

	/**
	 * Validate step can run
	 * @param context - Current generation context
	 * @returns Whether step can run and any error message
	 */
	validate?(context: MutableGenerationContext): Promise<{ valid: boolean; error?: string }>;

	/**
	 * Rollback step changes on failure
	 * @param context - Current generation context
	 * @param error - Error that caused rollback
	 */
	rollback?(context: MutableGenerationContext, error: Error): Promise<void>;
}

/**
 * Type guard for pipeline step plugins
 */
export function isPipelineStepPlugin(plugin: IPlugin): plugin is IPipelineStepPlugin {
	return plugin.capabilities.includes('pipeline-step');
}
