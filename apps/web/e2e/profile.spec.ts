import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Profile — UI + API contract.
 *
 * UI: /settings page renders username + email; can update via form.
 * API: GET /api/auth/profile, PUT /api/auth/profile.
 */

test.describe('Profile — UI', () => {
    test('settings page shows username input pre-filled', async ({ page }) => {
        await page.goto('/en/settings', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const usernameInput = page.locator('input').first();
        await expect(usernameInput).toBeVisible({ timeout: 10_000 });
        const value = await usernameInput.inputValue();
        expect(value.length, 'username should be pre-populated').toBeGreaterThan(0);
    });

    test('email field is read-only (disabled or readonly)', async ({ page }) => {
        await page.goto('/en/settings', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        const emailInput = page.locator('input[type="email"]').first();
        // Either type=email, or look for the disabled attribute
        const isDisabled = await emailInput.isDisabled({ timeout: 5_000 }).catch(() => false);
        const readonly = await emailInput.getAttribute('readonly').catch(() => null);
        expect(isDisabled || readonly !== null, 'email should be disabled or readonly').toBe(true);
    });
});

test.describe('Profile — API contract', () => {
    test('GET /api/auth/profile without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/profile`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/auth/profile with auth returns user', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // Profile shape might be { user: {...} } or flat
        const user = body?.user ?? body;
        expect(user.email).toBe(u.email);
    });

    test('GET /api/auth/profile/fresh returns user (force-refresh)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const user = body?.user ?? body;
        expect(user.email).toBe(u.email);
    });

    test('PUT /api/auth/profile updates username', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const newName = `Updated Name ${Date.now().toString(36)}`;

        const updateRes = await request.put(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
            data: { username: newName },
        });
        expect(
            updateRes.status(),
            `update status ${updateRes.status()}: ${await updateRes.text().catch(() => '')}`,
        ).toBeGreaterThanOrEqual(200);
        expect(updateRes.status()).toBeLessThan(300);

        const getRes = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(u.access_token),
        });
        const body = await getRes.json();
        const user = body?.user ?? body;
        expect(user.username).toBe(newName);
    });
});
