import type { MutableGenerationContext } from './generation-context.interface.js';
import type { StepExecutionContext } from './step-execution-context.interface.js';

/**
 * Interface for built-in step executors.
 *
 * Each built-in step in the default pipeline implements this interface.
 * The step receives both the mutable generation context and an execution
 * context containing facades for AI, Search, Screenshot, etc.
 */
export interface IBuiltInStepExecutor {
	/**
	 * Human-readable name of the step
	 */
	readonly name: string;

	/**
	 * Execute the step
	 *
	 * @param context - Mutable generation context with accumulated state
	 * @param execContext - Execution context with facades and utilities
	 * @returns Modified context (mutations are allowed)
	 */
	run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext>;
}
