import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Ideas (Work-Proposals) — endpoints ADDED on top of the existing
 * `work-proposals.spec.ts` baseline by the Missions/Ideas/Works build:
 *
 *   - POST  /api/me/work-proposals              user-manual create (PR B)
 *   - POST  /api/me/work-proposals/:id/build    queue for build (PR B)
 *   - POST  /api/me/work-proposals/:id/retry    retry FAILED (PR FF)
 *   - POST  /api/me/work-proposals/:id/rebuild  fresh attempt (PR FF)
 *   - GET   /api/me/work-proposals/:id/budget   per-Idea spend (PR U)
 *   - GET   /api/me/work-proposals?missionId=…  Mission-scoped filter (PR A)
 *
 * Existing work-proposals.spec.ts covers list / status / preferences /
 * dismiss / accept / refresh — this file extends with the net-new
 * routes, all with the same auth + ownership invariants.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Ideas — extended REST surface', () => {
    test('POST /api/me/work-proposals without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
            data: { description: 'x' },
        });
        expect(res.status()).toBe(401);
    });

    for (const action of ['build', 'retry', 'rebuild'] as const) {
        test(`POST /api/me/work-proposals/:id/${action} without auth → 401`, async ({
            request,
        }) => {
            const res = await request.post(
                `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/${action}`,
            );
            expect(res.status()).toBe(401);
        });

        test(`POST /api/me/work-proposals/:id/${action} with unknown id → 404/403/400`, async ({
            request,
        }) => {
            const u = await registerUserViaAPI(request);
            const res = await request.post(
                `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/${action}`,
                { headers: authedHeaders(u.access_token), data: {} },
            );
            // 400 is the state-machine guard ("only PENDING/FAILED can…");
            // 404 / 403 cover the ownership path. No 5xx allowed.
            expect([400, 403, 404]).toContain(res.status());
        });
    }

    test('GET /api/me/work-proposals/:id/budget without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/budget`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/work-proposals/:id/budget with unknown id → 404/403', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/budget`, {
            headers: authedHeaders(u.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('GET /api/me/work-proposals?missionId=… is accepted (filter contract)', async ({
        request,
    }) => {
        // The query param is tri-state: undefined = no filter; UUID = scope;
        // null encoded as empty would also be accepted. We assert here that
        // a well-formed UUID does NOT 4xx — the listing should return [].
        const u = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${UNKNOWN_UUID}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list = Array.isArray(body) ? body : (body?.proposals ?? body?.data ?? []);
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBe(0);
    });

    test('POST /api/me/work-proposals create → returns Idea with PENDING status', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const createRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: {
                description: 'E2E user-manual Idea for the contract pin',
            },
        });
        // 200 or 201 both acceptable; 4xx + 5xx are not.
        expect([200, 201]).toContain(createRes.status());
        const idea = await createRes.json();
        expect(idea.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(idea.status).toBe('pending');
        expect(idea.source).toBe('user-manual');
    });
});
