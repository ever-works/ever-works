import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Subscriptions API — GET/POST /api/subscriptions/plan.
 */

test.describe('Subscriptions — API contract', () => {
    test('GET /api/subscriptions/plan without auth returns 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/subscriptions/plan`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/subscriptions/plan with auth returns plan info', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `plan status was ${res.status()}`).toBe(200);
        const body = await res.json();
        // Either the plan object directly or wrapped in { plan: …, status: … }.
        const plan = body?.plan ?? body;
        expect(typeof plan, 'plan is an object').toBe('object');
    });

    test('POST /api/subscriptions/plan without body returns 4xx (not 5xx)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(res.status(), `status was ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
