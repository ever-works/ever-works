import { test, expect } from '@playwright/test';

/**
 * Playwright trace — golden-path artifact. This spec deliberately walks
 * the most-load-bearing happy paths (login, dashboard, /works) under
 * full trace recording. The artifact ends up in `test-results/` and is
 * intended for regression triage: when something starts behaving
 * strangely on CI, the golden trace gives a baseline of what "working"
 * looks like.
 *
 * The spec stays green so long as none of the steps produces a 5xx —
 * the value is the recording, not the pass/fail.
 */

test.describe('Golden trace — login + dashboard + works', () => {
    test.use({ trace: 'on' });

    test('walks the dashboard happy path under trace recording', async ({ page, baseURL }) => {
        const base = baseURL || 'http://localhost:3000';
        // 1. Login page renders.
        const loginRes = await page.goto(`${base}/en/login`, { waitUntil: 'domcontentloaded' });
        expect(loginRes?.status() ?? 0).toBeLessThan(500);
        await page.waitForTimeout(1_500);

        // 2. Dashboard route (storageState pre-authed) — already in the
        //    auth project, so we hit /en directly. If we get redirected
        //    back to /login (no auth), the recording still captures it.
        const dashRes = await page.goto(`${base}/en`, { waitUntil: 'domcontentloaded' });
        expect(dashRes?.status() ?? 0).toBeLessThan(500);
        await page.waitForTimeout(2_000);

        // 3. Works list.
        const worksRes = await page.goto(`${base}/en/works`, { waitUntil: 'domcontentloaded' });
        expect(worksRes?.status() ?? 0).toBeLessThan(500);
        await page.waitForTimeout(1_500);

        // 4. Settings.
        const settingsRes = await page.goto(`${base}/en/settings`, {
            waitUntil: 'domcontentloaded',
        });
        expect(settingsRes?.status() ?? 0).toBeLessThan(500);
        await page.waitForTimeout(1_500);

        // The trace artifact is the real output here; no further
        // assertions needed.
    });
});
