import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Anonymous-user claim flow — EW-617 G3. An anonymous user creates a
 * work, gets a magic-link token, then claims their account at
 * `/claim/[token]`. This deepens the [~] partial coverage in
 * zero-friction-flow.spec.ts.
 */

test.describe('Claim flow — API contract', () => {
    test('POST /api/auth/anonymous returns an anonymous session', async ({ request }) => {
        // Anonymous registration is rate-limited and may be gated by captcha
        // in prod. Both 200 (created) and 400/403 (captcha required, rate
        // limited) are acceptable.
        const res = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: { correlationId: 'e2e-anon-' + Date.now() },
        });
        expect(res.status()).toBeLessThan(500);
        if (res.status() === 200) {
            const body = await res.json();
            expect(typeof body?.access_token).toBe('string');
            expect(body?.user?.isAnonymous).toBe(true);
        }
    });

    test('GET /api/auth/claim/:token with bogus token → 4xx (not 5xx)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/claim/bogus-token-${Date.now()}`);
        expect(res.status()).toBeLessThan(500);
        expect([401, 403, 404, 400, 410]).toContain(res.status());
    });

    test('POST /api/auth/claim/:token with bogus token → 4xx (not 5xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/claim/bogus-token-${Date.now()}`, {
            data: { email: 'e2e@test.local', password: 'TestPass1!' },
        });
        expect(res.status()).toBeLessThan(500);
        expect([401, 403, 404, 400, 410]).toContain(res.status());
    });
});

test.describe('Claim flow — UI', () => {
    test('GET /en/claim/:token with bogus token renders without crashing', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/claim/bogus-token-${Date.now()}`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Either renders a "token invalid" error UI (200 with error state),
        // or returns 404. Both are acceptable; 5xx is the bug we'd catch.
        expect(res, 'response exists').not.toBeNull();
        if (res) {
            expect(res.status()).toBeLessThan(500);
        }
    });
});
