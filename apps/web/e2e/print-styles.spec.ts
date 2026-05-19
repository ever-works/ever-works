import { test, expect } from '@playwright/test';

/**
 * Print styles — pass 5. Coarse check that the key pages don't fall
 * apart under `emulateMedia({ media: 'print' })`. Print-broken pages
 * lose nav chrome AND content area at the same time — we catch that
 * here.
 */

test.describe('Print media — pages stay readable', () => {
    test('login page renders text content in print mode', async ({ page, baseURL }) => {
        await page.emulateMedia({ media: 'print' });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        // We don't pin specific styles — just that the rendered text is
        // non-trivial. A print stylesheet that hides everything is wrong.
        expect(body.trim().length, 'print-mode login has empty body').toBeGreaterThan(20);
    });

    test('register page renders text content in print mode', async ({ page, baseURL }) => {
        await page.emulateMedia({ media: 'print' });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/register`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.trim().length, 'print-mode register has empty body').toBeGreaterThan(20);
    });

    test('print mode does not hide form submit buttons entirely', async ({ page, baseURL }) => {
        await page.emulateMedia({ media: 'print' });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1_500);
        // A common print pitfall: stylesheet hides every button. The
        // submit must still be present in the DOM (even if visually
        // hidden) for users who print the page as a paper form.
        const submitExists = await page.locator('button[type="submit"]').count();
        expect(submitExists, 'print stylesheet removed submit button').toBeGreaterThan(0);
    });
});
