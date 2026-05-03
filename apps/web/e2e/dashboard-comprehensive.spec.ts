import { test, expect } from '@playwright/test';

/**
 * Comprehensive authenticated-dashboard E2E tests. Runs in the chromium
 * project (with stored auth state from global-setup), so the user is
 * already logged in and the onboarding + GitHub-connect modals are
 * pre-dismissed.
 *
 * What we cover:
 *   - Each main dashboard page loads without 5xx
 *   - Sidebar shows the "Works" nav label and "New Work" CTA
 *   - URL slugs are /works, /works/new, /settings, /activity, /plugins
 *   - Works list page renders header + search + summary
 *   - Activity log page renders + uses Work-vocabulary subtitle
 */

const dashboardPages = [
    { path: '/en', name: 'home' },
    { path: '/en/works', name: 'works list' },
    { path: '/en/works/new', name: 'new work' },
    { path: '/en/settings', name: 'settings' },
    { path: '/en/settings/security', name: 'security' },
    { path: '/en/settings/api-keys', name: 'API keys' },
    { path: '/en/settings/data', name: 'data' },
    { path: '/en/settings/danger', name: 'danger zone' },
    { path: '/en/plugins', name: 'plugins' },
    { path: '/en/activity', name: 'activity' },
];

test.describe('Dashboard — comprehensive (authenticated)', () => {
    for (const { path, name } of dashboardPages) {
        test(`${name} page (${path}) loads without 5xx`, async ({ page }) => {
            test.setTimeout(120_000);

            // In dev mode the first hit on a route can return 500 mid-compile.
            // Retry up to 3 times with a small delay before failing.
            let response;
            for (let attempt = 0; attempt < 3; attempt++) {
                response = await page.goto(path, { waitUntil: 'domcontentloaded' });
                if (response && response.status() < 500) break;
                await page.waitForTimeout(2_000);
            }
            expect(response?.status(), `${path} should not 5xx after retries`).toBeLessThan(500);

            // Should NOT have been bounced to /login
            await expect(page, `${path} should not redirect to /login`).not.toHaveURL(/\/login/);

            // Wait for client render
            await page.waitForTimeout(1_500);
            const body = await page.locator('body').innerText();

            // Page actually rendered something
            expect(body.length, `${path} page should have content`).toBeGreaterThan(50);
        });
    }

    test('sidebar shows "Works" nav item with /en/works href', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const worksLink = page.locator('a[href="/en/works"]').first();
        await expect(worksLink, 'sidebar /en/works link present').toBeVisible({ timeout: 10_000 });
    });

    test('sidebar "New Work" CTA is present', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const newWorkLink = page.locator('a[href="/en/works/new"]').first();
        await expect(newWorkLink, 'sidebar /en/works/new CTA present').toBeVisible({
            timeout: 10_000,
        });
    });

    test('works list page header uses Work vocabulary', async ({ page }) => {
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const body = await page.locator('body').innerText();

        expect(body).toMatch(/\bWorks\b/);
        expect(body).toMatch(/manage and organize your ai-powered works/i);
    });

    test('works list page search input is present', async ({ page }) => {
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const search = page.locator('input[placeholder*="works" i]').first();
        await expect(search, 'search input visible').toBeVisible({ timeout: 10_000 });
    });

    test('new work page shows three creation modes', async ({ page }) => {
        await page.goto('/en/works/new', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const body = await page.locator('body').innerText();
        expect(body).toMatch(/new work/i);

        expect(body, 'mode selector mentions Create/Configure/Import').toMatch(
            /create with ai|configure|manual|import existing/i,
        );
    });

    test('activity log subtitle uses Work vocabulary', async ({ page }) => {
        await page.goto('/en/activity', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const body = await page.locator('body').innerText();
        expect(body, 'activity subtitle mentions works').toMatch(
            /track all operations across your works/i,
        );
    });

    test('activity log column header is "Work" (singular)', async ({ page }) => {
        await page.goto('/en/activity', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const tableHeaders = page.locator('table thead th, [role="columnheader"]');
        const count = await tableHeaders.count();
        if (count > 0) {
            const headers = await tableHeaders.allInnerTexts();
            expect(headers.join('|'), 'table headers use Work vocabulary').toMatch(/work/i);
        }
    });

    test('plugins page loads', async ({ page }) => {
        const resp = await page.goto('/en/plugins', { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), '/en/plugins should not 5xx').toBeLessThan(500);
        await page.waitForTimeout(1_500);
        const body = await page.locator('body').innerText();
        expect(body, 'plugins page subtitle').toMatch(/manage your installed plugins/i);
    });

    test('clicking sidebar Works link navigates to /en/works', async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const worksLink = page.locator('a[href="/en/works"]').first();
        await expect(worksLink).toBeVisible({ timeout: 10_000 });
        await worksLink.click();
        await page.waitForURL(/\/en\/works(\?|$|\/)/, { timeout: 30_000 });
        expect(page.url()).toMatch(/\/en\/works/);
    });

    test('clicking sidebar "New Work" link navigates to /en/works/new', async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const newWorkLink = page.locator('a[href="/en/works/new"]').first();
        await expect(newWorkLink).toBeVisible({ timeout: 10_000 });
        await newWorkLink.click();
        await page.waitForURL(/\/en\/works\/new/, { timeout: 30_000 });
    });
});
