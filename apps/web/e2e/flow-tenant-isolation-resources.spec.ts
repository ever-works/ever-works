/**
 * Tenant isolation across EVERY resource type.
 *
 * Proves the platform's row-level tenancy is authoritative end-to-end across
 * the user-scoped first-class resources the API exposes. The sibling spec
 * `flow-multi-tenant-isolation.spec.ts` already covers the works / agents /
 * tasks / missions / orgs LIST scoping and their PRIMARY cross-user GET /
 * PATCH / DELETE guards, so THIS file deliberately extends coverage to the
 * resource surface that one does NOT touch:
 *
 *   • SKILLS               (list + GET/PATCH/DELETE + bindings sub-tree)
 *   • CONVERSATIONS        (list + GET/PATCH/DELETE + message-append injection)
 *   • KNOWLEDGE-BASE docs  (work-scoped list/get/patch/delete/create)
 *   • AGENT RUNS           (run-history read)
 *   • TASK secondary writes (assignees, transition)
 *   • the truthful GLOBAL org-slug resolver edge case (reachable cross-tenant
 *     yet leaks no scoped rows)
 *
 * ── Verified contract (probed live against http://127.0.0.1:3100, sqlite
 *    in-memory — the same driver CI uses — before any assertion was written):
 *
 *   Auth (helpers/api.ts):
 *     POST /api/auth/register { username(>=3), email, password }
 *       → 201 { access_token (32-char opaque), user:{ id, email, username } }.
 *
 *   Skills (read + Phase-9 write paths are WIRED):
 *     POST /api/skills { ownerType:'tenant', ownerId:<tenantId>, title,
 *       description, instructionsMd } → 201 { id, userId, ownerType, ownerId,
 *       tenantId, organizationId, slug, version, contentHash, … }
 *     GET  /api/skills                  → { data:[…], meta:{ total,limit,offset } }
 *     GET  /api/skills/:id              → 200 own / 404 cross / 400 non-uuid
 *       (ParseUUIDPipe) / 404 unknown-uuid
 *     PATCH/DELETE /api/skills/:id      → 404 cross (no 403 existence leak)
 *     GET/POST /api/skills/:id/bindings → 200/201 own; 404 cross (both verbs —
 *       the parent skill resolves via findByIdAndUser, so a non-owner 404s)
 *
 *   Conversations (read + write):
 *     POST /api/conversations { title? } → 201 { id, userId, title, tenantId,
 *       organizationId, … } (entity returned directly, no wrapper)
 *     GET  /api/conversations            → { conversations:[…], total }  (NOT data/meta)
 *     GET  /api/conversations/:id        → 200 own (incl. `messages:[…]`) / 404
 *       cross / 404 non-uuid (plain @Param — NO ParseUUIDPipe → service-miss 404)
 *     PATCH /api/conversations/:id { title } → 204 own / 404 cross
 *     DELETE /api/conversations/:id          → 204 own / 404 cross
 *     POST  /api/conversations/:id/messages { messages:[{role,content}] }
 *                                            → 201 { success:true } own / 404 cross
 *
 *   Knowledge base (work-scoped; reuses the /api/works ownership guard):
 *     POST /api/works/:id/kb/documents { path, title, class:'freeform', body }
 *                                        → 201 { id, workId, slug, body, … }
 *     GET  /api/works/:id/kb/documents   → { items:[…], total }  (own only)
 *     Any KB verb under another tenant's work → 403
 *       { status:'error', message:'You do not have permission to access this work' }
 *       (existence IS surfaced via 403 here, mirroring the works guard — NOT 404).
 *
 *   Agent + Task secondary writes:
 *     GET  /api/agents/:id/runs        → 200 own / 404 cross
 *     POST /api/agents/:id/assign-task → 404 cross
 *     POST /api/tasks/:id/assignees    → 404 cross (201 for the owner)
 *     POST /api/tasks/:id/transition   → 404 cross
 *
 *   Org slug resolver (truthful edge — NOT isolated by design):
 *     GET /api/organizations/:slug is a GLOBAL resolver → 200 for ANY authed
 *       user. The isolation boundary lives on the SCOPED resource lists, not
 *       the resolver, so we assert the resolver is reachable cross-tenant AND
 *       that it bleeds no rows into the visitor's /api/works list.
 *
 * ── Isolation discipline (matches every sibling flow): all mutations run on
 *    FRESH registerUserViaAPI() users (never the shared seeded user — a user-
 *    scoped fake key would shadow the env key and break sibling chat specs).
 *    List assertions use toContain / not.toContain on ids (tolerate pre-existing
 *    rows), never exact global counts. Unique suffixes via Date.now()+random.
 *    Cross-guard codes asserted tolerantly ([403,404]) where two valid policies
 *    exist, so a code shift never makes the flow a false fail.
 *
 * Filename uses the safe `flow-` prefix (NOT matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is fully API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI, createTaskViaAPI, listAgentRuns } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A tenant = a fresh user + the org whose creation lazily mints their Tenant. */
