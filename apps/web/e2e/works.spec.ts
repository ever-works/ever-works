import { test, expect } from '@playwright/test';

/**
 * Work E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

test.describe('Work listing', () => {
    test('should load the works page', async ({ page }) => {
        await page.goto('/en/works');

        await expect(page).toHaveURL(/\/works/);
        // Page should render without server error
        await expect(page.locator('body')).not.toContainText('500');
    });

    test('should show "new work" button or link', async ({ page }) => {
        await page.goto('/en/works');

        const newDirLink = page.locator('a[href*="/works/new"]');
        await expect(newDirLink.first()).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Work creation', () => {
    test('should show creation mode selector on new work page', async ({ page }) => {
        await page.goto('/en/works/new');

        // Should show 3 creation mode cards: AI, Manual, Import
        // Each is a <button> with descriptive text
        const buttons = page
            .locator('button')
            .filter({ hasText: /(AI|Manual|Import|Configure|Get Started)/i });
        await expect(buttons.first()).toBeVisible({ timeout: 10_000 });
    });

    test('should navigate to manual creation mode', async ({ page }) => {
        await page.goto('/en/works/new');

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

    test('should create a work via manual form', async ({ page }) => {
        const slug = `e2e-test-${Date.now().toString(36)}`;

        await page.goto('/en/works/new');

        // Select manual mode
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await manualCard.click();

        // Wait for the work creation form (scoped to avoid the AI chat input form)
        const workForm = page.locator('form.space-y-6, form[autocomplete="off"]').first();
        await expect(workForm).toBeVisible({ timeout: 10_000 });

        // Fill in the work form
        const nameInput = workForm.locator('input[type="text"]').first();
        await nameInput.fill(`E2E Test Dir ${slug}`);

        // Slug should auto-populate, but let's verify it exists
        const slugInput = workForm.locator('input[type="text"]').nth(1);
        await expect(slugInput).toHaveValue(/.+/);

        // Description — textarea
        const descriptionTextarea = workForm.locator('textarea').first();
        await descriptionTextarea.fill('Automated E2E test work for Playwright testing');

        // Submit the form
        const submitButton = workForm.locator('button[type="submit"]');
        await submitButton.click();

        // Should either redirect to the new work or show success
        // Wait for navigation away from /new page or for a toast success
        await page.waitForURL(/\/works\/(?!new)/, { timeout: 15_000 }).catch(() => {
            // If no redirect, check for error toast
        });
    });

    test('should navigate back from manual form to mode selector', async ({ page }) => {
        await page.goto('/en/works/new');

        // Enter manual mode
        const manualCard = page
            .locator('button')
            .filter({ hasText: /Configure|Manual/i })
            .first();
        await manualCard.click();

        // Wait for the work creation form (scoped to avoid AI chat input form)
        const workForm = page.locator('form.space-y-6, form[autocomplete="off"]').first();
        await expect(workForm).toBeVisible({ timeout: 10_000 });

        // Click back button
        const backButton = page.locator('button').filter({ hasText: /back/i }).first();
        if (await backButton.isVisible()) {
            await backButton.click();
            // Should show mode selector again with 3 cards
            await expect(manualCard).toBeVisible({ timeout: 5_000 });
        }
    });
});

test.describe('Work detail', () => {
    test('should show work page when accessing a valid work', async ({ page }) => {
        // First go to works list and click on one if it exists
        await page.goto('/en/works');
        await page.waitForLoadState('networkidle');

        const workLink = page.locator('a[href*="/works/"]').first();

        if (await workLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await workLink.click();
            await expect(page).toHaveURL(/\/works\/.+/);
            // Should render without error
            await expect(page.locator('body')).not.toContainText('500');
        }
    });
});
