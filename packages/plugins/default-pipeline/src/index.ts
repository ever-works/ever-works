/**
 * Default Pipeline Plugin
 *
 * This plugin is the **single source of truth** for all built-in pipeline steps.
 * The pipeline engine itself has no hardcoded knowledge of steps - it queries
 * this plugin for step definitions.
 *
 * @packageDocumentation
 */

export { DefaultPipelinePlugin, type IBuiltInStepExecutor } from './default-pipeline.plugin';

// Default export for plugin loader
export { default } from './default-pipeline.plugin';
