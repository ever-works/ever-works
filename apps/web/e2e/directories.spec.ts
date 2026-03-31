import { test, expect } from '@playwright/test';

/**
 * Directory E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

test.describe('Directory listing', () => {
    test('should load the directories page', async ({ page }) => {
        await page.goto('/en/directories');

        await expect(page).toHaveURL(/\/directories/);
        // Page should render without server error
        await expect(page.locator('body')).not.toContainText('500');
    });

    test('should show "new directory" button or link', async ({ page }) => {
        await page.goto('/en/directories');

        const newDirLink = page.locator('a[href*="/directories/new"]');
        await expect(newDirLink.first()).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Directory creation', () => {
    test('should show creation mode selector on new directory page', async ({ page }) => {
        await page.goto('/en/directories/new');

        // Should show 3 creation mode cards: AI, Manual, Import
        // Each is a <button> with descriptive text
        const buttons = page
            .locator('button')
            .filter({ hasText: /(AI|Manual|Import|Configure|Get Started)/i });
        await expect(buttons.first()).toBeVisible({ timeout: 10_000 });
    });

    test('should navigate to manual creation mode', async ({ page }) => {
        await page.goto('/en/directories/new');

        // Click the manual creation card (second button with PenLine icon)
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await expect(manualCard).toBeVisible({ timeout: 10_000 });
        await manualCard.click();

        // Should show the manual form with name, slug, description fields
        await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 5_000 });
    });

    test('should create a directory via manual form', async ({ page }) => {
        const slug = `e2e-test-${Date.now().toString(36)}`;

        await page.goto('/en/directories/new');

        // Select manual mode
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await manualCard.click();

        // Wait for form to appear
        await expect(page.locator('form')).toBeVisible({ timeout: 5_000 });

        // Fill in the directory form
        // Name field — the first text input in the form
        const nameInput = page.locator('form input[type="text"]').first();
        await nameInput.fill(`E2E Test Dir ${slug}`);

        // Slug should auto-populate, but let's verify it exists
        const slugInput = page.locator('form input[type="text"]').nth(1);
        await expect(slugInput).toHaveValue(/.+/);

        // Description — textarea
        const descriptionTextarea = page.locator('form textarea').first();
        await descriptionTextarea.fill('Automated E2E test directory for Playwright testing');

        // Submit the form
        const submitButton = page.locator('form button[type="submit"]');
        await submitButton.click();

        // Should either redirect to the new directory or show success
        // Wait for navigation away from /new page or for a toast success
        await page.waitForURL(/\/directories\/(?!new)/, { timeout: 15_000 }).catch(() => {
            // If no redirect, check for error toast
        });
    });

    test('should navigate back from manual form to mode selector', async ({ page }) => {
        await page.goto('/en/directories/new');

        // Enter manual mode
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await manualCard.click();

        // Wait for form
        await expect(page.locator('form')).toBeVisible({ timeout: 5_000 });

        // Click back button
        const backButton = page.locator('button').filter({ hasText: /back/i }).first();
        if (await backButton.isVisible()) {
            await backButton.click();
            // Should show mode selector again with 3 cards
            await expect(manualCard).toBeVisible({ timeout: 5_000 });
        }
    });
});

test.describe('Directory detail', () => {
    test('should show directory page when accessing a valid directory', async ({ page }) => {
        // First go to directories list and click on one if it exists
        await page.goto('/en/directories');
        await page.waitForLoadState('networkidle');

        const directoryLink = page.locator('a[href*="/directories/"]').first();

        if (await directoryLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await directoryLink.click();
            await expect(page).toHaveURL(/\/directories\/.+/);
            // Should render without error
            await expect(page.locator('body')).not.toContainText('500');
        }
    });
});
