/**
 * Composio Integration Plugin
 *
 * Pipeline plugin that executes Composio tools during work generation.
 * Composio brokers OAuth and exposes 500+ third-party apps (Gmail, Slack,
 * GitHub, Notion, Linear, Salesforce, …) through a single API. Each user
 * connects their accounts once via Composio's hosted OAuth flow; the plugin
 * then calls tools on their behalf using the user's `composio.user_id`.
 *
 * @packageDocumentation
 */

export { ComposioPlugin } from './composio.plugin.js';

// Types
export type {
	ComposioStepId,
	ComposioToolRef,
	ComposioResultShape,
	ComposioFieldMapping,
	ComposioToolInput,
	ComposioToolOutput,
	ComposioOutputItem,
	ComposioSettings,
	ComposioPipelineMetrics,
	ComposioConnectedAccount,
	ComposioToolkitEntry
} from './types.js';

// Default export for plugin loader
export { default } from './composio.plugin.js';
