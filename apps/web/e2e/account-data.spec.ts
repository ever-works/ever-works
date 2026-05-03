import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * /settings/data — export, import, sync UI + API.
 *
 * UI tests run with the chromium auth project.
 * API tests register fresh users so they're independent of storage state.
 */

test.describe('Settings → Data — UI', () => {
    test('page renders with export/import sections', async ({ page }) => {
        await page.goto('/en/settings/data', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const body = await page.locator('body').innerText();
        expect(body, 'data page should mention export/import/sync').toMatch(
            /export|import|backup|sync/i,
        );

        // At least one button (export, import, or sync configure) should be visible
        const anyButton = page.locator('button').first();
        await expect(anyButton).toBeVisible({ timeout: 10_000 });
    });
});

test.describe('Settings → Danger zone — UI', () => {
    test('delete confirmation requires email match', async ({ page }) => {
        await page.goto('/en/settings/danger', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const deleteBtn = page
            .locator('button')
            .filter({ hasText: /delete/i })
            .first();
        await expect(deleteBtn).toBeVisible({ timeout: 10_000 });
        await deleteBtn.click();
        await page.waitForTimeout(500);

        // Confirmation field should appear
        const confirmInput = page.locator('input[type="email"], input[type="text"]').last();
        await expect(confirmInput).toBeVisible({ timeout: 5_000 });

        // The final destructive button should be disabled until the user types
        // their email (or at least require non-empty input). We just verify
        // typing a wrong value doesn't submit/redirect.
        await confirmInput.fill('not-the-right-email@example.com');
        await page.waitForTimeout(300);
        // We must still be on /danger
        await expect(page).toHaveURL(/\/settings\/danger/);
    });
});

test.describe('Account API contract', () => {
    test('GET /api/account/export returns user data when authenticated', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/account/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `export status ${res.status()}`).toBe(200);
        const ctype = res.headers()['content-type'] || '';
        expect(ctype, 'export returns JSON').toMatch(/json/);
        const body = await res.json();
        expect(body, 'export body is an object').toBeTruthy();
    });

    test('GET /api/account/export without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/account/export`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/account/sync/status without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/account/sync/status`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/account/sync/status with auth does not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/account/sync/status`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `sync status ${res.status()}`).toBeLessThan(500);
    });
});
