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
export { CMA_FAN_OUT_CAPABILITY } from './types.js';
export type {
	ClaudeManagedAgentStepId,
	ManagedAgentFanOutCapability,
	ManagedAgentPipelineMetrics,
	ManagedRuntimeEnvironment,
	ManagedSessionPromptInput,
	ManagedSessionRunResult,
	ManagedSessionTokenUsage,
	ManagedSessionUsageSummary,
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
export { buildManagedAgentMetrics } from './utils/usage-metrics.js';
export { default } from './claude-managed-agent.plugin.js';
