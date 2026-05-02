/**
 * Gemini Generator Plugin
 *
 * Full pipeline plugin that delegates the entire work generation
 * to Gemini CLI. Instead of the standard 15-step pipeline, this
 * plugin runs a single Gemini CLI session that autonomously handles
 * web search, content creation, and file generation.
 *
 * @packageDocumentation
 */

export { GeminiPlugin } from './gemini.plugin.js';

// Types
export type { GeminiStepId } from './types.js';
export { GEMINI_STEP_IDS, isGeminiStepId } from './types.js';

// Default export for plugin loader
export { default } from './gemini.plugin.js';
