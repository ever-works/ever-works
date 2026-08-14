/**
 * Claude Managed Agent plugin.
 *
 * Self-managed pipeline plugin that delegates work generation to
 * Anthropic Claude Managed Agents and converts the final structured
 * response into Ever Works pipeline outputs.
 *
 * @packageDocumentation
 */

export { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';
export type {
	ClaudeManagedAgentStepId,
	ManagedRuntimeEnvironment,
	ManagedSessionPromptInput,
	ManagedSessionRunResult,
	ManagedSessionTokenUsage,
	PluginRunSessionsOptions,
	RunManagedSessionsOptions
} from './types.js';
export { runManagedSessions } from './utils/fan-out.js';
export { createCmaSdkClient } from './utils/cma-sdk.js';
export {
	computeConfigHash,
	ensureControlPlane,
	ensureManagedAgent,
	ensureManagedEnvironment,
	resolveNetworking
} from './utils/control-plane.js';
export { AnthropicManagedAgentsClient } from './utils/managed-agents-client.js';
export { default } from './claude-managed-agent.plugin.js';
