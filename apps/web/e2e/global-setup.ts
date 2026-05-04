import { test as setup, expect } from '@playwright/test';
import { TEST_USER } from './helpers/test-user';
import { registerViaAPI } from './helpers/auth';

const authFile = 'e2e/.auth/user.json';

/**
 * Global setup: create a test user and save authenticated browser state.
 *
 * Authenticated tests reuse this state so they don't need to log in individually.
 */
setup('authenticate', async ({ page, baseURL }) => {
    // Dev-mode compilation of the dashboard route on first hit can take a
    // long time, so the whole setup needs a generous budget.
    setup.setTimeout(300_000);

    // 1. Register the user via API (fast)
    try {
        await registerViaAPI(baseURL!, TEST_USER);
    } catch {
        // User may already exist from a previous run — try logging in instead
    }

    // 2. Thorough warmup: hit /en/login AND /en so both routes are compiled
    //    by the dev server before we attempt the login flow. The post-login
    //    server-action redirect needs the destination to be ready, otherwise
    //    the browser sits on /en/login while the dev server compiles /en.
    await page.goto('/en/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    await page.goto('/en', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    // 3. Log in via the UI so cookies are properly set by the Next.js server.
    //    Wait for the page (and any Fast Refresh rebuilds) to settle before
    //    interacting with the form, otherwise the submit button can get
    //    re-rendered out from under us in dev mode.
    await page.goto('/en/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);

    await page.locator('input[name="email"]').fill(TEST_USER.email);
    await page.locator('input[name="password"]').fill(TEST_USER.password);
    await page.locator('button[type="submit"]').click();

    // Wait for successful redirect to dashboard. The regex matches `/en`, `/en/`,
    // `/en?...`, or `/en/<dashboard-path>` — but NOT `/en/login` or other auth pages
    // (so we don't accidentally consider the still-on-login state as success).
    await page.waitForURL(/\/en(\/(?!login|register|forgot|reset|email|auth)|$|\?)/, {
        timeout: 120_000,
    });

    // Verify we're authenticated
    await expect(page).not.toHaveURL(/\/login/);

    // 3. Pre-dismiss the onboarding wizard so subsequent authenticated tests
    //    aren't blocked by the modal portal intercepting clicks.
    const ONBOARDING_KEY = 'ever-works-onboarding';
    await page.evaluate((key) => {
        try {
            window.localStorage.setItem(
                key,
                JSON.stringify({ step: 0, modalDismissed: true, headerDismissed: true }),
            );
        } catch {
            // localStorage may not be available; tests can dismiss manually.
        }
    }, ONBOARDING_KEY);

    // 4. Dismiss the "Connect your GitHub account" modal if it appears, and
    //    record the dismissal in localStorage (key is keyed by userId, so we
    //    have to interact rather than seed it directly).
    const dismissBtn = page.getByRole('button', { name: /I'll do this later/i });
    if (await dismissBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dismissBtn.click();
        await page.waitForTimeout(500);
    }

    // 5. Save the browser state (cookies, localStorage)
    await page.context().storageState({ path: authFile });
});
