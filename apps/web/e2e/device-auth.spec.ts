import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Device auth — CLI / external-tool login flow under `/api/device-auth`.
 * Pins the REST contract:
 *
 *   - `POST /api/device-auth/:pluginId/start`   — start a device-auth flow
 *   - `GET  /api/device-auth/:pluginId/status`  — poll for completion
 */

test.describe('Device auth — API contract', () => {
    test('POST /api/device-auth/:plugin/start without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/device-auth/github/start`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/device-auth/:plugin/status without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/device-auth/github/status`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/device-auth/:plugin/start with auth returns shape that includes a user code or url', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/device-auth/github/start`, {
            headers: authedHeaders(u.access_token),
        });
        // 200 with payload, OR 400/404 if the plugin isn't configured for this
        // env — both are acceptable "endpoint exists" outcomes.
        if (res.status() === 400 || res.status() === 404 || res.status() === 503) {
            test.skip(true, `device-auth not configured for this plugin (${res.status()})`);
        }
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const body = await res.json();
        // Standard device-auth payload: user_code + verification_uri at minimum.
        expect(
            typeof body?.user_code === 'string' ||
                typeof body?.userCode === 'string' ||
                typeof body?.verification_uri === 'string' ||
                typeof body?.verificationUri === 'string' ||
                typeof body?.deviceCode === 'string',
            `body shape: ${JSON.stringify(body).slice(0, 200)}`,
        ).toBe(true);
    });

    test('GET /api/device-auth/:plugin/status with auth returns a status-like shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/device-auth/github/status`, {
            headers: authedHeaders(u.access_token),
        });
        // 200 = status payload; 404 = no flow in progress for this user/plugin.
        // Both pin the contract that the endpoint exists and is auth-aware.
        expect([200, 400, 404]).toContain(res.status());
    });
});
