import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { listAgentRuns } from './helpers/agents-tasks';

/**
 * Mission → Idea → Work FULL CHAIN, end-to-end — the vertical stitch that
 * turns a Mission into an Idea, accepts the Idea into a Work, and then hangs
 * scoped Agents + Tasks + budgets off every node of the taxonomy. This file
 * pins the way LINKAGE IDS PROPAGATE across the whole chain and the way each
 * scoped list surface (work-proposals `?missionId`, tasks & agents
 * `?missionId/?ideaId/?workId`) projects the SAME chain differently. Every
 * status code, body shape, and error string asserted below was probed against
 * the LIVE API at http://127.0.0.1:3100 (sqlite in-memory, keyless — no LLM
 * provider, Trigger.dev unbound) BEFORE the assertions were written.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 * Deliberately DISJOINT from the sibling Mission/Idea/Work specs — this file
 * owns the CROSS-SURFACE stitch, not any single subsystem's depth:
 *   - mission-idea-task-flow.spec.ts   — Mission+Idea+scoped-Task on the SEEDED
 *     user, tasks `?missionId/?ideaId` only. THIS file adds the WORK scope +
 *     `?workId`, the AGENT scoping surface, and does it all on FRESH users.
 *   - flow-idea-to-work-accept.spec.ts — the accept state machine (repeat /
 *     dismiss / validation). THIS file touches accept only as the chain's spine
 *     (one hop) and asserts both-direction id propagation.
 *   - flow-idea-multi-work-links.spec.ts — the `idea_works` 0..N link list.
 *   - flow-mission-works-relation.spec.ts — the `mission_works` M:N surface in
 *     full. THIS file uses it only to CLOSE THE LOOP (the born-from-Idea Work
 *     rejoining its origin Mission with the 'created' relation) + the
 *     mission-delete-preserves-provenance invariant.
 *   - flow-agent-scoping-matrix{,-deep}.spec.ts — the agent scope-cascade rules.
 *     THIS file only projects the chain's three nodes onto the agent filters.
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────
 *  POST /api/me/missions {title,description,type,outstandingIdeasCap?} → 201
 *    { id, title, status:'active', type, outcome:null, completedAt:null,
 *      schedule:null, autoBuildWorks:false, outstandingIdeasCap, guardrailsOverride:null,
 *      missionTemplateRepo:null, missionRepo:null, sourceMissionId:null, createdAt, updatedAt }.
 *    bad type → 400.
 *  POST /api/me/work-proposals {description} → 201 source:'user-manual',
 *    status:'pending', missionId:null (the manual path can NEVER self-link).
 *  POST /api/works → { status:'success', work:{ id, acceptedFromIdeaId:null, … } }.
 *  POST /api/me/work-proposals/:id/accept {workId} → 200 {ok:true}; idea after →
 *    status:'accepted', acceptedWorkId=workId; work after → acceptedFromIdeaId=ideaId;
 *    GET :id/works → { links:[{ ideaId, workId, kind:'linked', … }] }.
 *  POST /api/tasks {title,(missionId|ideaId|workId)} → 201 slug 'T-n', status:'backlog',
 *    priority:'p3'; two scope ids → 400 "…exactly zero or one…"; unknown/foreign
 *    parent → 400 "<Kind> <id> not found." (BAD REQUEST, note the status).
 *  GET  /api/tasks?missionId|ideaId|workId → { data, meta }, EXACT partition;
 *    unknown scope → 200 empty; malformed → 400 (ParseUUIDPipe).
 *  POST /api/agents {scope,(missionId|ideaId|workId),name} → 201 status:'draft';
 *    scope⇎parent mismatches → 400 with a "<Scope>-scoped Agents require <parentId>
 *    (and only <parentId>)." message; unknown/foreign parent → 404 "<Kind> <id>
 *    not found." (NOT FOUND — the status ASYMMETRY vs Task-create is real).
 *  GET  /api/agents?missionId|ideaId|workId → { data, meta }; filters AND
 *    independently (?scope=work&missionId → always empty); malformed → 400.
 *  GET  /api/me/missions/:id/budget  → OwnerBudgetSummary ownerType:'mission'.
 *  GET  /api/me/work-proposals/:id/budget → same envelope ownerType:'idea'; both
 *    { periodStart<periodEnd, currentSpendCents:0, capCents:null, currency:'usd',
 *      percentUsed:null, allowOverage:true, blocked:false }.
 *  GET  /api/agents/:id/budget → { currentSpendCents:0, capCents:null,
 *    periodStart<periodEnd, currency:'USD' } — a DIFFERENT (rolling-30-day,
 *    UPPERCASE-currency) shape from the owner-budget envelope.
 *  POST /api/me/missions/:id/run-now → 200 { status:<enum>, missionId, message? }
 *    (keyless: 'no-ideas' / 'skipped-no-profile'); anon → 401; unknown → 404.
 *  POST /api/agents/:id/assign-task {taskId} → keyless 500 "assign-task enqueue
 *    failed: …TRIGGER_SECRET_KEY…" BUT an AgentRun row persists
 *    ({ status:'failed', triggerKind:'task', taskId }); cross-user → 404.
 *  Cross-user chain reads: mission 404, idea 404 "Proposal not found",
 *    task 404, agent 404 — but GET /api/works/:id → 403 (the ONE node that
 *    leaks existence via 403 instead of the chain's uniform 404). Pinned tolerant.
 *
 * Cross-spec isolation: EVERY test builds its chain on FRESH registerUserViaAPI()
 * users (unique Date.now suffixes). List assertions use toContain/not.toContain
 * on the caller's OWN ids — never global counts. No module-scope data loading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const IDEA_DESC_MIN = 'a curated directory of resources'; // ≥10 chars filler

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface MissionRow {
    id: string;
    title: string;
    description: string;
    type: string;
    status: string;
    outcome: string | null;
    completedAt: string | null;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: unknown;
    missionTemplateRepo: string | null;
    missionRepo: string | null;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface IdeaRow {
    id: string;
    status: string;
    source: string;
    acceptedWorkId: string | null;
    missionId: string | null;
}

interface TaskRow {
    id: string;
    slug: string;
    title: string;
    status: string;
    priority: string;
    missionId: string | null;
    ideaId: string | null;
    workId: string | null;
}

interface AgentRow {
    id: string;
    scope: string;
    name: string;
    slug: string;
    status: string;
    missionId: string | null;
    ideaId: string | null;
    workId: string | null;
}

interface OwnerBudget {
    ownerType: string;
    ownerId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<MissionRow> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: {
            title: `Chain Mission ${stamp()}`,
            description: 'end-to-end chain mission',
            type: 'one-shot',
            ...overrides,
        },
    });
    expect(res.status(), `mission create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createIdea(
    request: APIRequestContext,
    token: string,
    description = `${IDEA_DESC_MIN} ${stamp()}`,
): Promise<IdeaRow> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text().catch(() => '')}`).toBe(201);
    const idea = (await res.json()) as IdeaRow;
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    expect(idea.missionId).toBeNull();
    return idea;
}

async function acceptIdea(
    request: APIRequestContext,
    token: string,
    ideaId: string,
    workId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
        headers: authedHeaders(token),
        data: { workId },
    });
    expect(res.status(), `accept body=${await res.text().catch(() => '')}`).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
}

async function readIdea(request: APIRequestContext, token: string, id: string): Promise<IdeaRow> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

/** Create a Task, optionally scoped to a chain node. Returns the full row. */
async function createTask(
    request: APIRequestContext,
    token: string,
    body: { title: string; missionId?: string; ideaId?: string; workId?: string },
): Promise<TaskRow> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `task create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Create an Agent scoped to a chain node. Returns the full row. */
async function createAgent(
    request: APIRequestContext,
    token: string,
    body: { scope: string; name: string; missionId?: string; ideaId?: string; workId?: string },
): Promise<AgentRow> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `agent create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Build the Mission → Idea → Work chain (accept committed). */
async function buildChain(
    request: APIRequestContext,
    token: string,
): Promise<{ mission: MissionRow; idea: IdeaRow; workId: string }> {
    const mission = await createMission(request, token);
    const idea = await createIdea(request, token);
    const work = await createWorkViaAPI(request, token, { name: `Chain Work ${stamp()}` });
    expect(work.id).toMatch(UUID_RE);
    await acceptIdea(request, token, idea.id, work.id);
    return { mission, idea, workId: work.id };
}

