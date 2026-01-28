import { BasePlugin } from './base-plugin.js';
import type {
	IPipelineStepPlugin,
	StepExecutionOptions,
	StepProgressCallback,
	StepProgress
} from '../contracts/capabilities/pipeline-step.interface.js';
import type { MutableGenerationContext } from '../pipeline/generation-context.interface.js';
import type { PipelineStepDefinition, StepPosition } from '../pipeline/step-definition.types.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';
import type { BuiltInStepId } from '../pipeline/step-types.js';

/**
 * Abstract base class for pipeline step plugins
 * Provides common functionality and sensible defaults
 */
export abstract class BasePipelineStep extends BasePlugin implements IPipelineStepPlugin {
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline-step'];

	/** Step identifier - must be implemented */
	abstract readonly stepId: string;

	/** Step display name - must be implemented */
	abstract readonly stepName: string;

	/** Step description */
	readonly stepDescription?: string;

	/** Step position relative to built-in steps */
	abstract readonly stepPosition: StepPosition;

	/** Data keys this step provides */
	readonly provides: readonly string[] = [];

	/** Data keys this step requires */
	readonly requires: readonly string[] = [];

	/** Whether step can be skipped */
	readonly optional: boolean = false;

	/** Whether step can run in parallel */
	readonly parallelizable: boolean = false;

	/** Estimated duration in seconds */
	readonly estimatedDuration?: number;

	/**
	 * Execute the pipeline step
	 * Must be implemented by subclasses
	 */
	abstract execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext>;

	/**
	 * Get the step definition
	 */
	getStepDefinition(): PipelineStepDefinition {
		return {
			id: this.stepId,
			name: this.stepName,
			description: this.stepDescription,
			position: this.stepPosition,
			provides: this.provides,
			requires: this.requires,
			optional: this.optional,
			parallelizable: this.parallelizable,
			estimatedDuration: this.estimatedDuration
		};
	}

	/**
	 * Check if the step can be skipped
	 * Default: cannot skip unless optional
	 */
	async canSkip(_context: MutableGenerationContext): Promise<boolean> {
		return this.optional;
	}

	/**
	 * Estimate step duration
	 * Default: use estimatedDuration property or 5 seconds
	 */
	async estimateDuration(_context: MutableGenerationContext): Promise<number> {
		return (this.estimatedDuration ?? 5) * 1000;
	}

	/**
	 * Validate step can run
	 * Default: check required data keys are present
	 */
	async validate(context: MutableGenerationContext): Promise<{ valid: boolean; error?: string }> {
		for (const key of this.requires) {
			if (!(key in context) || context[key as keyof MutableGenerationContext] === undefined) {
				return {
					valid: false,
					error: `Missing required data: ${key}`
				};
			}
		}
		return { valid: true };
	}

	/**
	 * Rollback step changes on failure
	 * Default: no-op (subclasses can override)
	 */
	async rollback(_context: MutableGenerationContext, _error: Error): Promise<void> {
		// Default: no-op
	}

	// Helper methods for subclasses

	/**
	 * Create a step progress object
	 */
	protected createProgress(
		percent: number,
		message?: string,
		itemsProcessed?: number,
		totalItems?: number
	): StepProgress {
		return {
			percent: Math.min(100, Math.max(0, percent)),
			message,
			itemsProcessed,
			totalItems
		};
	}

	/**
	 * Report progress if callback is provided
	 */
	protected reportProgress(
		onProgress: StepProgressCallback | undefined,
		percent: number,
		message?: string,
		itemsProcessed?: number,
		totalItems?: number
	): void {
		if (onProgress) {
			onProgress(this.createProgress(percent, message, itemsProcessed, totalItems));
		}
	}

	/**
	 * Check if execution should be aborted
	 */
	protected shouldAbort(context: MutableGenerationContext, options?: StepExecutionOptions): boolean {
		if (context.shouldStop) {
			return true;
		}
		if (options?.signal?.aborted) {
			return true;
		}
		return false;
	}

	/**
	 * Create a position after a built-in step
	 */
	protected static after(stepId: BuiltInStepId): StepPosition {
		return { type: 'after', stepId };
	}

	/**
	 * Create a position before a built-in step
	 */
	protected static before(stepId: BuiltInStepId): StepPosition {
		return { type: 'before', stepId };
	}

	/**
	 * Create a position replacing a built-in step
	 */
	protected static replace(stepId: BuiltInStepId): StepPosition {
		return { type: 'replace', stepId };
	}

	/**
	 * Create a position at the start of the pipeline
	 */
	protected static first(): StepPosition {
		return { type: 'first' };
	}

	/**
	 * Create a position at the end of the pipeline
	 */
	protected static last(): StepPosition {
		return { type: 'last' };
	}
}
