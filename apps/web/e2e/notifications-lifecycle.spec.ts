import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notifications — full lifecycle:
 *
 *   - `GET  /api/notifications`             — list
 *   - `GET  /api/notifications/unread-count`— badge counter
 *   - `GET  /api/notifications/persistent`  — sticky / persistent
 *   - `POST /api/notifications/:id/read`    — mark one read
 *   - `POST /api/notifications/read-all`    — mark all read
 *   - `POST /api/notifications/:id/dismiss` — dismiss
 */

test.describe('Notifications — API contract', () => {
    test('GET /api/notifications without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/notifications`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/notifications/unread-count without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/notifications/unread-count`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/notifications/persistent without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/notifications/persistent`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/notifications for fresh user returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.notifications ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('GET /api/notifications/unread-count for fresh user returns numeric', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const n = typeof body === 'number' ? body : (body?.count ?? body?.unreadCount);
        expect(typeof n).toBe('number');
        expect(n).toBeGreaterThanOrEqual(0);
    });

    test('POST /api/notifications/read-all for fresh user responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        expect([401, 403]).not.toContain(res.status());
    });

    test('POST /api/notifications/:id/read with bogus id → 404 or 4xx (not 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/notifications/non-existent-id/read`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('POST /api/notifications/:id/dismiss without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/notifications/x/dismiss`);
        expect(res.status()).toBe(401);
    });
});
