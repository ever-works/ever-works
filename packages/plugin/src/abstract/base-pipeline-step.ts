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

/**
 * Abstract base class for pipeline step plugins.
 * Subclasses must implement: stepId, stepName, stepPosition, execute()
 */
export abstract class BasePipelineStep extends BasePlugin implements IPipelineStepPlugin {
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline-step'];

	abstract readonly stepId: string;
	abstract readonly stepName: string;
	abstract readonly stepPosition: StepPosition;

	readonly stepDescription?: string;
	readonly provides: readonly string[] = [];
	readonly requires: readonly string[] = [];
	readonly optional: boolean = false;
	readonly parallelizable: boolean = false;
	readonly estimatedDuration?: number;

	abstract execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext>;

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

	async canSkip(_context: MutableGenerationContext): Promise<boolean> {
		return this.optional;
	}

	async estimateDuration(_context: MutableGenerationContext): Promise<number> {
		return (this.estimatedDuration ?? 5) * 1000;
	}

	/** Validates that required data keys are present in context */
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

	/** Override to implement rollback on failure */
	async rollback(_context: MutableGenerationContext, _error: Error): Promise<void> {}

	// Helper methods

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

	protected shouldAbort(context: MutableGenerationContext, options?: StepExecutionOptions): boolean {
		if (context.shouldStop) {
			return true;
		}
		if (options?.signal?.aborted) {
			return true;
		}
		return false;
	}

	protected static after<TStepId extends string>(stepId: TStepId): StepPosition<TStepId> {
		return { type: 'after', stepId };
	}

	protected static before<TStepId extends string>(stepId: TStepId): StepPosition<TStepId> {
		return { type: 'before', stepId };
	}

	protected static replace<TStepId extends string>(stepId: TStepId): StepPosition<TStepId> {
		return { type: 'replace', stepId };
	}

	protected static first(): StepPosition {
		return { type: 'first' };
	}

	protected static last(): StepPosition {
		return { type: 'last' };
	}
}
