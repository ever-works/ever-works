import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Mission → Idea → Task hierarchy — real end-to-end coverage of the
 * deterministic wiring the public API exposes for the Missions / Ideas /
 * Tasks taxonomy (Mission = ongoing/one-shot goal; Idea = an atomic
 * work-proposal; Task = a unit of work scoped to exactly one parent).
 *
 * What this pins (all verified against the LIVE API before assertions):
 *   1. POST /api/me/missions { title, description, type:'one-shot' } persists;
 *      GET /api/me/missions and GET /api/me/missions/:id return it.
 *   2. POST /api/me/work-proposals { description } creates an Idea
 *      (source:'user-manual', status:'pending'). The user-manual create
 *      path does NOT accept a missionId — the Idea is born with
 *      missionId:null (the AI research pipeline is what links Ideas to a
 *      Mission, and there's no provider on the e2e stack). We assert that
 *      truthfully rather than inventing a linkage the API rejects.
 *   3. POST /api/tasks links a Task to its owners. Ownership is NON-
 *      EXCLUSIVE — a Task may carry missionId AND ideaId together, and
 *      both persist. The hierarchy is additionally expressed as a
 *      Mission-scoped Task and an Idea-scoped Task, all with
 *      status:'backlog'.
 *   4. GET /api/tasks?missionId=<id> returns only the Mission's Task;
 *      GET /api/tasks?ideaId=<id> returns only the Idea's Task. Neither
 *      filter leaks the other scope's Task nor an unscoped Task.
 *   5. UI (authenticated as the seeded user): the Mission renders on
 *      /missions, its detail renders on /missions/:id (h1 title), and the
 *      Mission-scoped Task renders on /missions/:id/tasks.
 *
 * AI-driven build/research paths are intentionally out of scope (no
 * provider locally). This is the deterministic create/link/filter spine.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Mission → Idea → Task hierarchy (seeded user)', () => {
    test('create Mission + Idea + scoped Tasks, then assert scoped filtering', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const headers = authedHeaders(token);
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        // ── 1. Mission persists ───────────────────────────────────────────
        const missionTitle = `E2E Mission ${stamp}`;
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: { title: missionTitle, description: 'Curate AI dev tools', type: 'one-shot' },
        });
        expect(missionRes.status(), `mission create body=${await missionRes.text()}`).toBe(201);
        const mission = await missionRes.json();
        expect(mission.id).toMatch(UUID_RE);
        expect(mission.title).toBe(missionTitle);
        expect(mission.type).toBe('one-shot');
        expect(mission.status).toBe('active');

        // GET one returns the same row.
        const getOne = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, { headers });
        expect(getOne.status()).toBe(200);
        expect((await getOne.json()).title).toBe(missionTitle);

        // GET list contains it (shared in-memory DB ⇒ tolerate other rows).
        const list = await (await request.get(`${API_BASE}/api/me/missions`, { headers })).json();
        expect((list as Array<{ id: string }>).map((m) => m.id)).toContain(mission.id);

        // ── 2. Idea persists (user-manual ⇒ missionId is null) ─────────────
        const ideaDesc = `E2E Idea ${stamp} — a directory of AI developer tools`;
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: ideaDesc },
        });
        expect(ideaRes.status(), `idea create body=${await ideaRes.text()}`).toBe(201);
        const idea = await ideaRes.json();
        expect(idea.id).toMatch(UUID_RE);
        expect(idea.source).toBe('user-manual');
        expect(idea.status).toBe('pending');
        // Linkage truth: the user-manual create path can't set a mission, so
        // the Idea is unlinked. (The list endpoint exposes a ?missionId=
        // filter for the AI-linked case — exercised below as a contract.)
        expect(idea.missionId).toBeNull();

        const ideaGet = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers,
        });
        expect(ideaGet.status()).toBe(200);

        // The Idea-by-Mission filter is a real, accepted contract: scoping
        // the (unlinked) Idea list to our brand-new Mission yields nothing.
        const ideasForMission = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
            { headers },
        );
        expect(ideasForMission.status()).toBe(200);
        const ideaListBody = await ideasForMission.json();
        const ideaList = Array.isArray(ideaListBody)
            ? ideaListBody
            : (ideaListBody?.proposals ?? ideaListBody?.data ?? []);
        expect(Array.isArray(ideaList)).toBe(true);
        expect((ideaList as Array<{ id: string }>).some((i) => i.id === idea.id)).toBe(false);

        // ── 3. A Mission-scoped Task and an Idea-scoped Task persist ───────
        // Task ownership is non-exclusive, so missionId+ideaId together is a
        // valid Task that belongs to both, not a 400.
        const both = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: `Both ${stamp}`, missionId: mission.id, ideaId: idea.id },
        });
        expect(both.status()).toBe(201);
        const bothTask = await both.json();
        expect(bothTask.missionId).toBe(mission.id);
        expect(bothTask.ideaId).toBe(idea.id);

        const missionTaskTitle = `Mission Task ${stamp}`;
        const missionTaskRes = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: missionTaskTitle, missionId: mission.id },
        });
        expect(missionTaskRes.status(), `mission task body=${await missionTaskRes.text()}`).toBe(
            201,
        );
        const missionTask = await missionTaskRes.json();
        expect(missionTask.id).toMatch(UUID_RE);
        expect(missionTask.missionId).toBe(mission.id);
        expect(missionTask.ideaId).toBeNull();
        expect(missionTask.status).toBe('backlog');

        const ideaTaskTitle = `Idea Task ${stamp}`;
        const ideaTaskRes = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: ideaTaskTitle, ideaId: idea.id },
        });
        expect(ideaTaskRes.status(), `idea task body=${await ideaTaskRes.text()}`).toBe(201);
        const ideaTask = await ideaTaskRes.json();
        expect(ideaTask.ideaId).toBe(idea.id);
        expect(ideaTask.missionId).toBeNull();
        expect(ideaTask.status).toBe('backlog');

        // An unscoped Task — must appear in NEITHER scoped filter.
        const unscopedRes = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: `Unscoped Task ${stamp}` },
        });
        expect(unscopedRes.status()).toBe(201);
        const unscopedTask = await unscopedRes.json();
        expect(unscopedTask.missionId).toBeNull();
        expect(unscopedTask.ideaId).toBeNull();

        // GET one round-trips the Mission link.
        const missionTaskGet = await request.get(`${API_BASE}/api/tasks/${missionTask.id}`, {
            headers,
        });
        expect(missionTaskGet.status()).toBe(200);
        expect((await missionTaskGet.json()).missionId).toBe(mission.id);

        // ── 4. Scoped filtering is exact (no cross-scope leakage) ──────────
        const byMission = await (
            await request.get(`${API_BASE}/api/tasks?missionId=${mission.id}`, { headers })
        ).json();
        const byMissionIds = (byMission.data as Array<{ id: string }>).map((t) => t.id);
        expect(byMissionIds).toContain(missionTask.id);
        expect(byMissionIds).not.toContain(ideaTask.id);
        expect(byMissionIds).not.toContain(unscopedTask.id);

        const byIdea = await (
            await request.get(`${API_BASE}/api/tasks?ideaId=${idea.id}`, { headers })
        ).json();
        const byIdeaIds = (byIdea.data as Array<{ id: string }>).map((t) => t.id);
        expect(byIdeaIds).toContain(ideaTask.id);
        expect(byIdeaIds).not.toContain(missionTask.id);
        expect(byIdeaIds).not.toContain(unscopedTask.id);

        // An unknown scope id returns an empty page, never a 4xx/5xx.
        const byUnknown = await request.get(`${API_BASE}/api/tasks?missionId=${UNKNOWN_UUID}`, {
            headers,
        });
        expect(byUnknown.status()).toBe(200);
        expect((await byUnknown.json()).data.length).toBe(0);
    });

    test('UI: the Mission, its detail page, and its scoped Task all render', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const headers = authedHeaders(token);
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        const missionTitle = `E2E UI Mission ${stamp}`;
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: missionTitle, description: 'render check', type: 'one-shot' },
            })
        ).json();
        expect(mission.id).toMatch(UUID_RE);

        const taskTitle = `E2E UI Mission Task ${stamp}`;
        const task = await (
            await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: taskTitle, missionId: mission.id },
            })
        ).json();
        expect(task.missionId).toBe(mission.id);

        // /missions catalog lists the Mission (MissionCard <h3> title).
        await page.goto('/missions', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(missionTitle).first()).toBeVisible({ timeout: 30_000 });

        // /missions/:id detail renders the Mission title (the <h1> header).
        await page.goto(`/missions/${mission.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: missionTitle }).first()).toBeVisible({
            timeout: 30_000,
        });

        // /missions/:id/tasks renders the Mission-scoped Task (TaskCard).
        // The Tasks tab filters the global list by missionId, so only this
        // Task — not the unrelated ones — shows up.
        await page.goto(`/missions/${mission.id}/tasks`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(taskTitle).first()).toBeVisible({ timeout: 30_000 });
    });
});
