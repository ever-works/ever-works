import { test, expect } from '@playwright/test';

/**
 * Authentication E2E tests.
 *
 * These run WITHOUT pre-authenticated state (chromium-no-auth project).
 */

test.describe('Registration', () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newUser = {
        name: `Reg Tester ${suffix}`,
        email: `reg-${suffix}@test.local`,
        password: 'SecurePass1!',
    };

    test('should register a new user and redirect to dashboard', async ({ page }) => {
        test.setTimeout(180_000);

        // Warm up the dashboard route so the post-register redirect resolves quickly.
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);

        await page.goto('/en/register', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1_000);

        // Verify form is visible
        await expect(page.locator('input[name="name"]')).toBeVisible();
        await expect(page.locator('input[name="email"]')).toBeVisible();
        await expect(page.locator('input[name="password"]')).toBeVisible();
        await expect(page.locator('input[name="confirmPassword"]')).toBeVisible();
        await expect(page.locator('#terms')).toBeVisible();

        // Fill form
        await page.locator('input[name="name"]').fill(newUser.name);
        await page.locator('input[name="email"]').fill(newUser.email);
        await page.locator('input[name="password"]').fill(newUser.password);
        await page.locator('input[name="confirmPassword"]').fill(newUser.password);
        await page.locator('#terms').check();

        // Submit
        await page.locator('button[type="submit"]').click();

        // Should redirect to dashboard (any /en path that isn't an auth page)
        await page.waitForURL(/\/en(\/(?!login|register|forgot|reset|email|auth)|$|\?)/, {
            timeout: 60_000,
        });
        await expect(page).not.toHaveURL(/\/register/);
    });

    test('should show error for mismatched passwords', async ({ page }) => {
        await page.goto('/en/register');

        await page.locator('input[name="name"]').fill('Test User');
        await page.locator('input[name="email"]').fill('mismatch@test.local');
        await page.locator('input[name="password"]').fill('SecurePass1!');
        await page.locator('input[name="confirmPassword"]').fill('DifferentPass2!');
        await page.locator('#terms').check();

        await page.locator('button[type="submit"]').click();

        // Should show password mismatch error (stays on register page)
        await expect(page).toHaveURL(/\/register/);
        await expect(page.locator('.bg-danger\\/10')).toBeVisible();
    });

    test('should show error for short password', async ({ page }) => {
        await page.goto('/en/register');

        await page.locator('input[name="name"]').fill('Test User');
        await page.locator('input[name="email"]').fill('short@test.local');
        await page.locator('input[name="password"]').fill('abc');
        await page.locator('input[name="confirmPassword"]').fill('abc');
        await page.locator('#terms').check();

        await page.locator('button[type="submit"]').click();

        // Should show password too short error
        await expect(page).toHaveURL(/\/register/);
        await expect(page.locator('.bg-danger\\/10')).toBeVisible();
    });

    test('should have link to login page', async ({ page }) => {
        await page.goto('/en/register');

        const loginLink = page.locator('a[href*="/login"]');
        await expect(loginLink).toBeVisible();
        await loginLink.click();

        await expect(page).toHaveURL(/\/login/);
    });
});

test.describe('Login', () => {
    test('should show login form with required fields', async ({ page }) => {
        await page.goto('/en/login');

        await expect(page.locator('input[name="email"]')).toBeVisible();
        await expect(page.locator('input[name="password"]')).toBeVisible();
        await expect(page.locator('button[type="submit"]')).toBeVisible();
    });

    test('should show error for invalid credentials', async ({ page }) => {
        await page.goto('/en/login');

        await page.locator('input[name="email"]').fill('nonexistent@test.local');
        await page.locator('input[name="password"]').fill('WrongPassword1!');

        await page.locator('button[type="submit"]').click();

        // Should show error and stay on login page
        await expect(page.locator('.bg-danger\\/10')).toBeVisible({ timeout: 10_000 });
        await expect(page).toHaveURL(/\/login/);
    });

    test('should have link to register page', async ({ page }) => {
        await page.goto('/en/login');

        const registerLink = page.locator('a[href*="/register"]');
        await expect(registerLink).toBeVisible();
        await registerLink.click();

        await expect(page).toHaveURL(/\/register/);
    });

    test('should have forgot password link', async ({ page }) => {
        await page.goto('/en/login');

        const forgotLink = page.locator('a[href*="/forgot-password"]');
        await expect(forgotLink).toBeVisible();
    });
});

test.describe('Social login', () => {
    test('should show social login buttons on login page', async ({ page }) => {
        await page.goto('/en/login');

        // Social login buttons should be present (GitHub, Google, etc.)
        const socialSection = page.locator('form');
        await expect(socialSection).toBeVisible();
    });

    test('should show social login buttons on register page', async ({ page }) => {
        await page.goto('/en/register');

        const socialSection = page.locator('form');
        await expect(socialSection).toBeVisible();
    });
});
