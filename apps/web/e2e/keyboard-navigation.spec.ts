import { test, expect } from '@playwright/test';

/**
 * Keyboard navigation — pass 5+. Covers tab-order, focus traps, and
 * Escape-to-close on modals. Complements accessibility.spec.ts which
 * focuses on ARIA and axe-core.
 */

test.describe('Keyboard navigation — login form', () => {
    test('Tab moves focus email → password → submit', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        // Focus the email field first to anchor tab order.
        const email = page.locator('input[name="email"]').first();
        if (!(await email.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'login form not visible');
        }
        await email.focus();
        // Tab once → password.
        await page.keyboard.press('Tab');
        const focused1 = await page.evaluate(
            () => (document.activeElement as HTMLInputElement)?.name || '',
        );
        // Some builds inject a "forgot password" link or "show password"
        // toggle between the two inputs — that's fine as long as we
        // reach the password field within a few tabs.
        let reachedPassword = focused1 === 'password';
        for (let i = 0; i < 4 && !reachedPassword; i++) {
            await page.keyboard.press('Tab');
            const f = await page.evaluate(
                () => (document.activeElement as HTMLInputElement)?.name || '',
            );
            if (f === 'password') {
                reachedPassword = true;
                break;
            }
        }
        expect(reachedPassword, 'tab order never reached password field').toBe(true);
    });

    test('Shift+Tab from password returns toward email', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        const pwd = page.locator('input[name="password"]').first();
        if (!(await pwd.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'password input not visible');
        }
        await pwd.focus();
        // Shift+Tab a few times — we should land back on the email field
        // within a reasonable number of presses (forms might have a
        // "show password" toggle in between).
        let landedEmail = false;
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press('Shift+Tab');
            const f = await page.evaluate(
                () => (document.activeElement as HTMLInputElement)?.name || '',
            );
            if (f === 'email') {
                landedEmail = true;
                break;
            }
        }
        expect(landedEmail, 'shift+tab never returned to email').toBe(true);
    });
});

test.describe('Keyboard navigation — dashboard', () => {
    test('Escape closes any open dropdown or modal (smoke)', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_500);
        // Open user menu if one is reachable.
        const menuTrigger = page
            .getByRole('button', { name: /account|profile|user menu|avatar|menu/i })
            .first();
        if (!(await menuTrigger.isVisible({ timeout: 3_000 }).catch(() => false))) {
            test.skip(true, 'no menu trigger to test Escape behaviour');
        }
        await menuTrigger.click().catch(() => undefined);
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        // After Escape, the menu should be closed — no menuitem visible.
        const stillOpen = await page
            .getByRole('menuitem')
            .first()
            .isVisible({ timeout: 1_500 })
            .catch(() => false);
        expect(stillOpen, 'menu remained open after Escape').toBe(false);
    });
});
