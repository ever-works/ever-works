import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * AI conversations API — GET/POST list, GET single, POST messages,
 * PATCH update, DELETE single, DELETE all.
 */

test.describe('Conversations — API contract', () => {
    test('GET /api/conversations without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/conversations`);
        expect(res.status()).toBe(401);
    });

    test('full lifecycle: create, list, get, update, delete', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // Create
        const createRes = await request.post(`${API_BASE}/api/conversations`, {
            headers,
            data: { title: 'e2e conversation' },
        });
        expect(createRes.status(), `create status: ${createRes.status()}`).toBeGreaterThanOrEqual(
            200,
        );
        expect(createRes.status()).toBeLessThan(300);
        const created = await createRes.json();
        const convoId = created?.id ?? created?.conversation?.id ?? created?.data?.id;
        expect(convoId, 'created conversation has id').toBeTruthy();

        // List
        const listRes = await request.get(`${API_BASE}/api/conversations`, { headers });
        expect(listRes.status()).toBe(200);
        const list = await listRes.json();
        const convos = Array.isArray(list)
            ? list
            : (list?.conversations ?? list?.items ?? list?.data ?? []);
        expect(Array.isArray(convos), 'list is array').toBe(true);
        expect(convos.find((c: { id?: string }) => c?.id === convoId)).toBeTruthy();

        // Get single
        const getRes = await request.get(`${API_BASE}/api/conversations/${convoId}`, { headers });
        expect(getRes.status()).toBe(200);

        // Update title
        const patchRes = await request.patch(`${API_BASE}/api/conversations/${convoId}`, {
            headers,
            data: { title: 'e2e renamed' },
        });
        expect(patchRes.status(), `patch status: ${patchRes.status()}`).toBeLessThan(400);

        // Delete
        const deleteRes = await request.delete(`${API_BASE}/api/conversations/${convoId}`, {
            headers,
        });
        expect(deleteRes.status(), `delete status: ${deleteRes.status()}`).toBeLessThan(400);

        // Verify deleted
        const getAfterDelete = await request.get(`${API_BASE}/api/conversations/${convoId}`, {
            headers,
        });
        // Either 404 (gone) or empty/200 with deleted flag — must not 5xx.
        expect(getAfterDelete.status()).toBeLessThan(500);
    });

    test('cross-user isolation: user A cannot see user B conversations', async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        // A creates
        const createRes = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(a.access_token),
            data: { title: 'A private convo' },
        });
        const created = await createRes.json();
        const convoId = created?.id ?? created?.conversation?.id;
        if (!convoId) test.skip(true, 'create response shape unknown');

        // B reads
        const bRead = await request.get(`${API_BASE}/api/conversations/${convoId}`, {
            headers: authedHeaders(b.access_token),
        });
        // Must not return A's content; expected 404 or 403.
        expect([403, 404]).toContain(bRead.status());
    });
});
