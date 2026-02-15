import type { IPlugin } from '../plugin.interface.js';
import type { IPipelineContext } from '../../pipeline/generation-context.interface.js';
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
	readonly targetPipelines: readonly string[];

	getStepDefinitions?(): PipelineStepDefinition[];
	getStepDefinition?(stepId?: string): PipelineStepDefinition | undefined;

	execute(
		context: IPipelineContext,
		options?: StepExecutionOptions,
		onProgress?: StepProgressCallback
	): Promise<IPipelineContext>;

	canSkip?(context: IPipelineContext): Promise<boolean>;
	validate?(context: IPipelineContext): Promise<{ valid: boolean; error?: string }>;
	rollback?(context: IPipelineContext, error: Error): Promise<void>;
}

export function isPipelineModifierPlugin(plugin: IPlugin): plugin is IPipelineModifierPlugin {
	return plugin.capabilities.includes('pipeline-modifier');
}
