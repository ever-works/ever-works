import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth state replay — pass 6. Deepens oauth-state.spec.ts. The
 * platform issues a one-time CSRF state for each OAuth initiation.
 * Re-using that state on a second callback MUST be rejected — that's
 * the entire point of CSRF protection.
 */

test.describe('OAuth state — single-use enforcement', () => {
    test('callback with random unconsumed state → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // We can't mint a real state without a full OAuth round-trip,
        // so this is the negative case: any state value the server
        // didn't issue MUST be rejected, NEVER coerced into 200.
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=bogus&state=replay-attack-${Date.now()}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('callback without state is rejected (no silent fallback)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/callback?code=bogus`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('callback with state but no code is rejected', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/callback?state=anything`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('two callbacks with identical bogus state both fail (no caching)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const state = `replay-${Date.now().toString(36)}`;
        const r1 = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake&state=${state}`,
            { headers: authedHeaders(u.access_token) },
        );
        const r2 = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake&state=${state}`,
            { headers: authedHeaders(u.access_token) },
        );
        // Both must fail. The second one MUST NOT silently succeed
        // because of any per-state caching the server might do.
        expect(r1.status()).toBeGreaterThanOrEqual(400);
        expect(r2.status()).toBeGreaterThanOrEqual(400);
        expect([200]).not.toContain(r1.status());
        expect([200]).not.toContain(r2.status());
    });
});

test.describe('OAuth initiation — state is fresh on every call', () => {
    test('two consecutive /connect/url calls return different state values', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const r1 = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (r1.status() === 400) {
            test.skip(true, 'provider not configured for OAuth in this env');
        }
        expect(r1.status()).toBe(200);
        const r2 = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        expect(r2.status()).toBe(200);
        const s1 = (await r1.json())?.state;
        const s2 = (await r2.json())?.state;
        expect(typeof s1).toBe('string');
        expect(typeof s2).toBe('string');
        // Reusing the same state across initiation calls would defeat
        // the CSRF protection — each round-trip needs its own nonce.
        expect(s1, 'oauth state was reused across two initiation calls').not.toBe(s2);
    });
});