async function listTaskIds(
    request: APIRequestContext,
    token: string,
    query: string,
): Promise<{ status: number; ids: string[] }> {
    const res = await request.get(`${API_BASE}/api/tasks?${query}`, {
        headers: authedHeaders(token),
    });
    if (res.status() !== 200) return { status: res.status(), ids: [] };
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return { status: 200, ids: body.data.map((t) => t.id) };
}

async function listAgentIds(
    request: APIRequestContext,
    token: string,
    query: string,
): Promise<{ status: number; ids: string[] }> {
    const res = await request.get(`${API_BASE}/api/agents?${query}`, {
        headers: authedHeaders(token),
    });
    if (res.status() !== 200) return { status: res.status(), ids: [] };
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return { status: 200, ids: body.data.map((a) => a.id) };
}

test.describe('Chain spine — Mission → Idea → Work linkage propagation', () => {
    test('a Mission is born ACTIVE with the full lifecycle DTO (no outcome, no source, cap echoed)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const mission = await createMission(request, user.access_token, {
            title: `Birth Mission ${stamp()}`,
            outstandingIdeasCap: 7,
        });
        expect(mission.id).toMatch(UUID_RE);
        expect(mission.status).toBe('active');
        expect(mission.type).toBe('one-shot');
        // Freshly-created lifecycle fields are all in their zero state.
        expect(mission.outcome).toBeNull();
        expect(mission.completedAt).toBeNull();
        expect(mission.schedule).toBeNull();
        expect(mission.autoBuildWorks).toBe(false);
        expect(mission.outstandingIdeasCap).toBe(7);
        expect(mission.guardrailsOverride).toBeNull();
        expect(mission.missionTemplateRepo).toBeNull();
        expect(mission.sourceMissionId).toBeNull();
        expect(typeof mission.createdAt).toBe('string');
        expect(typeof mission.updatedAt).toBe('string');

        // A bad type never mints a Mission.
        const badType = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(user.access_token),
            data: { title: 'x', description: 'd', type: 'galaxy' },
        });
        expect(badType.status()).toBe(400);
    });

    test('the accept hop propagates the linkage id BOTH directions and records a provenance link', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const idea = await createIdea(request, token);
        const work = await createWorkViaAPI(request, token, { name: `Spine Work ${stamp()}` });
        // The Work is born with NO source Idea.
        const wRaw = work.raw as { work?: { acceptedFromIdeaId?: string | null } };
        expect(wRaw.work?.acceptedFromIdeaId ?? null).toBeNull();

        await acceptIdea(request, token, idea.id, work.id);

        // Idea side: PENDING → ACCEPTED and the denormalized pointer lands.
        const accepted = await readIdea(request, token, idea.id);
        expect(accepted.status).toBe('accepted');
        expect(accepted.acceptedWorkId).toBe(work.id);

        // Work side: the back-pointer is stamped with the source Idea id.
        const workAfter = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(token),
        });
        expect(workAfter.status()).toBe(200);
        const wb = await workAfter.json();
        expect((wb?.work ?? wb)?.acceptedFromIdeaId ?? null).toBe(idea.id);

        // Provenance: the authoritative idea_works link carries both ids.
        const links = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/works`, {
            headers: authedHeaders(token),
        });
        expect(links.status()).toBe(200);
        const { links: rows } = (await links.json()) as {
            links: Array<{ ideaId: string; workId: string; kind: string }>;
        };
        expect(rows.map((l) => l.workId)).toContain(work.id);
        const link = rows.find((l) => l.workId === work.id)!;
        expect(link.ideaId).toBe(idea.id);
        expect(link.kind).toBe('linked');
    });

    test('a Task scopes to each chain node, and the mission/idea/work trio is mutually exclusive', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        const missionTask = await createTask(request, token, {
            title: `MT ${stamp()}`,
            missionId: mission.id,
        });
        expect(missionTask.slug).toMatch(/^T-\d+$/);
        expect(missionTask.status).toBe('backlog');
        expect(missionTask.priority).toBe('p3');
        expect(missionTask.missionId).toBe(mission.id);
        expect(missionTask.ideaId).toBeNull();
        expect(missionTask.workId).toBeNull();

        const ideaTask = await createTask(request, token, {
            title: `IT ${stamp()}`,
            ideaId: idea.id,
        });
        expect(ideaTask.ideaId).toBe(idea.id);
        expect(ideaTask.missionId).toBeNull();
        expect(ideaTask.workId).toBeNull();

        const workTask = await createTask(request, token, { title: `WT ${stamp()}`, workId });
        expect(workTask.workId).toBe(workId);
        expect(workTask.missionId).toBeNull();
        expect(workTask.ideaId).toBeNull();

        // Any PAIR of scope ids is rejected — a Task belongs to at most one node.
        for (const combo of [
            { missionId: mission.id, ideaId: idea.id },
            { missionId: mission.id, workId },
            { ideaId: idea.id, workId },
        ]) {
            const res = await request.post(`${API_BASE}/api/tasks`, {
                headers: authedHeaders(token),
                data: { title: `both ${stamp()}`, ...combo },
            });
            expect(res.status()).toBe(400);
            expect(msgOf(await res.json())).toMatch(/exactly zero or one/i);
        }
    });
});

test.describe('Chain projected onto scoped list filters', () => {
    test('tasks ?missionId / ?ideaId / ?workId partition the chain EXACTLY (no cross-scope leak)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        const mt = await createTask(request, token, {
            title: `MT ${stamp()}`,
            missionId: mission.id,
        });
        const it = await createTask(request, token, { title: `IT ${stamp()}`, ideaId: idea.id });
        const wt = await createTask(request, token, { title: `WT ${stamp()}`, workId });
        const unscoped = await createTask(request, token, { title: `US ${stamp()}` });

        const byMission = await listTaskIds(request, token, `missionId=${mission.id}`);
        expect(byMission.ids).toContain(mt.id);
        expect(byMission.ids).not.toContain(it.id);
        expect(byMission.ids).not.toContain(wt.id);
        expect(byMission.ids).not.toContain(unscoped.id);

        const byIdea = await listTaskIds(request, token, `ideaId=${idea.id}`);
        expect(byIdea.ids).toEqual([it.id]);

        const byWork = await listTaskIds(request, token, `workId=${workId}`);
        expect(byWork.ids).toEqual([wt.id]);

        // An unknown-but-valid scope id → empty page (never a 4xx); malformed → 400.
        const unknown = await listTaskIds(request, token, `workId=${UNKNOWN_UUID}`);
        expect(unknown.status).toBe(200);
        expect(unknown.ids).toEqual([]);
        const malformed = await request.get(`${API_BASE}/api/tasks?workId=not-a-uuid`, {
            headers: authedHeaders(token),
        });
        expect(malformed.status()).toBe(400);
    });

    test('agents ?missionId / ?ideaId / ?workId partition the chain EXACTLY (filters AND independently)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        const ma = await createAgent(request, token, {
            scope: 'mission',
            missionId: mission.id,
            name: `MA ${stamp()}`,
        });
        const ia = await createAgent(request, token, {
            scope: 'idea',
            ideaId: idea.id,
            name: `IA ${stamp()}`,
        });
        const wa = await createAgent(request, token, {
            scope: 'work',
            workId,
            name: `WA ${stamp()}`,
        });
        expect(ma.status).toBe('draft');
        expect(ma.scope).toBe('mission');
        expect(ma.missionId).toBe(mission.id);
        expect(ia.ideaId).toBe(idea.id);
        expect(wa.workId).toBe(workId);

        expect((await listAgentIds(request, token, `missionId=${mission.id}`)).ids).toEqual([
            ma.id,
        ]);
        expect((await listAgentIds(request, token, `ideaId=${idea.id}`)).ids).toEqual([ia.id]);
        expect((await listAgentIds(request, token, `workId=${workId}`)).ids).toEqual([wa.id]);

        // The predicates AND independently: a work-scoped row's missionId is null,
        // so ?scope=work&missionId can never match — always empty.
        expect(
            (await listAgentIds(request, token, `scope=work&missionId=${mission.id}`)).ids,
        ).toEqual([]);

        // Malformed filter id / bad enum → 400.
        expect(
            (
                await request.get(`${API_BASE}/api/agents?ideaId=not-a-uuid`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/agents?scope=galaxy`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(400);
    });

    test('cross-surface projection: one workId resolves to exactly one Task, one Agent, one provenance link, and one Mission edge', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        const workTask = await createTask(request, token, { title: `WT ${stamp()}`, workId });
        const workAgent = await createAgent(request, token, {
            scope: 'work',
            workId,
            name: `WA ${stamp()}`,
        });
        // Close the loop so the reverse Mission lookup has an edge to find.
        const attach = await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
            data: { workId, relation: 'created' },
        });
        expect(attach.status()).toBe(201);

        // The SAME workId, four subsystems, four coherent single-row answers.
        expect((await listTaskIds(request, token, `workId=${workId}`)).ids).toEqual([workTask.id]);
        expect((await listAgentIds(request, token, `workId=${workId}`)).ids).toEqual([
            workAgent.id,
        ]);

        const links = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/works`, {
            headers: authedHeaders(token),
        });
        const { links: linkRows } = (await links.json()) as { links: Array<{ workId: string }> };
        expect(linkRows.map((l) => l.workId)).toEqual([workId]);

        const reverse = await request.get(`${API_BASE}/api/me/missions/related-to-work/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(reverse.status()).toBe(200);
        const { relations } = (await reverse.json()) as {
            relations: Array<{ missionId: string; relation: string }>;
        };
        expect(relations.map((r) => r.missionId)).toEqual([mission.id]);
        expect(relations[0].relation).toBe('created');
    });

    test('the manual Idea stays unlinked (missionId null) — the ?missionId IDEA filter never sees it, even after accept, while the Task/Agent mission filters DO see the mission node', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        // Same missionId, THREE surfaces, THREE different truths:
        // (1) work-proposals ?missionId — the accepted Idea is unlinked, so it
        //     never appears in the Mission's Idea scope (default OR accepted).
        for (const statusQuery of ['', '&statuses=accepted']) {
            const scoped = await request.get(
                `${API_BASE}/api/me/work-proposals?missionId=${mission.id}${statusQuery}`,
                { headers: authedHeaders(token) },
            );
            expect(scoped.status()).toBe(200);
            expect((await scoped.json()).map((r: { id: string }) => r.id)).not.toContain(idea.id);
        }
        // The accepted Idea round-trips its missionId as null.
        expect((await readIdea(request, token, idea.id)).missionId).toBeNull();

        // (2) tasks ?missionId and (3) agents ?missionId DO surface the mission node.
        const mt = await createTask(request, token, {
            title: `MT ${stamp()}`,
            missionId: mission.id,
        });
        const ma = await createAgent(request, token, {
            scope: 'mission',
            missionId: mission.id,
            name: `MA ${stamp()}`,
        });
        expect((await listTaskIds(request, token, `missionId=${mission.id}`)).ids).toContain(mt.id);
        expect((await listAgentIds(request, token, `missionId=${mission.id}`)).ids).toContain(
            ma.id,
        );

        // A malformed ?missionId on the Idea filter is a 400 (@IsUUID); an
        // unknown-but-valid one is an empty page.
        expect(
            (
                await request.get(`${API_BASE}/api/me/work-proposals?missionId=not-a-uuid`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(400);
        const emptyScope = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${UNKNOWN_UUID}`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(emptyScope.status()).toBe(200);
        expect((await emptyScope.json()).length).toBe(0);
    });
});

test.describe('Chain-node creation guards (scope ↔ parent)', () => {
    test('an Agent scope demands its matching parent id (and only it)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        // scope=work with NO workId.
        const noParent = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: { scope: 'work', name: `NP ${stamp()}` },
        });
        expect(noParent.status()).toBe(400);
        expect(msgOf(await noParent.json())).toMatch(/work-scoped agents require workid/i);

        // scope=mission but a workId supplied → the WRONG parent for the scope.
        const missionWantsMission = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: { scope: 'mission', workId, name: `MM ${stamp()}` },
        });
        expect(missionWantsMission.status()).toBe(400);
        expect(msgOf(await missionWantsMission.json())).toMatch(
            /mission-scoped agents require missionid/i,
        );

        // scope=idea but a missionId supplied.
        const ideaWantsIdea = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: { scope: 'idea', missionId: mission.id, name: `II ${stamp()}` },
        });
        expect(ideaWantsIdea.status()).toBe(400);
        expect(msgOf(await ideaWantsIdea.json())).toMatch(/idea-scoped agents require ideaid/i);

        // Control: the correctly-scoped agent lands (201) for each real parent.
        expect(
            (
                await createAgent(request, token, {
                    scope: 'idea',
                    ideaId: idea.id,
                    name: `OK ${stamp()}`,
                })
            ).scope,
        ).toBe('idea');
    });

    test('a chain node parent must be REAL and OWNED — and Task-create (400) vs Agent-create (404) disagree on the status', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const foreignWork = await createWorkViaAPI(request, stranger.access_token, {
            name: `Foreign Work ${stamp()}`,
        });

        // ── Agent-create: unknown/foreign parent → 404 "…not found." ────────
        const agentGhost = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(owner.access_token),
            data: { scope: 'work', workId: UNKNOWN_UUID, name: `Ghost ${stamp()}` },
        });
        expect(agentGhost.status()).toBe(404);
        expect(msgOf(await agentGhost.json())).toMatch(/work .* not found/i);

        const agentForeign = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(owner.access_token),
            data: { scope: 'work', workId: foreignWork.id, name: `Foreign ${stamp()}` },
        });
        // Foreign and unknown are INDISTINGUISHABLE (same 404, no existence leak).
        expect(agentForeign.status()).toBe(404);
        expect(msgOf(await agentForeign.json())).toMatch(/work .* not found/i);

        // ── Task-create: same class of failure, but the API answers 400 here.
        const taskGhost = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(owner.access_token),
            data: { title: `Ghost ${stamp()}`, workId: UNKNOWN_UUID },
        });
        expect(taskGhost.status()).toBe(400);
        expect(msgOf(await taskGhost.json())).toMatch(/work .* not found/i);

        const taskForeign = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(owner.access_token),
            data: { title: `Foreign ${stamp()}`, workId: foreignWork.id },
        });
        expect(taskForeign.status()).toBe(400);

        // Missing title is a plain 400 too.
        const noTitle = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(owner.access_token),
            data: { workId: foreignWork.id },
        });
        expect(noTitle.status()).toBe(400);
    });
});

test.describe('Budget envelopes across the chain', () => {
    test('Mission + Idea budgets share the calendar-month OwnerBudgetSummary envelope (only ownerType differs)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea } = await buildChain(request, token);

        const missionBudget = await request.get(
            `${API_BASE}/api/me/missions/${mission.id}/budget`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(missionBudget.status()).toBe(200);
        const mb = (await missionBudget.json()) as OwnerBudget;

        const ideaBudget = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/budget`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(ideaBudget.status()).toBe(200);
        const ib = (await ideaBudget.json()) as OwnerBudget;

        // The ownerType is the ONLY field that distinguishes them; both share the
        // fresh calendar-month envelope (nothing spent, no cap, not blocked).
        expect(mb.ownerType).toBe('mission');
        expect(mb.ownerId).toBe(mission.id);
        expect(ib.ownerType).toBe('idea');
        expect(ib.ownerId).toBe(idea.id);
        for (const b of [mb, ib]) {
            expect(Date.parse(b.periodStart)).toBeLessThan(Date.parse(b.periodEnd));
            expect(b.currentSpendCents).toBe(0);
            expect(b.capCents).toBeNull();
            expect(b.currency).toBe('usd');
            expect(b.percentUsed).toBeNull();
            expect(b.allowOverage).toBe(true);
            expect(b.blocked).toBe(false);
        }
    });

    test('a chain-scoped Agent exposes a rolling-30-day spend rollup — a DIFFERENT shape from the owner envelope (currency UPPERCASE)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { workId } = await buildChain(request, token);
        const agent = await createAgent(request, token, {
            scope: 'work',
            workId,
            name: `WA ${stamp()}`,
        });

        const res = await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const b = (await res.json()) as {
            currentSpendCents: number;
            capCents: number | null;
            periodStart: string;
            periodEnd: string;
            currency: string;
            ownerType?: string;
        };
        expect(b.currentSpendCents).toBe(0);
        expect(b.capCents).toBeNull();
        expect(Date.parse(b.periodStart)).toBeLessThan(Date.parse(b.periodEnd));
        // The Agent rollup is the rolling-30-day view and uses UPPERCASE 'USD'
        // (vs the owner envelope's lowercase 'usd'); it carries NO ownerType.
        expect(b.currency).toBe('USD');
        expect(b.ownerType).toBeUndefined();
    });

    test('budgets are ownership-gated across every chain node (stranger → 404, anon → 401)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { mission, idea, workId } = await buildChain(request, owner.access_token);
        const agent = await createAgent(request, owner.access_token, {
            scope: 'work',
            workId,
            name: `WA ${stamp()}`,
        });

        const strangerHeaders = authedHeaders(stranger.access_token);
        // Mission budget — the getForUser gate 404s before summarizing spend.
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${mission.id}/budget`, {
                    headers: strangerHeaders,
                })
            ).status(),
        ).toBe(404);
        // Idea budget — uniform "Proposal not found" 404 (no per-Idea spend leak).
        const strangerIdea = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/budget`,
            {
                headers: strangerHeaders,
            },
        );
        expect(strangerIdea.status()).toBe(404);
        expect(msgOf(await strangerIdea.json())).toMatch(/proposal not found/i);
        // Agent budget — cross-user 404.
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, {
                    headers: strangerHeaders,
                })
            ).status(),
        ).toBe(404);

        // Anonymous → 401 on each.
        expect(
            (await request.get(`${API_BASE}/api/me/missions/${mission.id}/budget`)).status(),
        ).toBe(401);
        expect(
            (await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`)).status(),
        ).toBe(401);
        expect((await request.get(`${API_BASE}/api/agents/${agent.id}/budget`)).status()).toBe(401);
    });
});

test.describe('Mission tick + agent task-assignment within the chain', () => {
    test('run-now ticks the Mission, echoes its id with a known outcome; anon 401; unknown 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission } = await buildChain(request, token);

        const run = await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`, {
            headers: authedHeaders(token),
        });
        expect(run.status(), `run-now body=${await run.text().catch(() => '')}`).toBe(200);
        const body = (await run.json()) as { status: string; missionId: string; message?: string };
        expect(body.missionId).toBe(mission.id);
        // Keyless (no Work-Agent profile) → 'no-ideas'; assert the truthful enum.
        expect([
            'noop-placeholder',
            'queued',
            'spawned',
            'cap-hit',
            'no-ideas',
            'failed',
            'cron-no-match',
        ]).toContain(body.status);

        // Anonymous → 401; an unknown Mission id → 404 "Mission not found".
        expect(
            (await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`)).status(),
        ).toBe(401);
        const unknown = await request.post(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/run-now`, {
            headers: authedHeaders(token),
        });
        expect(unknown.status()).toBe(404);
        expect(msgOf(await unknown.json())).toMatch(/mission not found/i);
    });

    test('assigning a chain Task to a chain Agent persists an AgentRun even when the enqueue is unbound; cross-user assign → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const token = owner.access_token;
        const { workId } = await buildChain(request, token);
        const agent = await createAgent(request, token, {
            scope: 'work',
            workId,
            name: `WA ${stamp()}`,
        });
        const task = await createTask(request, token, { title: `WT ${stamp()}`, workId });

        // Keyless stack: the HTTP layer 500s (Trigger.dev unbound) but a run row
        // is still persisted. Tolerate a 202 in case a real adapter is present.
        const assign = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: authedHeaders(token),
            data: { taskId: task.id },
        });
        expect([202, 500]).toContain(assign.status());

        // The AgentRun record is the truthful assertion — not successful completion.
        const runs = await listAgentRuns(request, token, agent.id);
        const taskRun = runs.find((r) => r.taskId === task.id);
        expect(taskRun, 'an AgentRun for the chain Task must persist').toBeTruthy();
        expect(taskRun!.triggerKind).toBe('task');
        expect(['failed', 'queued', 'running', 'completed']).toContain(taskRun!.status);

        // A stranger cannot assign against the owner's Agent → 404 (no leak).
        const crossTask = await createTask(request, token, { title: `XT ${stamp()}`, workId });
        const cross = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: authedHeaders(stranger.access_token),
            data: { taskId: crossTask.id },
        });
        expect(cross.status()).toBe(404);
    });
});

