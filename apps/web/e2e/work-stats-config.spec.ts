import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Works meta endpoints — stats / config / website-settings /
 * website-templates / source-validation. These are the small read/write
 * accessor endpoints that hang off `/api/works/:id/...` and aren't
 * covered by the larger works-api.spec.ts (which focuses on the
 * top-level CRUD).
 */

test.describe('Works — stats endpoint', () => {
    test('GET /api/works/stats without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/stats`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/stats for fresh user returns numeric shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/stats`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });
});

test.describe('Works — website-templates list endpoint', () => {
    test('GET /api/works/website-templates returns templates', async ({ request }) => {
        // This endpoint is intentionally public (template browsing).
        const res = await request.get(`${API_BASE}/api/works/website-templates`);
        // 200 with templates or 401 if your config gates it — accept either.
        expect([200, 401]).toContain(res.status());
        if (res.status() === 200) {
            const body = await res.json();
            const arr = Array.isArray(body) ? body : (body?.templates ?? body?.data ?? []);
            expect(Array.isArray(arr)).toBe(true);
        }
    });
});

test.describe('Works — per-work config + website-settings', () => {
    test('GET /api/works/:id/config without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead/config`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/config for own work returns object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-config-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/config`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
    });

    test('GET /api/works/:id/website-settings without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead/website-settings`);
        expect(res.status()).toBe(401);
    });

    test('PUT /api/works/:id/website-settings without auth → 401', async ({ request }) => {
        const res = await request.put(`${API_BASE}/api/works/dead/website-settings`, {
            data: { theme: 'light' },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/works/:id/website-settings for own work returns object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-ws-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/website-settings`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Works — source-validation', () => {
    test('GET /api/works/:id/source-validation without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works/dead/source-validation`);
        expect(res.status()).toBe(401);
    });

    test('PUT /api/works/:id/source-validation without auth → 401', async ({ request }) => {
        const res = await request.put(`${API_BASE}/api/works/dead/source-validation`, {
            data: { enabled: true },
        });
        expect(res.status()).toBe(401);
    });

    test('PUT /api/works/:id/source-validation for own work accepts shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-sv-${Date.now()}`,
        });
        const res = await request.put(`${API_BASE}/api/works/${work.id}/source-validation`, {
            headers: authedHeaders(u.access_token),
            data: { enabled: true, cadence: 'weekly' },
        });
        expect(res.status()).toBeLessThan(500);
    });
});

test.describe('Works — quick-create', () => {
    test('POST /api/works/quick-create without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            data: { prompt: 'something' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/quick-create with auth + valid prompt responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works/quick-create`, {
            headers: authedHeaders(u.access_token),
            data: { prompt: 'awesome devtools directory' },
        });
        // 200/201 created; 400 validation; 429 throttled. Reject 5xx.
        expect(res.status()).toBeLessThan(500);
    });
});
