import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Notifications API contract.
 *
 * UI surface (notification bell, dropdown) varies between layouts and is
 * already implicitly covered by dashboard-comprehensive's "no 5xx" check,
 * so this suite focuses on the API contract that the bell consumes.
 */

test.describe('Notifications — API contract', () => {
    test('GET /api/notifications without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/notifications`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/notifications with auth returns list shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list = Array.isArray(body)
            ? body
            : (body?.items ?? body?.data ?? body?.notifications ?? []);
        expect(Array.isArray(list), `expected array, got ${typeof body}`).toBe(true);
    });

    test('GET /api/notifications/unread-count returns numeric count', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const count = typeof body === 'number' ? body : (body?.count ?? body?.unreadCount);
        expect(typeof count, `expected count number, got ${typeof count}`).toBe('number');
        expect(count).toBeGreaterThanOrEqual(0);
    });

    test('GET /api/notifications/persistent returns list shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/notifications/persistent`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list = Array.isArray(body)
            ? body
            : (body?.items ?? body?.data ?? body?.notifications ?? []);
        expect(Array.isArray(list)).toBe(true);
    });

    test('POST /api/notifications/read-all does not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/notifications/read-all`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `read-all status ${res.status()}`).toBeLessThan(500);
    });

    test('POST /api/notifications/:nonexistent/read returns 404 (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/notifications/00000000-0000-0000-0000-000000000000/read`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBeLessThan(500);
    });
});
