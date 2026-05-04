import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * API-keys: combined UI + API contract coverage for /settings/api-keys.
 *
 * UI tests run with the chromium project (authenticated state).
 * API tests register a fresh user per test so they're independent of
 * the shared storageState account.
 */

test.describe('API keys — UI', () => {
    test('page loads with create button and (initially) empty list / 0 keys', async ({ page }) => {
        await page.goto('/en/settings/api-keys', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);

        // Create / new / add button
        const createBtn = page
            .locator('button')
            .filter({ hasText: /create|new|add/i })
            .first();
        await expect(createBtn).toBeVisible({ timeout: 10_000 });

        // Page should not contain the legacy 500/Internal Server Error
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/Internal Server Error/i);
    });

    test('clicking "Create API Key" opens the create dialog with a name input', async ({
        page,
    }) => {
        await page.goto('/en/settings/api-keys', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        // Pick the specific "Create API Key" button (avoids matching a generic
        // "+ New Work" CTA in the sidebar).
        const createBtn = page
            .locator('button')
            .filter({ hasText: /create api key/i })
            .first();
        await expect(createBtn).toBeVisible({ timeout: 10_000 });
        await createBtn.click();

        // The unique signal that the dialog is open is the name input with
        // its specific placeholder ("e.g. My Integration"). That placeholder
        // doesn't appear anywhere else on the page.
        const nameInput = page.locator('input[placeholder*="My Integration" i]').first();
        await expect(nameInput, 'create dialog opened').toBeVisible({ timeout: 15_000 });
    });
});

test.describe('API keys — API contract', () => {
    test('GET /api/auth/api-keys without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/api-keys`);
        expect(res.status()).toBe(401);
    });

    test('full CRUD: create, list, revoke', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        // create
        const createRes = await request.post(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(u.access_token),
            data: { name: 'e2e-test-key' },
        });
        expect(
            createRes.status(),
            `create status was ${createRes.status()}: ${await createRes
                .text()
                .catch(() => '<no body>')}`,
        ).toBeGreaterThanOrEqual(200);
        expect(createRes.status()).toBeLessThan(300);
        const created = await createRes.json();
        // Most APIs return the plaintext key once on creation
        const keyId = created?.id ?? created?.key?.id ?? created?.apiKey?.id;
        expect(keyId, 'created key has an id').toBeTruthy();

        // list
        const listRes = await request.get(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(u.access_token),
        });
        expect(listRes.status()).toBe(200);
        const list = await listRes.json();
        const keys = Array.isArray(list) ? list : (list?.keys ?? list?.data ?? []);
        expect(Array.isArray(keys), 'list is an array').toBe(true);
        const found = keys.find((k: { id?: string }) => k?.id === keyId);
        expect(found, 'created key appears in list').toBeTruthy();

        // revoke
        const revokeRes = await request.delete(`${API_BASE}/api/auth/api-keys/${keyId}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(revokeRes.status(), 'revoke succeeds').toBeGreaterThanOrEqual(200);
        expect(revokeRes.status()).toBeLessThan(300);

        // revoke twice -> 404
        const revokeAgain = await request.delete(`${API_BASE}/api/auth/api-keys/${keyId}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(revokeAgain.status(), 'revoking twice returns 404').toBe(404);
    });

    test("one user cannot revoke another user's key", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const createRes = await request.post(`${API_BASE}/api/auth/api-keys`, {
            headers: authedHeaders(a.access_token),
            data: { name: 'cross-user-test' },
        });
        const created = await createRes.json();
        const keyId = created?.id ?? created?.key?.id ?? created?.apiKey?.id;

        const cross = await request.delete(`${API_BASE}/api/auth/api-keys/${keyId}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(cross.status(), 'other user can not revoke').toBe(404);
    });
});
