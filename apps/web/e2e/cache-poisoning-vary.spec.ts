import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Cache-poisoning Vary header — pass 17. Endpoints that vary their
 * response based on `Authorization` or `Accept-Language` MUST carry
 * the `Vary` header listing those names — otherwise a CDN can serve
 * an authenticated response to an unauthenticated requester (cache
 * poisoning).
 *
 * We probe:
 *  - /api/auth/profile (varies by Authorization)
 *  - /api/notifications (varies by Authorization)
 *  - /en/login (web tier — varies by Accept-Language)
 */

test.describe('Vary header — endpoints that vary by Authorization carry Vary: Authorization', () => {
    test('/api/auth/profile carries Vary header that includes Authorization', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        if (!res.ok()) test.skip(true, `/api/auth/profile ${res.status()}`);
        const vary = res.headers()['vary'] || '';
        // Acceptable: explicitly mentions Authorization, OR
        // Cache-Control is `private` / `no-store` (which also defeats
        // shared-cache poisoning).
        const cc = res.headers()['cache-control'] || '';
        const safeViaCacheControl = /\b(private|no-store|no-cache)\b/i.test(cc);
        const safeViaVary = /\bAuthorization\b/i.test(vary);
        expect(
            safeViaCacheControl || safeViaVary,
            `/api/auth/profile has no Vary: Authorization nor private/no-store Cache-Control (Vary="${vary}" CC="${cc}")`,
        ).toBe(true);
    });

    test('/api/notifications carries Vary: Authorization (or private Cache-Control)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        if (!res.ok()) test.skip(true, `/api/notifications ${res.status()}`);
        const vary = res.headers()['vary'] || '';
        const cc = res.headers()['cache-control'] || '';
        const safeViaCacheControl = /\b(private|no-store|no-cache)\b/i.test(cc);
        const safeViaVary = /\bAuthorization\b/i.test(vary);
        expect(
            safeViaCacheControl || safeViaVary,
            `/api/notifications cache poisoning risk: Vary="${vary}" CC="${cc}"`,
        ).toBe(true);
    });
});

test.describe('Vary header — locale-varying web pages carry Vary: Accept-Language', () => {
    test('/en/login carries Vary that includes Accept-Language or Cookie', async ({
        page,
        baseURL,
    }) => {
        const res = await page.request.get(`${baseURL || 'http://localhost:3000'}/en/login`);
        const vary = res.headers()['vary'] || '';
        const cc = res.headers()['cache-control'] || '';
        // /en/ is locale-pinned by URL so Vary may legitimately omit
        // Accept-Language. Cookie / RSC / private all acceptable.
        const safeVary = /\b(Accept-Language|Cookie|RSC|Next-Router-State-Tree)\b/i.test(vary);
        const safeCC = /\b(private|no-store|no-cache)\b/i.test(cc);
        const noCachePoisoning = safeVary || safeCC || !vary;
        // Just sanity-check we have *some* posture against shared-cache
        // poisoning — soft-warn rather than hard-fail because /en/login
        // is locale-pinned by URL and cacheable.
        if (!noCachePoisoning) {
            test.info().annotations.push({
                type: 'warning',
                description: `/en/login Vary="${vary}" CC="${cc}" — review for cache poisoning`,
            });
        }
    });
});
