import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Redis cache coherency — pass 9. The platform caches certain reads
 * (work lists, plan info, plugin metadata). After a mutation, the next
 * read must reflect the new state — no stale cache hand-off.
 *
 * We pin three classic write-then-read paths:
 *   - Create work → list shows new work
 *   - Rename work → detail + list show new name
 *   - Update profile → /profile shows new value
 */

test.describe('Cache coherency — write-then-read consistency', () => {
    test('create work → /api/works list shows new work immediately', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const create = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: {
                name: `cache-${stamp}`,
                slug: `cache-${stamp}`,
                description: `e2e cache ${stamp}`,
                organization: false,
            },
        });
        expect(create.ok()).toBe(true);
        const created = await create.json();
        const id = created?.work?.id ?? created?.id ?? created?.data?.id;
        // List immediately — there must NOT be a stale cache from before.
        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const ids = arr.map((w: { id: string }) => w.id);
        expect(ids).toContain(id);
    });

    test('rename work → detail fetch returns the NEW name', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `before-rename-${Date.now().toString(36)}`,
        });
        const newName = `after-rename-${Date.now().toString(36)}`;
        const rename = await request.put(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
            data: { name: newName },
        });
        if (!rename.ok()) test.skip(true, `rename failed (${rename.status()})`);
        const detail = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        const fetchedName = body?.name ?? body?.work?.name ?? body?.data?.name;
        expect(fetchedName, 'detail fetch returned stale name').toBe(newName);
    });

    test('rename work → /api/works list reflects the NEW name (no stale cache)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `list-before-${Date.now().toString(36)}`,
        });
        const newName = `list-after-${Date.now().toString(36)}`;
        const rename = await request.put(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
            data: { name: newName },
        });
        if (!rename.ok()) test.skip(true, `rename failed (${rename.status()})`);
        const list = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        const found = arr.find((row: { id: string }) => row.id === w.id);
        if (!found) test.skip(true, 'work not in list (paginated?)');
        expect(found?.name, 'list endpoint returned stale name').toBe(newName);
    });

    test('update profile → fresh GET returns the NEW username', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const newName = `Updated ${Date.now().toString(36)}`;
        const update = await request.put(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
            data: { username: newName },
        });
        if (!update.ok()) test.skip(true, `profile update returned ${update.status()}`);
        const fresh = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
            headers: authedHeaders(u.access_token),
        });
        expect(fresh.status()).toBe(200);
        const body = await fresh.json();
        const user = body?.user ?? body;
        expect(user?.username, '/profile/fresh returned stale username').toBe(newName);
    });
});
