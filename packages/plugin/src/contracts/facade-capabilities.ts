export const PLUGIN_CAPABILITIES = {
	AI_PROVIDER: 'ai-provider',
	SEARCH: 'search',
	SCREENSHOT: 'screenshot',
	CONTENT_EXTRACTOR: 'content-extractor',
	DATA_SOURCE: 'data-source',
	PIPELINE: 'pipeline',
	PIPELINE_MODIFIER: 'pipeline-modifier',
	CODE_EDIT: 'code-edit',
	FORM_SCHEMA_PROVIDER: 'form-schema-provider',
	DEPLOYMENT: 'deployment',
	GIT_PROVIDER: 'git-provider',
	OAUTH: 'oauth',
	DEVICE_AUTH: 'device-auth',
	PROMPT_PROVIDER: 'prompt-provider',
	// EW-637 — pluggable object storage. `put-object` + `get-object` are the
	// floor; `presigned-put` is opt-in for backends that can hand the
	// browser a direct-upload URL (S3, MinIO).
	STORAGE: 'storage',
	PUT_OBJECT: 'put-object',
	GET_OBJECT: 'get-object',
	PRESIGNED_PUT: 'presigned-put',
	// Agents/Skills/Tasks PR #1017 — Phase 8 (ADR-012). Plugin
	// category for Skill catalog providers. "Ever Works Skills" is
	// the first-party default; community plugins implement the same
	// `ISkillsProviderPlugin` contract to surface other catalogs.
	SKILLS_PROVIDER: 'skills-provider',
	// Agents/Skills/Tasks PR #1017 — Phase 11 (ADR-013). Plugin
	// category for external task trackers. "Ever Works Task Tracker"
	// is the first-party default. Community plugins (Linear / Jira /
	// GitHub Issues) implement the same contract.
	TASK_TRACKER: 'task-tracker',
	// Notifications v2 (EW-650) — Email Providers. Plugins MAY declare
	// `EMAIL_OUTBOUND`, `EMAIL_INBOUND`, or both. See
	// `capabilities/email-provider.interface.ts` for the contract.
	EMAIL_OUTBOUND: 'email-outbound',
	EMAIL_INBOUND: 'email-inbound',
	// Notifications v2 (sibling of EW-650) — Notification Channels.
	// Plugins declare `NOTIFICATION_CHANNEL` (umbrella) plus the
	// channel-specific constant for plugin discovery + UI grouping.
	// See `capabilities/notification-channel.interface.ts`.
	NOTIFICATION_CHANNEL: 'notification-channel',
	NOTIFICATION_CHANNEL_DISCORD: 'notification-channel-discord',
	NOTIFICATION_CHANNEL_SLACK: 'notification-channel-slack',
	NOTIFICATION_CHANNEL_TELEGRAM: 'notification-channel-telegram',
	NOTIFICATION_CHANNEL_WHATSAPP: 'notification-channel-whatsapp',
	NOTIFICATION_CHANNEL_NOVU: 'notification-channel-novu',
	// Connectors ("Connector fabric") — first-party BIDIRECTIONAL
	// communication-channel plugins. Each connector declares `CONNECTOR`
	// (umbrella, for discovery/grouping) plus its `CONNECTOR_<provider>`
	// constant. Superset of the outbound-only notification channels; see
	// `capabilities/connector.interface.ts`.
	CONNECTOR: 'connector',
	CONNECTOR_SLACK: 'connector-slack',
	CONNECTOR_DISCORD: 'connector-discord',
	CONNECTOR_WHATSAPP: 'connector-whatsapp',
	CONNECTOR_LINEAR: 'connector-linear',
	CONNECTOR_NOTION: 'connector-notion',
	CONNECTOR_MICROSOFT_365: 'connector-microsoft-365',
	// CRM / enrichment connectors — first-party native connectors over
	// the vendors' own Node SDKs. Outbound writes CRM records/notes,
	// the event-source leg streams record changes into the ingest spine.
	CONNECTOR_HUBSPOT: 'connector-hubspot',
	CONNECTOR_PIPEDRIVE: 'connector-pipedrive',
	// Social connectors — public-timeline surfaces. Outbound publishes a
	// post; the event-source leg streams mentions/replies + the account's
	// own timeline into the ingest spine.
	CONNECTOR_BLUESKY: 'connector-bluesky',
	CONNECTOR_MASTODON: 'connector-mastodon',
	// Pluggable persistent memory for AI coding / generation agents.
	// First-party implementation: `@ever-works/agentmemory-plugin`
	// (talks to the `agentmemory` standalone Node server on :3111 —
	// runs locally OR hosted via a configurable `baseUrl` + bearer
	// token). Community plugins (mem0, zep, langmem) implement the
	// same `IAgentMemoryPlugin` contract.
	AGENT_MEMORY: 'agent-memory',
	// Goals feature PR-7 — read-only metrics collectors. First-party
	// providers: `custom-http` (GET-only, SSRF-guarded) and `stripe`
	// (official SDK; balance + income windows). See
	// `capabilities/metrics-provider.interface.ts` for the contract.
	METRICS_PROVIDER: 'metrics-provider',
	// Streaming-terminal session hosts (Wave 1 M5). First-party:
	// pty-local (node-pty in the executing job-runtime worker, with a
	// child_process pipe floor). Future: pty-ssh (user's own box),
	// k8s-exec. See capabilities/terminal-stream.interface.ts.
	TERMINAL_STREAM: 'terminal-stream',
	// Isolated git working contexts for agent Tasks (Wave 2).
	WORKSPACE: 'workspace',
	// Headless browser drivers (audit item G22). navigate / extract /
	// screenshot / act, headless by default, behind a default-deny
	// navigation allowlist re-checked on every redirect hop. First-party:
	// `browser-automation` (Playwright). See
	// capabilities/browser-automation.interface.ts.
	BROWSER_AUTOMATION: 'browser-automation',
	// Event-ingest spine (Wave 6) — plugins that pull/push normalized
	// external events into the platform ingest pipeline. See
	// capabilities/event-source.interface.ts.
	EVENT_SOURCE: 'event-source'
} as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[keyof typeof PLUGIN_CAPABILITIES];

export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.values(PLUGIN_CAPABILITIES);

export function isValidPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && ALL_PLUGIN_CAPABILITIES.includes(value as PluginCapability);
}
