/**
 * Activepieces Automation Plugin
 *
 * Pipeline plugin that delegates work generation steps to Activepieces flows.
 * Talks to the Activepieces REST API directly (no SDK) and triggers flow webhooks
 * synchronously to collect structured work items.
 *
 * @packageDocumentation
 */

export { ActivepiecesPlugin } from './activepieces.plugin.js';

// Types
export type {
	ActivepiecesStepId,
	ActivepiecesFlowInput,
	ActivepiecesFlowOutput,
	ActivepiecesOutputItem,
	ActivepiecesSettings,
	ActivepiecesFlow,
	ActivepiecesFlowRun,
	ActivepiecesExecutionResult,
	WebhookMode
} from './types.js';

// Default export for plugin loader
export { default } from './activepieces.plugin.js';
