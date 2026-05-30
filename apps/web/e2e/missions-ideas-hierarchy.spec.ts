import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Missions / Ideas hierarchy — deepens the existing API-contract specs
 * (missions.spec.ts, ideas-extension.spec.ts) with the cross-entity wiring
 * that had no coverage: full-fork mission clone, the user-manual Idea
 * (work-proposal) lifecycle + budget, and the Mission/Idea scoping of
 * Agents and Tasks. AI-driven build/research paths are intentionally out
 * of scope (no provider locally) — this pins the deterministic wiring.
 *
 * Taxonomy: Mission = ongoing goal; Idea = atomic one-shot (a
 * work-proposal). Agents and Tasks can be scoped to either, plus Work.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Mission clone (full fork)', () => {
    test('clone copies the mission, sets sourceMissionId, and titles it "Copy of …"', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const origin = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: 'Curate AI dev tools', description: 'weekly', type: 'one-shot' },
            })
        ).json();

        const cloneRes = await request.post(`${API_BASE}/api/me/missions/${origin.id}/clone`, {
            headers,
            data: {},
        });
        expect(cloneRes.status(), `clone body=${await cloneRes.text()}`).toBe(201);
        const cloned = (await cloneRes.json()).mission;
        expect(cloned.id).not.toBe(origin.id);
        expect(cloned.sourceMissionId).toBe(origin.id);
        expect(cloned.title).toBe('Copy of Curate AI dev tools');
        expect(cloned.status).toBe('active');

        // Both now exist independently for the owner.
        const list = await (await request.get(`${API_BASE}/api/me/missions`, { headers })).json();
        const ids = list.map((m: { id: string }) => m.id);
        expect(ids).toContain(origin.id);
        expect(ids).toContain(cloned.id);
    });
});

test.describe('Idea (work-proposal) lifecycle — user-manual', () => {
    test('manual create → pending/user-manual; budget is idea-scoped; cross-user 404', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const headers = authedHeaders(alice.access_token);

        const idea = await (
            await request.post(`${API_BASE}/api/me/work-proposals`, {
                headers,
                data: { description: 'A directory of AI dev tools' },
            })
        ).json();
        expect(idea.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(idea.source).toBe('user-manual');
        expect(idea.status).toBe('pending');
        expect(idea.slugSuggestion).toBe('a-directory-of-ai-dev-tools');

        const got = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, { headers });
        expect(got.status()).toBe(200);

        const budget = await (
            await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`, { headers })
        ).json();
        expect(budget.ownerType).toBe('idea');
        expect(budget.ownerId).toBe(idea.id);
        expect(budget.currentSpendCents).toBe(0);
        expect(budget.blocked).toBe(false);

        // Cross-user isolation.
        const bobGet = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([403, 404]).toContain(bobGet.status());
    });
});

test.describe('Cross-entity scoping — Agents & Tasks across Mission/Idea', () => {
    test('Tasks: ?missionId and ?ideaId each return only their own scope', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: 'M', description: 'd', type: 'one-shot' },
            })
        ).json();
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'A curated directory of AI developer tools' },
        });
        expect(ideaRes.status()).toBe(201);
        const idea = await ideaRes.json();
        expect(idea.id).toBeTruthy();

        const missionTask = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: 'Mission task', missionId: mission.id },
            })
        ).json();
        const ideaTask = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: 'Idea task', ideaId: idea.id },
            })
        ).json();
        await request.post(`${API_BASE}/api/tasks`, { headers, data: { title: 'Unscoped task' } });

        const byMission = await (
            await request.get(`${API_BASE}/api/tasks?missionId=${mission.id}`, { headers })
        ).json();
        expect(byMission.data.map((t: { id: string }) => t.id)).toEqual([missionTask.id]);

        const byIdea = await (
            await request.get(`${API_BASE}/api/tasks?ideaId=${idea.id}`, { headers })
        ).json();
        expect(byIdea.data.map((t: { id: string }) => t.id)).toEqual([ideaTask.id]);

        const byUnknown = await (
            await request.get(`${API_BASE}/api/tasks?ideaId=${UNKNOWN_UUID}`, { headers })
        ).json();
        expect(byUnknown.data.length).toBe(0);
    });

    test('Agents: idea-scoped agent requires ideaId and is isolated by the scope filter', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const orphan = await request.post(`${API_BASE}/api/agents`, {
            headers,
            data: { scope: 'idea', name: 'No parent' },
        });
        expect(orphan.status()).toBe(400);
        expect((await orphan.json()).message).toMatch(/ideaId/i);

        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'An agent-driven research directory idea' },
        });
        expect(ideaRes.status()).toBe(201);
        const idea = await ideaRes.json();
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: 'M2', description: 'd', type: 'one-shot' },
            })
        ).json();

        const ideaAgent = await (
            await request.post(`${API_BASE}/api/agents`, {
                headers,
                data: { scope: 'idea', ideaId: idea.id, name: 'Idea Worker' },
            })
        ).json();
        expect(ideaAgent.scope).toBe('idea');
        expect(ideaAgent.ideaId).toBe(idea.id);
        await request.post(`${API_BASE}/api/agents`, {
            headers,
            data: { scope: 'mission', missionId: mission.id, name: 'Mission Worker' },
        });

        const byIdea = await (
            await request.get(`${API_BASE}/api/agents?scope=idea&ideaId=${idea.id}`, { headers })
        ).json();
        expect(byIdea.data.map((a: { id: string }) => a.id)).toEqual([ideaAgent.id]);
    });
});

test.describe('Missions / Ideas — UI (authenticated as the seeded user)', () => {
    async function seededToken(
        request: import('@playwright/test').APIRequestContext,
    ): Promise<string> {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        return (await login.json()).access_token;
    }

    test('a mission created via API appears on /missions', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = `E2E Mission ${Date.now().toString(36)}`;
        const res = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: { title, description: 'd', type: 'one-shot' },
        });
        expect(res.status()).toBe(201);
        await page.goto('/missions', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
    });

    test('an idea created via API appears on /ideas', async ({ page, request }) => {
        const token = await seededToken(request);
        const desc = `E2E Idea ${Date.now().toString(36)}`;
        const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers: authedHeaders(token),
            data: { description: desc },
        });
        expect(res.status()).toBe(201);
        await page.goto('/ideas', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(desc).first()).toBeVisible({ timeout: 30_000 });
    });
});
