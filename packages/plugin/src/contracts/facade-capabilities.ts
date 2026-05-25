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
	SKILLS_PROVIDER: 'skills-provider'
} as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[keyof typeof PLUGIN_CAPABILITIES];

export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.values(PLUGIN_CAPABILITIES);

export function isValidPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && ALL_PLUGIN_CAPABILITIES.includes(value as PluginCapability);
}
