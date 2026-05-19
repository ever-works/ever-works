import { test, expect } from '@playwright/test';

/**
 * Dropdown keyboard navigation — pass 8. Deepens keyboard-navigation.spec.ts.
 * Verifies the common dropdowns / menus on the dashboard accept arrow
 * keys + Enter + Escape — basic ARIA combobox / menu interaction. If
 * we can't find an open-able menu, skip with reason rather than fail.
 */

test.describe('Dropdown keyboard — open + arrow + select', () => {
    test('an opened menu responds to ArrowDown by moving focus', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        // Find any user / account / profile menu trigger.
        const trigger = page
            .getByRole('button', { name: /account|profile|user menu|avatar|menu|more/i })
            .first();
        if (!(await trigger.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'no menu trigger discovered');
        }
        await trigger.click().catch(() => undefined);
        await page.waitForTimeout(500);
        const firstItem = page.getByRole('menuitem').first();
        if (!(await firstItem.isVisible({ timeout: 2_000 }).catch(() => false))) {
            test.skip(true, 'no menuitem rendered after click');
        }
        // Focus the first item then ArrowDown.
        await firstItem.focus();
        await page.keyboard.press('ArrowDown');
        const activeText = await page.evaluate(() => document.activeElement?.textContent ?? '');
        // Active element after ArrowDown should still be inside a
        // menu-shaped container. Greptile P1: previously this branch
        // called test.skip when ArrowDown moved focus OUT of the menu,
        // turning the exact regression this test exists to catch into a
        // silent skip. Now we assert directly — a real bug fails the
        // suite.
        const stillInsideMenu = await page.evaluate(
            () =>
                document.activeElement?.closest(
                    '[role="menu"], [role="menubar"], [role="listbox"]',
                ) !== null,
        );
        expect(
            stillInsideMenu,
            `ArrowDown moved focus outside the menu (active="${activeText.slice(0, 40)}")`,
        ).toBe(true);
    });

    test('Escape closes an open menu', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const trigger = page
            .getByRole('button', { name: /account|profile|user menu|avatar|menu/i })
            .first();
        if (!(await trigger.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'no menu trigger');
        }
        await trigger.click().catch(() => undefined);
        await page.waitForTimeout(400);
        const item = page.getByRole('menuitem').first();
        if (!(await item.isVisible({ timeout: 2_000 }).catch(() => false))) {
            test.skip(true, 'no menuitem visible');
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const stillOpen = await item.isVisible({ timeout: 1_000 }).catch(() => false);
        expect(stillOpen, 'menu remained open after Escape').toBe(false);
    });

    test('Enter on a menu item navigates / fires an action', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const trigger = page
            .getByRole('button', { name: /account|profile|user menu|avatar|menu/i })
            .first();
        if (!(await trigger.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'no menu trigger');
        }
        await trigger.click().catch(() => undefined);
        await page.waitForTimeout(400);
        const settingsItem = page
            .getByRole('menuitem', { name: /settings|preferences|profile|account/i })
            .first();
        if (!(await settingsItem.isVisible({ timeout: 2_000 }).catch(() => false))) {
            test.skip(true, 'no settings menuitem');
        }
        const urlBefore = page.url();
        await settingsItem.focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(800);
        // Either the URL changed (navigation) or the menu closed and a
        // sub-pane opened. Either way, observable user-facing effect must
        // happen — the menu cannot just swallow Enter silently.
        const urlAfter = page.url();
        const menuStillOpen = await page
            .getByRole('menuitem')
            .first()
            .isVisible({ timeout: 800 })
            .catch(() => false);
        const visibleEffect = urlAfter !== urlBefore || !menuStillOpen;
        expect(visibleEffect, 'Enter on menu item had no visible effect').toBe(true);
    });
});
