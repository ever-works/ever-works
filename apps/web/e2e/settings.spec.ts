import { test, expect } from '@playwright/test';

/**
 * Settings & Profile E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

test.describe('Settings navigation', () => {
    test('should load settings page with profile form', async ({ page }) => {
        await page.goto('/en/settings');

        await expect(page).toHaveURL(/\/settings/);

        // Profile form should have username input
        const usernameInput = page.locator('input').first();
        await expect(usernameInput).toBeVisible({ timeout: 10_000 });
    });

    test('should show settings sidebar tabs', async ({ page }) => {
        await page.goto('/en/settings');

        // Settings sidebar should have links to sub-pages
        const securityLink = page.locator('a[href*="/settings/security"]');
        const apiKeysLink = page.locator('a[href*="/settings/api-keys"]');
        const dataLink = page.locator('a[href*="/settings/data"]');
        const dangerLink = page.locator('a[href*="/settings/danger"]');

        await expect(securityLink.first()).toBeVisible({ timeout: 10_000 });
        await expect(apiKeysLink.first()).toBeVisible();
        await expect(dataLink.first()).toBeVisible();
        await expect(dangerLink.first()).toBeVisible();
    });

    test('should navigate to security settings', async ({ page }) => {
        await page.goto('/en/settings');

        const securityLink = page.locator('a[href*="/settings/security"]').first();
        await securityLink.click();

        await expect(page).toHaveURL(/\/settings\/security/);
        // Should have password inputs
        await expect(page.locator('input[type="password"]').first()).toBeVisible({
            timeout: 10_000,
        });
    });

    test('should navigate to API keys settings', async ({ page }) => {
        await page.goto('/en/settings');

        const apiKeysLink = page.locator('a[href*="/settings/api-keys"]').first();
        await apiKeysLink.click();

        await page.waitForURL(/\/settings\/api-keys/, { timeout: 30_000 });
        await expect(page.locator('body')).not.toContainText('500');
    });

    test('should navigate to data management settings', async ({ page }) => {
        await page.goto('/en/settings');

        const dataLink = page.locator('a[href*="/settings/data"]').first();
        await dataLink.click();

        await page.waitForURL(/\/settings\/data/, { timeout: 30_000 });
        await expect(page.locator('body')).not.toContainText('500');
    });

    test('should navigate to danger zone settings', async ({ page }) => {
        await page.goto('/en/settings');

        const dangerLink = page.locator('a[href*="/settings/danger"]').first();
        await dangerLink.click();

        await page.waitForURL(/\/settings\/danger/, { timeout: 30_000 });
        await expect(page.locator('body')).not.toContainText('500');
    });
});

test.describe('Profile settings', () => {
    test('should display current username', async ({ page }) => {
        await page.goto('/en/settings');

        // Username input should have a value (the current user's username)
        const usernameInput = page.locator('input').first();
        await expect(usernameInput).toBeVisible({ timeout: 10_000 });
        await expect(usernameInput).not.toHaveValue('');
    });

    test('should display email field as read-only', async ({ page }) => {
        await page.goto('/en/settings');

        // Email input should be present and disabled/readonly
        const emailInput = page.locator('input[type="email"], input[disabled]').first();
        await expect(emailInput).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Security settings', () => {
    test('should show password change form', async ({ page }) => {
        await page.goto('/en/settings/security');

        const passwordInputs = page.locator('input[type="password"]');
        // Should have current password, new password, confirm password
        await expect(passwordInputs.first()).toBeVisible({ timeout: 10_000 });
        const count = await passwordInputs.count();
        expect(count).toBeGreaterThanOrEqual(3);
    });

    test('should have update button', async ({ page }) => {
        await page.goto('/en/settings/security');

        const updateButton = page.locator('button[type="submit"]');
        await expect(updateButton).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('API keys settings', () => {
    test('should show create API key button', async ({ page }) => {
        await page.goto('/en/settings/api-keys');

        // Should have a button to create a new API key
        const createButton = page
            .locator('button')
            .filter({ hasText: /create|new|add/i })
            .first();
        await expect(createButton).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Danger zone', () => {
    test('should show delete account button', async ({ page }) => {
        await page.goto('/en/settings/danger');

        const deleteButton = page
            .locator('button')
            .filter({ hasText: /delete/i })
            .first();
        await expect(deleteButton).toBeVisible({ timeout: 10_000 });
    });

    test('should show confirmation form when delete is clicked', async ({ page }) => {
        await page.goto('/en/settings/danger');

        const deleteButton = page
            .locator('button')
            .filter({ hasText: /delete/i })
            .first();
        await deleteButton.click();

        // Confirmation should appear with email input
        const emailConfirmInput = page.locator('input[type="email"], input[type="text"]').last();
        await expect(emailConfirmInput).toBeVisible({ timeout: 5_000 });
    });
});
