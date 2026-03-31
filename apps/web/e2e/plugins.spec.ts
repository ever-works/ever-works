import { test, expect } from '@playwright/test';

/**
 * Plugins page E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

test.describe('Plugins', () => {
    test('should load plugins page', async ({ page }) => {
        await page.goto('/en/plugins');

        await expect(page).toHaveURL(/\/plugins/);
        await expect(page.locator('body')).not.toContainText('500');
    });

    test('should display plugin cards or list', async ({ page }) => {
        await page.goto('/en/plugins');

        // Page should render content (heading, cards, or empty state)
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 10_000 });
    });
});
