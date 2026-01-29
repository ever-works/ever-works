/**
 * Pipeline module exports
 *
 * This module provides the plugin-driven pipeline system for directory generation.
 * It supports step replacement, injection, disabling, and positioning through plugins.
 */

// Type-safe generation context
export { TypedGenerationContext, createGenerationContext } from './generation-context';

// Built-in steps
export {
    BUILT_IN_STEPS,
    BUILT_IN_STEPS_MAP,
    BUILT_IN_STEP_SERVICE_MAP,
    getBuiltInStep,
    isBuiltInStep,
    getBuiltInStepIds,
} from './built-in-steps';

// Default pipeline plugin
export { DefaultPipelinePlugin, type IBuiltInStepExecutor } from './default-pipeline.plugin';

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
