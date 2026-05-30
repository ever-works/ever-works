import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Skills — deep coverage of the Skills feature (Agents/Skills/Tasks build).
 * Zero dedicated e2e specs existed before this file. Assertions are pinned
 * against live API shapes (verified on a running stack).
 *
 * A "Skill" is a reusable markdown capability (frontmatter + instructionsMd)
 * owned at a scope (tenant/mission/idea/work/agent). Bindings attach a skill
 * to a target. The local catalog is empty without a catalog provider, so the
 * catalog test asserts shape only; custom-create is the exercised path.
 *
 * API surface (`apps/api/src/skills/*`):
 *   - GET  /api/skills                 list `{data, meta}` (+ ownerType/search/pagination)
 *   - POST /api/skills                 create (ownerType + ownerId required; slug auto-lowercased)
 *   - GET  /api/skills/:id             get one (cross-user 404)
 *   - PATCH /api/skills/:id            update body (contentHash recomputed)
 *   - DELETE /api/skills/:id           delete -> {deleted:true}
 *   - GET/POST /api/skills/:id/bindings  bindings (array; agent target needs targetId)
 *   - GET  /api/skills/catalog         platform catalog `{entries, total}`
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

async function ownerIdFor(
    request: import('@playwright/test').APIRequestContext,
    token: string,
): Promise<string> {
    const res = await request.get(`${API_BASE}/api/auth/profile`, {
        headers: authedHeaders(token),
    });
    const me = await res.json();
    return me.id ?? me.user?.id;
}

