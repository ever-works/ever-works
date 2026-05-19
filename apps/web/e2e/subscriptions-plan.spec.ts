import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Subscriptions plan — `/api/subscriptions/plan` GET + POST. The
 * platform tracks per-user subscription plan (`free`, paid tiers) and
 * gates features by plan. This deepens subscriptions.spec.ts's
 * coverage.
 */

test.describe('Subscriptions — plan endpoint', () => {
    test('GET /api/subscriptions/plan without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/subscriptions/plan`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/subscriptions/plan for fresh user returns a plan object', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body).toBe('object');
        expect(body).not.toBeNull();
        // Expect at least one of these standard fields.
        const hasShape =
            typeof body?.plan === 'object' ||
            typeof body?.code === 'string' ||
            typeof body?.id === 'string' ||
            typeof body?.tier === 'string';
        expect(hasShape, `plan body: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
    });

    test('POST /api/subscriptions/plan without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            data: { code: 'free' },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/subscriptions/plan with auth + valid body responds < 500', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { code: 'free' },
        });
        // 200 = switched; 400 = body schema; 403 = plan not selectable. < 500 expected.
        expect(res.status()).toBeLessThan(500);
        expect([401]).not.toContain(res.status());
    });
});
