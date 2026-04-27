/**
 * Claude Managed Agent plugin.
 *
 * Self-managed pipeline plugin that delegates directory generation to
 * Anthropic Claude Managed Agents and converts the final structured
 * response into Ever Works pipeline outputs.
 *
 * @packageDocumentation
 */

export { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';
export type { ClaudeManagedAgentStepId } from './types.js';
export { default } from './claude-managed-agent.plugin.js';
