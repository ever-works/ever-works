/**
 * Claude Code Generator Plugin
 *
 * Full pipeline plugin that delegates the entire work generation
 * to Claude Code CLI. Instead of the standard 15-step pipeline, this
 * plugin runs a single Claude Code session that autonomously handles
 * web search, content creation, and file generation.
 *
 * @packageDocumentation
 */

export { ClaudeCodePlugin } from './claude-code.plugin.js';

// Types
export type { ClaudeCodeStepId } from './types.js';
export { CLAUDE_CODE_STEP_IDS, isClaudeCodeStepId } from './types.js';

// Default export for plugin loader
export { default } from './claude-code.plugin.js';
