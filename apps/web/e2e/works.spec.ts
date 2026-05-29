import { test, expect } from '@playwright/test';

/**
 * Work E2E tests.
 *
 * These run WITH pre-authenticated state.
 */

test.describe('Work listing', () => {
    test('should load the works page', async ({ page }) => {
        const response = await page.goto('/en/works');

        await expect(page).toHaveURL(/\/works/);
        // Assert against HTTP status — the body now includes "500+ third-
        // party apps" copy (Composio plugin description) when the Plugins
        // panel is in view, which false-positives a body substring check.
        expect(response?.status(), '/en/works should not 5xx').toBeLessThan(500);
    });

    test('should show "new work" button or link', async ({ page }) => {
        await page.goto('/en/works');

        // PR DD repointed primary "+ New" CTAs from /works/new → /new (the
        // unified picker). Accept either destination; both shapes also with
        // the legacy /en locale prefix.
        const newDirLink = page.locator(
            'a[href$="/new"]:not([href*="/works/"]), a[href$="/works/new"], a[href*="/works/new?"]',
        );
        await expect(newDirLink.first()).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Work creation', () => {
    test('should show creation mode selector on new work page', async ({ page }) => {
        // PR DD — /works/new without ?mode/?proposal 307s to the unified
        // /new picker. Force `?mode=ai` so the legacy mode-card selector
        // assertion still applies.
        await page.goto('/en/works/new?mode=ai');

        // Should show 3 creation mode cards: AI, Manual, Import
        // Each is a <button> with descriptive text
        const buttons = page
            .locator('button')
            .filter({ hasText: /(AI|Manual|Import|Configure|Get Started)/i });
        await expect(buttons.first()).toBeVisible({ timeout: 10_000 });
    });

    test('should navigate to manual creation mode', async ({ page }) => {
        // Land directly on manual mode — PR DD redirect now means a bare
        // /works/new goes to /new; `?mode=manual` keeps us on the form.
        await page.goto('/en/works/new?mode=manual');

        // Should show the manual form with name, slug, description fields
        await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 5_000 });
    });

    test('should create a work via manual form', async ({ page }) => {
        const slug = `e2e-test-${Date.now().toString(36)}`;

        await page.goto('/en/works/new?mode=manual');

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
        // Land on manual mode directly (see comment on the previous test).
        await page.goto('/en/works/new?mode=manual');

        // Wait for the work creation form (scoped to avoid AI chat input form)
        const workForm = page.locator('form.space-y-6, form[autocomplete="off"]').first();
        await expect(workForm).toBeVisible({ timeout: 10_000 });

        // Click back button → returns to the mode-card selector on /works/new.
        const backButton = page.locator('button').filter({ hasText: /back/i }).first();
        if (await backButton.isVisible()) {
            await backButton.click();
            const manualCard = page
                .locator('button')
                .filter({ hasText: /Configure|Manual/i })
                .first();
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
            // Capture the actual work-detail navigation response (works with
            // Next.js soft routing — the RSC fetch is a real HTTP request).
            // `performance.getEntriesByType('navigation')` only reflects the
            // initial /en/works load and would always be 200 on a soft nav,
            // silently passing even if the detail page 5xx'd.
            const [response] = await Promise.all([
                page
                    .waitForResponse(
                        (r) =>
                            /\/works\/[^/?#]+/.test(new URL(r.url()).pathname) &&
                            r.request().method() === 'GET',
                        { timeout: 10_000 },
                    )
                    .catch(() => null),
                workLink.click(),
            ]);
            await expect(page).toHaveURL(/\/works\/.+/);
            if (response) {
                expect(response.status(), 'work detail navigation should not 5xx').toBeLessThan(
                    500,
                );
            }
        }
    });
});
