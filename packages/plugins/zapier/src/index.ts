/**
 * Zapier Automation Plugin
 *
 * Pipeline plugin that triggers Zapier actions during directory generation.
 * Supports both the structured `{ items: [...] }` contract and native Zapier
 * action records via user-provided field mapping.
 *
 * @packageDocumentation
 */

export { ZapierPlugin } from './zapier.plugin.js';

// Types
export type {
	ZapierStepId,
	ZapierActionType,
	ZapierActionRef,
	ZapierResultShape,
	ZapierFieldMapping,
	ZapierWorkflowInput,
	ZapierWorkflowOutput,
	ZapierOutputItem,
	ZapierSettings,
	ZapierPipelineMetrics
} from './types.js';

// Default export for plugin loader
export { default } from './zapier.plugin.js';
