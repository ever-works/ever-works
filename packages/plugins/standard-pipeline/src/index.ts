/**
 * Standard Pipeline Plugin
 *
 * This plugin is the **single source of truth** for all built-in pipeline steps.
 * The pipeline engine itself has no hardcoded knowledge of steps - it queries
 * this plugin for step definitions.
 *
 * @packageDocumentation
 */

export { StandardPipelinePlugin } from './standard-pipeline.plugin.js';

// Types - BuiltInStepId is the source of truth for step identifiers
export type { BuiltInStepId } from './types.js';
export { BUILT_IN_STEP_IDS, isBuiltInStepId } from './types.js';

// Step implementations
export * from './steps/index.js';

// Default export for plugin loader
export { default } from './standard-pipeline.plugin.js';
