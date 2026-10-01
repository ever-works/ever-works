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
	EVENT_SOURCE: 'event-source',
	// Capability & playbook catalogue (AW-21) — plugins that supply Playbook
	// catalogue entries (packaged outcomes: trigger, steps, required
	// capabilities, artefacts, escalation points). Consumed only through
	// PlaybookCatalogFacadeService. See
	// capabilities/playbook-provider.interface.ts.
	PLAYBOOK_PROVIDER: 'playbook-provider',
	// AW-15 — optional access-level declaration ("Read only" / "Read and
	// write") mapped onto the tool-grant lattice. Declared alongside a
	// provider's main capability; see
	// capabilities/connection-scopes.interface.ts.
	CONNECTION_SCOPES: 'connection-scopes',
	// App Works (APW-07 T3) — App dependency providers: the `k8s` plugin serves
	// the three in-cluster ids, `app-dependencies-external` the external ones,
	// and P2's `apps-tier-dependencies` the managed ones. Consumed only through
	// `AppDependencyFacadeService`; see
	// capabilities/app-dependency.interface.ts.
	APP_DEPENDENCY: 'app-dependency',
	// App Works (APW-05 T2) — producing a container image from a commit. The
	// `github-actions-build` plugin declares it (`IBuildPlugin`, `buildKind
	// 'github-actions'`), and P3's `apps-builder` declares the same capability
	// with the other `buildKind`. Consumed only through `BuildFacadeService`
	// (APW-05 T16); see `capabilities/build.interface.ts`. Resolution R-13 keeps
	// `build` a CAPABILITY while the strategy (`dockerfile` / `image` / `auto` /
	// `none`) stays the App spec's own choice.
	BUILD: 'build',
	// App Works (APW-12 T4) — the Ever ID relying-party capability. The
	// `oidc-identity` plugin declares it (APW-12 T5/T6), and it is consumed only
	// through `IdentityProviderFacadeService` (APW-12 plan §4.4); see
	// `capabilities/identity-provider.interface.ts`. Appended after `build`, and
	// landed in the same change as the `identity` category in
	// `plugin-manifest.types.ts` — a plugin contract with no category to be
	// discovered under is a manifest the loader rejects.
	IDENTITY_PROVIDER: 'identity-provider',
	// App Works (APW-10 T2) — the managed hosting tier's zone capability. The
	// `ever-works-apps` plugin declares it together with `deployment`
	// (plan §5.2:602) and is consumed only through `AppsTierFacadeService`
	// (APW-10 plan §5.3:655); see `capabilities/apps-tier.interface.ts`.
	// Appended after `identity-provider`, and appended **last** on purpose:
	// every existing constant keeps its value and its position, because the
	// capability list is an append-only surface — a member that moves silently
	// changes what a persisted manifest means. Deliberately NOT paired with a
	// new category: the tier's plugin is a `deployment` plugin, so
	// `PLUGIN_CATEGORIES` is untouched and every exhaustive map over it in
	// `apps/web` stays total.
	APPS_TIER: 'apps-tier'
} as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[keyof typeof PLUGIN_CAPABILITIES];

export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.values(PLUGIN_CAPABILITIES);

export function isValidPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && ALL_PLUGIN_CAPABILITIES.includes(value as PluginCapability);
}
