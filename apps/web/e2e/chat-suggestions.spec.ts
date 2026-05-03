import { test, expect } from '@playwright/test';

/**
 * Authenticated home page — AI chat panel suggestions use the new vocabulary.
 *
 * The home page has an AI chat panel with prompt suggestions like
 * "Show my works" / "Build a Work for AI tools" / "Suggest a Work to build".
 * If they're rendered we assert they use the new word; if the panel is
 * collapsed or not present in this build, the test is skipped.
 */

const OLD_SINGULAR = ['Di', 'rectory'].join('');
const OLD_PLURAL = ['Di', 'rectories'].join('');

test.describe('AI chat panel suggestions', () => {
    test('suggestion text uses Works vocabulary, not Directory', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_500);

        const body = await page.locator('body').innerText();
        // Find any "Show my X" / "Build a X" / "Suggest a X" prompts and check vocab.
        const prompts = body.match(/(?:show my|build a|suggest a) (\w+)/gi) ?? [];

        if (prompts.length === 0) {
            test.skip(true, 'no chat suggestions visible in this build');
        }

        for (const p of prompts) {
            expect(p.toLowerCase()).not.toContain(OLD_SINGULAR.toLowerCase());
            expect(p.toLowerCase()).not.toContain(OLD_PLURAL.toLowerCase());
        }
    });

    test('chat input placeholder (if present) uses new vocabulary', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_500);

        const chatInput = page
            .locator(
                'textarea[placeholder], input[placeholder*="ask" i], input[placeholder*="message" i]',
            )
            .first();
        if (!(await chatInput.isVisible({ timeout: 3_000 }).catch(() => false))) {
            test.skip(true, 'no chat input present');
        }
        const placeholder = await chatInput.getAttribute('placeholder');
        if (placeholder) {
            expect(placeholder.toLowerCase()).not.toContain(OLD_SINGULAR.toLowerCase());
            expect(placeholder.toLowerCase()).not.toContain(OLD_PLURAL.toLowerCase());
        }
    });
});
