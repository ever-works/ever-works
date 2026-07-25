/**
 * Prompt-facade keys for the GTM pipeline's AI-backed stages. When a
 * prompt provider is configured, these keys let operators manage the
 * stage prompts externally; otherwise the hardcoded defaults apply.
 */
export const GTM_PROMPT_KEYS = {
	RESEARCH_QUERIES: 'gtm-pipeline.research-queries',
	DRAFT: 'gtm-pipeline.draft',
	ENRICH: 'gtm-pipeline.enrich',
	MEASURE: 'gtm-pipeline.measure'
} as const;
