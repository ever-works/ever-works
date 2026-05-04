/**
 * Pipeline module exports
 *
 * This module provides the plugin-driven pipeline system for work generation.
 * It supports step replacement, injection, disabling, and positioning through plugins.
 */

// Re-export IBuiltInStepExecutor type from the plugin SDK
export type { IBuiltInStepExecutor } from '@ever-works/plugin';

// Pipeline builder service
export {
    PipelineBuilderService,
    CircularDependencyError,
    MissingDependencyError,
} from './pipeline-builder.service';

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

// Pipeline facade service (shared facade binding)
export { PipelineFacadeService } from './pipeline-facade.service';

// Pipeline orchestrator (main entry point)
export {
    PipelineOrchestratorService,
    type PipelineExecutionMode,
} from './pipeline-orchestrator.service';

// Pipeline module
export { PipelineModule } from './pipeline.module';

// Pipeline validators
export {
    validatePipelineResult,
    validatePipelineResultOrThrow,
    type PipelineResultValidation,
} from './validators';
