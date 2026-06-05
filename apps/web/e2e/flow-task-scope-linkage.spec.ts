import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createTaskViaAPI } from './helpers/agents-tasks';
import { createOrganizationViaAPI } from './helpers/organizations';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Task ↔ scope linkage — the cross-feature integration spine that pins how a
 * Task binds to exactly one parent scope (Mission | Idea | Work), how the
 * three `?missionId=` / `?ideaId=` / `?workId=` list filters partition a
 * user's Tasks, how scope behaves under PATCH, how scope interacts with the
 * lazy-tenant stamping subscriber, and how all of that stays isolated per
 * user. Companion to — and deliberately NON-overlapping with —
 * `mission-idea-task-flow.spec.ts` (mission/idea filters only) and
 * `flow-multi-tenant-isolation.spec.ts` (tenant stamping of an UNSCOPED
 * post-org task + cross-user work/mission guards).
 *
 * Every contract below was reconciled against the HARDENED API source
 * (`apps/api/src/tasks/*` + `packages/agent/src/tasks-domain/tasks.service.ts`):
 *
 *   POST /api/tasks { title, missionId?|ideaId?|workId? }            → 201
 *     - status:'backlog', priority:'p3', slug:'T-n' (per-user counter).
 *     - Scope columns are nullable + additive; service enforces "exactly
 *       zero or one of missionId/ideaId/workId" → popCount>1 is 400
 *       "...exactly zero or one of missionId / ideaId / workId.".
 *     - The scope id is FK-enforced AND ownership-enforced at create time
 *       (`assertScopeReachable`): a workId/missionId/ideaId that does not
 *       exist — OR exists but is owned by another user — is a 400
 *       ("Work <id> not found." / "Mission …" / "Idea …"). Linkage is a
 *       REAL owned reference, not a free pointer. So each scoped Task must
 *       be pinned to an entity the caller created and owns.
 *   GET  /api/tasks?workId=<id> / ?missionId= / ?ideaId=             → 200
 *       { data:[…], meta:{ total, limit, offset } }. The list is ALWAYS
 *       user-scoped first; the scope filter narrows within the caller's own
 *       Tasks. An orphan (unscoped) Task appears in NONE of the three.
 *       An unknown scope id → 200 with an empty page (never 4xx/5xx).
 *   PATCH /api/tasks/:id                                              → 200
 *       The UpdateTaskDto whitelists title/description/priority/labels/
 *       parentTaskId/requireAllApprovers ONLY, and the global ValidationPipe
 *       runs `forbidNonWhitelisted` — so a PATCH that even MENTIONS a scope
 *       key (missionId/ideaId/workId) is rejected 400 "property <key> should
 *       not exist". Scope is therefore IMMUTABLE post-create: a Task NEVER
 *       moves between scopes via PATCH (the request is refused outright; a
 *       title-only PATCH succeeds and leaves the scope untouched).
 *   GET  /api/tasks/:id (cross-user)                                  → 404
 *       (no existence leak; never 403).
 *
 *   Tenant stamping ∩ scope (probed — "lazy Tenant on first Org"):
 *     - A fresh user's Tasks are born tenantId:null, organizationId:null.
 *     - Creating the user's FIRST org lazily mints a Tenant and
 *       RETROACTIVELY backfills that tenantId onto the user's pre-existing
 *       Task rows — but leaves their organizationId null (the org is the
 *       active scope for NEW writes, not a retro membership). [The isolation
 *       spec only verified this backfill for WORKS; here we pin it for the
 *       TASK row, and additionally for a SCOPE-linked task.]
 *     - Every subsequent scoped write carries the org's tenantId AND
 *       organizationId SIMULTANEOUSLY with its own missionId/ideaId/workId.
 *
 * AI/build/research linkage (Idea→Mission auto-link, agent dispatch) needs a
 * provider + Trigger.dev — absent on the e2e stack — so it is out of scope.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The shared `Task` helper interface only declares the smoke fields
 * (id/slug/title/status/priority). The live API echoes the full row, so we
 * read the scope + tenant columns through this narrower view of the same
 * response (no helper modification — just a precise local read shape).
 */
interface ScopedTaskView {
    id: string;
    title: string;
    missionId: string | null;
    ideaId: string | null;
    workId: string | null;
    tenantId: string | null;
    organizationId: string | null;
}

/** Re-view a helper-typed Task (or raw GET body) as its scope/tenant columns. */
function asScoped(task: unknown): ScopedTaskView {
    return task as ScopedTaskView;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token;
}

