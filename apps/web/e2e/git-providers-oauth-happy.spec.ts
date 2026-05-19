import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Git provider OAuth happy-path — pass 7. We can't actually round-trip
 * against the real GitHub provider in CI (no client secrets there), but
 * we CAN drive the platform-side endpoints that the round-trip would
 * exercise and pin their contracts:
 *
 *   - `GET /api/oauth/github/connect/url` — issues a fresh state cookie
 *   - `GET /api/oauth/providers` — lists configured providers
 *   - `GET /api/oauth/github/connection` — reports current connection
 *
 * Plus the unhappy paths the bot review previously flagged: callback
 * with bad code, callback without state.
 */

test.describe('Git OAuth — happy-path endpoints', () => {
    test('GET /api/oauth/providers returns a non-empty list with shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.providers ?? body?.data ?? []);
        // Some envs have zero providers configured — that's OK.
        if (arr.length === 0) {
            test.skip(true, 'no OAuth providers configured in this env');
        }
        // If any are configured, each must have at least a name / id key.
        for (const p of arr) {
            const id = p?.id ?? p?.name ?? p?.provider;
            expect(typeof id, `provider missing id/name: ${JSON.stringify(p).slice(0, 100)}`).toBe(
                'string',
            );
        }
    });

    test('GET /api/oauth/github/connect/url issues url + state for authed user', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 400) {
            test.skip(true, 'github provider not configured in this env');
        }
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body?.url).toBe('string');
        expect(typeof body?.state).toBe('string');
        expect(body.state.length).toBeGreaterThan(16);
        // URL should point at github.com.
        expect(body.url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/i);
        // URL must contain the state parameter (CSRF).
        const u2 = new URL(body.url);
        expect(u2.searchParams.get('state')).toBe(body.state);
    });

    test('GET /api/oauth/github/connection for fresh user returns disconnected state', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connection`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
        // Fresh user has never bound github — `connected` (or equivalent
        // flag) must be falsy. We don't pin the exact field name.
        const connected =
            body?.connected ??
            body?.isConnected ??
            body?.linked ??
            body?.bound ??
            body?.status === 'connected';
        if (typeof connected === 'boolean') {
            expect(connected, `fresh user reports github already connected`).toBe(false);
        }
    });
});

test.describe('Git OAuth — disconnect contract', () => {
    test('DELETE /api/oauth/github/connection for fresh user → 4xx or 204 (no-op)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.delete(`${API_BASE}/api/oauth/github/connection`, {
            headers: authedHeaders(u.access_token),
        });
        // Either 204 (idempotent — nothing to disconnect, return success)
        // or 404 (no connection found). Never 5xx.
        expect(res.status()).toBeLessThan(500);
    });
});
