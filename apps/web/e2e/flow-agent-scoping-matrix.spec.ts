import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createAgentViaAPI, type Agent } from './helpers/agents-tasks';

/**
 * Agent scoping matrix — deep, multi-entity coverage of the four Agent
 * scopes (tenant / mission / idea / work) and the scope-cascade rules the
 * Agents API (PR #1017, FU-2) really enforces.
 *
 * Every shape below was probed against the LIVE API (sqlite in-memory, the
 * same driver CI uses) before any assertion was written:
 *
 *   POST /api/agents { scope, name, missionId?, ideaId?, workId? } → 201 AgentDto
 *     - scope:'tenant'  → must carry NO parent id (missionId/ideaId/workId).
 *         A parent id ⇒ 400 "Tenant-scoped Agents must not have
 *         missionId/ideaId/workId."
 *     - scope:'mission' → requires (and only) missionId; else 400
 *         "Mission-scoped Agents require missionId (and only missionId)."
 *     - scope:'idea'    → requires (and only) ideaId; else 400
 *         "Idea-scoped Agents require ideaId (and only ideaId)."
 *     - scope:'work'    → requires (and only) workId; else 400
 *         "Work-scoped Agents require workId (and only workId)."
 *     New Agents are born status:'draft'.
 *
 *   GET /api/agents?scope=<s>&<parent>Id=<id> → { data: AgentDto[], meta }.
 *     The repo ANDs each filter field independently and excludes archived
 *     rows. A scoped filter returns ONLY the matching-scope/parent agents
 *     and never leaks a sibling scope's agent.
 *
 *   Lifecycle (USER_TRANSITIONS in agents.service.ts):
 *     draft → active | archived          (so pause-from-draft ⇒ 400)
 *     active ⇄ paused                     (active→paused, paused→active)
 *     POST /api/agents/:id/pause  : active → paused
 *     POST /api/agents/:id/resume : draft/paused/error → active
 *     An illegal hop ⇒ 400 "Cannot transition Agent from <from> to <to>."
 *
 *   Cross-user reads/writes return 404 (NOT 403) — architecture/security §9
 *     forbids leaking another user's Agent's existence.
 *
 * Parent entities are created via their real endpoints (verified shapes):
 *   POST /api/me/missions        { title, description, type:'one-shot' } → 201 { id, status:'active' }
 *   POST /api/me/work-proposals  { description }                        → 201 { id, status:'pending', source:'user-manual' } (the "Idea")
 *   POST /api/works              (via createWorkViaAPI)                  → { work:{ id } }
 *
 * Isolation: all mutations run on FRESH registerUserViaAPI() users (never
 * the shared seeded user) so the in-memory DB stays clean for sibling
 * specs, and assertions tolerate pre-existing rows (toContain / scoped
 * filters), never exact global counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a Mission and return its id (verified shape). */
async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'agent-scoping-matrix probe', type: 'one-shot' },
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    return body.id as string;
}

/** Create an Idea (user-manual work-proposal) and return its id. */
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
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.source).toBe('user-manual');
    return body.id as string;
}

