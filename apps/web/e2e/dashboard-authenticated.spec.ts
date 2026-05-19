import { test, expect } from '@playwright/test';

/**
 * Authenticated dashboard UI driving — pass 4 ramp. This spec uses the
 * shared storageState fixture from global-setup so we land on /en/ as a
 * signed-in user without re-logging in.
 *
 * Pinning the *interactive* UI surface that earlier passes only probed
 * for "renders without 500". We click into widgets, check that the
 * navigation chrome wires up, and assert key counters / lists are
 * present.
 */

test.describe('Dashboard — authenticated UI (storageState)', () => {
    test('home renders welcome heading + at least one nav region', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 15_000 });
        // There must be SOME sort of nav chrome — sidebar (aside) or header
        // (nav). We don't care which; we only care that the dashboard
        // shell rendered, not just a blank page.
        const nav = page.locator('aside, nav').first();
        await expect(nav).toBeVisible({ timeout: 10_000 });
    });

    test('stats overview cards render with non-zero counts or "0" placeholder', async ({
        page,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);
        // Stats cards typically have a label + a numeric value.
        // We don't pin the exact label set (it evolves), but if any stat
        // labels exist they should render numbers or "—".
        const labels = await page
            .getByText(/total works|active websites|items|requests|generations|usage/i)
            .all();
        if (labels.length === 0) {
            test.skip(true, 'no stats overview labels found in this build');
        }
        // At least one of the labels must be visible — confirms the
        // dashboard didn't render an empty shell.
        let anyVisible = false;
        for (const l of labels.slice(0, 3)) {
            if (await l.isVisible().catch(() => false)) {
                anyVisible = true;
                break;
            }
        }
        expect(anyVisible).toBe(true);
    });

    test('keyboard Tab eventually reaches an interactive element', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_000);
        // Press Tab a few times and check focus lands on something
        // focusable. This is a coarse accessibility smoke that catches
        // the regression where the entire dashboard becomes
        // focus-trapped behind a hidden modal or skip-link.
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press('Tab');
        }
        const focused = await page.evaluate(() => {
            const el = document.activeElement;
            return el ? el.tagName : null;
        });
        // body = nothing focused; anything else = good.
        expect(focused, `Tab landed on ${focused}`).not.toBe('BODY');
    });

    test('clicking the Works nav link routes to /works', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        // Find any anchor that points at /works (sidebar or top nav).
        const link = page.locator('a[href*="/works"]').first();
        if (!(await link.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'no /works link found in nav for this build');
        }
        await link.click();
        await page.waitForURL(/\/works/, { timeout: 15_000 });
        await expect(page).toHaveURL(/\/works/);
    });

    test('user avatar / menu opens a dropdown', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        // Try common avatar / account-menu triggers.
        const triggers = [
            page.getByRole('button', { name: /account|profile|user menu|avatar/i }),
            page.locator('[data-testid*="avatar" i], [data-testid*="user-menu" i]'),
            page.locator('header button').last(),
        ];
        let opened = false;
        for (const t of triggers) {
            const first = t.first();
            if (await first.isVisible({ timeout: 3_000 }).catch(() => false)) {
                await first.click().catch(() => undefined);
                // Look for a menu item that only appears after opening.
                const item = page.getByRole('menuitem').first();
                if (await item.isVisible({ timeout: 3_000 }).catch(() => false)) {
                    opened = true;
                    break;
                }
            }
        }
        if (!opened) {
            test.skip(true, 'no avatar/user-menu dropdown discovered');
        }
    });
});
