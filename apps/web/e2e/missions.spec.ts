import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Missions — REST contract for `/api/me/missions/*`. Pins the
 * surface added by Missions/Ideas/Works build phases:
 *
 *   - GET    /api/me/missions               list (PR G)
 *   - POST   /api/me/missions               create (PR H)
 *   - GET    /api/me/missions/:id           get one (PR H)
 *   - PATCH  /api/me/missions/:id           partial update (PR H)
 *   - DELETE /api/me/missions/:id           delete (PR H)
 *   - POST   /api/me/missions/:id/{pause,resume,complete} (PR H)
 *   - POST   /api/me/missions/:id/clone     full-fork clone (PR HH)
 *   - POST   /api/me/missions/:id/run-now   manual tick (PR J)
 *   - GET    /api/me/missions/:id/budget    per-Mission spend (PR U)
 *
 * Auth is enforced via `@CurrentUser()` on every route; ownership
 * checks live in `MissionsService.getForUser` (404 when another
 * user's Mission is requested).
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Missions — API contract', () => {
    test('GET /api/me/missions without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/me/missions`);
        expect(res.status()).toBe(401);
    });

    test('POST /api/me/missions without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/me/missions`, {
            data: { description: 'x', type: 'one-shot' },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/me/missions for a fresh user returns empty array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(0);
    });

    test('GET /api/me/missions/:id with unknown id → 404 (not 5xx, not 200)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}`, {
            headers: authedHeaders(u.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('PATCH /api/me/missions/:id with unknown id → 404/403', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.patch(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}`, {
            headers: authedHeaders(u.access_token),
            data: { title: 'renamed' },
        });
        expect([403, 404]).toContain(res.status());
    });

    test('DELETE /api/me/missions/:id with unknown id → 404/403', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.delete(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}`, {
            headers: authedHeaders(u.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    for (const lifecycle of ['pause', 'resume', 'complete', 'run-now', 'clone'] as const) {
        test(`POST /api/me/missions/:id/${lifecycle} with unknown id → 404/403/400`, async ({
            request,
        }) => {
            const u = await registerUserViaAPI(request);
            const res = await request.post(
                `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/${lifecycle}`,
                { headers: authedHeaders(u.access_token), data: {} },
            );
            // 400 acceptable when status-machine guard fires before the
            // 404 (e.g. ParseUUIDPipe path) — the test pins "no 5xx".
            expect([400, 403, 404]).toContain(res.status());
        });
    }

    test('GET /api/me/missions/:id/budget with unknown id → 404/403', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/budget`, {
            headers: authedHeaders(u.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('POST /api/me/missions create → GET → PATCH → DELETE happy path', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // Create
        const createRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: 'E2E Mission',
                description: 'Built by e2e test to pin the CRUD contract',
                type: 'one-shot',
            },
        });
        expect(createRes.status(), `create body=${await createRes.text()}`).toBe(201);
        const created = await createRes.json();
        expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.title).toBe('E2E Mission');
        expect(created.type).toBe('one-shot');
        expect(created.status).toBe('active');

        // List should include it
        const listRes = await request.get(`${API_BASE}/api/me/missions`, { headers });
        expect(listRes.status()).toBe(200);
        const list = await listRes.json();
        expect(list.find((m: { id: string }) => m.id === created.id)).toBeTruthy();

        // Get one
        const getRes = await request.get(`${API_BASE}/api/me/missions/${created.id}`, { headers });
        expect(getRes.status()).toBe(200);
        expect((await getRes.json()).id).toBe(created.id);

        // Patch
        const patchRes = await request.patch(`${API_BASE}/api/me/missions/${created.id}`, {
            headers,
            data: { title: 'Renamed' },
        });
        expect(patchRes.status()).toBe(200);
        expect((await patchRes.json()).title).toBe('Renamed');

        // Delete
        const delRes = await request.delete(`${API_BASE}/api/me/missions/${created.id}`, {
            headers,
        });
        expect(delRes.status()).toBe(200);

        // Subsequent get → 404
        const afterRes = await request.get(`${API_BASE}/api/me/missions/${created.id}`, {
            headers,
        });
        expect([403, 404]).toContain(afterRes.status());
    });

    test('lifecycle: create → pause → resume → complete', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const createRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: { description: 'Lifecycle test mission', type: 'one-shot' },
        });
        expect(createRes.status()).toBe(201);
        const m = await createRes.json();

        const pauseRes = await request.post(`${API_BASE}/api/me/missions/${m.id}/pause`, {
            headers,
            data: {},
        });
        expect(pauseRes.status()).toBe(200);
        expect((await pauseRes.json()).status).toBe('paused');

        const resumeRes = await request.post(`${API_BASE}/api/me/missions/${m.id}/resume`, {
            headers,
            data: {},
        });
        expect(resumeRes.status()).toBe(200);
        expect((await resumeRes.json()).status).toBe('active');

        const completeRes = await request.post(`${API_BASE}/api/me/missions/${m.id}/complete`, {
            headers,
            data: {},
        });
        expect(completeRes.status()).toBe(200);
        expect((await completeRes.json()).status).toBe('completed');

        // Pause on a completed Mission must fail (state-machine guard)
        const pauseCompleted = await request.post(`${API_BASE}/api/me/missions/${m.id}/pause`, {
            headers,
            data: {},
        });
        expect([400, 409]).toContain(pauseCompleted.status());
    });

    test('cross-user isolation: another user gets 404 on my mission', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);

        const createRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(alice.access_token),
            data: { description: "Alice's private mission", type: 'one-shot' },
        });
        expect(createRes.status()).toBe(201);
        const m = await createRes.json();

        const bobRes = await request.get(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        // Service throws NotFoundException — same shape whether the id
        // is wrong-owner or non-existent (avoids existence-probing).
        expect([403, 404]).toContain(bobRes.status());
    });
});
