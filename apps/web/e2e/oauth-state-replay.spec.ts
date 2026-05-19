import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth state replay — pass 6. Deepens oauth-state.spec.ts. The
 * platform issues a one-time CSRF state for each OAuth initiation.
 * Re-using that state on a second callback MUST be rejected — that's
 * the entire point of CSRF protection.
 *
 * Important: OAuth callbacks are real-world hit by an UNAUTHENTICATED
 * browser following a provider redirect. Each scenario therefore runs
 * BOTH unauth and authed — the unauth variant catches a server that
 * silently 200's a bad state when the user happens not to have a JWT.
 */

test.describe('OAuth state — single-use enforcement (UNAUTH — real attack path)', () => {
    test('unauth callback with random unconsumed state → 4xx', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=bogus&state=replay-attack-${Date.now()}`,
        );
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('unauth callback without state is rejected', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/oauth/github/callback?code=bogus`);
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('unauth callback with state but no code is rejected', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/oauth/github/callback?state=anything`);
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('two unauth callbacks with identical bogus state both fail (no caching)', async ({
        request,
    }) => {
        const state = `replay-unauth-${Date.now().toString(36)}`;
        const r1 = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake&state=${state}`,
        );
        const r2 = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake&state=${state}`,
        );
        expect(r1.status()).toBeGreaterThanOrEqual(400);
        expect(r2.status()).toBeGreaterThanOrEqual(400);
        expect([200]).not.toContain(r1.status());
        expect([200]).not.toContain(r2.status());
    });
});

test.describe('OAuth state — single-use enforcement (AUTHED — second-factor path)', () => {
    test('authed callback with random unconsumed state → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Some platforms let an already-authenticated user re-bind a
        // provider; pin that the state guard still applies on that
        // codepath, not just on the unauth one.
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=bogus&state=replay-authed-${Date.now()}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('authed callback without state is rejected', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/callback?code=bogus`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
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
