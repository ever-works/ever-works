import type { IPlugin } from '../plugin.interface.js';
import type { IPipelineStepPlugin, StepExecutionOptions, StepProgressCallback } from './pipeline-step.interface.js';
import type { IFormSchemaProvider } from './form-schema-provider.interface.js';
import type { PipelineStepDefinition } from '../../pipeline/step-definition.types.js';
import type { MutableGenerationContext } from '../../pipeline/generation-context.interface.js';
import type { StepExecutionContext } from '../../pipeline/step-execution-context.interface.js';
import type { IBuiltInStepExecutor } from '../../pipeline/built-in-step-executor.interface.js';

/**
 * Interface for the default/built-in pipeline plugin.
 *
 * This is a specialized system plugin that:
 * - Provides ALL built-in step definitions (single source of truth)
 * - Registers step executors for each step
 * - Provides form schema for generator UI
 * - Cannot be disabled (system plugin)
 *
 * @typeParam TStepId - Union type of valid step IDs (e.g., BuiltInStepId)
 */
export interface IDefaultPipelinePlugin<TStepId extends string = string>
	extends IPipelineStepPlugin<TStepId>, IFormSchemaProvider {
	/** Must be true - system plugins cannot be disabled */
	readonly systemPlugin: true;

	/** Get all step definitions with type-safe IDs */
	getStepDefinitions(): PipelineStepDefinition<TStepId>[];

	/** Get a specific step definition by ID */
	getStepDefinition(stepId?: TStepId | string): PipelineStepDefinition<TStepId> | undefined;

	/** Check if a step ID is valid for this pipeline */
	isValidStepId(stepId: string): stepId is TStepId;

	/** Get all valid step IDs */
	getStepIds(): readonly TStepId[];

	/** Register a step executor */
	registerStepExecutor(stepId: TStepId, executor: IBuiltInStepExecutor): void;

	/** Check if executor is registered for step */
	hasExecutor(stepId: TStepId): boolean;

	/** Execute a specific step */
	executeStep(
		stepId: TStepId | string,
		context: MutableGenerationContext,
		execContext: StepExecutionContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext>;
}

/**
 * Type guard for default pipeline plugins
 */
export function isDefaultPipelinePlugin<TStepId extends string = string>(
	plugin: IPlugin
): plugin is IDefaultPipelinePlugin<TStepId> {
	return (
		plugin.capabilities.includes('pipeline-step') &&
		plugin.capabilities.includes('form-schema-provider') &&
		(plugin as IDefaultPipelinePlugin<TStepId>).systemPlugin === true &&
		typeof (plugin as IDefaultPipelinePlugin<TStepId>).getStepDefinitions === 'function' &&
		typeof (plugin as IDefaultPipelinePlugin<TStepId>).registerStepExecutor === 'function' &&
		typeof (plugin as IDefaultPipelinePlugin<TStepId>).isValidStepId === 'function'
	);
}
