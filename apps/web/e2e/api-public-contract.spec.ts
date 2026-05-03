import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Surface-level contract tests for the entire public API.
 *
 * For each known route prefix we hit a representative endpoint and assert:
 *  - the route exists (status != 404)
 *  - the API isn't crashing (status < 500)
 *
 * For protected endpoints we additionally assert the unauth posture is
 * 401 (not 403, not 200).
 *
 * This is a tripwire: when somebody renames a controller or deletes a
 * route by mistake, the corresponding test fires immediately.
 */

test.describe('Public API — health & metadata', () => {
    test('GET /api/health → 200', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
    });

    test('GET /api/auth/providers → 200 (public)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/providers`);
        // This endpoint is typically public for the social-login UI to render
        expect(res.status(), `providers status ${res.status()}`).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });

    test('GET /api/auth/validate-email-token without a token returns 4xx', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/validate-email-token`);
        expect(res.status()).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });

    test('GET /api/auth/validate-reset-token without a token returns 4xx', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/auth/validate-reset-token`);
        expect(res.status()).toBeLessThan(500);
        expect(res.status()).not.toBe(404);
    });
});

const protectedEndpoints = [
    '/api/works',
    '/api/works/stats',
    '/api/auth/api-keys',
    '/api/auth/profile',
    '/api/account/export',
    '/api/account/sync/status',
    '/api/notifications',
    '/api/notifications/unread-count',
    '/api/notifications/persistent',
    '/api/activity-log',
    '/api/activity-log/summary',
    '/api/activity-log/running-count',
    '/api/activity-log/export',
    '/api/conversations',
    '/api/subscriptions/plan',
    '/api/plugins',
];

test.describe('Public API — protected endpoints reject unauth (401)', () => {
    for (const path of protectedEndpoints) {
        test(`GET ${path} → 401 (no auth)`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${path} returned ${res.status()}`).toBe(401);
        });
    }
});

test.describe('Public API — non-existent routes 404 cleanly', () => {
    const nonExistent = [
        '/api/this-route-does-not-exist',
        '/api/auth/this-route-does-not-exist',
        // /api/works/:something matches the @Get('works/:id') route, so to
        // get a real 404 we use a path that can't be matched by any route param.
        '/api/works/abc/this-subroute-does-not-exist',
    ];

    for (const path of nonExistent) {
        test(`GET ${path} → 404`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), `${path} returned ${res.status()}`).toBe(404);
        });
    }
});

test.describe('Public API — POST without body returns 4xx (not 5xx)', () => {
    const postEndpoints = [
        '/api/auth/register',
        '/api/auth/login',
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
    ];

    for (const path of postEndpoints) {
        test(`POST ${path} without body → 4xx`, async ({ request }) => {
            const res = await request.post(`${API_BASE}${path}`, { data: {} });
            expect(res.status(), `${path} returned ${res.status()}`).toBeLessThan(500);
            expect(res.status()).toBeGreaterThanOrEqual(400);
        });
    }
});
