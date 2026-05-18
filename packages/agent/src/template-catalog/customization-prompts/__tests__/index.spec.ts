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
        // These assertions pin load-bearing fragments of the prompt: if any of
        // them silently drop, the agent may break the user's fork. Updating a
        // matcher here should be a deliberate change.
        it('forbids functional / config changes so the user’s site stays mergeable upstream', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/UI/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/No functional changes/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/No content edits/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/package\.json/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/astro\.config/);
        });

        it('reminds the agent it must not commit or push', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/No commits, no PRs/i);
        });

        it('points the agent at the canonical styling levers (global.css, BaseLayout, @theme)', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/styles\/global\.css/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/@theme/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/--color-brand-/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/BaseLayout\.astro/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/data-component/);
        });

        it('marks shared workspace packages and content as off-limits', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/packages\/ui\//);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/\.content\//);
        });
    });
});