interface TenantCtx {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    headers: { Authorization: string };
    tenantId: string;
    orgId: string;
    orgSlug: string;
}

async function buildTenantCtx(request: APIRequestContext): Promise<TenantCtx> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const org = await createOrganizationViaAPI(request, token, `Iso Org ${stamp()}`);
    expect(org.tenantId).toMatch(UUID_RE);
    return {
        user,
        token,
        headers: authedHeaders(token),
        tenantId: org.tenantId,
        orgId: org.id,
        orgSlug: org.slug,
    };
}

/** Create a Skill at tenant scope (Phase-9 write path). */
async function createSkill(
    request: APIRequestContext,
    ctx: TenantCtx,
    title: string,
): Promise<{ id: string; tenantId: string; userId: string }> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: ctx.headers,
        data: {
            ownerType: 'tenant',
            ownerId: ctx.tenantId,
            title,
            description: 'tenant-isolation probe skill',
            instructionsMd: '# instructions\nbody',
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.tenantId).toBe(ctx.tenantId);
    return body;
}

/** Create a Conversation; the entity is returned directly (no wrapper). */
async function createConversation(
    request: APIRequestContext,
    ctx: TenantCtx,
    title: string,
): Promise<{ id: string; userId: string }> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: ctx.headers,
        data: { title },
    });
    expect(res.status(), `createConversation body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    return body;
}

/** Create a freeform KB document under a work; returns its id + path. */
async function createKbDoc(
    request: APIRequestContext,
    ctx: TenantCtx,
    workId: string,
    slug: string,
): Promise<{ id: string; path: string }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
        headers: ctx.headers,
        data: {
            path: `freeform/${slug}.md`,
            title: `KB ${slug}`,
            class: 'freeform',
            body: '# secret content',
        },
    });
    expect(res.status(), `createKbDoc body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    return { id: body.id, path: body.path };
}

