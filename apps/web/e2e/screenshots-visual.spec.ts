import { test, expect } from '@playwright/test';

/**
 * Visual regression — pass 5. Playwright's `toHaveScreenshot()` diffs
 * the current render against a baseline image. The baseline files don't
 * yet exist in this repo, so the whole describe is gated behind
 * `RUN_VISUAL_REGRESSION=1` — when first enabled, run with
 * `pnpm exec playwright test --update-snapshots screenshots-visual` to
 * record the baselines. Subsequent runs will diff.
 *
 * Without the env flag this is a no-op skip — keeps the rest of the
 * suite green while we build coverage in parallel.
 *
 * Baselines live in `apps/web/e2e/__screenshots__/` (default location).
 */

const RUN_VISUAL = process.env.RUN_VISUAL_REGRESSION === '1';

test.describe('Visual regression — public pages', () => {
    test.skip(
        !RUN_VISUAL,
        'set RUN_VISUAL_REGRESSION=1 to enable; run with --update-snapshots first to record baselines',
    );

    test('login page matches baseline', async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        // Settle animations / web fonts.
        await page.waitForTimeout(2_500);
        await expect(page).toHaveScreenshot('login-en-1280.png', {
            fullPage: true,
            maxDiffPixelRatio: 0.02,
            animations: 'disabled',
        });
    });

    test('register page matches baseline', async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/register`, {
            waitUntil: 'networkidle',
        });
        await page.waitForTimeout(2_500);
        await expect(page).toHaveScreenshot('register-en-1280.png', {
            fullPage: true,
            maxDiffPixelRatio: 0.02,
            animations: 'disabled',
        });
    });

    test('forgot-password page matches baseline', async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/forgot-password`, {
            waitUntil: 'networkidle',
        });
        if (!res || res.status() === 404) {
            test.skip(true, '/forgot-password not exposed');
        }
        await page.waitForTimeout(2_500);
        await expect(page).toHaveScreenshot('forgot-password-en-1280.png', {
            fullPage: true,
            maxDiffPixelRatio: 0.02,
            animations: 'disabled',
        });
    });
});
