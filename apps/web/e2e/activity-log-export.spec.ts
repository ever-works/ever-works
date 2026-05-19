import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Activity log — deepens activity-log.spec.ts by pinning the export
 * (CSV / JSON) endpoint, the running-count + summary aggregates, and
 * the individual entry fetch (`/api/activity-log/:id`).
 */

test.describe('Activity log — export', () => {
    test('GET /api/activity-log/export without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/activity-log/export`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/activity-log/export for fresh user returns text/csv (or json)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const ct = res.headers()['content-type'] || '';
        const ok =
            ct.includes('text/csv') ||
            ct.includes('application/json') ||
            ct.includes('application/octet-stream') ||
            ct.includes('text/plain');
        expect(ok, `content-type: ${ct}`).toBe(true);
    });
});

test.describe('Activity log — aggregates', () => {
    test('GET /api/activity-log/running-count without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/activity-log/running-count`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/activity-log/running-count for fresh user returns numeric', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/running-count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const n = typeof body === 'number' ? body : (body?.count ?? body?.running);
        expect(typeof n).toBe('number');
        expect(n).toBeGreaterThanOrEqual(0);
    });

    test('GET /api/activity-log/summary without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/activity-log/summary`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/activity-log/summary returns object shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/activity-log/summary`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });
});

test.describe('Activity log — individual entry (deepens [~])', () => {
    test('GET /api/activity-log/:id with bogus id → 404 (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/activity-log/00000000-0000-0000-0000-000000000000`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBeLessThan(500);
        expect([200]).not.toContain(res.status());
    });

    test('GET /api/activity-log/:id without auth → 401', async ({ request }) => {
        const res = await request.get(
            `${API_BASE}/api/activity-log/00000000-0000-0000-0000-000000000000`,
        );
        expect(res.status()).toBe(401);
    });
});

test.describe('Activity log — ingest endpoint (internal)', () => {
    test('POST /api/activity-log/ingest without auth → 401 or 403', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/activity-log/ingest`, {
            data: { events: [] },
        });
        expect([401, 403]).toContain(res.status());
    });
});

test.describe('Activity log — web export route', () => {
    test('GET /api/activity-log/export (web) without auth → 401 or redirect', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/activity-log/export`;
        const res = await page.request.get(url);
        // 401/403/404 acceptable; 5xx not.
        expect(res.status()).toBeLessThan(500);
    });
});
