/**
 * Make.com Workflows Plugin
 *
 * Full pipeline plugin that delegates work generation to Make.com
 * scenarios or webhooks. Instead of running local AI agents, this plugin
 * triggers a Make.com automation and collects the structured item results.
 *
 * @packageDocumentation
 */

export { MakePlugin } from './make.plugin.js';

// Types
export type {
	MakeStepId,
	MakeExecutionMode,
	MakeWorkflowInput,
	MakeWorkflowOutput,
	MakeOutputItem,
	MakeSettings,
	MakeScenarioSummary,
	MakeHookSummary
} from './types.js';

// Default export for plugin loader
export { default } from './make.plugin.js';
