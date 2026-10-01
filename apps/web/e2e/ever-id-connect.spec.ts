import { expect, test, type Page } from '@playwright/test';
import { loginViaUI } from './helpers/auth';
import {
    disableEverId,
    enableEverId,
    everIdLaneAvailable,
    makeEverIdUser,
    registerPasswordAccount,
    setEverIdUser,
    type EverIdFakeUser,
} from './helpers/ever-id';

/**
 * APW-12 (Ever ID) — connecting Ever ID to an existing account, explicitly, from
 * Settings → Security, and disconnecting it again (spec §6.3–§6.4; ACC-12-16,
 * ACC-12-17, ACC-12-18, ACC-12-21).
 *
 *  - Connecting starts from the Connected identities card, goes through Ever ID
 *    (asked to sign in again there) and ends on a confirmation screen that shows
 *    both addresses; nothing is connected until the person confirms.
 *  - Once connected, "Sign in with Ever ID" signs in to that same account.
 *  - An Ever ID already connected to another account cannot be connected again.
 *  - Disconnecting asks first, and the account keeps its other sign-in methods.
 */

test.use({ storageState: { cookies: [], origins: [] } });

async function startConnect(
    page: Page,
    everId: EverIdFakeUser,
    request: Parameters<typeof setEverIdUser>[0],
) {
    await setEverIdUser(request, everId);
    await page.goto('/settings/security');
    await expect(page.getByTestId('connected-identities-card')).toBeVisible();
    await expect(page.getByTestId('ever-id-not-connected')).toBeVisible();
    await page.getByTestId('ever-id-connect').click();
}

test.describe('Connect Ever ID from Settings', () => {
    test.skip(!everIdLaneAvailable(), 'needs the Ever ID fixture provider (EVER_ID_E2E_FAKE_URL)');
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ request }) => {
        await enableEverId(request);
    });

    test.afterAll(async ({ request }) => {
        await disableEverId(request);
    });

    test('connects only after the person confirms, then signs in to the same account', async ({
        page,
        request,
    }) => {
        const account = await registerPasswordAccount(request, 'everid-connect');
        const everId = makeEverIdUser('everid-connect-id');
        await loginViaUI(page, account);

        await startConnect(page, everId, request);
        await page.waitForURL(/\/settings\/security\/connect-ever-id/);
        await expect(page.getByTestId('ever-id-connect-ever-id-email')).toContainText(everId.email);
        await expect(page.getByTestId('ever-id-connect-account-email')).toContainText(
            account.email,
        );
        // The two addresses differ, and the screen says so before anything happens.
        await expect(page.getByTestId('ever-id-emails-differ')).toBeVisible();

        await page.getByTestId('ever-id-connect-submit').click();
        await page.waitForURL(/\/settings\/security(?!\/connect)/);
        await expect(page.getByText('Ever ID connected.')).toBeVisible();
        await expect(page.getByTestId('ever-id-identity')).toBeVisible();
        await expect(page.getByTestId('ever-id-identity')).toContainText(everId.email);

        // Signed out, then back in with Ever ID: the same account, its identity listed.
        await page.context().clearCookies();
        await page.goto('/login');
        await page.getByTestId('ever-id-button').click();
        await page.waitForURL((url) => !/\/(login|auth\/)/.test(url.pathname));
        await page.goto('/settings/security');
        await expect(page.getByTestId('ever-id-identity')).toContainText(everId.email);

        // A second account cannot take the same Ever ID.
        const other = await registerPasswordAccount(request, 'everid-connect-other');
        await page.context().clearCookies();
        await loginViaUI(page, other);
        await startConnect(page, everId, request);
        await page.waitForURL(/\/settings\/security(?!\/connect)/);
        await expect(page.getByTestId('ever-id-connect-error')).toContainText(
            'This Ever ID is already connected to a different Ever Works account.',
        );
        await expect(page.getByTestId('ever-id-not-connected')).toBeVisible();
    });

    test('cancelling the confirmation connects nothing', async ({ page, request }) => {
        const account = await registerPasswordAccount(request, 'everid-cancel');
        await loginViaUI(page, account);

        await startConnect(page, makeEverIdUser('everid-cancel-id'), request);
        await page.waitForURL(/\/settings\/security\/connect-ever-id/);
        await page.getByTestId('ever-id-connect-cancel').click();
        await page.waitForURL(/\/settings\/security(?!\/connect)/);
        await expect(page.getByTestId('ever-id-not-connected')).toBeVisible();
    });

    test('disconnects after asking, and the password still signs in', async ({ page, request }) => {
        const account = await registerPasswordAccount(request, 'everid-disconnect');
        await loginViaUI(page, account);
        await startConnect(page, makeEverIdUser('everid-disconnect-id'), request);
        await page.waitForURL(/\/settings\/security\/connect-ever-id/);
        await page.getByTestId('ever-id-connect-submit').click();
        await page.waitForURL(/\/settings\/security(?!\/connect)/);
        await expect(page.getByTestId('ever-id-identity')).toBeVisible();

        await page.getByTestId('ever-id-disconnect').click();
        const dialog = page.getByTestId('ever-id-disconnect-dialog');
        await expect(dialog).toBeVisible();
        // "Keep it" changes nothing.
        await page.getByTestId('ever-id-disconnect-keep').click();
        await expect(page.getByTestId('ever-id-identity')).toBeVisible();

        await page.getByTestId('ever-id-disconnect').click();
        await page.getByTestId('ever-id-disconnect-confirm').click();
        await expect(page.getByTestId('ever-id-not-connected')).toBeVisible();

        await page.context().clearCookies();
        await loginViaUI(page, account);
    });
});
