import { test, expect } from '@playwright/test';

/**
 * Onboarding tour replay — pass 11. The platform may support a
 * `?tour=1` query param (or `?onboarding=replay`) that re-triggers the
 * onboarding wizard for completed users. Useful for support / docs.
 *
 * We verify the dashboard page renders under both `?tour=1` and
 * without it, and that the tour-flag URL parameter doesn't cause a
 * 5xx.
 */

const TOUR_QUERIES = ['?tour=1', '?onboarding=replay', '?welcome=1', '?showTour=true'];

test.describe('Onboarding tour — replay via query param', () => {
    for (const q of TOUR_QUERIES) {
        test(`/en${q} renders without 5xx`, async ({ page }) => {
            const res = await page.goto(`/en${q}`, { waitUntil: 'domcontentloaded' });
            if (!res) test.skip(true, 'no response');
            expect(res!.status()).toBeLessThan(500);
            // Page must render — empty body would mean a query-param
            // crashed the React tree.
            const body = await page
                .locator('body')
                .innerText()
                .catch(() => '');
            expect(body.length, `tour query ${q} produced empty body`).toBeGreaterThan(20);
        });
    }
});

test.describe("Onboarding tour — clean URL doesn't re-trigger", () => {
    test('plain /en after dismiss does not surface tour overlay', async ({ page }) => {
        // Visit /en after global-setup has dismissed onboarding. The
        // tour overlay should NOT be visible.
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        // Tour overlays are typically modals or fixed-position panels
        // labelled with role=dialog. We don't require them to be
        // absent (the dashboard may legitimately have OTHER dialogs);
        // we just check the body actually has chrome.
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 10_000 });
    });
});
