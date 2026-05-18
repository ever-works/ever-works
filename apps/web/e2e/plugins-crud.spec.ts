import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Plugins CRUD surface — top-level user plugin toggles and the
 * work-scoped plugin enable/disable/capability assignment.
 */

test.describe('Plugins — top-level user plugin CRUD', () => {
    test('GET /api/plugins for fresh user returns plugins list', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.plugins ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
        // Platform ships >= a handful of plugins out-of-box.
        expect(arr.length).toBeGreaterThan(0);
    });

    test('GET /api/plugins/settings-menu without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/plugins/settings-menu`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/plugins/:pluginId for known plugin returns object', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Probe a few well-known plugin ids the platform ships with.
        const KNOWN = ['openai', 'tavily', 'github', 'vercel', 'openrouter'];
        let foundOk = false;
        for (const id of KNOWN) {
            const res = await request.get(`${API_BASE}/api/plugins/${id}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 200) {
                foundOk = true;
                const body = await res.json();
                expect(typeof body).toBe('object');
                break;
            }
        }
        expect(foundOk, 'at least one known plugin id resolves').toBe(true);
    });

    test('GET /api/plugins/:pluginId/models returns model list or 404', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins/openai/models`, {
            headers: authedHeaders(u.access_token),
        });
        // 200 (configured) or 404/400 (no config) — never 5xx.
        expect(res.status()).toBeLessThan(500);
    });

    test('POST /api/plugins/:id/enable without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/plugins/openai/enable`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/plugins/:id/disable without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/plugins/openai/disable`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/plugins/pipeline-default without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/plugins/pipeline-default`, {
            data: { pluginId: 'standard-pipeline' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/plugins/:id/validate-connection without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/plugins/openai/validate-connection`);
        expect(res.status()).toBe(401);
    });
});

test.describe('Plugins — work-scoped CRUD', () => {
    test('GET /api/works/:id/plugins for own work returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `e2e-wp-${Date.now()}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${work.id}/plugins`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.plugins ?? body?.data ?? []);
        expect(Array.isArray(arr)).toBe(true);
    });

    test('POST /api/works/:id/plugins/:plugin/enable without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/plugins/openai/enable`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/works/:id/plugins/:plugin/capability without auth → 401', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/works/dead/plugins/openai/capability`, {
            data: { capability: 'ai-provider' },
        });
        expect(res.status()).toBe(401);
    });
});
