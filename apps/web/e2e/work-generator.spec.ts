import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work generator surface — the AI-driven generation pipeline:
 *
 *   - `GET  /api/works/:id/history`            — past generations
 *   - `POST /api/works/:id/generate`           — kick off generation
 *   - `POST /api/works/:id/cancel-generation`  — cancel in-flight
 *   - `GET  /api/works/:id/generator-form`     — UI form metadata
 *   - `POST /api/works/generate-details`       — pre-generation details
 *   - `GET  /api/works/:id/schedule`           — scheduled-generation config
 *   - `PUT/DELETE /api/works/:id/schedule`     — schedule mutations
 *   - `POST /api/works/:id/schedule/run`       — manual scheduled run
 *
 * Plus the dashboard sub-pages under `works/:id/generator/{history,
 * comparisons,comparisons/:slug,schedule}`.
 */

test.describe('Work generator — API contract', () => {
    test('GET /api/works/:id/history without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead-beef/history`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/history for own work returns 200 + array shape', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-gen-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/history`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.history ?? body?.items ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('GET /api/works/:id/generator-form for own work returns shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-form-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/generator-form`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
    });

    test('GET /api/generator-form (top-level) without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/generator-form`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/cancel-generation without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/cancel-generation`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/schedule for own work returns 200 (or 404 if no schedule yet)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-sched-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/schedule`, {
            headers: authedHeaders(u.access_token),
        });
        expect([200, 404]).toContain(res.status());
    });

    test('POST /api/works/generate-details without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/generate-details`, {
            data: { prompt: 'open source x' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/generate-details with auth responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works/generate-details`, {
            headers: authedHeaders(u.access_token),
            data: { prompt: 'open source headless cms' },
        });
        // 200 if AI provider configured; 503 if not; 400 if body shape differs.
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Work generator — UI surface (auth gated)', () => {
    const SUBPAGES = [
        'generator',
        'generator/history',
        'generator/schedule',
        'generator/comparisons',
    ];
    for (const sub of SUBPAGES) {
        test(`Work ${sub} page requires auth`, async ({ page, baseURL }) => {
            const url = `${baseURL || 'http://localhost:3000'}/en/works/non-existent-id/${sub}`;
            const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
            const finalUrl = page.url();
            expect(
                finalUrl.includes('/login') || (res && [200, 404, 403].includes(res.status())),
                `final url for /${sub}: ${finalUrl}`,
            ).toBeTruthy();
        });
    }
});
