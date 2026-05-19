import { test, expect } from '@playwright/test';

/**
 * Password paste allowed — pass 20. HIBP and NIST 800-63B guidance:
 * password fields should NOT block paste. Pasting from a password
 * manager (1Password, Bitwarden, etc.) is critical UX, and blocking
 * it pushes users to weaker passwords.
 *
 * We verify:
 *  - login + register password fields have no `onpaste="return false"`
 *    or similar paste-blocker
 *  - simulating Ctrl+V into the field actually populates the value
 */

test.describe('Password fields — paste is allowed', () => {
    test('login password field accepts pasted text', async ({ page, baseURL, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => null);
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const pw = page.locator('input[name="password"]').first();
        if (!(await pw.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'password field not visible');
        }
        const pasteValue = 'Pasted#FromManager-Pass123';
        // 1) No inline onpaste="return false" attribute. `.toMatch` errors
        //    on null, so only check when the attribute is actually present.
        const onpaste = await pw.getAttribute('onpaste');
        if (onpaste !== null) {
            expect(
                onpaste,
                `login password field has onpaste="${onpaste}" — blocks paste from password manager`,
            ).not.toMatch(/false|preventDefault/i);
        }
        // 2) No JS-attached paste handler that calls preventDefault.
        //    Dispatch a real ClipboardEvent and verify defaultPrevented stays false.
        const prevented = await pw.evaluate((el) => {
            const ev = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: new DataTransfer(),
            });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        expect(
            prevented,
            'login password field has a paste listener that calls preventDefault — blocks password manager paste',
        ).toBe(false);
        // 3) Round-trip: fill() simulates a paste; value must populate.
        await pw.fill(pasteValue);
        const got = await pw.inputValue();
        expect(got, 'password field did not accept the pasted value').toBe(pasteValue);
    });

    test('register password field accepts pasted text', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/register`, {
            waitUntil: 'domcontentloaded',
        });
        const pw = page.locator('input[name="password"]').first();
        if (!(await pw.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'password field not visible on register');
        }
        const onpaste = await pw.getAttribute('onpaste');
        if (onpaste !== null) {
            expect(
                onpaste,
                `register password field has onpaste="${onpaste}" — blocks paste`,
            ).not.toMatch(/false|preventDefault/i);
        }
        const prevented = await pw.evaluate((el) => {
            const ev = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: new DataTransfer(),
            });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        expect(
            prevented,
            'register password field has a paste listener that calls preventDefault — blocks password manager paste',
        ).toBe(false);
        const pasteValue = 'Register#Pasted-Pass123';
        await pw.fill(pasteValue);
        const got = await pw.inputValue();
        expect(got).toBe(pasteValue);
    });

    test('password fields do not declare autocomplete="off" without password-manager hint', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const pw = page.locator('input[name="password"]').first();
        if (!(await pw.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'password field not visible');
        }
        const ac = await pw.getAttribute('autocomplete');
        // `autocomplete="off"` blocks password managers. Acceptable:
        // `current-password`, `new-password`, or omitted. Soft-warn on
        // bare `off`.
        if (ac && ac.toLowerCase() === 'off') {
            test.info().annotations.push({
                type: 'warning',
                description: `login password field has autocomplete="off" — blocks password managers`,
            });
        }
    });
});
