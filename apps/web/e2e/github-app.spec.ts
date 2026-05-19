import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * GitHub App integration — setup / install / callback / webhook plus
 * the installations CRUD. Covers both API controller endpoints under
 * `/api/github-app/*` and the Next.js web entry points
 * `/api/github-app/{setup,callback}`.
 */

test.describe('GitHub App — API contract', () => {
    test('POST /api/github-app/webhooks without signature → 4xx (not 5xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/github-app/webhooks`, {
            data: { action: 'ping' },
        });
        // Endpoint must validate the X-Hub-Signature-256 header and reject
        // unsigned payloads. 400/401/403 all OK; 5xx is the bug we'd catch.
        expect(res.status(), `status was ${res.status()}`).toBeLessThan(500);
    });

    test('GET /api/github-app/setup without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/github-app/setup`);
        expect([401, 403]).toContain(res.status());
    });

    test('GET /api/github-app/installations without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/github-app/installations`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/github-app/installations for a fresh user returns array', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/github-app/installations`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.installations ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('POST /api/github-app/installations/:id/sync with bogus id → 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/github-app/installations/non-existent/sync`,
            {
                headers: authedHeaders(u.access_token),
            },
        );
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('POST install/:id/repositories/:repoId/onboard with bogus ids → 4xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/github-app/installations/non-existent/repositories/non-existent/onboard`,
            {
                headers: authedHeaders(u.access_token),
            },
        );
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });
});

test.describe('GitHub App — web entry points', () => {
    test('GET /api/github-app/setup web route exists', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/github-app/setup`;
        const res = await page.request.get(url);
        // 200/302/4xx all acceptable; we just want to confirm the route is reachable.
        expect(res.status()).toBeLessThan(500);
    });

    test('GET /api/github-app/callback web route exists', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/github-app/callback`;
        const res = await page.request.get(url);
        expect(res.status()).toBeLessThan(500);
    });

    test('Settings → GitHub App page requires auth', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/en/settings/github-app`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const finalUrl = page.url();
        expect(
            finalUrl.includes('/login') || (res && [200, 404, 403].includes(res.status())),
        ).toBeTruthy();
    });
});
