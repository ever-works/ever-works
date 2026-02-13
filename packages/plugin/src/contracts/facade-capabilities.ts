export const PLUGIN_CAPABILITIES = {
	AI_PROVIDER: 'ai-provider',
	SEARCH: 'search',
	SCREENSHOT: 'screenshot',
	CONTENT_EXTRACTOR: 'content-extractor',
	DATA_SOURCE: 'data-source',
	PIPELINE: 'pipeline',
	PIPELINE_MODIFIER: 'pipeline-modifier',
	FORM_SCHEMA_PROVIDER: 'form-schema-provider',
	FORM_FIELD: 'form-field',
	DEPLOYMENT: 'deployment',
	GIT_PROVIDER: 'git-provider',
	OAUTH: 'oauth',
	SUB_PROVIDER: 'sub-provider',
	CONFIG_AWARE: 'config-aware',
	CUSTOM_CAPABILITY: 'custom-capability'
} as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[keyof typeof PLUGIN_CAPABILITIES];

export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.values(PLUGIN_CAPABILITIES);

export function isValidPluginCapability(value: unknown): value is PluginCapability {
	return typeof value === 'string' && ALL_PLUGIN_CAPABILITIES.includes(value as PluginCapability);
}
