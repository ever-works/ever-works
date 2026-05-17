import {
    MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT,
    getCustomizationPromptForBaseTemplate,
    hasCustomizationPromptForBaseTemplate,
} from '../index';

describe('customization prompt registry', () => {
    it('returns the minimal-template prompt for "minimal"', () => {
        expect(getCustomizationPromptForBaseTemplate('minimal')).toBe(
            MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT,
        );
        expect(hasCustomizationPromptForBaseTemplate('minimal')).toBe(true);
    });

    it('returns null for templates without a registered prompt (e.g. classic)', () => {
        expect(getCustomizationPromptForBaseTemplate('classic')).toBeNull();
        expect(hasCustomizationPromptForBaseTemplate('classic')).toBe(false);
    });

    it('treats unknown ids and null/undefined as unsupported', () => {
        expect(getCustomizationPromptForBaseTemplate('unknown')).toBeNull();
        expect(getCustomizationPromptForBaseTemplate(null)).toBeNull();
        expect(getCustomizationPromptForBaseTemplate(undefined)).toBeNull();
        expect(hasCustomizationPromptForBaseTemplate('')).toBe(false);
    });

    describe('minimal-template prompt', () => {
        it('forbids functional / config changes so the user’s site stays mergeable upstream', () => {
            // These guardrails are load-bearing: if any of them silently drop
            // from the prompt the agent may break the user's fork. Pinned so
            // a future prompt-edit is a deliberate change.
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/UI/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/Do NOT change functionality/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/Do NOT modify content data/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/package\.json/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/astro\.config/);
        });

        it('reminds the agent it must not commit or push', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/No commits, no PRs/i);
        });
    });
});
