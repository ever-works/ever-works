import type { IPlugin } from '../plugin.interface.js';
import type { MutableGenerationContext } from '../../pipeline/generation-context.interface.js';
import type { PipelineStepDefinition } from '../../pipeline/step-definition.types.js';
import type { StepExecutionOptions, StepProgressCallback } from './pipeline-plugin.interface.js';

/**
 * Pipeline modifier plugin interface.
 * Capability: 'pipeline-modifier'
 *
 * Modifiers add/remove/disable steps in a target pipeline.
 * They must declare which pipeline(s) they target via `targetPipelines`.
 *
 * Use ['*'] to target all engine-orchestratable pipelines.
 */
export interface IPipelineModifierPlugin extends IPlugin {
	/** Which pipeline(s) this modifier targets. Use ['*'] for all. */
	readonly targetPipelines: readonly string[];

	/** Get step definitions to add/inject */
	getStepDefinitions?(): PipelineStepDefinition[];
	getStepDefinition?(stepId?: string): PipelineStepDefinition | undefined;

	/** Execute a modifier-provided step */
	execute(
		context: MutableGenerationContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<MutableGenerationContext>;

	/** Can this step be skipped? */
	canSkip?(context: MutableGenerationContext): Promise<boolean>;
	/** Validate before execution */
	validate?(context: MutableGenerationContext): Promise<{ valid: boolean; error?: string }>;
	/** Rollback on failure */
	rollback?(context: MutableGenerationContext, error: Error): Promise<void>;
}

/**
 * Type guard for pipeline modifier plugins
 */
export function isPipelineModifierPlugin(plugin: IPlugin): plugin is IPipelineModifierPlugin {
	return plugin.capabilities.includes('pipeline-modifier');
}
