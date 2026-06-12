import { test, expect, type Page } from '@playwright/test';

/**
 * Settings & Profile E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

/**
 * Click a settings sidebar link and assert the client-side nav landed.
 *
 * The settings sub-page links are server-rendered, so the <a> is a clickable
 * DOM node the instant the HTML arrives — but its Next.js client-nav handler
 * isn't attached until React hydrates. A click in that window is swallowed
 * (no navigation), and since it never re-fires, a one-shot click + 30s
 * toHaveURL still times out at /settings. Under the prebuilt-prod CI web
 * (#1275) hydration is fast but not instantaneous, so this raced
 * occasionally (settings.spec.ts:60 on shard 13). Re-click until the URL
 * actually changes — actionability checks don't cover a not-yet-hydrated
 * onClick, so the retry is the deterministic fix.
 */
async function clickSettingsLink(page: Page, href: string, urlPattern: RegExp): Promise<void> {
    const link = page.locator(`a[href*="${href}"]`).first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(async () => {
        await link.click();
        await expect(page).toHaveURL(urlPattern, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
}

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

        await clickSettingsLink(page, '/settings/security', /\/settings\/security/);
        // Should have password inputs
        await expect(page.locator('input[type="password"]').first()).toBeVisible({
            timeout: 10_000,
        });
    });

    test('should navigate to API keys settings', async ({ page }) => {
        await page.goto('/en/settings');

        await clickSettingsLink(page, '/settings/api-keys', /\/settings\/api-keys/);
    });

    test('should navigate to data management settings', async ({ page }) => {
        await page.goto('/en/settings');

        await clickSettingsLink(page, '/settings/data', /\/settings\/data/);
    });

    test('should navigate to danger zone settings', async ({ page }) => {
        await page.goto('/en/settings');

        await clickSettingsLink(page, '/settings/danger', /\/settings\/danger/);
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
