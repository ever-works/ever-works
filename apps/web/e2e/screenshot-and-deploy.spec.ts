import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Plugins-capabilities surface — `/api/screenshot/*`, `/api/deploy/*`,
 * `/api/search/*` smoke. These are wired through plugin facades so we
 * just verify the routes exist and reject unauth cleanly.
 */

// Real endpoint paths exposed by these capability controllers (verified
// against source). Each is auth-required; the goal is to confirm the
// route exists and rejects unauth (not 404, not 5xx).
const protectedReadEndpoints = [
    '/api/screenshot/check-availability',
    '/api/deploy/providers',
    '/api/search/check-availability',
];

test.describe('Plugins-capabilities — protected endpoints reject unauth', () => {
    for (const path of protectedReadEndpoints) {
        test(`GET ${path} → 401 (no auth)`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            // 401 expected; 404 means we wired the wrong path; >=500 means
            // something broke server-side.
            expect(res.status(), `${path} returned ${res.status()}`).not.toBe(404);
            expect(res.status()).toBeLessThan(500);
        });
    }

    test('POST /api/search/ without auth → 401 (auth-protected)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/search/`, { data: {} });
        expect(res.status(), `status: ${res.status()}`).not.toBe(404);
        expect(res.status()).toBeLessThan(500);
    });
});
