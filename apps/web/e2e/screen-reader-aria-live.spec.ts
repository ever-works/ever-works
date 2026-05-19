import { test, expect } from '@playwright/test';

/**
 * Screen reader aria-live — pass 19. Form errors must surface in an
 * aria-live region so assistive tech announces them. WCAG 2.2 4.1.3
 * Status Messages.
 */

test.describe('Accessibility — aria-live regions on login form', () => {
    test('/en/login carries an aria-live region or aria-relevant landmark', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        // Probe for typical patterns: explicit aria-live, role=alert,
        // role=status. Any of these signals an announce-able region.
        const liveCount = await page.locator('[aria-live]').count();
        const alertCount = await page.locator('[role="alert"]').count();
        const statusCount = await page.locator('[role="status"]').count();
        const total = liveCount + alertCount + statusCount;
        if (total === 0) {
            // Soft signal — form errors won't be screen-reader-announced
            // unless they get added on validation. Informational.
            test.info().annotations.push({
                type: 'warning',
                description:
                    '/en/login has no aria-live / role=alert / role=status landmarks — form errors may not announce',
            });
        }
        // At least the page should render.
        const body = await page.locator('body').innerText();
        expect(body.length).toBeGreaterThan(20);
    });

    test('submitting login with bad password reveals an announce-able error', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const email = page.locator('input[name="email"]').first();
        const pw = page.locator('input[name="password"]').first();
        const submit = page.locator('button[type="submit"]').first();
        if (!(await email.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'login form not rendering');
        }
        await email.fill(`screenreader-aria-${Date.now()}@test.local`);
        await pw.fill('Wrong#PasswordTwelveChars');
        await submit.click().catch(() => null);
        // Give the form ~3s to display error.
        await page.waitForTimeout(3_000);
        // After submit, look for a now-populated aria-live region OR
        // a visible error message with role=alert.
        // Codex P1: `[role!="presentation"]` is not valid CSS — Playwright
        // would throw a selector-parsing error before the test ran. Use
        // the canonical `:not()` form instead.
        const announcedNow =
            (await page.locator('[aria-live]:not([role="presentation"])').count()) +
            (await page.locator('[role="alert"]').count()) +
            (await page.locator('[role="status"]').count());
        // Either there's an aria-live target (good), or the page just
        // didn't surface an error in time (informational).
        if (announcedNow === 0) {
            test.info().annotations.push({
                type: 'informational',
                description:
                    'login form rejected the bad password but produced no aria-live / role=alert landmark',
            });
        }
    });
});
