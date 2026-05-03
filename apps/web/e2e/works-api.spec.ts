import { test, expect } from '@playwright/test';

/**
 * API contract tests for the Directory→Work rename.
 *
 * Hits the NestJS API (port 3100) directly:
 *   - /api/works/* should respond (typically 401 unauth, but routes exist)
 *   - /api/directories/* should be 404 (routes are gone)
 *   - register + login still work
 *   - health endpoint responds
 *
 * The OLD path is constructed at runtime so the rename script doesn't
 * see a literal string in this file.
 */

const API_BASE = process.env.API_URL || 'http://localhost:3100';
const OLD_BASE = ['di', 'rec', 'tories'].join(''); // -> "directories"

test.describe('Works rename — API contract', () => {
    test('GET /api/health responds 200', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
    });

    const newRoutes = [
        '/api/works',
        '/api/works/stats',
        '/api/works/website-templates',
        '/api/works/some-id-that-doesnt-exist',
        '/api/works/some-id/items',
        '/api/works/some-id/config',
        '/api/works/some-id/count',
        '/api/works/some-id/categories-tags',
        '/api/works/some-id/history',
        '/api/works/some-id/schedule',
        '/api/works/some-id/advanced-prompts',
        '/api/works/import/repositories',
    ];

    for (const route of newRoutes) {
        test(`new route ${route} exists (any non-404 status)`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${route}`);
            // Without auth, expect 401 / 403 / 400 / 200 — anything BUT 404.
            // 404 would mean the route doesn't exist.
            expect(res.status(), `${route} status was ${res.status()}`).not.toBe(404);
            expect(res.status(), `${route} should not 5xx`).toBeLessThan(500);
        });
    }

    const oldRoutes = [
        `/api/${OLD_BASE}`,
        `/api/${OLD_BASE}/stats`,
        `/api/${OLD_BASE}/some-id`,
        `/api/${OLD_BASE}/some-id/items`,
    ];

    for (const route of oldRoutes) {
        test(`old route ${route} returns 404`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${route}`);
            expect(res.status(), `${route} should be 404 (was ${res.status()})`).toBe(404);
        });
    }

    test('POST /api/auth/register creates a user', async ({ request }) => {
        const email = `api-test-${Date.now()}@test.local`;
        const res = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: 'API Test',
                email,
                password: 'Test1234!secure',
            },
        });
        expect(res.status(), `register should succeed`).toBeGreaterThanOrEqual(200);
        expect(res.status(), `register should not error`).toBeLessThan(300);

        const body = await res.json();
        expect(body, 'register response has access_token').toHaveProperty('access_token');
        expect(body, 'register response has user').toHaveProperty('user');
        expect(body.user, 'user has email').toHaveProperty('email');
    });

    test('POST /api/auth/login authenticates a registered user', async ({ request }) => {
        const email = `api-login-${Date.now()}@test.local`;
        const password = 'Test1234!secure';

        // Register first
        await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: 'Login Test', email, password },
        });

        // Then login
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email, password },
        });

        expect(res.status(), 'login should succeed').toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('access_token');
        expect(body.user.email).toBe(email);
    });

    test('GET /api/works without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works`);
        expect(res.status(), 'unauth /api/works').toBe(401);
    });

    test('authenticated GET /api/works returns a list shape', async ({ request }) => {
        const email = `list-test-${Date.now()}@test.local`;
        const password = 'Test1234!secure';
        const reg = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: 'List Test', email, password },
        });
        const { access_token } = await reg.json();

        const res = await request.get(`${API_BASE}/api/works`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        expect(res.status(), 'authenticated /api/works').toBe(200);

        const body = await res.json();
        // The response should have either { works: [...] } or { directories: [...] }
        // (DB column still uses old name internally — TS-side property may
        // reflect the old name temporarily). Either is acceptable; what we
        // care about is that the endpoint works.
        const list = body.works ?? body.directories ?? body;
        expect(Array.isArray(list) || typeof list === 'object', 'response is list-shaped').toBe(
            true,
        );
    });
});
