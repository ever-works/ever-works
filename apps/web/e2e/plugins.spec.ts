import { test, expect } from '@playwright/test';

/**
 * Plugins page E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

test.describe('Plugins', () => {
    test('should load plugins page', async ({ page }) => {
        const response = await page.goto('/en/plugins');

        await expect(page).toHaveURL(/\/plugins/);
        // Assert against the HTTP status, not the body — the page's catalog
        // copy now includes "500+ third-party apps" (Composio plugin
        // description) which triggers a false positive when scanning body
        // text for "500".
        expect(response?.status(), '/en/plugins should not 5xx').toBeLessThan(500);
    });

    test('should display plugin cards or list', async ({ page }) => {
        await page.goto('/en/plugins');

        // Page should render content (heading, cards, or empty state)
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 10_000 });
    });
});
