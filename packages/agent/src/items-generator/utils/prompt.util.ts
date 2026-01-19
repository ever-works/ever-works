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

    return `${basePrompt}

## Additional User Instructions:
${customPrompt.trim()}`;
}
