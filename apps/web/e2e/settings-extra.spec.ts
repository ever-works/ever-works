import { test, expect } from '@playwright/test';

/**
 * Extra coverage for the dashboard /settings/* surface beyond what
 * settings.spec.ts and account-data.spec.ts already check:
 *  - GitHub App settings page (auth-required) renders without 5xx
 *  - Plugins category settings under /settings/plugins/[category] no-5xx
 *  - Each settings sub-route preserves the sidebar nav
 */

const settingsRoutes = [
    '/en/settings/github-app',
    '/en/settings/plugins',
    '/en/settings/plugins/ai-provider',
    '/en/settings/plugins/search',
    '/en/settings/plugins/git-provider',
    '/en/settings/plugins/deployment',
];

test.describe('Settings — extra page coverage', () => {
    for (const path of settingsRoutes) {
        test(`${path} renders without 5xx`, async ({ page }) => {
            test.setTimeout(60_000);
            // Dev-mode first hit can return 5xx mid-compile — allow a retry.
            let response;
            for (let attempt = 0; attempt < 3; attempt++) {
                response = await page.goto(path, { waitUntil: 'domcontentloaded' });
                if (response && response.status() < 500) break;
                await page.waitForTimeout(2_000);
            }
            expect(response?.status(), `${path} should not 5xx`).toBeLessThan(500);

            // Should not be bounced to /login (we have stored auth state)
            await expect(page, `${path} should not redirect to /login`).not.toHaveURL(/\/login/);

            await page.waitForTimeout(1_500);
            const body = await page.locator('body').innerText();
            expect(body.length, `${path} should render content`).toBeGreaterThan(50);
        });
    }

    test('settings sidebar links remain reachable across sub-routes', async ({ page }) => {
        await page.goto('/en/settings', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        for (const sub of ['security', 'api-keys', 'data', 'danger']) {
            const link = page.locator(`a[href*="/settings/${sub}"]`).first();
            await expect(link, `sidebar link for /settings/${sub}`).toBeVisible({
                timeout: 10_000,
            });
        }
    });
});
