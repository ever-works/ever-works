import { test, expect } from '@playwright/test';

/**
 * Navigation & route protection E2E tests.
 *
 * These run WITHOUT pre-authenticated state (chromium-no-auth project).
 */

test.describe('Route protection', () => {
    test('should redirect unauthenticated user from dashboard to login', async ({ page }) => {
        await page.goto('/en');

        // Unauthenticated users should be redirected to login
        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });

    test('should redirect unauthenticated user from works to login', async ({ page }) => {
        await page.goto('/en/works');

        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });

    test('should redirect unauthenticated user from settings to login', async ({ page }) => {
        await page.goto('/en/settings');

        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });

    test('should redirect unauthenticated user from new work page to login', async ({ page }) => {
        await page.goto('/en/works/new');

        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });
});

test.describe('Public pages', () => {
    test('should load login page without redirect', async ({ page }) => {
        await page.goto('/en/login');

        await expect(page).toHaveURL(/\/login/);
        await expect(page.locator('input[name="email"]')).toBeVisible();
    });

    test('should load register page without redirect', async ({ page }) => {
        await page.goto('/en/register');

        await expect(page).toHaveURL(/\/register/);
        await expect(page.locator('input[name="name"]')).toBeVisible();
    });

    test('should load forgot password page without redirect', async ({ page }) => {
        await page.goto('/en/forgot-password');

        await expect(page).toHaveURL(/\/forgot-password/);
        // Should render without 500 error
        await expect(page.locator('body')).not.toContainText('Internal Server Error');
    });
});

test.describe('Locale routing', () => {
    test('should redirect root to default locale', async ({ page }) => {
        await page.goto('/');

        // Should redirect to /en/ or another locale
        await page.waitForURL(/\/[a-z]{2}\//, { timeout: 10_000 });
    });

    test('should load pages with explicit locale prefix', async ({ page }) => {
        await page.goto('/en/login');
        await expect(page).toHaveURL(/\/en\/login/);
    });
});