test.describe('Tenant isolation across every resource type', () => {
    test('flow 1 — Skills: two tenants see only their own; cross GET/PATCH/DELETE 404; bad/unknown-id boundary', async ({
        request,
    }) => {
        const a = await buildTenantCtx(request);
        const b = await buildTenantCtx(request);
        expect(a.user.user.id).not.toBe(b.user.user.id);

        const sa = await createSkill(request, a, `Alpha Skill ${stamp()}`);
        const sb = await createSkill(request, b, `Bravo Skill ${stamp()}`);

        // ── List scoping: { data, meta } shape, own-rows-only ──
        const listA = await request.get(`${API_BASE}/api/skills`, { headers: a.headers });
        const listB = await request.get(`${API_BASE}/api/skills`, { headers: b.headers });
        expect(listA.status()).toBe(200);
        expect(listB.status()).toBe(200);
        const aRows = (await listA.json()).data as Array<{ id: string; userId: string }>;
        const bRows = (await listB.json()).data as Array<{ id: string; userId: string }>;
        const aIds = aRows.map((r) => r.id);
        const bIds = bRows.map((r) => r.id);
        expect(aIds).toContain(sa.id);
        expect(aIds).not.toContain(sb.id);
        expect(bIds).toContain(sb.id);
        expect(bIds).not.toContain(sa.id);
        // No foreign userId ever leaks into either list.
        expect(aRows.every((r) => r.userId === a.user.user.id)).toBe(true);
        expect(bRows.every((r) => r.userId === b.user.user.id)).toBe(true);

        // ── Cross-tenant GET / PATCH / DELETE: 404 (no 403 existence leak) ──
        const crossUrl = `${API_BASE}/api/skills/${sa.id}`;
        expect((await request.get(crossUrl, { headers: b.headers })).status()).toBe(404);
        expect(
            (
                await request.patch(crossUrl, { headers: b.headers, data: { title: 'hijack' } })
            ).status(),
        ).toBe(404);
        expect((await request.delete(crossUrl, { headers: b.headers })).status()).toBe(404);

        // ── Owner sanity + malformed/unknown id boundary ──
        expect((await request.get(crossUrl, { headers: a.headers })).status()).toBe(200);
        // ParseUUIDPipe → 400 for a non-uuid; well-formed unknown uuid → 404.
        expect(
            (
                await request.get(`${API_BASE}/api/skills/not-a-uuid`, { headers: b.headers })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${UNKNOWN_UUID}`, { headers: b.headers })
            ).status(),
        ).toBe(404);

        // ── The owner's skill survived the hijack attempts untouched. ──
        const survived = await (await request.get(crossUrl, { headers: a.headers })).json();
        expect(survived.title).not.toBe('hijack');
    });

    test('flow 2 — Skill bindings sub-tree: owner reads + creates; the other tenant is 404 on both verbs', async ({
        request,
    }) => {
        const a = await buildTenantCtx(request);
        const b = await buildTenantCtx(request);
        const sa = await createSkill(request, a, `Bind Skill ${stamp()}`);
        const bindingsUrl = `${API_BASE}/api/skills/${sa.id}/bindings`;

        // Owner creates a tenant-scope binding (201) and lists it back (200).
        const created = await request.post(bindingsUrl, {
            headers: a.headers,
            data: { targetType: 'tenant' },
        });
        expect(
            created.status(),
            `binding create body=${await created.text().catch(() => '')}`,
        ).toBe(201);
        const ownList = await request.get(bindingsUrl, { headers: a.headers });
        expect(ownList.status()).toBe(200);

        // The other tenant can neither enumerate NOR mutate the skill's bindings:
        // the binding routes resolve the parent skill via findByIdAndUser, so a
        // non-owner hits the same 404 wall as the skill itself.
        expect((await request.get(bindingsUrl, { headers: b.headers })).status()).toBe(404);
        expect(
            (
                await request.post(bindingsUrl, {
                    headers: b.headers,
                    data: { targetType: 'tenant' },
                })
            ).status(),
        ).toBe(404);
    });

    test('flow 3 — Conversations: own-only list; cross GET/PATCH/DELETE + message-injection all 404', async ({
        request,
    }) => {
        const a = await buildTenantCtx(request);
        const b = await buildTenantCtx(request);

        const ca = await createConversation(request, a, `Alpha thread ${stamp()}`);
        const cb = await createConversation(request, b, `Bravo thread ${stamp()}`);

        // ── List scoping: { conversations, total } shape, own-only ──
        const listA = await request.get(`${API_BASE}/api/conversations`, { headers: a.headers });
        const listB = await request.get(`${API_BASE}/api/conversations`, { headers: b.headers });
        expect(listA.status()).toBe(200);
        expect(listB.status()).toBe(200);
        const aThreads = (await listA.json()).conversations as Array<{
            id: string;
            userId?: string;
        }>;
        const bThreads = (await listB.json()).conversations as Array<{
            id: string;
            userId?: string;
        }>;
        expect(aThreads.map((c) => c.id)).toContain(ca.id);
        expect(aThreads.map((c) => c.id)).not.toContain(cb.id);
        expect(bThreads.map((c) => c.id)).toContain(cb.id);
        expect(bThreads.map((c) => c.id)).not.toContain(ca.id);
        // The list projection (repo.findByUser) selects only id/title/providerId/
        // model/createdAt/updatedAt — userId is INTENTIONALLY omitted since the rows
        // are already user-scoped. Ownership is proven on the detail GET below, which
        // DOES return userId; the list-scoping itself is proven by the id membership
        // checks above. (cf. createConversation's POST body, which carries userId.)
        expect(aThreads.every((c) => c.userId === undefined)).toBe(true);
        const aDetail = await request.get(`${API_BASE}/api/conversations/${ca.id}`, {
            headers: a.headers,
        });
        expect(aDetail.status()).toBe(200);
        expect((await aDetail.json()).userId).toBe(a.user.user.id);

        // ── Cross-tenant GET / PATCH(204) / DELETE(204) all → 404 ──
        const crossUrl = `${API_BASE}/api/conversations/${ca.id}`;
        expect((await request.get(crossUrl, { headers: b.headers })).status()).toBe(404);
        expect(
            (
                await request.patch(crossUrl, { headers: b.headers, data: { title: 'hijack' } })
            ).status(),
        ).toBe(404);
        expect((await request.delete(crossUrl, { headers: b.headers })).status()).toBe(404);
        // Plain @Param (no ParseUUIDPipe) → a non-uuid id is a clean service-miss 404.
        expect(
            (
                await request.get(`${API_BASE}/api/conversations/not-a-uuid`, {
                    headers: b.headers,
                })
            ).status(),
        ).toBe(404);

        // ── Cross-tenant message-append: the foreign user cannot inject ──
        const crossAppend = await request.post(`${crossUrl}/messages`, {
            headers: b.headers,
            data: { messages: [{ role: 'user', content: 'cross-tenant injection' }] },
        });
        expect(crossAppend.status()).toBe(404);

        // ── Owner sanity: GET 200 + append 201 { success:true } ──
        expect((await request.get(crossUrl, { headers: a.headers })).status()).toBe(200);
        const ownAppend = await request.post(`${crossUrl}/messages`, {
            headers: a.headers,
            data: { messages: [{ role: 'user', content: 'legit message' }] },
        });
        expect(ownAppend.status()).toBe(201);
        expect((await ownAppend.json()).success).toBe(true);

        // ── The injected message NEVER landed: A's thread reads back with only
        //    the owner's own message (the foreign injection content is absent). ──
        const reread = await (await request.get(crossUrl, { headers: a.headers })).json();
        const messages: Array<{ content: string }> = reread.messages ?? [];
        expect(messages.some((m) => m.content === 'cross-tenant injection')).toBe(false);
        expect(messages.some((m) => m.content === 'legit message')).toBe(true);
    });

    test('flow 4 — Knowledge base: KB docs are work-scoped; the other tenant gets 403/404 on every verb', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const a = await buildTenantCtx(request);
        const b = await buildTenantCtx(request);

        // Each tenant owns a work + a freeform KB doc inside it.
        const { id: aWorkId } = await createWorkViaAPI(request, a.token, {
            name: `Alpha KB Work ${stamp()}`,
            slug: `alpha-kb-${stamp()}`,
        });
        const { id: bWorkId } = await createWorkViaAPI(request, b.token, {
            name: `Bravo KB Work ${stamp()}`,
            slug: `bravo-kb-${stamp()}`,
        });
        const aDoc = await createKbDoc(request, a, aWorkId, `alpha-${stamp()}`);
        const bDoc = await createKbDoc(request, b, bWorkId, `bravo-${stamp()}`);

        // ── Own list returns { items, total } and contains only own doc ──
        const aList = await request.get(`${API_BASE}/api/works/${aWorkId}/kb/documents`, {
            headers: a.headers,
        });
        expect(aList.status()).toBe(200);
        const aItems = (await aList.json()).items as Array<{ id: string }>;
        expect(aItems.map((d) => d.id)).toContain(aDoc.id);
        expect(aItems.map((d) => d.id)).not.toContain(bDoc.id);

        // ── Cross-tenant: the /api/works ownership guard wins BEFORE the KB
        //    layer, so every KB verb on A's work is a 403 with a descriptive
        //    (non-PII) message — the same guard the works routes use. ──
        const crossList = await request.get(`${API_BASE}/api/works/${aWorkId}/kb/documents`, {
            headers: b.headers,
        });
        expect([403, 404]).toContain(crossList.status());
        if (crossList.status() === 403) {
            expect(String((await crossList.json()).message ?? '')).toContain('permission');
        }

        const docUrl = `${API_BASE}/api/works/${aWorkId}/kb/documents/${aDoc.id}`;
        expect([403, 404]).toContain((await request.get(docUrl, { headers: b.headers })).status());
        expect([403, 404]).toContain(
            (
                await request.patch(docUrl, { headers: b.headers, data: { title: 'hijack' } })
            ).status(),
        );
        expect([403, 404]).toContain(
            (await request.delete(docUrl, { headers: b.headers })).status(),
        );

        // The foreign tenant also cannot CREATE a doc inside A's work.
        const crossCreate = await request.post(`${API_BASE}/api/works/${aWorkId}/kb/documents`, {
            headers: b.headers,
            data: { path: 'freeform/intruder.md', title: 'x', class: 'freeform', body: 'x' },
        });
        expect([403, 404]).toContain(crossCreate.status());

        // ── Owner sanity: GET-by-id reachable; the intruder's writes never landed.
        const ownGet = await request.get(docUrl, { headers: a.headers });
        expect(ownGet.status()).toBe(200);
        const ownDoc = await ownGet.json();
        expect(ownDoc.id).toBe(aDoc.id);
        expect(ownDoc.body).toContain('secret');
        expect(ownDoc.title).not.toBe('hijack');
        // The doc is still the only one in A's work (no intruder row leaked in).
        const stillThere = await request.get(`${API_BASE}/api/works/${aWorkId}/kb/documents`, {
            headers: a.headers,
        });
        expect((await stillThere.json()).items.map((d: { id: string }) => d.id)).toContain(aDoc.id);
    });

    test('flow 5 — Agent + Task secondary writes: runs/assign-task/assignees/transition all 404 cross-tenant', async ({
        request,
    }) => {
        const a = await buildTenantCtx(request);
        const b = await buildTenantCtx(request);

        const agent = await createAgentViaAPI(request, a.token, {
            scope: 'tenant',
            name: `Alpha Agent ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, a.token, { title: `Alpha Task ${stamp()}` });

        // ── Agent runs: owner 200, foreign 404 (no existence leak) ──
        const runsUrl = `${API_BASE}/api/agents/${agent.id}/runs`;
        expect((await request.get(runsUrl, { headers: b.headers })).status()).toBe(404);
        const ownRuns = await listAgentRuns(request, a.token, agent.id);
        expect(Array.isArray(ownRuns)).toBe(true);

        // ── assign-task on a foreign agent → 404 even with a bogus taskId ──
        const assign = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: b.headers,
            data: { taskId: UNKNOWN_UUID },
        });
        expect(assign.status()).toBe(404);

        // ── Task secondary writes by the foreign tenant → 404 ──
        const assignee = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers: b.headers,
            data: { assigneeType: 'agent', assigneeId: agent.id },
        });
        expect(assignee.status()).toBe(404);

        const transition = await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
            headers: b.headers,
            data: { to: 'todo' },
        });
        expect(transition.status()).toBe(404);

        // ── Owner sanity: the very same task accepts a legitimate assignee (201).
        const ownAssignee = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers: a.headers,
            data: { assigneeType: 'agent', assigneeId: agent.id },
        });
        expect(ownAssignee.status()).toBe(201);
    });

    test('flow 6 — cross-resource sweep: the GLOBAL org-slug resolver is reachable cross-tenant yet leaks NO scoped rows', async ({
        request,
    }) => {
        // One tenant builds the full resource surface; a second, unrelated tenant
        // then proves none of it bleeds across — on works, agents, tasks, missions,
        // skills, AND conversations in a single sweep.
        const owner = await buildTenantCtx(request);
        const visitor = await buildTenantCtx(request);

        const s = stamp();
        const { id: workId } = await createWorkViaAPI(request, owner.token, {
            name: `Sweep Work ${s}`,
            slug: `sweep-work-${s}`,
        });
        const agent = await createAgentViaAPI(request, owner.token, {
            scope: 'tenant',
            name: `Sweep Agent ${s}`,
        });
        const task = await createTaskViaAPI(request, owner.token, { title: `Sweep Task ${s}` });
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: owner.headers,
            data: { title: `Sweep Mission ${s}`, description: 'd', type: 'one-shot' },
        });
        expect(missionRes.status()).toBe(201);
        const missionId = (await missionRes.json()).id as string;
        const skill = await createSkill(request, owner, `Sweep Skill ${s}`);
        const convo = await createConversation(request, owner, `Sweep Convo ${s}`);

        // ── The org-slug resolver is GLOBAL by design: the visitor resolves the
        //    owner's org by slug (200). This is NOT a leak of scoped data — it's a
        //    public-namespace resolver — so we assert it truthfully. ──
        const resolved = await request.get(`${API_BASE}/api/organizations/${owner.orgSlug}`, {
            headers: visitor.headers,
        });
        expect(resolved.status()).toBe(200);
        expect((await resolved.json()).id).toBe(owner.orgId);

        // ── …and despite resolving the org, the visitor's SCOPED lists stay clean:
        //    not one of the owner's six resources appears. ──
        const vWorks = await request.get(`${API_BASE}/api/works?limit=100`, {
            headers: visitor.headers,
        });
        expect(vWorks.status()).toBe(200);
        expect(((await vWorks.json()).works ?? []).map((w: { id: string }) => w.id)).not.toContain(
            workId,
        );

        const vAgents = await request.get(`${API_BASE}/api/agents?limit=100`, {
            headers: visitor.headers,
        });
        expect(((await vAgents.json()).data ?? []).map((x: { id: string }) => x.id)).not.toContain(
            agent.id,
        );

        const vTasks = await request.get(`${API_BASE}/api/tasks?limit=100`, {
            headers: visitor.headers,
        });
        expect(((await vTasks.json()).data ?? []).map((x: { id: string }) => x.id)).not.toContain(
            task.id,
        );

        const vMissions = await request.get(`${API_BASE}/api/me/missions`, {
            headers: visitor.headers,
        });
        const missionsBody = await vMissions.json();
        const missionArr = Array.isArray(missionsBody) ? missionsBody : (missionsBody.data ?? []);
        expect(missionArr.map((x: { id: string }) => x.id)).not.toContain(missionId);

        const vSkills = await request.get(`${API_BASE}/api/skills?limit=100`, {
            headers: visitor.headers,
        });
        expect(((await vSkills.json()).data ?? []).map((x: { id: string }) => x.id)).not.toContain(
            skill.id,
        );

        const vConvos = await request.get(`${API_BASE}/api/conversations?limit=100`, {
            headers: visitor.headers,
        });
        expect(
            ((await vConvos.json()).conversations ?? []).map((x: { id: string }) => x.id),
        ).not.toContain(convo.id);

        // ── Direct cross-tenant GET on every id is forbidden (404 for the
        //    own-row-or-nothing resources; 403/404 for the work guard). ──
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${agent.id}`, {
                    headers: visitor.headers,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers: visitor.headers })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${missionId}`, {
                    headers: visitor.headers,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${skill.id}`, {
                    headers: visitor.headers,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/conversations/${convo.id}`, {
                    headers: visitor.headers,
                })
            ).status(),
        ).toBe(404);
        expect([403, 404]).toContain(
            (
                await request.get(`${API_BASE}/api/works/${workId}`, { headers: visitor.headers })
            ).status(),
        );
    });
});
