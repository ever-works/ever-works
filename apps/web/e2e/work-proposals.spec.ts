import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Work proposals — the community-PR / collaborative-proposal surface
 * under `/api/me/work-proposals`. Pins the REST contract for the
 * list/status/preferences endpoints.
 */

test.describe('Work proposals — API contract', () => {
    test('GET /api/me/work-proposals without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/work-proposals`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/work-proposals/status without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/work-proposals/status`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/work-proposals/preferences without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/work-proposals/preferences`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/work-proposals for a fresh user returns empty list', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `status was ${res.status()}`).toBe(200);
        const body = await res.json();
        const list = Array.isArray(body) ? body : (body?.proposals ?? body?.data ?? []);
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBe(0);
    });

    test('GET /api/me/work-proposals/preferences for a fresh user returns an object', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
        expect(body).not.toBeNull();
    });

    test('PUT /api/me/work-proposals/preferences accepts a well-formed body', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.put(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers: authedHeaders(u.access_token),
            data: { emailNotifications: false },
        });
        expect(res.status(), `status was ${res.status()}`).toBeLessThan(500);
        expect([401, 403]).not.toContain(res.status());
    });

    test('POST /api/me/work-proposals/refresh without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/me/work-proposals/refresh`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/work-proposals/:id with unknown id → 404 or 403 (not 200, not 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals/dead-beef-non-existent`, {
            headers: authedHeaders(u.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('POST /api/me/work-proposals/:id/accept with unknown id → 404/403', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/me/work-proposals/dead-beef-non-existent/accept`,
            {
                headers: authedHeaders(u.access_token),
            },
        );
        expect([403, 404, 400]).toContain(res.status());
    });
});
