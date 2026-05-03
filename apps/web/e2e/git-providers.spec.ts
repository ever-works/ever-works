import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Git providers capability — `/api/git-providers/*`.
 *
 * Surface check: endpoint exists, rejects unauth, returns provider list.
 */

test.describe('Git providers — API contract', () => {
    test('GET /api/git-providers without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/git-providers`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/git-providers with auth returns provider list', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/git-providers`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const body = await res.json();
        const providers = Array.isArray(body)
            ? body
            : (body?.providers ?? body?.data ?? body?.items ?? []);
        expect(Array.isArray(providers), 'providers is array').toBe(true);
    });
});