/** Raw create-agent POST so we can assert non-2xx statuses + messages. */
async function rawCreateAgent(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/agents`, { headers: authedHeaders(token), data });
}

/** GET /api/agents with an arbitrary query string. Returns parsed list page. */
async function listAgents(
    request: APIRequestContext,
    token: string,
    query: string,
): Promise<{ data: Agent[]; meta: { total: number; limit: number; offset: number } }> {
    const res = await request.get(`${API_BASE}/api/agents${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text()}`).toBe(200);
    return res.json();
}

test.describe('Agent scoping matrix', () => {
    test('scope-cascade: each scope requires its parent id and is isolated by the scope filter', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = stamp();

        // ── Build the four parents (tenant has none) ──────────────────────
        const missionId = await createMission(request, token, `Scope Mission ${s}`);
        const ideaId = await createIdea(request, token, `Scope Idea ${s} — a directory of tools`);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Scope Work ${s}`,
            slug: `scope-work-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        // ── 1a. Each non-tenant scope REQUIRES its parent id (400 without) ─
        const missingMission = await rawCreateAgent(request, token, {
            scope: 'mission',
            name: `Mission Agent ${s}`,
        });
        expect(missingMission.status()).toBe(400);
        expect((await missingMission.json()).message).toBe(
            'Mission-scoped Agents require missionId (and only missionId).',
        );

        const missingIdea = await rawCreateAgent(request, token, {
            scope: 'idea',
            name: `Idea Agent ${s}`,
        });
        expect(missingIdea.status()).toBe(400);
        expect((await missingIdea.json()).message).toBe(
            'Idea-scoped Agents require ideaId (and only ideaId).',
        );

        const missingWork = await rawCreateAgent(request, token, {
            scope: 'work',
            name: `Work Agent ${s}`,
        });
        expect(missingWork.status()).toBe(400);
        expect((await missingWork.json()).message).toBe(
            'Work-scoped Agents require workId (and only workId).',
        );

        // A tenant-scoped Agent must carry NO parent id — passing one is a 400.
        const tenantWithParent = await rawCreateAgent(request, token, {
            scope: 'tenant',
            name: `Bad Tenant Agent ${s}`,
            missionId,
        });
        expect(tenantWithParent.status()).toBe(400);
        expect((await tenantWithParent.json()).message).toBe(
            'Tenant-scoped Agents must not have missionId/ideaId/workId.',
        );

        // ── 1b. Create one Agent at every scope (all start status:'draft') ─
        const tenantAgent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Tenant Agent ${s}`,
        });
        expect(tenantAgent.scope).toBe('tenant');
        expect(tenantAgent.status).toBe('draft');

        const missionAgent = await createAgentViaAPI(request, token, {
            scope: 'mission',
            name: `Mission Agent ${s}`,
            missionId,
        });
        expect(missionAgent.scope).toBe('mission');
        // The parent linkage round-trips on the DTO.
        const missionAgentFull = await (
            await request.get(`${API_BASE}/api/agents/${missionAgent.id}`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(missionAgentFull.missionId).toBe(missionId);
        expect(missionAgentFull.ideaId).toBeNull();
        expect(missionAgentFull.workId).toBeNull();

        const ideaAgent = await createAgentViaAPI(request, token, {
            scope: 'idea',
            name: `Idea Agent ${s}`,
            ideaId,
        });
        expect(ideaAgent.scope).toBe('idea');

        const workAgent = await createAgentViaAPI(request, token, {
            scope: 'work',
            name: `Work Agent ${s}`,
            workId,
        });
        expect(workAgent.scope).toBe('work');

        const allIds = [tenantAgent.id, missionAgent.id, ideaAgent.id, workAgent.id];
        expect(new Set(allIds).size).toBe(4); // distinct rows

        // ── 1c. The scope filter returns ONLY that scope's agent ──────────
        const byTenant = await listAgents(request, token, '?scope=tenant');
        const tenantIds = byTenant.data.map((a) => a.id);
        expect(tenantIds).toContain(tenantAgent.id);
        expect(tenantIds).not.toContain(missionAgent.id);
        expect(tenantIds).not.toContain(ideaAgent.id);
        expect(tenantIds).not.toContain(workAgent.id);
        // A tenant-scoped row carries no parent ⇒ scope=tenant rows are all tenant.
        expect(byTenant.data.every((a) => a.scope === 'tenant')).toBe(true);

        const byMission = await listAgents(request, token, `?scope=mission&missionId=${missionId}`);
        expect(byMission.data.map((a) => a.id)).toEqual([missionAgent.id]);
        expect(byMission.meta.total).toBe(1);

        const byIdea = await listAgents(request, token, `?scope=idea&ideaId=${ideaId}`);
        expect(byIdea.data.map((a) => a.id)).toEqual([ideaAgent.id]);
        expect(byIdea.meta.total).toBe(1);

        const byWork = await listAgents(request, token, `?scope=work&workId=${workId}`);
        expect(byWork.data.map((a) => a.id)).toEqual([workAgent.id]);
        expect(byWork.meta.total).toBe(1);

        // The unfiltered list contains all four (tolerate any extra rows).
        const all = await listAgents(request, token, '');
        const allListIds = all.data.map((a) => a.id);
        for (const id of allIds) expect(allListIds).toContain(id);

        // A scoped filter with an unknown parent id is an empty page, not a 4xx.
        const byUnknownMission = await listAgents(
            request,
            token,
            `?scope=mission&missionId=${UNKNOWN_UUID}`,
        );
        expect(byUnknownMission.data.length).toBe(0);
        expect(byUnknownMission.meta.total).toBe(0);
    });

    test('lifecycle across scopes: a draft work-scoped agent cannot pause, then resume⇄pause cycles', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Lifecycle Work ${s}`,
            slug: `lifecycle-work-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        const agent = await createAgentViaAPI(request, token, {
            scope: 'work',
            name: `Lifecycle Agent ${s}`,
            workId,
        });
        expect(agent.status).toBe('draft');

        const pauseUrl = `${API_BASE}/api/agents/${agent.id}/pause`;
        const resumeUrl = `${API_BASE}/api/agents/${agent.id}/resume`;

        // draft → pause is an illegal hop (USER_TRANSITIONS[draft] = [active, archived]).
        const illegalPause = await request.post(pauseUrl, { headers });
        expect(illegalPause.status()).toBe(400);
        expect((await illegalPause.json()).message).toBe(
            'Cannot transition Agent from draft to paused.',
        );

        // Status unchanged after the rejected transition.
        const stillDraft = await (
            await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers })
        ).json();
        expect(stillDraft.status).toBe('draft');

        // resume: draft → active
        const resumed1 = await request.post(resumeUrl, { headers });
        expect(resumed1.status(), `resume body=${await resumed1.text()}`).toBe(200);
        expect((await resumed1.json()).status).toBe('active');

        // pause: active → paused
        const paused = await request.post(pauseUrl, { headers });
        expect(paused.status(), `pause body=${await paused.text()}`).toBe(200);
        expect((await paused.json()).status).toBe('paused');

        // resume: paused → active
        const resumed2 = await request.post(resumeUrl, { headers });
        expect(resumed2.status()).toBe(200);
        expect((await resumed2.json()).status).toBe('active');

        // The persisted row reflects the final state.
        const finalGet = await (
            await request.get(`${API_BASE}/api/agents/${agent.id}`, { headers })
        ).json();
        expect(finalGet.status).toBe('active');

        // Sanity: an active agent re-resumed is an illegal hop
        // (USER_TRANSITIONS[active] = [paused, archived]) ⇒ 400.
        const illegalResume = await request.post(resumeUrl, { headers });
        expect(illegalResume.status()).toBe(400);
        expect((await illegalResume.json()).message).toBe(
            'Cannot transition Agent from active to active.',
        );
    });

    test('cross-scope + cross-user isolation: mission filters never bleed, foreign agent is 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        // Two distinct Missions, each with its own mission-scoped Agent.
        const missionAId = await createMission(request, token, `Iso Mission A ${s}`);
        const missionBId = await createMission(request, token, `Iso Mission B ${s}`);

        const agentA = await createAgentViaAPI(request, token, {
            scope: 'mission',
            name: `Iso Agent A ${s}`,
            missionId: missionAId,
        });
        const agentB = await createAgentViaAPI(request, token, {
            scope: 'mission',
            name: `Iso Agent B ${s}`,
            missionId: missionBId,
        });

        // Filtering by Mission A returns only agentA — agentB never bleeds in.
        const byA = await listAgents(request, token, `?scope=mission&missionId=${missionAId}`);
        expect(byA.data.map((a) => a.id)).toEqual([agentA.id]);
        expect(byA.data.map((a) => a.id)).not.toContain(agentB.id);

        // …and vice-versa.
        const byB = await listAgents(request, token, `?scope=mission&missionId=${missionBId}`);
        expect(byB.data.map((a) => a.id)).toEqual([agentB.id]);
        expect(byB.data.map((a) => a.id)).not.toContain(agentA.id);

        // ── Cross-user: a second user cannot see or mutate owner's Agent ──
        const attacker = await registerUserViaAPI(request);
        const atkHeaders = authedHeaders(attacker.access_token);
        const agentUrl = `${API_BASE}/api/agents/${agentA.id}`;

        // GET → 404 (existence is NOT leaked via 403).
        const foreignGet = await request.get(agentUrl, { headers: atkHeaders });
        expect(foreignGet.status()).toBe(404);
        expect((await foreignGet.json()).message).toBe(`Agent ${agentA.id} not found.`);

        // PATCH → 404
        const foreignPatch = await request.patch(agentUrl, {
            headers: atkHeaders,
            data: { title: 'hijacked' },
        });
        expect(foreignPatch.status()).toBe(404);

        // POST /pause → 404 (transition on a foreign agent leaks nothing).
        const foreignPause = await request.post(`${agentUrl}/pause`, { headers: atkHeaders });
        expect(foreignPause.status()).toBe(404);

        // The attacker filtering by owner's Mission id sees an empty page —
        // the filter is also scoped to the caller's userId.
        const attackerView = await listAgents(
            request,
            attacker.access_token,
            `?scope=mission&missionId=${missionAId}`,
        );
        expect(attackerView.meta.total).toBe(0);
        expect(attackerView.data.length).toBe(0);

        // Owner can still read their own Agent (sanity: the 404s above are
        // ownership-scoped, not a deleted/broken row).
        const ownerGet = await request.get(agentUrl, { headers });
        expect(ownerGet.status()).toBe(200);
        expect((await ownerGet.json()).id).toBe(agentA.id);

        // A non-UUID id is a 400 from ParseUUIDPipe (not a 404), and an
        // unknown well-formed UUID is a 404.
        const badId = await request.get(`${API_BASE}/api/agents/not-a-uuid`, { headers });
        expect(badId.status()).toBe(400);
        const unknownId = await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}`, { headers });
        expect(unknownId.status()).toBe(404);
    });
});
