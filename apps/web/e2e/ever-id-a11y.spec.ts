import { expect, test, type Page } from '@playwright/test';
import {
    disableEverId,
    enableEverId,
    everIdLaneAvailable,
    makeEverIdUser,
    setEverIdUser,
} from './helpers/ever-id';
import { describeViolations, runAxe, seriousViolations } from './helpers/axe';

/**
 * APW-12 (Ever ID) — the Ever ID screens are usable with a keyboard and a screen
 * reader (spec §6.7; NFR-6).
 *
 *  - The button is a real button with its full name, reachable with Tab from the
 *    password form, and starts the sign-in with Enter.
 *  - On the create-account screen the consent checkbox has a name, Enter on it does
 *    not submit, and a refusal is announced (`role="alert"`).
 *  - axe finds no serious or critical issue in the Ever ID button or the
 *    create-account form. axe-core is injected from the installed package
 *    (`helpers/axe.ts`); a load failure fails the test.
 */

test.use({ storageState: { cookies: [], origins: [] } });

/** Assert no serious or critical axe violation inside `selector`. */
async function expectNoSeriousViolations(page: Page, selector: string): Promise<void> {
    const serious = seriousViolations(await runAxe(page, { include: [selector] }));
    expect(serious, describeViolations(serious)).toEqual([]);
}

test.describe('Ever ID accessibility', () => {
    test.skip(!everIdLaneAvailable(), 'needs the Ever ID fixture provider (EVER_ID_E2E_FAKE_URL)');
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ request }) => {
        await enableEverId(request);
    });

    test.afterAll(async ({ request }) => {
        await disableEverId(request);
    });

    test('the sign-in button is a named button reachable with the keyboard', async ({
        page,
        request,
    }) => {
        await setEverIdUser(request, makeEverIdUser('everid-a11y-key'));
        await page.goto('/login');

        const button = page.getByRole('button', { name: 'Sign in with Ever ID' });
        await expect(button).toBeVisible();
        await expectNoSeriousViolations(page, '[data-testid="ever-id-button"]');

        await page.locator('input[name="password"]').focus();
        let reached = false;
        for (let i = 0; i < 12 && !reached; i += 1) {
            await page.keyboard.press('Tab');
            reached = await button.evaluate((element) => element === document.activeElement);
        }
        expect(reached).toBe(true);

        // Enter starts the sign-in: an unknown person ends on the create-account screen.
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/auth\/ever-id\/create-account/);
    });

    test('the create-account consent is named, Enter does not submit, and refusals are announced', async ({
        page,
        request,
    }) => {
        await setEverIdUser(request, makeEverIdUser('everid-a11y-consent'));
        await page.goto('/login');
        await page.getByTestId('ever-id-button').click();
        await page.waitForURL(/\/auth\/ever-id\/create-account/);

        const consent = page.getByTestId('ever-id-create-account-terms');
        await expect(consent).toHaveAccessibleName(
            /I agree to the Terms of Service and Privacy Policy/,
        );

        // Enter on the checkbox neither ticks-and-submits nor leaves the page.
        await consent.focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/auth\/ever-id\/create-account/);

        // Submitting unticked is refused with an announcement.
        await page.getByRole('button', { name: 'Create account' }).click();
        const refusal = page.getByTestId('ever-id-create-account-error');
        await expect(refusal).toBeVisible();
        await expect(refusal).toHaveAttribute('role', 'alert');
        await expect(page).toHaveURL(/\/auth\/ever-id\/create-account/);

        await expectNoSeriousViolations(page, '[data-testid="ever-id-create-account-form"]');
    });
});
