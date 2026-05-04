/**
 * SIM AI Workflows Plugin
 *
 * Full pipeline plugin that delegates work generation to SIM AI
 * workflows. Instead of running local AI agents, this plugin triggers
 * deployed SIM workflows and collects structured item results.
 *
 * @packageDocumentation
 */

export { SimAiPlugin } from './sim-ai.plugin.js';

// Types
export type { SimAiStepId, SimWorkflowInput, SimWorkflowOutput, SimOutputItem, SimAiSettings } from './types.js';

// Default export for plugin loader
export { default } from './sim-ai.plugin.js';
