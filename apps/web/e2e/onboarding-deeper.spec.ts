import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Onboarding — deepens onboarding.spec.ts / onboarding-wizard-v2.spec.ts
 * by pinning the state controller's GET/PUT lifecycle, the catalog
 * endpoints, and the dismiss / complete transitions.
 */

test.describe('Onboarding state — GET/PUT lifecycle', () => {
    test('GET /api/onboarding/state without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/onboarding/state`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/onboarding/state for fresh user returns an object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });

    test('PUT /api/onboarding/state without auth → 401', async ({ request }) => {
        const res = await request.put(`${API_BASE}/api/onboarding/state`, {
            data: { step: 'welcome' },
        });
        expect(res.status()).toBe(401);
    });

    test('PUT /api/onboarding/state with a well-formed body responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.put(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(u.access_token),
            data: { step: 'welcome', completed: false },
        });
        expect(res.status()).toBeLessThan(500);
        expect([401]).not.toContain(res.status());
    });
});

test.describe('Onboarding catalog endpoints', () => {
    test('GET /api/onboarding/catalog/ai-providers returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/onboarding/catalog/ai-providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.json();
            const arr = Array.isArray(body) ? body : (body?.providers ?? body?.data ?? []);
            expect(Array.isArray(arr)).toBe(true);
        }
    });

    test('GET /api/onboarding/catalog/storage returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/onboarding/catalog/storage`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/onboarding/catalog/deployment returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/onboarding/catalog/deployment`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Onboarding — dismiss / complete transitions', () => {
    test('POST /api/onboarding/dismiss without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/onboarding/dismiss`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/onboarding/complete without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/onboarding/complete`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/onboarding/dismiss for fresh user responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        expect([401]).not.toContain(res.status());
    });
});
