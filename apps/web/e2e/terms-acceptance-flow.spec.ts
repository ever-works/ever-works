import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Terms of Service / privacy acceptance — pass 9. Some platforms gate
 * key actions behind a ToS acceptance check. We probe candidate
 * endpoints and verify either:
 *   - A fresh user has `termsAcceptedAt` / equivalent set during
 *     registration (the implicit-acceptance pattern), OR
 *   - There's an `/api/me/accept-terms` endpoint to drive explicitly.
 *
 * If neither shape exists, skip — ToS isn't gated in this build.
 */

const ACCEPT_PATHS = [
    '/api/me/accept-terms',
    '/api/auth/accept-terms',
    '/api/terms/accept',
    '/api/account/accept-terms',
];

test.describe('Terms of Service — acceptance state', () => {
    test('fresh user profile reports terms acceptance timestamp (if exposed)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const user = body?.user ?? body;
        const ALIASES = [
            'termsAcceptedAt',
            'terms_accepted_at',
            'tosAcceptedAt',
            'privacyAcceptedAt',
            'acceptedTermsAt',
        ];
        const value = ALIASES.map((k) => user?.[k]).find((v) => v !== undefined);
        if (value === undefined) {
            test.skip(true, 'profile does not expose terms acceptance — ToS may not be gated');
        }
        // If exposed, value must NOT be null (incomplete registration)
        // and must NOT be a future date.
        expect(value, 'terms acceptance reported as null').not.toBeNull();
        if (typeof value === 'string') {
            const ts = Date.parse(value);
            expect(Number.isNaN(ts), `unparseable terms timestamp: ${value}`).toBe(false);
            expect(ts, 'future-dated terms acceptance').toBeLessThanOrEqual(Date.now() + 5_000);
        }
    });
});

test.describe('Terms of Service — accept-terms endpoint', () => {
    test('accept-terms endpoint (if exposed) requires auth', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of ACCEPT_PATHS) {
            const res = await request.post(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            found = { path, status: res.status() };
            break;
        }
        if (!found) test.skip(true, 'no accept-terms endpoint exposed');
        expect([401, 403]).toContain(found!.status);
    });

    test('authed POST to accept-terms is idempotent (calling twice does not 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of ACCEPT_PATHS) {
            const r1 = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { version: '1.0' },
            });
            if (r1.status() === 404) continue;
            found = true;
            const r2 = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { version: '1.0' },
            });
            expect(r1.status()).toBeLessThan(500);
            expect(r2.status()).toBeLessThan(500);
            // Status family should match (both 2xx, or both 4xx).
            expect(Math.floor(r1.status() / 100)).toBe(Math.floor(r2.status() / 100));
            return;
        }
        if (!found) test.skip(true, 'no accept-terms endpoint exposed');
    });
});

test.describe('Terms of Service — page surfaces', () => {
    test('/en/terms (or /privacy) renders without 5xx', async ({ page, baseURL }) => {
        const candidates = ['/en/terms', '/en/privacy', '/terms', '/privacy'];
        for (const path of candidates) {
            const res = await page.goto(`${baseURL || 'http://localhost:3000'}${path}`, {
                waitUntil: 'domcontentloaded',
            });
            if (!res || res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            const body = await page
                .locator('body')
                .innerText()
                .catch(() => '');
            expect(body.length, `${path} rendered an empty body`).toBeGreaterThan(20);
            return;
        }
        test.skip(true, 'no /terms or /privacy page exposed');
    });
});
