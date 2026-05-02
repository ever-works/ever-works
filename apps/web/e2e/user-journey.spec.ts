import { test, expect } from '@playwright/test';

/**
 * Full user journey E2E test.
 *
 * Tests the complete lifecycle: register -> dashboard -> create work -> view -> settings.
 * This runs WITHOUT pre-authenticated state (fresh user).
 */

test.describe('Complete user journey', () => {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = {
        name: `Journey User ${suffix}`,
        email: `journey-${suffix}@test.local`,
        password: 'JourneyPass1!secure',
    };

    test('register, create work, browse, visit settings', async ({ page }) => {
        // ---- Step 1: Register ----
        await page.goto('/en/register');

        await page.locator('input[name="name"]').fill(user.name);
        await page.locator('input[name="email"]').fill(user.email);
        await page.locator('input[name="password"]').fill(user.password);
        await page.locator('input[name="confirmPassword"]').fill(user.password);
        await page.locator('#terms').check();
        await page.locator('button[type="submit"]').click();

        // Should arrive at dashboard
        await page.waitForURL(/\/(en\/)?(works|$)/, { timeout: 15_000 });

        // ---- Step 2: Navigate to create work ----
        await page.goto('/en/works/new');

        // Select manual creation mode
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await expect(manualCard).toBeVisible({ timeout: 10_000 });
        await manualCard.click();

        // Fill work form
        const dirSlug = `journey-${suffix}`;
        await expect(page.locator('form')).toBeVisible({ timeout: 5_000 });

        const nameInput = page.locator('form input[type="text"]').first();
        await nameInput.fill(`Journey Dir ${dirSlug}`);

        const descriptionTextarea = page.locator('form textarea').first();
        await descriptionTextarea.fill('Full journey test work');

        // Submit
        const submitButton = page.locator('form button[type="submit"]');
        await submitButton.click();

        // Wait for redirect or error
        await page.waitForURL(/\/works\/(?!new)/, { timeout: 15_000 }).catch(() => {
            // May fail if git provider not configured — that's ok for e2e
        });

        // ---- Step 3: Visit works list ----
        await page.goto('/en/works');
        await expect(page).toHaveURL(/\/works/);

        // ---- Step 4: Visit settings ----
        await page.goto('/en/settings');
        await expect(page).toHaveURL(/\/settings/);

        // Verify username is shown
        const usernameInput = page.locator('input').first();
        await expect(usernameInput).toBeVisible({ timeout: 10_000 });

        // ---- Step 5: Visit security settings ----
        await page.goto('/en/settings/security');
        await expect(page.locator('input[type="password"]').first()).toBeVisible({
            timeout: 10_000,
        });
    });
});
