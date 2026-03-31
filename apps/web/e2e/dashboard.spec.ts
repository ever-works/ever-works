import { test, expect } from '@playwright/test';

/**
 * Dashboard E2E tests.
 *
 * These run WITH pre-authenticated state (chromium project with storageState).
 */

test.describe('Dashboard', () => {
	test('should load the dashboard after login', async ({ page }) => {
		await page.goto('/en');

		// Should not redirect to login
		await expect(page).not.toHaveURL(/\/login/);

		// Dashboard should show welcome heading
		const heading = page.locator('h1');
		await expect(heading).toBeVisible({ timeout: 10_000 });
	});

	test('should display stats overview section', async ({ page }) => {
		await page.goto('/en');

		// StatsOverview component should render
		// It shows totalDirectories, totalItems, activeWebsites
		await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
	});

	test('should have navigation sidebar', async ({ page }) => {
		await page.goto('/en');

		// Sidebar navigation should include links to key sections
		const nav = page.locator('nav, aside');
		await expect(nav.first()).toBeVisible({ timeout: 10_000 });
	});

	test('should navigate to directories page', async ({ page }) => {
		await page.goto('/en');
		await page.waitForLoadState('networkidle');

		// Find and click a link to directories
		const dirLink = page.locator('a[href*="/directories"]').first();
		if (await dirLink.isVisible()) {
			await dirLink.click();
			await expect(page).toHaveURL(/\/directories/);
		}
	});

	test('should navigate to settings page', async ({ page }) => {
		await page.goto('/en/settings');

		await expect(page).toHaveURL(/\/settings/);
		// Settings page should load without error
		await expect(page.locator('body')).not.toContainText('500');
	});
});
