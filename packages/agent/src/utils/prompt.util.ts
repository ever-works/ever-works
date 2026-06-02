import { sanitizePrompt } from './sanitize.util';

/**
 * Appends a custom prompt to a base prompt if provided.
 * Custom prompts are added as "Additional User Instructions" at the end of the base prompt.
 *
 * @param basePrompt - The standard hardcoded prompt
 * @param customPrompt - Optional user-defined prompt to append
 * @returns The combined prompt, or just the base prompt if no custom prompt is provided
 */
export function appendCustomPrompt(basePrompt: string, customPrompt?: string | null): string {
    if (!customPrompt || customPrompt.trim().length === 0) {
        return basePrompt;
    }

    // Security (prompt-injection): the custom prompt is tenant-supplied, untrusted
    // text injected verbatim into LLM system/user prompts across every pipeline step.
    // Run it through the canonical `sanitizePrompt` (same defense as PromptFacadeService)
    // to strip control characters — which can smuggle hidden directives or corrupt
    // logs/UI — and to hard-cap length so an oversized blob cannot flood the model
    // context. Newlines/whitespace are preserved so legitimate multi-line instruction
    // formatting is unchanged. NOTE: this does not provide structural (delimiter)
    // isolation against instruction-override injection — see deferred follow-up.
    const sanitized = sanitizePrompt(customPrompt);
    if (sanitized.length === 0) {
        return basePrompt;
    }

    return `${basePrompt}

## Additional User Instructions:
${sanitized}`;
}
