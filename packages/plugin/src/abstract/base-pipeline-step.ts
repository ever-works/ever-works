import { BasePlugin } from './base-plugin.js';
import type { IPipelineModifierPlugin } from '../contracts/capabilities/pipeline-modifier.interface.js';
import type {
	StepExecutionOptions,
	StepProgressCallback,
	StepProgress
} from '../contracts/capabilities/pipeline-plugin.interface.js';
import type { IPipelineContext } from '../pipeline/generation-context.interface.js';
import type { PipelineStepDefinition, StepPosition } from '../pipeline/step-definition.types.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';

/**
 * Abstract base class for pipeline modifier plugins.
 * TContext defaults to IPipelineContext; subclasses can narrow it.
 */
export abstract class BasePipelineStep<TContext extends IPipelineContext = IPipelineContext>
	extends BasePlugin
	implements IPipelineModifierPlugin
{
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities: readonly string[] = ['pipeline-modifier'];

	abstract readonly stepId: string;
	abstract readonly stepName: string;
	abstract readonly stepPosition: StepPosition;
	abstract readonly targetPipelines: readonly string[];

	readonly stepDescription?: string;
	readonly provides: readonly string[] = [];
	readonly requires: readonly string[] = [];
	readonly optional: boolean = false;
	readonly parallelizable: boolean = false;
	readonly estimatedDuration?: number;

	abstract execute(
		context: TContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<TContext>;

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

	async canSkip(_context: TContext): Promise<boolean> {
		return this.optional;
	}

	async validate(context: TContext): Promise<{ valid: boolean; error?: string }> {
		for (const key of this.requires) {
			if (!(key in context) || (context as unknown as Record<string, unknown>)[key] === undefined) {
				return { valid: false, error: `Missing required data: ${key}` };
			}
		}
		return { valid: true };
	}

	async rollback(_context: TContext, _error: Error): Promise<void> {}

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

	protected shouldAbort(context: TContext, options?: StepExecutionOptions): boolean {
		return context.shouldStop === true || options?.signal?.aborted === true;
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
