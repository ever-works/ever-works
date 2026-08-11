import { expect, test } from '@playwright/test';

/**
 * Can a real person actually create an account on this deployment?
 *
 * On 2026-08-09 the answer was no, on stage and production, while:
 *   - `/api/health/ready` reported ok across all ten subsystems,
 *   - `/api/version` reported the freshly-deployed SHA,
 *   - `GET /register` returned HTTP 200.
 *
 * The page was 200 and the form was dead: the consent checkbox rendered
 * `disabled` because the document fetch 404'd, so the submit could never be
 * made. Every signal we watched was green.
 *
 * The failure mode this guards against is therefore specific: a page that
 * *renders* but cannot be *used*. Asserting the checkbox is enabled is the
 * cheapest possible expression of that, and it is exactly what was false.
 */

function uniqueEmail(): string {
    // Keep it obviously-synthetic so the row is easy to find and purge in the
    // target environment.
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `smoke-${stamp}@smoke.ever.works`;
}

/**
 * Writes are opt-in. Creating accounts is fine on dev/stage and is how the
 * signup path gets genuinely exercised, but production is not a test fixture —
 * a smoke suite must not leave rows in the customer database. Production still
 * gets the read-only half, which is the half that failed on 2026-08-09.
 */
const WRITES_ALLOWED = process.env.SMOKE_ALLOW_WRITES === 'true';

test.describe('deployed signup', () => {
    test('the register page renders a consent checkbox that can actually be ticked', async ({
        page,
    }) => {
        await page.goto('/en/register', { waitUntil: 'domcontentloaded' });

        const terms = page.locator('#terms');
        await expect(terms).toBeVisible();

        // The assertion that was false in production. `toBeEnabled` rather than
        // a click, so the failure message names the real problem instead of
        // surfacing as an action timeout.
        await expect(
            terms,
            'consent checkbox is disabled — the register page could not load the required ' +
                'legal documents, so no account can be created on this deployment',
        ).toBeEnabled();
    });

    test('a new account can be created end to end', async ({ page }) => {
        test.skip(!WRITES_ALLOWED, 'writes disabled — set SMOKE_ALLOW_WRITES=true (never on prod)');
        const email = uniqueEmail();

        await page.goto('/en/register', { waitUntil: 'domcontentloaded' });

        await page.locator('input[name="name"]').fill('Smoke Test');
        await page.locator('input[name="email"]').fill(email);
        await page.locator('input[name="password"]').fill('SmokeTest1!');
        await page.locator('input[name="confirmPassword"]').fill('SmokeTest1!');
        await page.locator('#terms').check();

        await page.locator('button[type="submit"]').click();

        // Anywhere that is not an auth page counts as success: deployments
        // differ in whether they land on the dashboard, an onboarding wizard,
        // or an email-verification notice, and this suite should not encode
        // one environment's onboarding policy.
        await page.waitForURL(
            /^https?:\/\/[^/]+(?:\/en)?(\/(?!login|register|forgot|reset)|$|\?)/,
            { timeout: 60_000 },
        );
        await expect(page).not.toHaveURL(/\/register/);
    });

    test('the login page is reachable and interactive', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('input[name="email"]')).toBeVisible();
        await expect(page.locator('input[type="password"]').first()).toBeVisible();
        await expect(page.locator('button[type="submit"]').first()).toBeEnabled();
    });
});