test.describe('Whole-chain isolation', () => {
    test('every chain node is walled off from a stranger, and the stranger’s scoped filters never surface the chain', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const token = owner.access_token;
        const { mission, idea, workId } = await buildChain(request, token);
        const task = await createTask(request, token, { title: `WT ${stamp()}`, workId });
        const agent = await createAgent(request, token, {
            scope: 'work',
            workId,
            name: `WA ${stamp()}`,
        });

        const s = authedHeaders(stranger.access_token);
        // Mission / Idea / Task / Agent all 404 (the uniform no-existence-leak
        // posture). The Work read is the ONE node that answers 403 instead —
        // pinned tolerantly since both are ownership rejections.
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${mission.id}`, { headers: s })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, { headers: s })
            ).status(),
        ).toBe(404);
        expect(
            (await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers: s })).status(),
        ).toBe(404);
        expect(
            (await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers: s })).status(),
        ).toBe(404);
        const workRead = await request.get(`${API_BASE}/api/works/${workId}`, { headers: s });
        expect([403, 404]).toContain(workRead.status());

        // The stranger's own scoped filters, run against the chain's ids, are empty.
        expect((await listTaskIds(request, stranger.access_token, `workId=${workId}`)).ids).toEqual(
            [],
        );
        expect(
            (await listAgentIds(request, stranger.access_token, `workId=${workId}`)).ids,
        ).toEqual([]);

        // Unauthenticated list → 401.
        expect((await request.get(`${API_BASE}/api/me/missions`)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/agents`)).status()).toBe(401);
    });

    test('a stranger cannot MUTATE any hop of the chain', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { mission, idea, workId } = await buildChain(request, owner.access_token);
        const s = authedHeaders(stranger.access_token);

        // Accept the owner's Idea against a Work the stranger controls → 404.
        const strangerWork = await createWorkViaAPI(request, stranger.access_token, {
            name: `Stranger Work ${stamp()}`,
        });
        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers: s,
            data: { workId: strangerWork.id },
        });
        expect(accept.status()).toBe(404);

        // Attach the owner's Work to the stranger's OWN mission → 404 (foreign Work).
        const strangerMission = await createMission(request, stranger.access_token);
        const attach = await request.post(
            `${API_BASE}/api/me/missions/${strangerMission.id}/works`,
            {
                headers: s,
                data: { workId, relation: 'created' },
            },
        );
        expect(attach.status()).toBe(404);

        // Run-now the owner's Mission → 404.
        expect(
            (
                await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`, {
                    headers: s,
                })
            ).status(),
        ).toBe(404);

        // Spawn a work-scoped Agent on the owner's Work → 404 (foreign parent).
        const agent = await request.post(`${API_BASE}/api/agents`, {
            headers: s,
            data: { scope: 'work', workId, name: `Hijack ${stamp()}` },
        });
        expect(agent.status()).toBe(404);

        // None of the above mutated the owner's chain: the Idea stays in the
        // state buildChain left it (it was already accepted to mint `workId`),
        // proving the stranger's failed writes changed nothing.
        expect((await readIdea(request, owner.access_token, idea.id)).status).toBe('accepted');
    });
});

test.describe('Mission ↔ Work loop closure', () => {
    test('the accepted Work rejoins its origin Mission with the "created" relation; both directions agree and it detaches cleanly', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, workId } = await buildChain(request, token);

        // The Mission starts with no Work relations.
        const before = await request.get(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
        });
        expect(before.status()).toBe(200);
        expect((await before.json()).relations).toHaveLength(0);

        // Attach the born-from-Idea Work under the 'created' provenance relation.
        const attach = await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
            data: { workId, relation: 'created' },
        });
        expect(attach.status()).toBe(201);
        const attached = (await attach.json()).relations as Array<{
            workId: string;
            relation: string;
            workName: string | null;
        }>;
        expect(attached).toHaveLength(1);
        expect(attached[0].workId).toBe(workId);
        expect(attached[0].relation).toBe('created');
        expect(typeof attached[0].workName).toBe('string');

        // The reverse lookup agrees — the Work knows its Mission.
        const reverse = await request.get(`${API_BASE}/api/me/missions/related-to-work/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(reverse.status()).toBe(200);
        const { relations } = (await reverse.json()) as {
            relations: Array<{ missionId: string; relation: string; missionStatus: string | null }>;
        };
        expect(relations.map((r) => r.missionId)).toContain(mission.id);
        expect(relations.find((r) => r.missionId === mission.id)!.relation).toBe('created');

        // Detach → {deleted:true}, and the forward list empties.
        const detach = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/works/${workId}/created`,
            { headers: authedHeaders(token) },
        );
        expect(detach.status()).toBe(200);
        expect(await detach.json()).toEqual({ deleted: true });
        const after = await request.get(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
        });
        expect((await after.json()).relations).toHaveLength(0);
    });

    test('deleting the origin Mission leaves the born-from-Idea Work AND its Idea→Work provenance intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, idea, workId } = await buildChain(request, token);

        // Attach the Work to the Mission so the delete has an edge to cascade.
        expect(
            (
                await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
                    headers: authedHeaders(token),
                    data: { workId, relation: 'created' },
                })
            ).status(),
        ).toBe(201);

        // Delete the Mission (allowed from any status).
        const del = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);

        // The Work survives (Missions never own Works) …
        expect(
            (
                await request.get(`${API_BASE}/api/works/${workId}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(200);
        // … the Idea is still ACCEPTED with its acceptedWorkId pointer …
        const ideaAfter = await readIdea(request, token, idea.id);
        expect(ideaAfter.status).toBe('accepted');
        expect(ideaAfter.acceptedWorkId).toBe(workId);
        // … and the idea_works provenance link is untouched by the Mission delete
        // (a separate table from the cascaded mission_works edge).
        const links = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/works`, {
            headers: authedHeaders(token),
        });
        expect(links.status()).toBe(200);
        const { links: rows } = (await links.json()) as { links: Array<{ workId: string }> };
        expect(rows.map((l) => l.workId)).toContain(workId);
    });
});
