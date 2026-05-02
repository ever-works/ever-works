/**
 * Hermes Agent pipeline plugin.
 *
 * Delegates full directory generation to a Hermes Agent CLI session running
 * against a user-selected Hermes profile on the backend machine.
 */

export { HermesAgentPlugin } from './hermes-agent.plugin.js';

export type { HermesAgentStepId } from './types.js';
export { HERMES_AGENT_STEP_IDS, isHermesAgentStepId } from './types.js';

export { default } from './hermes-agent.plugin.js';
