export const PLUGIN_CAPABILITIES = {
	AI_PROVIDER: 'ai-provider',
	SEARCH: 'search',
	SCREENSHOT: 'screenshot',
	CONTENT_EXTRACTOR: 'content-extractor',
	DATA_SOURCE: 'data-source',
	PIPELINE_STEP: 'pipeline-step',
	FULL_PIPELINE: 'full-pipeline',
	FORM_SCHEMA_PROVIDER: 'form-schema-provider',
	FORM_FIELD: 'form-field',
	DEPLOYMENT: 'deployment',
	GIT_PROVIDER: 'git-provider',
	OAUTH: 'oauth',
	SUB_PROVIDER: 'sub-provider',
	CONFIG_AWARE: 'config-aware',
	CUSTOM_CAPABILITY: 'custom-capability',
	DEFAULT_PIPELINE: 'default-pipeline'
} as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[keyof typeof PLUGIN_CAPABILITIES];

export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.values(PLUGIN_CAPABILITIES);

export function isValidPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && ALL_PLUGIN_CAPABILITIES.includes(value as PluginCapability);
}
