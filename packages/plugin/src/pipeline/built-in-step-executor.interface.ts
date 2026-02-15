import type { IPipelineContext } from './generation-context.interface.js';
import type { StepExecutionContext } from './step-execution-context.interface.js';

/**
 * Interface for built-in step executors.
 * Steps cast context to their pipeline's concrete type internally.
 */
export interface IBuiltInStepExecutor {
	readonly name: string;
	run(context: IPipelineContext, execContext: StepExecutionContext): Promise<IPipelineContext>;
}
