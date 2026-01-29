/**
 * Pipeline module exports
 *
 * This module provides the plugin-driven pipeline system for directory generation.
 * It supports step replacement, injection, disabling, and positioning through plugins.
 */

// Type-safe generation context
export { TypedGenerationContext, createGenerationContext } from './generation-context';

// Default pipeline plugin (NestJS wrapper around standalone plugin)
// The standalone plugin in @ever-works/default-pipeline-plugin is the single source of truth
export { DefaultPipelinePlugin, type IBuiltInStepExecutor } from './default-pipeline.plugin';

// Backwards-compatible exports - these now delegate to DefaultPipelinePlugin static methods
// Prefer using DefaultPipelinePlugin.getBuiltInSteps() etc. directly
import { DefaultPipelinePlugin } from './default-pipeline.plugin';

/** @deprecated Use DefaultPipelinePlugin.getBuiltInSteps() instead */
export const BUILT_IN_STEPS = DefaultPipelinePlugin.getBuiltInSteps();

/** @deprecated Use DefaultPipelinePlugin.getBuiltInSteps() to get a Map instead */
export const BUILT_IN_STEPS_MAP = new Map(
    DefaultPipelinePlugin.getBuiltInSteps().map((step) => [step.id, step]),
);

/** @deprecated Use DefaultPipelinePlugin.getServiceMap() instead */
export const BUILT_IN_STEP_SERVICE_MAP = DefaultPipelinePlugin.getServiceMap();

/** @deprecated Use DefaultPipelinePlugin.getBuiltInStep() instead */
export const getBuiltInStep = DefaultPipelinePlugin.getBuiltInStep;

/** @deprecated Use DefaultPipelinePlugin.isBuiltInStep() instead */
export const isBuiltInStep = DefaultPipelinePlugin.isBuiltInStep;

/** @deprecated Use DefaultPipelinePlugin.getBuiltInStepIds() instead */
export const getBuiltInStepIds = DefaultPipelinePlugin.getBuiltInStepIds;

// Pipeline builder service
export {
    PipelineBuilderService,
    CircularDependencyError,
    MissingDependencyError,
} from './pipeline-builder.service';

// Step adapter service (bridges legacy step services to plugin system)
export { StepAdapterService, type ILegacyPipelineStep } from './step-adapter.service';

// Executable pipeline runtime
export {
    ExecutablePipelineRunner,
    PipelineRuntimeEvents,
    type StateChangePayload,
} from './executable-pipeline.class';

// Step-based pipeline executor
export {
    StepPipelineExecutorService,
    PipelineEvents,
    type CheckpointData,
} from './step-pipeline-executor.service';

// Full pipeline executor
export { FullPipelineExecutorService } from './full-pipeline-executor.service';

// Pipeline orchestrator (main entry point)
export {
    PipelineOrchestratorService,
    type PipelineExecutionMode,
} from './pipeline-orchestrator.service';

// Provider override service
export {
    ProviderOverrideService,
    type ProviderOverrideContext,
    type ProviderOverrideResult,
} from './provider-override.service';
