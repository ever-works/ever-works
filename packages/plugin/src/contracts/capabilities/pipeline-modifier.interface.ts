import type { IPlugin } from '../plugin.interface.js';
import type { IPipelineContext } from '../../pipeline/generation-context.interface.js';
import type { PipelineStepDefinition } from '../../pipeline/step-definition.types.js';
import type { StepExecutionOptions, StepProgressCallback } from './pipeline-plugin.interface.js';

/**
 * Build-time check input passed to `IPipelineModifierPlugin.canSkipAtBuildTime`.
 *
 * The narrow shape — settings + scope keys + pipeline id — is everything
 * a sensible build-time decision needs. We deliberately do NOT pass an
 * `IPipelineContext` here because the host pipeline hasn't constructed
 * its context yet at build time, and a "partial context" contract would
 * be a footgun (each modifier would have to defensively `?.` every field
 * it might want to read).
 */
export interface ModifierBuildTimeCheck {
	/** Resolved plugin settings (4-level hierarchy, secrets included). */
	readonly settings: Record<string, unknown>;
	/** The Work the pipeline is being built for, when one exists. */
	readonly workId?: string;
	/** The user the pipeline is being built for, when one exists. */
	readonly userId?: string;
	/** Id of the host pipeline (e.g. `'standard-pipeline'`). */
	readonly pipelineId: string;
}

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

	/**
	 * Called by `PipelineBuilderService` before this modifier's steps
	 * are injected into the host pipeline. Return `true` to skip the
	 * modifier entirely for the given run — neither its injected steps
	 * nor its `execute()` will fire.
	 *
	 * Distinct from `canSkip(context)` (kept for backwards compatibility
	 * / runtime-decided skips): the build-time hook has a narrow,
	 * settings-focused signature that's resolvable BEFORE the host
	 * pipeline has constructed its context. Use this for the common
	 * "skip when an opt-in flag is off" case; use `canSkip(context)`
	 * for runtime decisions that need pipeline state.
	 *
	 * Added in PR #1087 — Workspace KB
	 * `2026-05-28-pipeline-builder-canskip-proposal.md` option B.
	 */
	canSkipAtBuildTime?(input: ModifierBuildTimeCheck): Promise<boolean>;

	canSkip?(context: IPipelineContext): Promise<boolean>;
	validate?(context: IPipelineContext): Promise<{ valid: boolean; error?: string }>;
	rollback?(context: IPipelineContext, error: Error): Promise<void>;
}

export function isPipelineModifierPlugin(plugin: IPlugin): plugin is IPipelineModifierPlugin {
	return plugin.capabilities.includes('pipeline-modifier');
}
