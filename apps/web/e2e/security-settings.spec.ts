import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders, loginViaAPI } from './helpers/api';

/**
 * Security settings — UI form + API change-password contract.
 *
 * UI tests run with stored-auth state.
 * API tests register a fresh user per test.
 */

test.describe('Security — UI', () => {
    test('shows three password inputs (current, new, confirm) and submit', async ({ page }) => {
        await page.goto('/en/settings/security', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const pwInputs = page.locator('input[type="password"]');
        const count = await pwInputs.count();
        expect(count, 'expect at least 3 password inputs').toBeGreaterThanOrEqual(3);

        const submit = page.locator('button[type="submit"]').first();
        await expect(submit).toBeVisible({ timeout: 10_000 });
    });

    test('submitting empty form keeps user on /security (validation kicks in)', async ({
        page,
    }) => {
        await page.goto('/en/settings/security', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const submit = page.locator('button[type="submit"]').first();
        await submit.click();
        await page.waitForTimeout(800);

        await expect(page).toHaveURL(/\/settings\/security/);
    });
});

test.describe('Security — API contract', () => {
    test('POST /api/auth/update-password without auth returns 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            data: { currentPassword: 'x', newPassword: 'NewSecure1!' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/auth/update-password with wrong current → 4xx (not 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: 'WrongPassword!', newPassword: 'NewSecure1!' },
        });
        expect(res.status(), `wrong-current status ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('POST /api/auth/update-password with correct current → succeeds, new password works', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const newPassword = 'EvenMoreSecure2!';

        const res = await request.post(`${API_BASE}/api/auth/update-password`, {
            headers: authedHeaders(u.access_token),
            data: { currentPassword: u.password, newPassword },
        });
        expect(
            res.status(),
            `update status ${res.status()}: ${await res.text().catch(() => '')}`,
        ).toBeGreaterThanOrEqual(200);
        expect(res.status()).toBeLessThan(300);

        // Old password should no longer work
        const oldLogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
        });
        expect(oldLogin.status(), 'old password no longer works').toBeGreaterThanOrEqual(400);

        // New password should work
        const newLogin = await loginViaAPI(request, { email: u.email, password: newPassword });
        expect(newLogin.access_token).toBeTruthy();
    });

    test('POST /api/auth/logout with auth → 200/204', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/auth/logout`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `logout status ${res.status()}`).toBeLessThan(400);
    });
});
