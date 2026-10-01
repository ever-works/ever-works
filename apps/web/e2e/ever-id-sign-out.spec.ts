import { expect, test, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, makeTestUser, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';
import {
    disableEverId,
    enableEverId,
    everIdLaneAvailable,
    makeEverIdUser,
    registerPasswordAccount,
    sendEverIdSignOutNotice,
    setEverIdSessionId,
    setEverIdUser,
    type EverIdFakeUser,
} from './helpers/ever-id';

/**
 * APW-12 (Ever ID) — signing out, both ways (spec §6.5; FR-36, FR-37; ACC-12-24,
 * ACC-12-25, ACC-12-26).
 *
 *  - S6: when Ever ID tells this installation that a person signed out there (a
 *    back-channel logout notice), the Ever Works sessions opened with that Ever ID
 *    session end, the API answers the notice with `Cache-Control: no-store`, and the
 *    sign-in page says "You were signed out of Ever ID." Other people's sessions are
 *    untouched.
 *  - S7: "Sign out" on a session opened with Ever ID asks whether to sign out of
 *    Ever ID too; ticked, the browser makes the round trip through Ever ID and lands
 *    on the sign-in page with "You're signed out of Ever Works and Ever ID."
 */

test.use({ storageState: { cookies: [], origins: [] } });

/** Sign up with Ever ID through the create-account screen; ends signed in. */
async function signUpWithEverId(
    page: Page,
    person: EverIdFakeUser,
    request: Parameters<typeof setEverIdUser>[0],
) {
    await setEverIdUser(request, person);
    await page.goto('/login');
    await page.getByTestId('ever-id-button').click();
    await page.waitForURL(/\/auth\/ever-id\/create-account/);
    await page.getByTestId('ever-id-create-account-terms').check();
    await page.getByTestId('ever-id-create-account-submit').click();
    await page.waitForURL((url) => !/\/(login|auth\/)/.test(url.pathname));
}

test.describe('Signing out with Ever ID', () => {
    test.skip(!everIdLaneAvailable(), 'needs the Ever ID fixture provider (EVER_ID_E2E_FAKE_URL)');
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ request }) => {
        await enableEverId(request);
    });

    test.afterAll(async ({ request }) => {
        await disableEverId(request);
    });

    test("a sign-out notice from Ever ID ends that session and nobody else's", async ({
        page,
        request,
    }) => {
        const sid = `sid-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        await setEverIdSessionId(request, sid);
        await signUpWithEverId(page, makeEverIdUser('everid-notice'), request);
        await page.goto('/settings/security');
        await expect(page.getByTestId('ever-id-identity')).toBeVisible();

        // Someone else, signed in with a password, is not affected by the notice.
        const bystander = await registerUserViaAPI(request, makeTestUser('everid-bystander'));

        const answer = await sendEverIdSignOutNotice(request, { sid });
        expect(answer.status).toBe(200);
        expect(answer.cacheControl ?? '').toContain('no-store');

        await page.goto('/login');
        await expect(page.getByTestId('ever-id-signed-out-notice')).toHaveText(
            'You were signed out of Ever ID.',
        );
        await page.goto('/settings/security');
        await page.waitForURL(/\/login/);

        const profile = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(bystander.access_token),
        });
        expect(profile.status()).toBe(200);
    });

    test('"Also sign out of Ever ID" signs out of both and says so', async ({
        page,
        request,
        baseURL,
    }) => {
        // A password account that connects Ever ID, then signs in with it — so the
        // session is one Ever ID opened and the onboarding wizard is out of the way.
        const account = await registerPasswordAccount(request, 'everid-both');
        await loginViaUI(page, account);
        await setEverIdUser(request, makeEverIdUser('everid-both-id'));
        await page.goto('/settings/security');
        await page.getByTestId('ever-id-connect').click();
        await page.waitForURL(/\/settings\/security\/connect-ever-id/);
        await page.getByTestId('ever-id-connect-submit').click();
        await page.waitForURL(/\/settings\/security(?!\/connect)/);

        await page.context().clearCookies();
        await setEverIdSessionId(request, `sid-${Date.now().toString(36)}`);
        await page.goto('/login');
        await page.getByTestId('ever-id-button').click();
        await page.waitForURL((url) => !/\/(login|auth\/)/.test(url.pathname));

        // The profile menu at the foot of the (expanded) sidebar shows the address.
        await page
            .context()
            .addCookies([
                { name: 'sidebar-collapsed', value: '0', url: baseURL ?? 'http://localhost:3000' },
            ]);
        await page.goto('/settings/security');
        await page.locator('aside').getByText(account.email).first().click();
        await page.getByRole('menuitem', { name: /sign out/i }).click();

        const dialog = page.getByTestId('ever-id-sign-out-dialog');
        await expect(dialog).toBeVisible();
        // Unticked every time it opens.
        await expect(page.getByTestId('ever-id-sign-out-also')).not.toBeChecked();
        await page.getByTestId('ever-id-sign-out-also').check();
        await page.getByTestId('ever-id-sign-out-confirm').click();

        await page.waitForURL(/\/login\?signedOut=ever-id/);
        await expect(page.getByTestId('ever-id-signed-out-notice')).toHaveText(
            "You're signed out of Ever Works and Ever ID.",
        );
        await page.goto('/settings/security');
        await page.waitForURL(/\/login/);
    });
});
