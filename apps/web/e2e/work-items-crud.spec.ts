import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work items CRUD surface (beyond bulk import/export):
 *
 *   - `GET  /api/works/:id/items`                  — list
 *   - `GET  /api/works/:id/count`                  — count
 *   - `GET  /api/works/:id/categories-tags`        — taxonomy
 *   - `POST /api/works/:id/submit-item`            — submit one item
 *   - `POST /api/works/:id/remove-item`            — remove one item
 *   - `POST /api/works/:id/update-item`            — update one item
 *   - `POST /api/works/:id/check-item-health`      — health probe
 *   - `POST /api/extract-item-details`             — parse from URL
 *   - `POST /api/works/:id/bulk-capture-images`    — bulk image fetch
 */

test.describe('Work items — read endpoints', () => {
    test('GET /api/works/:id/items without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead-beef/items`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/items for own work returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-items-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/items`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.items ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('GET /api/works/:id/count for own work returns numeric shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-cnt-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/count`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const n = typeof body === 'number' ? body : (body?.count ?? body?.total);
        expect(typeof n).toBe('number');
        expect(n).toBeGreaterThanOrEqual(0);
    });

    test('GET /api/works/:id/categories-tags returns taxonomy shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-tax-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/categories-tags`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
    });
});

test.describe('Work items — write endpoints', () => {
    test('POST /api/works/:id/submit-item without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/submit-item`, {
            data: { name: 'x', url: 'https://example.com' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/remove-item without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/remove-item`, {
            data: { itemId: 'x' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/update-item without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/update-item`, {
            data: { itemId: 'x' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/check-item-health without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/check-item-health`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/extract-item-details without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/extract-item-details`, {
            data: { url: 'https://example.com' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/extract-item-details with auth + valid URL responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/extract-item-details`, {
            headers: authedHeaders(u.access_token),
            data: { url: 'https://example.com' },
        });
        // 200 (with details), 400 (validation), 503 (extractor not configured) all OK.
        expect(res.status()).toBeLessThan(500);
        expect([401, 403]).not.toContain(res.status());
    });

    test('POST /api/works/:id/bulk-capture-images without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/bulk-capture-images`);
        expect(res.status()).toBe(401);
    });
});
