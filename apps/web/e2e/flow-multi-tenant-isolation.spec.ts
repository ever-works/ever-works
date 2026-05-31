import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * Multi-tenant isolation (deep) — three multi-entity, cross-feature
 * orchestrations that prove the platform's row-level tenancy is authoritative
 * end-to-end across every scoped resource type (works, agents, tasks,
 * missions, organizations).
 *
 * Every endpoint/shape below was probed against the LIVE API (sqlite
 * in-memory, the same driver CI uses) before any assertion was written:
 *
 *   Auth
 *     POST /api/auth/register { username(>=3), email, password }
 *       → 201 { access_token (32-char opaque), user:{ id, email, username } }
 *
 *   Resource create (all owner-scoped to the calling user):
 *     POST /api/works   { name, slug, description, organization:false }
 *       → 200 { status:'success', work:{ id, userId, tenantId, organizationId, … } }
 *     POST /api/agents  { scope:'tenant', name }
 *       → 201 { id, userId, scope:'tenant', status:'draft', … }   (NB: the
 *         Agent DTO does NOT expose tenantId/organizationId — so flow 3 asserts
 *         tenant consistency via works+tasks, which DO expose it.)
 *     POST /api/tasks   { title }
 *       → 201 { id, userId, slug:'T-n', status:'backlog', tenantId, organizationId, … }
 *     POST /api/me/missions { title, description, type:'one-shot' }
 *       → 201 { id, status:'active', … }
 *     POST /api/organizations { name }
 *       → 201 { id, tenantId, slug, displayName, registrationStatus:'draft', … }
 *
 *   Resource list (owner-scoped; never leaks another tenant's rows):
 *     GET /api/works        → { status:'success', works:[…], total, limit, offset }
 *     GET /api/agents       → { data:[…], meta:{ total, limit, offset } }
 *     GET /api/tasks        → { data:[…], meta:{ total, limit, offset } }
 *     GET /api/me/missions  → bare array [ … ]
 *     GET /api/organizations→ bare array [ … ]
 *
 *   Cross-user scope-guard status codes (probed — note the asymmetry):
 *     works   : GET 403, PATCH 403 (msg "You do not have permission to access
 *               this work"); there is NO DELETE /api/works/:id route at all
 *               (owner gets 404 route-not-found too), so DELETE is excluded.
 *     tasks   : GET 404, PATCH 404, DELETE 404
 *     missions: GET 404, PATCH 404, DELETE 404
 *     agents  : GET 404, PATCH 404, DELETE 404  (existence not leaked via 403)
 *
 *   Tenant stamping (probed — "lazy Tenant on first Org"):
 *     - A fresh user's works/tasks are born tenantId:null, organizationId:null.
 *     - Creating the user's FIRST organization lazily mints a Tenant. Minting
 *       RETROACTIVELY backfills that tenantId onto the user's pre-existing
 *       scoped rows (work + task) — but leaves their organizationId null (the
 *       org becomes the active scope only for NEW writes, not a retro member).
 *     - Every subsequent scoped write (work, task) is auto-stamped with that
 *       org's tenantId AND organizationId.
 *     - A user has exactly ONE Tenant: a 2nd org reuses the same tenantId.
 *     - Two distinct users get two distinct tenantIds.
 *
 * Isolation discipline (matches sibling specs): all mutations run on FRESH
 * registerUserViaAPI() users (never the shared seeded user) so the in-memory
 * DB stays clean for other specs, and list assertions tolerate pre-existing
 * rows (toContain / not.toContain on ids), never exact global counts.
 *
 * Filename uses the safe `flow-` prefix (NOT matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is fully API-orchestrated, so it does not
 * contend on the shared UI/stack.
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
        data: { title, description: 'multi-tenant-isolation probe', type: 'one-shot' },
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.status).toBe('active');
    return body.id as string;
}

/** GET /api/works and return the parsed page (status:'success', works:[…]). */
async function listWorks(
    request: APIRequestContext,
    token: string,
): Promise<{ works: Array<{ id: string; userId: string }>; total: number }> {
    const res = await request.get(`${API_BASE}/api/works`, { headers: authedHeaders(token) });
    expect(res.status(), `list works body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return { works: body.works ?? [], total: body.total ?? (body.works ?? []).length };
}

/** GET a `{ data, meta }` list endpoint (agents / tasks). */
async function listDataMeta(
    request: APIRequestContext,
    token: string,
    path: string,
): Promise<{ data: Array<{ id: string }>; total: number }> {
    const res = await request.get(`${API_BASE}${path}`, { headers: authedHeaders(token) });
    expect(res.status(), `list ${path} body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return { data: body.data ?? [], total: body.meta?.total ?? (body.data ?? []).length };
}

/** GET a bare-array list endpoint (missions / organizations). */
async function listArray<T = { id: string }>(
    request: APIRequestContext,
    token: string,
    path: string,
): Promise<T[]> {
    const res = await request.get(`${API_BASE}${path}`, { headers: authedHeaders(token) });
    expect(res.status(), `list ${path} body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), `${path} should return a bare array`).toBe(true);
    return body as T[];
}

interface Tenant {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    workId: string;
    agentId: string;
    taskId: string;
    missionId: string;
}

/** Build one fully-populated tenant: org + work + agent + task + mission. */
async function buildTenant(request: APIRequestContext, label: string): Promise<Tenant> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const s = stamp();

    // First org → lazily mints the Tenant and makes it the active scope.
    const org = await createOrganizationViaAPI(request, token, `${label} Org ${s}`);
    expect(org.tenantId).toMatch(UUID_RE);

    const { id: workId } = await createWorkViaAPI(request, token, {
        name: `${label} Work ${s}`,
        slug: `${label.toLowerCase()}-work-${s}`,
    });
    expect(workId).toMatch(UUID_RE);

    const agent = await createAgentViaAPI(request, token, {
        scope: 'tenant',
        name: `${label} Agent ${s}`,
    });
    const task = await createTaskViaAPI(request, token, { title: `${label} Task ${s}` });
    const missionId = await createMission(request, token, `${label} Mission ${s}`);

    return { user, token, workId, agentId: agent.id, taskId: task.id, missionId };
}

test.describe('Multi-tenant isolation (deep)', () => {
    test('two fully-populated tenants see ONLY their own rows on every list endpoint', async ({
        request,
    }) => {
        // Two independent users, each with org + work + agent + task + mission.
        const a = await buildTenant(request, 'Alpha');
        const b = await buildTenant(request, 'Bravo');

        // Sanity: the two users are genuinely distinct.
        expect(a.user.user.id).not.toBe(b.user.user.id);

        // ── Works ─────────────────────────────────────────────────────────
        const aWorks = await listWorks(request, a.token);
        const bWorks = await listWorks(request, b.token);
        const aWorkIds = aWorks.works.map((w) => w.id);
        const bWorkIds = bWorks.works.map((w) => w.id);
        expect(aWorkIds).toContain(a.workId);
        expect(aWorkIds).not.toContain(b.workId); // Bravo's work never bleeds into Alpha
        expect(bWorkIds).toContain(b.workId);
        expect(bWorkIds).not.toContain(a.workId); // …and vice-versa
        // Every row Alpha sees is owned by Alpha (no foreign userId leaks).
        expect(aWorks.works.every((w) => w.userId === a.user.user.id)).toBe(true);
        expect(bWorks.works.every((w) => w.userId === b.user.user.id)).toBe(true);

        // ── Agents ({ data, meta }) ─────────────────────────────────────────
        const aAgents = await listDataMeta(request, a.token, '/api/agents');
        const bAgents = await listDataMeta(request, b.token, '/api/agents');
        expect(aAgents.data.map((x) => x.id)).toContain(a.agentId);
        expect(aAgents.data.map((x) => x.id)).not.toContain(b.agentId);
        expect(bAgents.data.map((x) => x.id)).toContain(b.agentId);
        expect(bAgents.data.map((x) => x.id)).not.toContain(a.agentId);

        // ── Tasks ({ data, meta }) ──────────────────────────────────────────
        const aTasks = await listDataMeta(request, a.token, '/api/tasks');
        const bTasks = await listDataMeta(request, b.token, '/api/tasks');
        expect(aTasks.data.map((x) => x.id)).toContain(a.taskId);
        expect(aTasks.data.map((x) => x.id)).not.toContain(b.taskId);
        expect(bTasks.data.map((x) => x.id)).toContain(b.taskId);
        expect(bTasks.data.map((x) => x.id)).not.toContain(a.taskId);

        // ── Missions (bare array) ───────────────────────────────────────────
        const aMissions = await listArray(request, a.token, '/api/me/missions');
        const bMissions = await listArray(request, b.token, '/api/me/missions');
        expect(aMissions.map((x) => x.id)).toContain(a.missionId);
        expect(aMissions.map((x) => x.id)).not.toContain(b.missionId);
        expect(bMissions.map((x) => x.id)).toContain(b.missionId);
        expect(bMissions.map((x) => x.id)).not.toContain(a.missionId);

        // ── Organizations (bare array) — each user sees exactly their own ───
        const aOrgs = await listArray<{ id: string; tenantId: string }>(
            request,
            a.token,
            '/api/organizations',
        );
        const bOrgs = await listArray<{ id: string; tenantId: string }>(
            request,
            b.token,
            '/api/organizations',
        );
        // Each fresh user created exactly one org with exactly one tenant.
        expect(aOrgs.length).toBe(1);
        expect(bOrgs.length).toBe(1);
        const aTenantIds = new Set(aOrgs.map((o) => o.tenantId));
        const bTenantIds = new Set(bOrgs.map((o) => o.tenantId));
        expect(aTenantIds.size).toBe(1);
        expect(bTenantIds.size).toBe(1);
        // The two tenants are different namespaces entirely.
        const aTenant = [...aTenantIds][0];
        const bTenant = [...bTenantIds][0];
        expect(aTenant).not.toBe(bTenant);
    });

    test("scope guards: each user is forbidden GET/PATCH/DELETE on the other user's resources", async ({
        request,
    }) => {
        const a = await buildTenant(request, 'Owner');
        const b = await registerUserViaAPI(request);
        const atk = authedHeaders(b.access_token); // attacker (user B) headers
        const own = authedHeaders(a.token);

        // ── Works: GET & PATCH are scope-guarded (403); no DELETE route ─────
        const workUrl = `${API_BASE}/api/works/${a.workId}`;
        const workGet = await request.get(workUrl, { headers: atk });
        expect([403, 404]).toContain(workGet.status());
        // Probed status is 403 with a descriptive (non-leaky) message.
        if (workGet.status() === 403) {
            const body = await workGet.json();
            const msg = body.message ?? body.msg;
            expect(String(msg)).toContain('permission');
        }
        const workPatch = await request.patch(workUrl, {
            headers: atk,
            data: { name: 'hijacked' },
        });
        expect([403, 404]).toContain(workPatch.status());

        // ── Tasks: GET / PATCH / DELETE all 404 (existence not leaked) ──────
        const taskUrl = `${API_BASE}/api/tasks/${a.taskId}`;
        expect((await request.get(taskUrl, { headers: atk })).status()).toBe(404);
        expect(
            (await request.patch(taskUrl, { headers: atk, data: { title: 'hijacked' } })).status(),
        ).toBe(404);
        expect((await request.delete(taskUrl, { headers: atk })).status()).toBe(404);

        // ── Missions: GET / PATCH / DELETE all 404 ──────────────────────────
        const missionUrl = `${API_BASE}/api/me/missions/${a.missionId}`;
        expect((await request.get(missionUrl, { headers: atk })).status()).toBe(404);
        expect(
            (
                await request.patch(missionUrl, { headers: atk, data: { title: 'hijacked' } })
            ).status(),
        ).toBe(404);
        expect((await request.delete(missionUrl, { headers: atk })).status()).toBe(404);

        // ── Agents: GET / PATCH / DELETE all 404 ────────────────────────────
        const agentUrl = `${API_BASE}/api/agents/${a.agentId}`;
        const agentGet = await request.get(agentUrl, { headers: atk });
        expect(agentGet.status()).toBe(404);
        expect(
            (await request.patch(agentUrl, { headers: atk, data: { name: 'x' } })).status(),
        ).toBe(404);
        expect((await request.delete(agentUrl, { headers: atk })).status()).toBe(404);

        // ── Owner sanity: every one of those ids is fully reachable to its ──
        //    rightful owner, proving the 403/404s above are ownership-scoped
        //    (not a deleted/broken row or a wrong route).
        expect((await request.get(workUrl, { headers: own })).status()).toBe(200);
        expect((await request.get(taskUrl, { headers: own })).status()).toBe(200);
        expect((await request.get(missionUrl, { headers: own })).status()).toBe(200);
        expect((await request.get(agentUrl, { headers: own })).status()).toBe(200);

        // A non-UUID agent id is a 400 (ParseUUIDPipe), an unknown well-formed
        // UUID is a 404 — neither leaks anything across the tenant boundary.
        expect(
            (await request.get(`${API_BASE}/api/agents/not-a-uuid`, { headers: own })).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}`, { headers: own })
            ).status(),
        ).toBe(404);
    });

    test('tenant stamping: first org lazily mints a tenant that every later scoped write shares', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        // ── 1. PRE-tenant: a work created before any org is born unstamped ──
        const { id: preWorkId, raw: preRaw } = await createWorkViaAPI(request, token, {
            name: `Pre Work ${s}`,
            slug: `pre-work-${s}`,
        });
        const preWork = (
            preRaw as { work: { tenantId: string | null; organizationId: string | null } }
        ).work;
        expect(preWork.tenantId).toBeNull();
        expect(preWork.organizationId).toBeNull();

        // ── 2. Create the user's FIRST org → lazily mints the Tenant ────────
        const org = await createOrganizationViaAPI(request, token, `Stamp Org ${s}`);
        const tenantId = org.tenantId;
        expect(tenantId).toMatch(UUID_RE);

        // ── 3. POST-tenant scoped writes are auto-stamped with tenantId +
        //       organizationId (the active scope). Probed: BOTH works AND
        //       tasks expose these fields and carry the org's tenant. ───────
        const { id: postWorkId } = await createWorkViaAPI(request, token, {
            name: `Post Work ${s}`,
            slug: `post-work-${s}`,
        });
        const postTask = await createTaskViaAPI(request, token, { title: `Post Task ${s}` });

        // Read each back via GET-by-id and assert tenant consistency.
        const postWorkBody = await (
            await request.get(`${API_BASE}/api/works/${postWorkId}`, { headers })
        ).json();
        const postWork = postWorkBody.work ?? postWorkBody;
        expect(postWork.tenantId).toBe(tenantId);
        expect(postWork.organizationId).toBe(org.id);

        const postTaskBody = await (
            await request.get(`${API_BASE}/api/tasks/${postTask.id}`, { headers })
        ).json();
        expect(postTaskBody.tenantId).toBe(tenantId);
        expect(postTaskBody.organizationId).toBe(org.id);

        // The org row itself, the work, and the task all agree on ONE tenant —
        // tenantId is consistent across resource types.
        expect(new Set([org.tenantId, postWork.tenantId, postTaskBody.tenantId]).size).toBe(1);

        // ── 4. One tenant per user: a SECOND org reuses the same tenantId ───
        const org2 = await createOrganizationViaAPI(request, token, `Stamp Org2 ${s}`);
        expect(org2.tenantId).toBe(tenantId);
        const orgs = await listArray<{ id: string; tenantId: string }>(
            request,
            token,
            '/api/organizations',
        );
        expect(orgs.length).toBe(2);
        expect(new Set(orgs.map((o) => o.tenantId))).toEqual(new Set([tenantId]));

        // ── 5. Minting the tenant RETROACTIVELY backfills tenantId onto the
        //       user's pre-existing work (probed) so the whole tenant shares
        //       ONE namespace — but organizationId stays null on that earlier
        //       row (the org is the active scope for NEW writes, not a retro
        //       membership). This is the truthful, probed behavior. ─────────
        const preWorkAfter = await (
            await request.get(`${API_BASE}/api/works/${preWorkId}`, { headers })
        ).json();
        const preAfter = preWorkAfter.work ?? preWorkAfter;
        expect(preAfter.tenantId).toBe(tenantId);
        expect(preAfter.organizationId).toBeNull();
    });
});
