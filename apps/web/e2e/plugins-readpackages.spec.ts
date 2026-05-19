import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Plugin OAuth — GitHub `read:packages` / `write:packages` subflow.
 *
 *   - `GET /api/oauth/:p/read-packages/connect/url`        — issue auth URL
 *   - `GET /api/oauth/:p/callback/plugins/read-packages`   — handle callback
 *
 * Used by the GitHub plugin's "Authorize with GitHub" button on the
 * `readPackagesPat` field. The resulting token is stored in plugin
 * settings (not as the user's main OAuth connection). Pins the auth
 * gate + response shape; full token exchange requires real OAuth
 * credentials so it skips in unconfigured envs.
 */

test.describe('Read-packages OAuth — initiation URL', () => {
    test('GET /api/oauth/:p/read-packages/connect/url without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/oauth/github/read-packages/connect/url`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/oauth/:p/read-packages/connect/url with auth returns {url, state}', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/oauth/github/read-packages/connect/url?callbackUrl=` +
                encodeURIComponent(
                    'https://app.ever.works/api/oauth/github/callback/plugins/read-packages',
                ),
            { headers: authedHeaders(u.access_token) },
        );
        if (res.status() === 400) {
            test.skip(true, `provider missing client config (400) — covered by integration`);
        }
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const body = await res.json();
        expect(typeof body?.url).toBe('string');
        expect(typeof body?.state).toBe('string');
        expect(body.state.length).toBeGreaterThan(16);
        // The provider URL should encode the read:packages scope.
        expect(body.url).toMatch(/read[:%3A]packages/i);
    });
});

test.describe('Read-packages OAuth — callback', () => {
    test('GET /api/oauth/:p/callback/plugins/read-packages without auth → 401', async ({
        request,
    }) => {
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins/read-packages?code=x&state=y`,
        );
        expect(res.status()).toBe(401);
    });

    test('GET callback/plugins/read-packages with auth + bogus code → 4xx (not 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins/read-packages?code=bogus&state=bogus`,
            { headers: authedHeaders(u.access_token) },
        );
        // 400 = bad code; 404 = state cookie missing; 403 = state mismatch — all < 500.
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });
});

test.describe('Plugin OAuth — main callback (deepens [~])', () => {
    test('GET /api/oauth/:p/callback/plugins without auth → 401', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=x&state=y`,
        );
        expect(res.status()).toBe(401);
    });

    test('GET /api/oauth/:p/callback/plugins with auth + bogus code → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback/plugins?code=bogus&state=bogus`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('GET /api/oauth/:p/connect/url with auth returns url+state', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 400) {
            test.skip(true, 'provider not configured');
        }
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body?.url).toBe('string');
        expect(typeof body?.state).toBe('string');
    });

    test('GET /api/oauth/providers returns provider list', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
    });

    test('GET /api/oauth/:p/connection returns connection state', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connection`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });
});
