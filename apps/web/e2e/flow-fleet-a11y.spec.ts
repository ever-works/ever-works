import { test, expect, type Page } from '@playwright/test';
import {
    FLEET_HUB_CLICK_TIMEOUT as CLICK_TIMEOUT,
    FLEET_HUB_ON,
    enrollFleetNode,
    freshFleetUser,
    signedInFleetUser,
} from './helpers/fleet-hub';

/**
 * Fleet hub (FL-01, T-28, spec §5.12 / §5.13, FR-34) — the keyboard walk of the
 * hub and the computer page: both tab strips are `tablist`s with one selected
 * tab in the tab order and Left / Right / Home / End moving the focus; Space
 * opens the focused tab; `1` – `6` open the hub tabs; on a computer page `?`
 * opens the shortcut sheet (Escape closes it) and `F` stars and unstars the
 * computer; and the ⋯ menu and the tab strip are reachable with Tab alone.
 *
 * An automated contrast / role sweep needs an accessibility-engine dev
 * dependency the repo does not have (owner question, FL-01 lane log); this
 * walk covers the keyboard half of T-28 without one.
 *
 * Skips unless the web server under test runs with `FLEET_HUB_ENABLED=true`.
 */

async function blur(page: Page) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function focusedTestId(page: Page): Promise<string | null> {
    return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

test.describe('Fleet hub — keyboard walk', () => {
    test.skip(!FLEET_HUB_ON, 'FLEET_HUB_ENABLED is not on for this run');

    test('the hub strip: roving focus, Space, and the digits (spec §5.12, §5.13)', async ({
        browser,
        request,
    }) => {
        const u = await freshFleetUser(request);
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            await page.goto('/en/fleet', { waitUntil: 'networkidle' });
            const strip = page.getByTestId('fleet-hub-tabs').getByRole('tablist');
            await expect(strip.getByRole('tab')).toHaveCount(6);
            await expect(strip.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
            await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

            const overview = page.getByTestId('fleet-hub-tab-overview');
            await overview.focus();
            await page.keyboard.press('ArrowRight');
            await expect(page.getByTestId('fleet-hub-tab-computers')).toBeFocused();
            await page.keyboard.press('End');
            await expect(page.getByTestId('fleet-hub-tab-usage')).toBeFocused();
            await page.keyboard.press('ArrowRight');
            await expect(overview).toBeFocused();
            await page.keyboard.press('ArrowLeft');
            await expect(page.getByTestId('fleet-hub-tab-usage')).toBeFocused();
            await page.keyboard.press('Home');
            await expect(overview).toBeFocused();
            // Moving the focus never navigates.
            await expect(page).toHaveURL(/\/en\/fleet$/);

            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('Space');
            await expect(page).toHaveURL(/\/en\/fleet\/computers$/);

            await blur(page);
            await page.keyboard.press('1');
            await expect(page).toHaveURL(/\/en\/fleet$/);
            await blur(page);
            await page.keyboard.press('3');
            await expect(page).toHaveURL(/\/en\/fleet\/sessions$/);
            await blur(page);
            await page.keyboard.press('6');
            await expect(page).toHaveURL(/\/en\/fleet\/usage$/);
            // A digit past the last tab does nothing.
            await blur(page);
            await page.keyboard.press('7');
            await expect(page).toHaveURL(/\/en\/fleet\/usage$/);
        } finally {
            await close();
        }
    });

    test('the computer page: its strip, `?`, `F`, and Tab reaches every act (FR-34)', async ({
        browser,
        request,
    }) => {
        const u = await freshFleetUser(request);
        const node = await enrollFleetNode(request, u.access_token);
        const { page, close } = await signedInFleetUser(browser, u);
        try {
            await page.goto(`/en/fleet/computers/${node.nodeId}`, { waitUntil: 'networkidle' });
            const strip = page.getByTestId('fleet-computer-tabs').getByRole('tablist');
            await expect(strip.getByRole('tab')).toHaveCount(12);
            await expect(strip.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);

            const overview = page.getByTestId('fleet-computer-tab-overview');
            await overview.focus();
            await page.keyboard.press('ArrowRight');
            await expect(page.getByTestId('fleet-computer-tab-sessions')).toBeFocused();
            await page.keyboard.press('End');
            await expect(page.getByTestId('fleet-computer-tab-settings')).toBeFocused();
            await page.keyboard.press('Home');
            await expect(overview).toBeFocused();

            // `?` opens the sheet; Escape closes it.
            await blur(page);
            await page.keyboard.press('Shift+Slash');
            const sheet = page.getByTestId('fleet-computer-shortcuts');
            await expect(sheet).toBeVisible();
            await expect(sheet).toContainText('Keyboard shortcuts');
            await expect(sheet).toContainText('Add to or remove from favourites');
            await page.keyboard.press('Escape');
            await expect(sheet).toHaveCount(0);

            // `F` stars, and says so; `F` again unstars.
            await blur(page);
            await page.keyboard.press('f');
            await expect(page.getByText(`Added ${node.name} to favourites.`)).toBeVisible();
            await page.reload({ waitUntil: 'networkidle' });
            const menu = page.getByTestId('fleet-computer-menu-trigger');
            await menu.click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('fleet-computer-menu-favourite')).toHaveText(
                /Remove from favourites/,
            );
            await page.keyboard.press('Escape');
            await blur(page);
            await page.keyboard.press('f');
            await expect(page.getByText(`Removed ${node.name} from favourites.`)).toBeVisible();

            // Tab alone reaches the ⋯ menu and the open tab.
            await page.reload({ waitUntil: 'networkidle' });
            await blur(page);
            const reached = new Set<string>();
            for (let i = 0; i < 80; i += 1) {
                await page.keyboard.press('Tab');
                const id = await focusedTestId(page);
                if (id) reached.add(id);
                if (
                    reached.has('fleet-computer-menu-trigger') &&
                    reached.has('fleet-computer-tab-overview')
                ) {
                    break;
                }
            }
            expect([...reached]).toEqual(
                expect.arrayContaining([
                    'fleet-computer-menu-trigger',
                    'fleet-computer-tab-overview',
                ]),
            );
            // Only the open tab is in the tab order (roving tab index).
            expect(reached.has('fleet-computer-tab-sessions')).toBe(false);
        } finally {
            await close();
        }
    });
});
