import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Git providers capability — `/api/git-providers/*`.
 *
 * Surface check: endpoint exists, rejects unauth, returns provider list.
 */

test.describe('Git providers — API contract', () => {
    test('GET /api/git-providers/github/connection without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/git-providers/github/connection`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/git-providers/github/connection with auth returns connection info', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/git-providers/github/connection`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const body = await res.json();
        // Without OAuth set up this is { connected: false } or similar; we
        // just verify the endpoint shape.
        expect(typeof body, 'connection response is an object').toBe('object');
    });
});
