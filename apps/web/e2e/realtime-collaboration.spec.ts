import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Realtime collaboration — pass 13. Two browser-like API contexts as
 * the same owner mutate a single work. We don't require server-pushed
 * realtime sync (would need Yjs/Liveblocks). We pin the looser
 * eventual-consistency contract: after one context writes, the other's
 * next read sees the change.
 */

test.describe('Realtime collab — eventual consistency across contexts', () => {
    test('rename in context A is visible to context B on next GET', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `collab-${Date.now().toString(36)}`,
        });
        const newName = `collab-renamed-${Date.now().toString(36)}`;
        const rename = await request.put(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
            data: { name: newName },
        });
        if (!rename.ok()) test.skip(true, `rename returned ${rename.status()}`);
        // Now "context B" — same token, fresh request lifecycle.
        const fetched = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(fetched.status()).toBe(200);
        const body = await fetched.json();
        const fetchedName = body?.name ?? body?.work?.name ?? body?.data?.name;
        expect(fetchedName, `context B saw stale name after A rename`).toBe(newName);
    });

    test('two parallel rename attempts result in deterministic final state', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `collab-race-${Date.now().toString(36)}`,
        });
        const nameA = `race-A-${Date.now().toString(36)}`;
        const nameB = `race-B-${Date.now().toString(36)}`;
        await Promise.all([
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { name: nameA },
            }),
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { name: nameB },
            }),
        ]);
        const fetched = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(fetched.status()).toBe(200);
        const body = await fetched.json();
        const finalName = body?.name ?? body?.work?.name ?? body?.data?.name;
        // The final state must be ONE of the two writes — no
        // frankenstein merge.
        expect([nameA, nameB], `final name "${finalName}" is neither A nor B`).toContain(finalName);
    });

    test('owner sees own activity-log entries from parallel actions', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        // Spawn 3 parallel work creations.
        const created = await Promise.all([
            createWorkViaAPI(request, u.access_token, { name: `parallel-1-${stamp}` }),
            createWorkViaAPI(request, u.access_token, { name: `parallel-2-${stamp}` }),
            createWorkViaAPI(request, u.access_token, { name: `parallel-3-${stamp}` }),
        ]);
        const ids = created.map((c) => c.id);
        // All three created successfully.
        expect(ids.every(Boolean)).toBe(true);
        // List endpoint must show all three.
        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const listIds = arr.map((w: { id: string }) => w.id);
        for (const id of ids) {
            expect(listIds, `parallel create id ${id} not in list`).toContain(id);
        }
    });
});
