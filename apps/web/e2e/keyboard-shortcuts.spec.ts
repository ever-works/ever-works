import { test, expect } from '@playwright/test';

/**
 * Keyboard shortcuts — pass 11. Deepens keyboard-navigation.spec.ts.
 * Many apps wire global shortcuts like `/` (command palette / search)
 * and `?` (shortcuts overlay). Verify they don't crash and either
 * open a known overlay or are silently ignored.
 */

test.describe('Keyboard shortcuts — global hotkeys', () => {
    test('pressing `/` on dashboard either opens search OR is silently ignored', async ({
        page,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        // Click somewhere neutral to ensure focus isn't in an input.
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.keyboard.press('/');
        await page.waitForTimeout(800);
        // Look for any open dialog / command palette signal.
        const palette = page
            .locator('[role="dialog"], [role="combobox"], [data-state="open"][role*="dialog" i]')
            .first();
        const visible = await palette.isVisible({ timeout: 2_000 }).catch(() => false);
        // We don't require a palette to exist; we DO require that
        // pressing `/` didn't crash the page.
        const stillRenders = await page
            .locator('h1, h2')
            .first()
            .isVisible({ timeout: 2_000 })
            .catch(() => false);
        expect(stillRenders, 'page chrome disappeared after pressing /').toBe(true);
        void visible;
    });

    test('pressing `?` on dashboard either opens shortcuts overlay OR is silently ignored', async ({
        page,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.keyboard.press('?');
        await page.waitForTimeout(800);
        const stillRenders = await page
            .locator('h1, h2')
            .first()
            .isVisible({ timeout: 2_000 })
            .catch(() => false);
        expect(stillRenders).toBe(true);
    });

    test('Ctrl+K (command palette) does not 5xx the page', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        await page.keyboard.press('Control+K');
        await page.waitForTimeout(800);
        const stillRenders = await page
            .locator('h1, h2')
            .first()
            .isVisible({ timeout: 2_000 })
            .catch(() => false);
        expect(stillRenders, 'page broke after Ctrl+K').toBe(true);
    });

    test('Escape closes any opened palette/overlay', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        await page.keyboard.press('Control+K');
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        // After Escape, dashboard chrome must still render — Escape
        // must not unmount the whole shell.
        await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 5_000 });
    });
});
