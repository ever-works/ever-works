import { expect, test, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';
import {
    disableEverId,
    enableEverId,
    everIdLaneAvailable,
    makeEverIdUser,
    setEverIdUser,
} from './helpers/ever-id';

/**
 * APW-12 (Ever ID) — signing in and signing up with Ever ID, end to end, against the
 * fixture provider (spec §6.1–§6.2; ACC-12-02, ACC-12-09, ACC-12-10, ACC-12-12,
 * ACC-12-15).
 *
 * What these walk through, in a real browser, with the real API and the real
 * `oidc-identity` plugin:
 *  - an unknown, verified Ever ID creates an account ONLY after the person confirms
 *    on the create-account screen; Cancel creates nothing;
 *  - the next sign-in goes straight in, with no screen in between;
 *  - an Ever ID whose e-mail an existing account already uses signs nobody in and
 *    links nothing — the person is told to sign in the usual way and connect from
 *    Settings;
 *  - an unverified Ever ID e-mail is refused;
 *  - every existing way to sign in is still on the page, and the registration page's
 *    button waits for the terms box like the social buttons do.
 *
 * Ever ID is turned on for this file only (the administrator route, `beforeAll`) and
 * off again afterwards (`afterAll`). The file skips itself in a lane without the
 * fixture provider.
 */

test.use({ storageState: { cookies: [], origins: [] } });

/** `/`, `/?newUser=true`, `/en`… — anywhere that is not a sign-in or Ever ID screen. */
const SIGNED_IN_URL =
    /^https?:\/\/[^/]+(?:\/en)?(?:\/(?!login|register|auth\/|settings\/security\/connect)[^?]*)?(?:\?.*)?$/;

async function clickEverIdButton(
    page: Page,
    path: '/login' | '/register' = '/login',
): Promise<void> {
    await page.goto(path);
    const button = page.getByTestId('ever-id-button');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await button.click();
}

test.describe('Sign in with Ever ID', () => {
    test.skip(!everIdLaneAvailable(), 'needs the Ever ID fixture provider (EVER_ID_E2E_FAKE_URL)');
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ request }) => {
        await enableEverId(request);
    });

    test.afterAll(async ({ request }) => {
        await disableEverId(request);
    });

    test('keeps every existing sign-in method and adds the Ever ID button', async ({ page }) => {
        await page.goto('/login');

        await expect(page.locator('input[name="email"]')).toBeVisible();
        await expect(page.locator('input[name="password"]')).toBeVisible();
        await expect(page.getByTestId('ever-id-button')).toHaveText(/Sign in with Ever ID/);
        // Magic link is on in this lane; its tab is still offered next to the password form.
        await expect(page.getByTestId('login-tab-magic-link')).toBeVisible();
    });

    test('waits for the terms box on the registration page', async ({ page }) => {
        await page.goto('/register');

        const button = page.getByTestId('ever-id-button');
        await expect(button).toHaveText(/Sign up with Ever ID/);
        await expect(button).toBeDisabled();
        await expect(page.getByTestId('ever-id-button-reason')).toBeVisible();

        await page.locator('#terms').check();
        await expect(button).toBeEnabled();
    });

    test('creates an account only after the person confirms, and goes straight in next time', async ({
        page,
        request,
    }) => {
        const person = makeEverIdUser('everid-new');
        await setEverIdUser(request, person);

        // First visit: the create-account screen, with the identity read-only.
        await clickEverIdButton(page);
        await page.waitForURL(/\/auth\/ever-id\/create-account/);
        await expect(
            page.getByText(`Signed in to Ever ID as ${person.name} · ${person.email}`),
        ).toBeVisible();

        // Cancel creates nothing: signing in again shows the same screen again.
        await page.getByTestId('ever-id-create-account-cancel').click();
        await page.waitForURL(/\/login/);
        await clickEverIdButton(page);
        await page.waitForURL(/\/auth\/ever-id\/create-account/);

        // Creating needs the terms box.
        await page.getByTestId('ever-id-create-account-submit').click();
        await expect(page.getByTestId('ever-id-create-account-error')).toBeVisible();
        await page.getByTestId('ever-id-create-account-terms').check();
        await page.getByTestId('ever-id-create-account-submit').click();
        await page.waitForURL(SIGNED_IN_URL);

        // Signed out and back in: no screen in between this time.
        await page.context().clearCookies();
        await clickEverIdButton(page);
        await page.waitForURL(SIGNED_IN_URL);
        await page.goto('/settings/security');
        await expect(page.getByTestId('ever-id-identity')).toBeVisible();
    });

    test('never links an Ever ID to an existing account by e-mail', async ({ page, request }) => {
        const existing = await registerUserViaAPI(request, makeTestUser('everid-existing'));
        await setEverIdUser(request, {
            subject: makeEverIdUser('everid-same-email').subject,
            email: existing.email,
            emailVerified: true,
            name: 'Same Address',
        });

        await clickEverIdButton(page);
        await page.waitForURL(/\/auth\/ever-id\/account-exists/);
        await expect(page.getByText(existing.email)).toBeVisible();

        // Nothing was connected and nobody was signed in.
        const identities = await request.get(`${API_BASE}/api/auth/ever-id/identities`, {
            headers: authedHeaders(existing.access_token),
        });
        expect(identities.status()).toBe(200);
        expect((await identities.json()).items).toEqual([]);
        await page.goto('/settings/security');
        await page.waitForURL(/\/login/);
    });

    test('refuses an Ever ID whose e-mail is not verified', async ({ page, request }) => {
        await setEverIdUser(request, {
            ...makeEverIdUser('everid-unverified'),
            emailVerified: false,
        });

        await clickEverIdButton(page);
        await page.waitForURL(/\/auth\/error/);
        await expect(
            page.getByText('Verify your e-mail address with Ever ID first, then try again.'),
        ).toBeVisible();
    });
});
