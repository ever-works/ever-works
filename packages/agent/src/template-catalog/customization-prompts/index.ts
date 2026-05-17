import { MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT } from './minimal-template.prompt';

const CUSTOMIZATION_PROMPTS: Record<string, string> = {
    minimal: MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT,
};

export function getCustomizationPromptForBaseTemplate(
    id: string | null | undefined,
): string | null {
    return id ? (CUSTOMIZATION_PROMPTS[id] ?? null) : null;
}

export function hasCustomizationPromptForBaseTemplate(id: string | null | undefined): boolean {
    return getCustomizationPromptForBaseTemplate(id) !== null;
}

export { MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT };
