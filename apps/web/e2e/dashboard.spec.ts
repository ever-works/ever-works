import { test, expect } from '@playwright/test';

/**
 * Dashboard E2E tests.
 *
 * These run WITH pre-authenticated state (chromium project with storageState).
 *
 * Owner 2026-09-18 — the Dashboard deliberately has NO page header any more:
 * the greeting, the subtitle and the date line were removed, so `/en` no
 * longer carries an `<h1>` (the page opens with the composer and the
 * `Your workspace` card, whose heading is an `<h2>`). The old assertions here
 * looked for that `<h1>`; they now pin what the page actually opens with.
 */

test.describe('Dashboard', () => {
    test('should load the dashboard after login', async ({ page }) => {
        await page.goto('/en');

        // Should not redirect to login
        await expect(page).not.toHaveURL(/\/login/);

        // The morning stack is the page: the composer comes first.
        await expect(page.getByTestId('home-morning')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId('home-composer')).toBeVisible({ timeout: 15_000 });
    });

    test('should display the Your workspace stats card', async ({ page }) => {
        await page.goto('/en');

        // The merged card: a `Your workspace` heading with a Today half and
        // an All half, the latter holding the account totals (Total Works,
        // Total Items, …) that used to live in the collapsed region.
        const card = page.getByTestId('home-block-workspace');
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card.getByRole('heading', { name: 'Your workspace' })).toBeVisible();
        await expect(card.getByRole('heading', { name: 'Today' })).toBeVisible();
        await expect(card.getByRole('heading', { name: 'All' })).toBeVisible();
        await expect(card.getByText('Total Works')).toBeVisible();
    });

    test('should have navigation sidebar', async ({ page }) => {
        await page.goto('/en');

        // Sidebar navigation should include links to key sections
        const nav = page.locator('nav, aside');
        await expect(nav.first()).toBeVisible({ timeout: 10_000 });
    });

    test('should navigate to works page', async ({ page }) => {
        await page.goto('/en');
        await page.waitForLoadState('networkidle');

        // Find and click a link to works
        const dirLink = page.locator('a[href*="/works"]').first();
        if (await dirLink.isVisible()) {
            await dirLink.click();
            await expect(page).toHaveURL(/\/works/);
        }
    });

    test('should navigate to settings page', async ({ page }) => {
        await page.goto('/en/settings');

        await expect(page).toHaveURL(/\/settings/);
        // Settings page should load without error
        await expect(page.locator('body')).not.toContainText('500');
    });
});
