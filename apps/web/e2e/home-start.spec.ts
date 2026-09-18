import { test, expect } from '@playwright/test';

/**
 * Home (owner 2026-09-18) — the Dashboard's "start something" composer.
 *
 * The owner replaced the Dashboard's single-line Task box with the `/new`
 * page's prompt + kind chips, "just for Dashboard … one line for text, not
 * multiple, but if user starts typing more, it should auto-expand". So this
 * spec pins the three things that make it the `/new` composer rather than a
 * lookalike — the same chip catalog, the same 10-character submit floor, the
 * same chip-seeds-the-prompt behaviour — plus the one thing that makes it the
 * Dashboard's: it starts one line tall.
 *
 * The submit ROUTING (which chip lands where, what reaches the chat AI) is
 * pinned by `src/components/new/NewPageClient.unit.spec.tsx`, which drives the
 * shared controller both surfaces use.
 */

const CHIP_OPTION = (prefix: string) => `[data-testid="${prefix}-chips"] [role="option"]`;

async function chipLabels(page: import('@playwright/test').Page, prefix: string) {
    return page.locator(CHIP_OPTION(prefix)).allInnerTexts();
}

test.describe('Home start composer', () => {
    test('opens with the /new prompt, the same kind chips, and no greeting header (owner items 6, 8-10)', async ({
        page,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });

        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });

        // Everything the owner asked to delete is gone from the top of the page.
        await expect(page.getByTestId('home-greeting')).toHaveCount(0);
        await expect(page.getByTestId('home-score-line')).toHaveCount(0);
        await expect(page.getByTestId('home-timezone-footnote')).toHaveCount(0);
        await expect(page.getByText('Manage your AI-powered works')).toHaveCount(0);

        // The same chips, in the same order, as the dedicated `/new` page.
        const homeChips = await chipLabels(page, 'home-chip');
        expect(homeChips.length).toBeGreaterThan(0);

        await page.goto('/en/new', { waitUntil: 'domcontentloaded' });
        await expect(page.locator(CHIP_OPTION('new-chip')).first()).toBeVisible({
            timeout: 30_000,
        });
        expect(await chipLabels(page, 'new-chip')).toEqual(homeChips);
    });

    test('starts one line tall and grows with the text (owner item 6)', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });

        await field.fill('');
        const oneLine = (await field.boundingBox())!.height;

        await field.fill('a sentence long enough to wrap onto a second line in this field');
        const grown = (await field.boundingBox())!.height;
        expect(grown).toBeGreaterThan(oneLine);

        await field.fill('');
    });

    test('holds Send under the /new minimum of 10 characters', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });
        const send = page.getByTestId('home-start-submit');

        await field.fill('too short');
        await expect(send).toBeDisabled();
        await field.fill('long enough to send');
        await expect(send).toBeEnabled();

        await field.fill('');
    });

    test('picking a chip seeds its example into the input', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });

        await field.fill('');
        await page.getByTestId('home-chip-directory').click();
        // The TypewriterPlaceholder hands over the chip's own example, stripped
        // of its `e.g. "…"` wrapper, so the pick produces a real prompt.
        await expect(field).not.toHaveValue('');
        await expect(field).toHaveValue(/[Dd]irectory/);

        await field.fill('');
    });
});