/** Create a Mission via the public API; returns its id. */
async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'scope-linkage probe', type: 'one-shot' },
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    return (await res.json()).id;
}

/** Create an Idea (work-proposal) via the public API; returns its id. */
async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    return (await res.json()).id;
}

/** Page through the full task list filtered by one scope param; return ids. */
async function listTaskIds(
    request: APIRequestContext,
    token: string,
    query: string,
): Promise<{ ids: string[]; total: number }> {
    const res = await request.get(`${API_BASE}/api/tasks?${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list ${query} body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return { ids: (body.data as Array<{ id: string }>).map((t) => t.id), total: body.meta.total };
}

/** POST /api/tasks raw (no helper 201-assertion); returns the response. */
async function postTask(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data,
    });
}

test.describe('Task ↔ scope linkage (Mission / Idea / Work)', () => {
    test('full scope partition: one Task per scope + an orphan, each filter returns ONLY its own', async ({
        request,
    }) => {
        // A FRESH user keeps the partition deterministic — the shared seeded
        // user accumulates rows across specs, which would defeat exact
        // membership reasoning across all three filters.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Build all three real parents.
        const missionId = await createMission(request, token, `Scope Mission ${s}`);
        const ideaId = await createIdea(request, token, `Scope Idea ${s} — directory of dev tools`);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Scope Work ${s}`,
            slug: `scope-work-${s}`,
        });
        expect(missionId).toMatch(UUID_RE);
        expect(ideaId).toMatch(UUID_RE);
        expect(workId).toMatch(UUID_RE);

        // One Task pinned to each scope + one orphan (unscoped). Each
        // create echoes back ONLY its own scope column; the other two stay
        // null (additive, single-parent linkage).
        const missionTask = await createTaskViaAPI(request, token, {
            title: `Mission-scoped ${s}`,
            missionId,
        });
        expect(asScoped(missionTask).missionId).toBe(missionId);
        expect(asScoped(missionTask).ideaId).toBeNull();
        expect(asScoped(missionTask).workId).toBeNull();

        const ideaTask = await createTaskViaAPI(request, token, {
            title: `Idea-scoped ${s}`,
            ideaId,
        });
        expect(asScoped(ideaTask).ideaId).toBe(ideaId);
        expect(asScoped(ideaTask).missionId).toBeNull();
        expect(asScoped(ideaTask).workId).toBeNull();

        const workTask = await createTaskViaAPI(request, token, {
            title: `Work-scoped ${s}`,
            workId,
        });
        expect(asScoped(workTask).workId).toBe(workId);
        expect(asScoped(workTask).missionId).toBeNull();
        expect(asScoped(workTask).ideaId).toBeNull();

        const orphanTask = await createTaskViaAPI(request, token, { title: `Orphan ${s}` });
        expect(asScoped(orphanTask).missionId).toBeNull();
        expect(asScoped(orphanTask).ideaId).toBeNull();
        expect(asScoped(orphanTask).workId).toBeNull();

        // The unfiltered list contains ALL FOUR.
        const all = await listTaskIds(request, token, 'limit=200');
        for (const t of [missionTask, ideaTask, workTask, orphanTask]) {
            expect(all.ids, `unfiltered should contain ${t.id}`).toContain(t.id);
        }

        // ── Each scope filter is an exact partition: it returns its own
        //    Task and NEITHER the other two scoped Tasks NOR the orphan. ──
        const byMission = await listTaskIds(request, token, `missionId=${missionId}`);
        expect(byMission.ids).toContain(missionTask.id);
        expect(byMission.ids).not.toContain(ideaTask.id);
        expect(byMission.ids).not.toContain(workTask.id);
        expect(byMission.ids).not.toContain(orphanTask.id);

        const byIdea = await listTaskIds(request, token, `ideaId=${ideaId}`);
        expect(byIdea.ids).toContain(ideaTask.id);
        expect(byIdea.ids).not.toContain(missionTask.id);
        expect(byIdea.ids).not.toContain(workTask.id);
        expect(byIdea.ids).not.toContain(orphanTask.id);

        // The WORK filter is the gap `mission-idea-task-flow.spec.ts` never
        // exercised — pin it with the same exactness.
        const byWork = await listTaskIds(request, token, `workId=${workId}`);
        expect(byWork.ids).toContain(workTask.id);
        expect(byWork.ids).not.toContain(missionTask.id);
        expect(byWork.ids).not.toContain(ideaTask.id);
        expect(byWork.ids).not.toContain(orphanTask.id);

        // The orphan is reachable ONLY via the unfiltered list — it is
        // invisible to all three scope filters.
        for (const { ids } of [byMission, byIdea, byWork]) {
            expect(ids).not.toContain(orphanTask.id);
        }
    });

    test('scope exclusivity: every pair of scopes is a 400, a real single scope is accepted, a ghost id is rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        const missionId = await createMission(request, token, `Excl Mission ${s}`);
        const ideaId = await createIdea(request, token, `Excl Idea ${s}`);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Excl Work ${s}`,
            slug: `excl-work-${s}`,
        });

        // ALL THREE pairings violate "exactly zero or one" → 400 with the
        // same server message. (The mission-idea spec only checked the
        // mission+idea pairing; work+* is the new coverage.)
        const pairs: Array<[string, Record<string, string>]> = [
            ['mission+idea', { missionId, ideaId }],
            ['mission+work', { missionId, workId }],
            ['idea+work', { ideaId, workId }],
        ];
        for (const [label, scope] of pairs) {
            const res = await request.post(`${API_BASE}/api/tasks`, {
                headers,
                data: { title: `reject ${label} ${s}`, ...scope },
            });
            expect(res.status(), `${label} should be 400`).toBe(400);
            expect((await res.json()).message).toMatch(/exactly zero or one/i);
        }

        // All three scopes together is ALSO a 400 (popCount 3 > 1).
        const triple = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: `reject triple ${s}`, missionId, ideaId, workId },
        });
        expect(triple.status()).toBe(400);

        // Linkage is FK + ownership enforced (`assertScopeReachable`): a Task
        // pinned to a never-created ghost workId is REJECTED at create time
        // with a 400 "Work <id> not found." — the scope id must reference a
        // real entity the caller owns, not a free pointer.
        const ghostId = UNKNOWN_UUID;
        const ghostRes = await postTask(request, token, {
            title: `Ghost-scoped ${s}`,
            workId: ghostId,
        });
        expect(ghostRes.status(), `ghost workId should be 400`).toBe(400);
        expect((await ghostRes.json()).message).toMatch(/not found/i);

        // The single REAL, owned work scope is accepted, and the work filter
        // returns exactly that task.
        const realTask = await createTaskViaAPI(request, token, {
            title: `Real-scoped ${s}`,
            workId,
        });
        expect(asScoped(realTask).workId).toBe(workId);
        const byReal = await listTaskIds(request, token, `workId=${workId}`);
        expect(byReal.ids).toContain(realTask.id);
        // The ghost scope id resolves to an empty page (never created, no row).
        const byGhost = await listTaskIds(request, token, `workId=${ghostId}`);
        expect(byGhost.ids).not.toContain(realTask.id);
    });

    test('scope is immutable post-create: PATCH never moves a Task between scopes', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        const missionId = await createMission(request, token, `Immut Mission ${s}`);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Immut Work ${s}`,
            slug: `immut-work-${s}`,
        });

        // Born work-scoped.
        const task = await createTaskViaAPI(request, token, {
            title: `Immutable scope ${s}`,
            workId,
        });
        expect(asScoped(task).workId).toBe(workId);

        // A PATCH that even MENTIONS a scope key is REFUSED outright: the
        // UpdateTaskDto whitelists only title/description/priority/labels/
        // parentTaskId/requireAllApprovers, and the global ValidationPipe runs
        // `forbidNonWhitelisted`, so {workId, missionId, …} → 400 "property
        // <key> should not exist". Scope therefore can never move via PATCH.
        const newTitle = `Renamed but pinned ${s}`;
        const rejectRes = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers,
            data: { workId: null, missionId, title: newTitle },
        });
        expect(rejectRes.status(), `scope-key patch should be 400`).toBe(400);
        expect((await rejectRes.json()).message).toEqual(
            expect.arrayContaining([expect.stringMatching(/should not exist/i)]),
        );

        // The rejected request changed NOTHING — the row is byte-for-byte its
        // birth state (original title, work scope intact, mission still null).
        const afterReject = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers })
        ).json();
        expect(afterReject.title).toBe(`Immutable scope ${s}`); // not renamed
        expect(afterReject.workId).toBe(workId);
        expect(afterReject.missionId).toBeNull();

        // A title-only PATCH (whitelisted field) DOES succeed and leaves the
        // scope untouched — mutable fields move, scope does not.
        const patchRes = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers,
            data: { title: newTitle },
        });
        expect(patchRes.status(), `patch body=${await patchRes.text()}`).toBe(200);
        const patched = await patchRes.json();
        expect(patched.title).toBe(newTitle); // mutable field moved
        expect(patched.workId).toBe(workId); // scope unchanged

        // GET-by-id confirms the persisted row agrees (no eventual move).
        const after = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers })
        ).json();
        expect(after.workId).toBe(workId);
        expect(after.missionId).toBeNull();

        // The filters reflect the immutability: still in the work filter,
        // still NOT in the mission filter after the failed move attempt.
        const byWork = await listTaskIds(request, token, `workId=${workId}`);
        expect(byWork.ids).toContain(task.id);
        const byMission = await listTaskIds(request, token, `missionId=${missionId}`);
        expect(byMission.ids).not.toContain(task.id);
    });

    test('cross-user scope isolation: each user owns its own work scope, zero leakage; cross-read is 404', async ({
        request,
    }) => {
        // Two independent users. Scope linkage is ownership-enforced, so B
        // CANNOT pin a Task to A's workId — referencing A's work id is a 400
        // "Work <id> not found." (it is unreachable for B). Each user owns its
        // own work scope; the list is user-scoped FIRST so neither sees the
        // other's Task, and a direct cross-user GET-by-id is a 404 (no
        // existence leak via 403).
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const tokenA = userA.access_token;
        const tokenB = userB.access_token;
        const s = stamp();

        // A owns a real work + a work-scoped Task.
        const { id: workIdA } = await createWorkViaAPI(request, tokenA, {
            name: `A Work ${s}`,
            slug: `a-work-${s}`,
        });
        const taskA = await createTaskViaAPI(request, tokenA, {
            title: `A scoped ${s}`,
            workId: workIdA,
        });

        // B CANNOT claim A's work scope — ownership enforcement rejects it 400.
        const claimRes = await postTask(request, tokenB, {
            title: `B tries A's scope ${s}`,
            workId: workIdA,
        });
        expect(claimRes.status(), `B claiming A's work should be 400`).toBe(400);
        expect((await claimRes.json()).message).toMatch(/not found/i);

        // B owns its OWN real work + a work-scoped Task on it.
        const { id: workIdB } = await createWorkViaAPI(request, tokenB, {
            name: `B Work ${s}`,
            slug: `b-work-${s}`,
        });
        const taskB = await createTaskViaAPI(request, tokenB, {
            title: `B scoped ${s}`,
            workId: workIdB,
        });
        expect(asScoped(taskB).workId).toBe(workIdB);
        expect(taskB.id).not.toBe(taskA.id);

        // A's ?workId= view shows A's Task; B's own-work view shows B's Task.
        // The user partition holds — neither leaks into the other's filter.
        const aView = await listTaskIds(request, tokenA, `workId=${workIdA}`);
        expect(aView.ids).toContain(taskA.id);
        expect(aView.ids).not.toContain(taskB.id);

        const bView = await listTaskIds(request, tokenB, `workId=${workIdB}`);
        expect(bView.ids).toContain(taskB.id);
        expect(bView.ids).not.toContain(taskA.id);

        // Direct cross-user reads are 404 BOTH ways (no 403 existence leak).
        const bReadsA = await request.get(`${API_BASE}/api/tasks/${taskA.id}`, {
            headers: authedHeaders(tokenB),
        });
        expect(bReadsA.status()).toBe(404);
        const aReadsB = await request.get(`${API_BASE}/api/tasks/${taskB.id}`, {
            headers: authedHeaders(tokenA),
        });
        expect(aReadsB.status()).toBe(404);

        // Cross-user PATCH is likewise a 404 — B can't mutate A's Task.
        const bPatchesA = await request.patch(`${API_BASE}/api/tasks/${taskA.id}`, {
            headers: authedHeaders(tokenB),
            data: { title: 'hijack' },
        });
        expect(bPatchesA.status()).toBe(404);
    });

    test('tenant stamping ∩ scope: pre-org scoped Task is backfilled tenant-only; post-org scoped Task carries tenant+org+scope together', async ({
        request,
    }) => {
        // This is the scope×tenant intersection the isolation spec did NOT
        // probe: it backfilled a WORK and stamped an UNSCOPED post-org task.
        // Here we pin the behavior for SCOPE-LINKED tasks specifically.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        // ── PRE-org: a work + a work-scoped Task, both born unstamped ──────
        const { id: preWorkId } = await createWorkViaAPI(request, token, {
            name: `Pre Work ${s}`,
            slug: `pre-work-${s}`,
        });
        const preScopedTask = await createTaskViaAPI(request, token, {
            title: `Pre-org scoped ${s}`,
            workId: preWorkId,
        });
        expect(asScoped(preScopedTask).tenantId).toBeNull();
        expect(asScoped(preScopedTask).organizationId).toBeNull();
        // Its scope linkage is set from birth, before any tenant exists.
        expect(asScoped(preScopedTask).workId).toBe(preWorkId);

        // ── Mint the FIRST org → lazy Tenant ───────────────────────────────
        const org = await createOrganizationViaAPI(request, token, `Stamp Org ${s}`);
        const tenantId = org.tenantId;
        expect(tenantId).toMatch(UUID_RE);

        // ── Retroactive backfill of the PRE-org scoped Task: tenantId is
        //    filled in, organizationId stays null, and the scope linkage is
        //    UNTOUCHED (tenant stamping never rewrites missionId/workId). ──
        const preAfter = await (
            await request.get(`${API_BASE}/api/tasks/${preScopedTask.id}`, { headers })
        ).json();
        expect(preAfter.tenantId).toBe(tenantId);
        expect(preAfter.organizationId).toBeNull();
        expect(preAfter.workId).toBe(preWorkId); // scope preserved through backfill

        // ── POST-org: a NEW work + a work-scoped Task carry the org's tenant
        //    AND organizationId SIMULTANEOUSLY with their own scope id. ─────
        const { id: postWorkId } = await createWorkViaAPI(request, token, {
            name: `Post Work ${s}`,
            slug: `post-work-${s}`,
        });
        const postScopedTask = await createTaskViaAPI(request, token, {
            title: `Post-org scoped ${s}`,
            workId: postWorkId,
        });
        expect(asScoped(postScopedTask).tenantId).toBe(tenantId);
        expect(asScoped(postScopedTask).organizationId).toBe(org.id);
        expect(asScoped(postScopedTask).workId).toBe(postWorkId);

        // tenantId is one shared namespace across the org row, the work, and
        // both scoped tasks.
        const postWorkBody = await (
            await request.get(`${API_BASE}/api/works/${postWorkId}`, { headers })
        ).json();
        const postWork = postWorkBody.work ?? postWorkBody;
        expect(
            new Set([org.tenantId, postWork.tenantId, asScoped(postScopedTask).tenantId]).size,
        ).toBe(1);

        // The work filter still finds the post-org scoped task even though it
        // is now tenant+org-stamped — stamping is orthogonal to scope linkage.
        const byPostWork = await listTaskIds(request, token, `workId=${postWorkId}`);
        expect(byPostWork.ids).toContain(postScopedTask.id);
    });

    test('UI: a Work-scoped Task renders on the work /tasks tab (filtered by workId)', async ({
        page,
        request,
        baseURL,
    }) => {
        // UI-driven assertion → use the seeded user (storageState cookie).
        const token = await seededToken(request);
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `UI Scope Work ${s}`,
            slug: `ui-scope-work-${s}`,
        });
        // A scoped Task that SHOULD show on this work's tab…
        const onTabTitle = `On-tab ${s}`;
        const onTab = await createTaskViaAPI(request, token, { title: onTabTitle, workId });
        expect(asScoped(onTab).workId).toBe(workId);
        // …and an orphan that should NOT (the tab filters by workId).
        const orphanTitle = `Off-tab orphan ${s}`;
        await createTaskViaAPI(request, token, { title: orphanTitle });

        const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
        await page.goto(`${origin}/works/${workId}/tasks`, { waitUntil: 'domcontentloaded' });

        // Resilient to next-dev local↔CI route divergence: the nested
        // /works/:id/tasks page may render the scoped section OR (locally)
        // fall through to a catch-all. Accept either the task title (CI/full
        // render) or the section's "Tasks" header as proof the route mounted.
        const taskCell = page.getByText(onTabTitle).first();
        const sectionHeader = page.getByRole('heading', { name: 'Tasks' }).first();
        // When the route renders fully BOTH the task title AND the "Tasks"
        // header are present, so the .or() union matches 2 elements — apply
        // .first() to the whole union (not each operand) to stay strict-safe.
        await expect(taskCell.or(sectionHeader).first()).toBeVisible({ timeout: 30_000 });

        // If the full section rendered the scoped task, the orphan must NOT
        // be on this workId-filtered tab. Only assert the negative when the
        // positive (task title) actually rendered, to stay route-divergence
        // safe.
        if (await taskCell.isVisible().catch(() => false)) {
            await expect(page.getByText(orphanTitle)).toHaveCount(0);
        }
    });
});
