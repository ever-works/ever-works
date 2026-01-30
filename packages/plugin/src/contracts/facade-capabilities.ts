/**
 * Centralized facade capability identifiers.
 */
export const FACADE_CAPABILITIES = {
	SEARCH: 'search',
	SCREENSHOT: 'screenshot',
	AI: 'ai-provider',
	CONTENT_EXTRACTOR: 'content-extractor',
	DATA_SOURCE: 'data-source',
	FULL_PIPELINE: 'full-pipeline'
} as const;

export type FacadeCapability = (typeof FACADE_CAPABILITIES)[keyof typeof FACADE_CAPABILITIES];
