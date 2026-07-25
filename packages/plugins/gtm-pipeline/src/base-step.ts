import type { FacadeOptions, IBuiltInStepExecutor, IPipelineContext, StepExecutionContext } from '@ever-works/plugin';
import { GtmPipelineContext } from './context.js';
import type { GtmStageId } from './types.js';
import { resolveGtmSettings, type GtmPipelineSettings } from './settings.js';

/**
 * Base class for all GTM pipeline stages.
 * run() satisfies IBuiltInStepExecutor; execute() is what stages implement.
 */
export abstract class BaseGtmStep implements IBuiltInStepExecutor {
	abstract readonly name: string;
	abstract readonly stepId: GtmStageId;

	async run(context: IPipelineContext, execContext: StepExecutionContext): Promise<IPipelineContext> {
		return this.execute(context as GtmPipelineContext, execContext);
	}

	abstract execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext>;

	protected settingsOf(context: GtmPipelineContext): GtmPipelineSettings {
		return resolveGtmSettings(context.request.config);
	}

	protected facadeOptions(execContext: StepExecutionContext): FacadeOptions {
		return {
			userId: execContext.user?.id ?? execContext.work.user?.id ?? '',
			workId: execContext.work.id
		};
	}

	protected addWarning(context: GtmPipelineContext, message: string): void {
		context.warnings.push(message);
	}

	protected formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
