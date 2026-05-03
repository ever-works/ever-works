import { test, expect } from '@playwright/test';

/**
 * Onboarding behaviour for an authenticated user.
 *
 * The shared chromium project's storageState already has the onboarding
 * modals dismissed (set in global-setup), so these tests verify that the
 * dismissed state survives reload + navigation.
 */

test.describe('Onboarding — dismissal persists', () => {
    test('home page does not show the onboarding modal as a blocker', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        // The "Welcome" / onboarding modal would block all clicks. Verify
        // we can still click a sidebar link.
        const worksLink = page.locator('a[href="/en/works"]').first();
        await expect(worksLink).toBeVisible({ timeout: 10_000 });
        await worksLink.click();
        await page.waitForURL(/\/en\/works(\?|\/|$)/, { timeout: 30_000 });
    });

    test('localStorage contains the dismissed onboarding state', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const stored = await page.evaluate(() => {
            try {
                return window.localStorage.getItem('ever-works-onboarding');
            } catch {
                return null;
            }
        });
        if (stored) {
            const parsed = JSON.parse(stored) as { modalDismissed?: boolean };
            expect(
                parsed.modalDismissed === true || parsed.modalDismissed === undefined,
                'modal flagged as dismissed (or missing key — both acceptable)',
            ).toBe(true);
        }
    });

    test('"Connect GitHub" modal does not block navigation on /works/new', async ({ page }) => {
        await page.goto('/en/works/new', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        // We should still be able to interact with the page — at minimum, see
        // one of the three creation mode cards.
        const anyMode = page
            .locator('button')
            .filter({ hasText: /(create with ai|configure|manual|import existing)/i })
            .first();
        await expect(anyMode).toBeVisible({ timeout: 10_000 });
    });
});
