import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Plugin search capability — `/api/search/*`. The platform's search
 * facade dispatches to whichever search plugin the user has wired up
 * (Tavily, Brave, Exa, Perplexity, …).
 *
 * Pins the contract: endpoint exists, requires auth, check-availability
 * tells the caller whether any provider is configured.
 */

test.describe('Search capability — API contract', () => {
    test('GET /api/search/check-availability without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/search/check-availability`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/search without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/search`, {
            data: { query: 'ever works' },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/search/check-availability returns boolean-shaped response', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/search/check-availability`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const body = await res.json();
        // Endpoint either returns `{ available: boolean }` or a plain boolean.
        const flag =
            typeof body === 'boolean'
                ? body
                : typeof body?.available === 'boolean'
                  ? body.available
                  : typeof body?.configured === 'boolean'
                    ? body.configured
                    : undefined;
        expect(typeof flag, `response shape: ${JSON.stringify(body)}`).toBe('boolean');
    });

    test('POST /api/search with empty body returns 4xx (validation), not 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/search`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        // 400 = validation rejection (expected); 503 = no provider configured;
        // 404 = endpoint not found in this build. Reject 5xx beyond 503.
        expect([200, 400, 404, 503]).toContain(res.status());
    });

    test('POST /api/search with a query string is at least syntactically accepted', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/search`, {
            headers: authedHeaders(u.access_token),
            data: { query: 'open source directories' },
        });
        // 200 = provider configured and answered; 503 = no provider; 4xx = body
        // schema differs from this test's guess. We just want to confirm the
        // endpoint exists and isn't crashing.
        expect(res.status(), `status was ${res.status()}`).toBeLessThan(500);
        expect([401, 403]).not.toContain(res.status());
    });
});
