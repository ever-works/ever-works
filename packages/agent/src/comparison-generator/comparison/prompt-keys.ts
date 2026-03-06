/**
 * Prompt keys for the comparison generator.
 *
 * These keys are used to look up externally managed prompts via the
 * prompt facade (e.g., Langfuse). When no external prompt is found,
 * the hardcoded default in comparison-writer.ts is used as fallback.
 *
 * Convention: `comparison.<prompt-name>`
 */
export const PROMPT_KEYS = {
    STRUCTURE: 'comparison.structure',
    MARKDOWN: 'comparison.markdown',
    EXTENDED_ANALYSIS: 'comparison.extended-analysis',
} as const;