test.describe('Skills — API contract', () => {
    test('GET /api/skills without auth → 401', async ({ request }) => {
        expect((await request.get(`${API_BASE}/api/skills`)).status()).toBe(401);
    });

    test('POST /api/skills without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/skills`, { data: { title: 'x' } });
        expect(res.status()).toBe(401);
    });

    test('GET /api/skills for a fresh user → empty {data, meta}', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/skills`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBe(0);
        expect(body.meta).toMatchObject({ total: 0 });
    });

    test('POST /api/skills creates a custom skill (slug lowercased, frontmatter, v1.0.0)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const res = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                ownerId: u.user.id,
                title: 'Code Review Checklist',
                description: 'how to review',
                instructionsMd: '# Code Review\n\nsteps',
            },
        });
        expect(res.status(), `create body=${await res.text()}`).toBe(201);
        const skill = await res.json();
        expect(skill.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(skill.slug).toBe('code-review-checklist');
        expect(skill.ownerType).toBe('tenant');
        expect(skill.version).toBe('1.0.0');
        // Hand-authored custom skill — not sourced from a catalog entry.
        expect(skill.sourceCatalogSlug).toBeNull();
        expect(skill.frontmatter).toMatchObject({ name: 'code-review-checklist' });

        const list = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        expect(list.data.find((s: { id: string }) => s.id === skill.id)).toBeTruthy();
    });

    test('POST /api/skills validates ownerType/ownerId', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const noOwnerId = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: { ownerType: 'tenant', title: 'S', description: 'd', instructionsMd: '# S' },
        });
        expect(noOwnerId.status()).toBe(400);
        expect((await noOwnerId.json()).message).toMatch(/ownerId is required/i);

        const badType = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'user',
                ownerId: u.user.id,
                title: 'S',
                description: 'd',
                instructionsMd: '# S',
            },
        });
        expect(badType.status()).toBe(400);
        expect((await badType.json()).message).toMatch(/invalid ownerType/i);
    });

    test('PATCH /api/skills/:id updates body and recomputes contentHash', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const skill = await (
            await request.post(`${API_BASE}/api/skills`, {
                headers,
                data: {
                    ownerType: 'tenant',
                    ownerId: u.user.id,
                    title: 'Editable Skill',
                    description: 'd',
                    instructionsMd: '# v1',
                },
            })
        ).json();

        const patch = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers,
            data: { instructionsMd: '# v2\n\nmore' },
        });
        expect(patch.status()).toBe(200);
        const updated = await patch.json();
        expect(updated.instructionsMd).toBe('# v2\n\nmore');
        expect(updated.contentHash).not.toBe(skill.contentHash);
    });

    test('bindings: empty array → create tenant + mission bindings → both listed; agent target requires targetId', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const skill = await (
            await request.post(`${API_BASE}/api/skills`, {
                headers,
                data: {
                    ownerType: 'tenant',
                    ownerId: u.user.id,
                    title: 'Bindable',
                    description: 'd',
                    instructionsMd: '# B',
                },
            })
        ).json();

        const empty = await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, { headers });
        expect(empty.status()).toBe(200);
        expect(await empty.json()).toEqual([]);

        const tenantBinding = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers,
            data: { targetType: 'tenant', priority: 100 },
        });
        expect(tenantBinding.status()).toBe(201);
        const tb = await tenantBinding.json();
        expect(tb.targetType).toBe('tenant');
        expect(tb.injectIntoAgent).toBe(true);
        expect(tb.priority).toBe(100);

        // agent target without an id is rejected (server-side validation).
        const badAgent = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers,
            data: { targetType: 'agent' },
        });
        expect(badAgent.status()).toBe(400);
        expect((await badAgent.json()).message).toMatch(/targetId is required/i);

        // bind to a real mission.
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: 'BindMission', description: 'd', type: 'one-shot' },
            })
        ).json();
        const missionBinding = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers,
            data: { targetType: 'mission', targetId: mission.id },
        });
        expect(missionBinding.status()).toBe(201);

        const all = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, { headers })
        ).json();
        expect(all.length).toBe(2);
        expect(all.map((b: { targetType: string }) => b.targetType).sort()).toEqual([
            'mission',
            'tenant',
        ]);
    });

    test('GET /api/skills/catalog returns {entries, total} shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/skills/catalog?limit=3`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.entries)).toBe(true);
        expect(typeof body.total).toBe('number');
    });

    test('cross-user isolation: another user gets 403/404 on my skill', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const skill = await (
            await request.post(`${API_BASE}/api/skills`, {
                headers: authedHeaders(alice.access_token),
                data: {
                    ownerType: 'tenant',
                    ownerId: alice.user.id,
                    title: 'Private',
                    description: 'd',
                    instructionsMd: '# P',
                },
            })
        ).json();
        const res = await request.get(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([403, 404]).toContain(res.status());
    });

    test('DELETE /api/skills/:id → {deleted:true}; subsequent GET → 404', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const skill = await (
            await request.post(`${API_BASE}/api/skills`, {
                headers,
                data: {
                    ownerType: 'tenant',
                    ownerId: u.user.id,
                    title: 'Delete Me Skill',
                    description: 'd',
                    instructionsMd: '# D',
                },
            })
        ).json();

        const del = await request.delete(`${API_BASE}/api/skills/${skill.id}`, { headers });
        expect(del.status()).toBe(200);
        expect(await del.json()).toMatchObject({ deleted: true });

        const after = await request.get(`${API_BASE}/api/skills/${skill.id}`, { headers });
        expect([403, 404]).toContain(after.status());
    });
});

test.describe('Skills — UI (authenticated as the seeded user)', () => {
    test('/skills index renders the hub', async ({ page }) => {
        await page.goto('/skills', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        // The hub exposes section toggles (installed / available / custom).
        await expect(page.getByText(/installed/i).first()).toBeVisible({ timeout: 30_000 });
    });

    test('a custom skill created via API renders on its detail page', async ({ page, request }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        const { access_token, user } = await login.json();
        const ownerId = user?.id ?? (await ownerIdFor(request, access_token));

        const title = `E2E Skill ${Date.now().toString(36)}`;
        const createRes = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(access_token),
            data: {
                ownerType: 'tenant',
                ownerId,
                title,
                description: 'created by e2e',
                instructionsMd: '# E2E\n\nbody',
            },
        });
        expect(createRes.status()).toBe(201);
        const skill = await createRes.json();

        await page.goto(`/skills/${skill.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
    });
});
