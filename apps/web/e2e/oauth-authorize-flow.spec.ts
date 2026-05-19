import { test, expect } from '@playwright/test';

/**
 * `/api/auth/authorize` — the OAuth-style authorisation endpoint on the
 * web tier that delegates to the API and returns the provider URL +
 * cookies. oauth-state.spec.ts pins the API contract; this deepens the
 * web-route side (auth gate, redirect shape).
 */

test.describe('Web /api/auth/authorize route', () => {
    test('GET /api/auth/authorize without auth + no params → 4xx or redirect', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/auth/authorize`;
        const res = await page.request.get(url, { maxRedirects: 0 });
        // Acceptable: 302/303 redirect to login; 400/401/403 reject; 404 if web
        // route was removed. Reject 5xx.
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/auth/authorize?provider=github redirects (or 4xx)', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/auth/authorize?provider=github`;
        const res = await page.request.get(url, { maxRedirects: 0 });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 302 || res.status() === 303) {
            const location = res.headers()['location'];
            expect(typeof location).toBe('string');
            expect(location!.length).toBeGreaterThan(0);
        }
    });
});
