/**
 * OpenCode Generator Plugin
 *
 * Full pipeline plugin that delegates the entire work generation
 * to OpenCode CLI. Instead of the standard 15-step pipeline, this
 * plugin runs a single OpenCode session that autonomously handles
 * web search, content creation, and file generation.
 *
 * @packageDocumentation
 */

export { OpenCodePlugin } from './opencode.plugin.js';

// Types
export type { OpenCodeStepId } from './types.js';
export { OPENCODE_STEP_IDS, isOpenCodeStepId } from './types.js';

// Default export for plugin loader
export { default } from './opencode.plugin.js';
