import { MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT } from './minimal-template.prompt';

// Registry of base prompts keyed by built-in template id. A built-in
// template is "agent-customizable" only when (a) WebsiteTemplateConfig
// marks it customizable AND (b) a prompt is registered here.
const CUSTOMIZATION_PROMPTS: Record<string, string> = {
    minimal: MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT,
};

export function getCustomizationPromptForBaseTemplate(
    builtInTemplateId: string | null | undefined,
): string | null {
    if (!builtInTemplateId) {
        return null;
    }
    return CUSTOMIZATION_PROMPTS[builtInTemplateId] ?? null;
}

export function hasCustomizationPromptForBaseTemplate(
    builtInTemplateId: string | null | undefined,
): boolean {
    return getCustomizationPromptForBaseTemplate(builtInTemplateId) !== null;
}

export { MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT };
