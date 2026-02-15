import type { IBuiltInStepExecutor, IPipelineContext, StepExecutionContext } from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from './context/index.js';
import { getErrorMessage } from './utils/error.utils.js';
import type { BuiltInStepId } from './types.js';

/**
 * Base class for all standard pipeline steps.
 * run() satisfies IBuiltInStepExecutor; execute() is what steps implement.
 */
export abstract class BasePipelineStep implements IBuiltInStepExecutor {
	abstract readonly name: string;
	abstract readonly stepId: BuiltInStepId;

	async run(context: IPipelineContext, execContext: StepExecutionContext): Promise<IPipelineContext> {
		return this.execute(context as MutableGenerationContext, execContext);
	}

	abstract execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext>;

	protected accumulateMetrics(
		metrics: StandardPipelineMetrics,
		usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
		cost: number | null
	): void {
		if (!metrics.steps) {
			metrics.steps = {};
		}
		if (!metrics.steps[this.stepId]) {
			metrics.steps[this.stepId] = {
				name: this.name,
				startTime: Date.now(),
				success: true
			};
		}
		const stepMetrics = metrics.steps[this.stepId];
		if (!stepMetrics.custom) {
			stepMetrics.custom = {};
		}
		if (usage) {
			stepMetrics.custom.totalTokens = ((stepMetrics.custom.totalTokens as number) || 0) + usage.totalTokens;
		}
		if (cost) {
			stepMetrics.custom.totalCost = ((stepMetrics.custom.totalCost as number) || 0) + cost;
		}
	}

	protected addWarning(context: MutableGenerationContext, message: string): void {
		context.warnings.push(message);
	}

	protected formatError(error: unknown): string {
		return getErrorMessage(error);
	}
}
