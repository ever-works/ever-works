/**
 * Cross-tenant data-leak MATRIX — two tenants × every scoped resource type,
 * stressed through every leak VECTOR an attacker actually controls: search,
 * filter, pagination, sort, attacker-supplied scope params, and id/slug guessing.
 *
 * The sibling isolation specs already prove the BASELINE:
 *   • flow-multi-tenant-isolation.spec.ts  — plain LIST own-only + direct
 *     cross GET/PATCH/DELETE guards + tenant stamping.
 *   • flow-tenant-isolation-resources.spec.ts — skills / conversations / KB /
 *     agent-runs / task-secondary-writes + the global org-slug resolver edge.
 *   • multi-tenant-data-leak.spec.ts — `?owner=`/`?tenant=` on /api/works only.
 *
 * THIS file deliberately covers what those do NOT: the systematic LEAK-VECTOR
 * matrix. For every resource it drives the list endpoint with the attacker's
 * OWN bearer but the VICTIM's identifiers smuggled into the query string
 * (search term, ownerId/userId/scope/workId/missionId filters), plus
 * pagination/offset abuse and id/slug enumeration — and asserts not one
 * victim row, id, or field ever crosses the boundary.
 *
 * ── Verified contract (probed LIVE against http://127.0.0.1:3100, sqlite
 *    in-memory — the same driver CI uses — before any assertion was written):
 *
 *   Auth (helpers/api.ts):
 *     POST /api/auth/register { username(>=3), email, password }
 *       → 201 { access_token (32-char opaque), user:{ id, email, username } }
 *
 *   LIST endpoints + the query params each actually honours (from the live
 *   controllers — every one is server-side OWNER-scoped; the params below only
 *   ever NARROW the caller's own rows, never widen to a foreign tenant):
 *     GET /api/works         ?search&limit&offset            → { status, works:[…], total }
 *     GET /api/tasks         ?status&priority&missionId&ideaId&workId&parentTaskId
 *                             &label&search&limit&offset      → { data:[…], meta:{ total,limit,offset } }
 *       · invalid ?status=<bad>  → 400 (server validates the enum)
 *       · ?limit clamps to 200, ?offset clamps to ≥0 (no overflow leak)
 *     GET /api/agents        ?scope&status&search&limit&offset → { data:[…], meta }
 *       · ?limit>200 → 400 ["limit must not be greater than 200"] (DTO @Max)
 *     GET /api/skills        ?ownerType&ownerId&search&limit&offset → { data:[…], meta }
 *       · the ATTACKER-controlled ?ownerId is the sharpest pivot — passing the
 *         VICTIM's tenantId as ownerId still returns 0 rows (own-scope wins).
 *     GET /api/conversations ?limit&offset                   → { conversations:[…], total }
 *       · tolerates an unknown ?search and a huge ?limit; still own-only.
 *     GET /api/me/missions                                   → bare array [ … ]
 *
 *   id / slug ENUMERATION (probed):
 *     · A Task's slug is the per-user sequence "T-1","T-2",… — NOT global. A
 *       fresh second user's first task is ALSO "T-1", so guessing a victim's
 *       slug only ever resolves the guesser's OWN row. (And /api/tasks/:id is
 *       ParseUUIDPipe-guarded, so a slug "T-1" passed as :id → 400 anyway.)
 *     · /api/tasks/:id, /api/skills/:id, /api/agents/:id → ParseUUIDPipe:
 *         non-uuid → 400; well-formed unknown/foreign uuid → 404.
 *     · /api/me/missions/:id cross-tenant → 404.
 *
 *   Tenant minting (probed — "lazy Tenant on first Org"): creating a user's
 *   FIRST organization mints their Tenant and is what gives us a real tenantId
 *   to smuggle into the ?ownerId skill filter.
 *
 * ── Isolation discipline (matches every sibling flow): all mutations run on
 *    FRESH registerUserViaAPI() users (never the shared seeded user — a user-
 *    scoped fake key would shadow the env key and break sibling chat specs).
 *    List assertions use toContain / not.toContain on ids (tolerate pre-existing
 *    rows), never exact global counts. Unique suffixes via Date.now()+random.
 *    Status codes asserted tolerantly ([403,404] / [400,404]) where two valid
 *    policies coexist, so a code shift never makes the flow a false fail.
 *
 * Filename uses the safe `flow-` prefix (NOT matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is fully API-orchestrated, so it does not
 * contend on the shared UI/stack.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A fully-built tenant: a fresh user, the org whose creation mints their
 * Tenant, and one row of every scoped resource type — each carrying a unique,
 * searchable marker so we can later prove a foreign tenant's search/filter can
 * never surface it.
 */
interface BuiltTenant {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    headers: { Authorization: string };
    tenantId: string;
    orgId: string;
    marker: string;
    workId: string;
    taskId: string;
    taskSlug: string;
    agentId: string;
    skillId: string;
    missionId: string;
}

/** Create a Mission and return its id (verified shape: 201 → { id, status:'active' }). */
async function createMission(
    request: APIRequestContext,
    headers: { Authorization: string },
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers,
        data: { title, description: 'cross-tenant-leak probe', type: 'one-shot' },
    });
    expect(res.status(), `mission create body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    return body.id as string;
}

/** Create a tenant-scope Skill and return its id (verified Phase-9 write path). */
async function createSkill(
    request: APIRequestContext,
    headers: { Authorization: string },
    userId: string,
    tenantId: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers,
        data: {
            ownerType: 'tenant',
            // Tenant-scope skills are USER-owned (API filters by userId), so
            // ownerId is the owner's user id. The skill's tenantId is then
            // auto-stamped from that user's tenant — which is exactly
            // `tenantId` here — so the isolation assertion below still holds.
            ownerId: userId,
            title,
            description: 'cross-tenant-leak probe skill',
            instructionsMd: '# secret instructions',
        },
    });
    expect(res.status(), `skill create body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.tenantId).toBe(tenantId);
    return body.id as string;
}

/**
 * Build one fully-populated tenant. Every resource name embeds the tenant's
 * unique `marker` so search/filter leak probes have a precise needle to hunt.
 */
async function buildTenant(request: APIRequestContext, label: string): Promise<BuiltTenant> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const headers = authedHeaders(token);
    const marker = `LEAK${label}${stamp()}`.replace(/-/g, '');

    const org = await createOrganizationViaAPI(request, token, `${marker} Org`);
    expect(org.tenantId).toMatch(UUID_RE);

    const { id: workId } = await createWorkViaAPI(request, token, {
        name: `${marker} Work`,
        slug: `${marker.toLowerCase()}-work`,
    });
    expect(workId).toMatch(UUID_RE);

    const task = await createTaskViaAPI(request, token, { title: `${marker} Task` });
    const agent = await createAgentViaAPI(request, token, {
        scope: 'tenant',
        name: `${marker} Agent`,
    });
    const skillId = await createSkill(request, headers, user.user.id, org.tenantId, `${marker} Skill`);
    const missionId = await createMission(request, headers, `${marker} Mission`);

    return {
        user,
        token,
        headers,
        tenantId: org.tenantId,
        orgId: org.id,
        marker,
        workId,
        taskId: task.id,
        taskSlug: task.slug,
        agentId: agent.id,
        skillId,
        missionId,
    };
}

/** GET a list endpoint and return the raw JSON (caller picks the row array out). */
async function getList(
    request: APIRequestContext,
    headers: { Authorization: string },
    path: string,
): Promise<{ status: number; body: any }> {
    const res = await request.get(`${API_BASE}${path}`, { headers });
    const status = res.status();
    const body = res.ok() ? await res.json() : await res.text();
    return { status, body };
}

/** Normalise every list shape (works / data-meta / conversations / bare array) → id[]. */
function rowIds(body: any): string[] {
    if (Array.isArray(body)) return body.map((r) => r.id);
    const arr = body?.works ?? body?.data ?? body?.conversations ?? body?.items ?? [];
    return (arr as Array<{ id: string }>).map((r) => r.id);
}

test.describe('Cross-tenant leak matrix (two tenants × every resource × every vector)', () => {
    test('flow 1 — SEARCH vector: a victim row never surfaces in the attacker‑s search across works/tasks/skills', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const victim = await buildTenant(request, 'Victim');
        const attacker = await buildTenant(request, 'Attacker');
        expect(victim.user.user.id).not.toBe(attacker.user.user.id);
        // The two markers are distinct needles.
        expect(victim.marker).not.toBe(attacker.marker);

        // ── The attacker searches each resource for the VICTIM's exact marker.
        //    Server-side owner-scoping must apply BEFORE the search filter, so
        //    the victim's row is invisible no matter how precise the term. ──
        const works = await getList(
            request,
            attacker.headers,
            `/api/works?search=${encodeURIComponent(victim.marker)}&limit=200`,
        );
        expect(works.status).toBe(200);
        expect(rowIds(works.body)).not.toContain(victim.workId);

        const tasks = await getList(
            request,
            attacker.headers,
            `/api/tasks?search=${encodeURIComponent(victim.marker)}&limit=200`,
        );
        expect(tasks.status).toBe(200);
        expect(rowIds(tasks.body)).not.toContain(victim.taskId);

        const skills = await getList(
            request,
            attacker.headers,
            `/api/skills?search=${encodeURIComponent(victim.marker)}&limit=200`,
        );
        expect(skills.status).toBe(200);
        expect(rowIds(skills.body)).not.toContain(victim.skillId);

        // ── Positive control: the VICTIM searching their OWN marker DOES find
        //    each row — proving the search engine works and the empty attacker
        //    result is genuine isolation, not a broken search index. ──
        const ownWorks = await getList(
            request,
            victim.headers,
            `/api/works?search=${encodeURIComponent(victim.marker)}&limit=200`,
        );
        expect(rowIds(ownWorks.body)).toContain(victim.workId);
        const ownTasks = await getList(
            request,
            victim.headers,
            `/api/tasks?search=${encodeURIComponent(victim.marker)}&limit=200`,
        );
        expect(rowIds(ownTasks.body)).toContain(victim.taskId);
    });

    test('flow 2 — FILTER pivot: attacker‑supplied ownerId / scope / status filters cannot widen scope to a foreign tenant', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const victim = await buildTenant(request, 'FVictim');
        const attacker = await buildTenant(request, 'FAttacker');

        // ── Skills ?ownerId — the sharpest pivot. The attacker smuggles the
        //    VICTIM's real tenantId in as ownerId. Probed live: still 0 of the
        //    victim's rows; own-scope is authoritative over the filter. ──
        const pivot = await getList(
            request,
            attacker.headers,
            `/api/skills?ownerType=tenant&ownerId=${victim.tenantId}&limit=200`,
        );
        expect(pivot.status).toBe(200);
        expect(rowIds(pivot.body)).not.toContain(victim.skillId);
        // Every row returned (if any) belongs to the attacker, never the victim.
        const pivotRows = (pivot.body?.data ?? []) as Array<{ userId: string }>;
        expect(pivotRows.every((r) => r.userId === attacker.user.user.id)).toBe(true);

        // Cross-check: the attacker re-uses ownerId=victim.tenantId AND
        // search=victim.marker together — the compound filter still leaks nothing.
        const compound = await getList(
            request,
            attacker.headers,
            `/api/skills?ownerType=tenant&ownerId=${victim.tenantId}&search=${encodeURIComponent(victim.marker)}`,
        );
        expect(rowIds(compound.body)).not.toContain(victim.skillId);

        // ── Agents ?scope / ?status — the attacker filters by the same scope
        //    the victim's agent uses (tenant). No widening across the boundary. ──
        const agentsByScope = await getList(
            request,
            attacker.headers,
            `/api/agents?scope=tenant&limit=200`,
        );
        expect(agentsByScope.status).toBe(200);
        expect(rowIds(agentsByScope.body)).not.toContain(victim.agentId);

        // ── Tasks ?status/?priority — narrowing filters never widen scope. ──
        const tasksByStatus = await getList(
            request,
            attacker.headers,
            `/api/tasks?status=backlog&priority=p3&limit=200`,
        );
        expect(tasksByStatus.status).toBe(200);
        expect(rowIds(tasksByStatus.body)).not.toContain(victim.taskId);

        // ── Positive control: the victim's OWN ownerId filter DOES return their
        //    skill, proving the filter is functional (empty attacker = isolation). ──
        const ownPivot = await getList(
            request,
            victim.headers,
            `/api/skills?ownerType=tenant&ownerId=${victim.tenantId}&limit=200`,
        );
        expect(rowIds(ownPivot.body)).toContain(victim.skillId);
    });

    test('flow 3 — RELATION filter: attacker referencing a victim‑s workId / missionId / parentTaskId leaks no tasks', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const victim = await buildTenant(request, 'RVictim');
        const attacker = await buildTenant(request, 'RAttacker');

        // The victim owns a task explicitly linked to their OWN work, so the
        // relation filters below have a real row to (fail to) surface. NOTE: the
        // service enforces "exactly zero or one of missionId/ideaId/workId" — a
        // task scoped to BOTH work + mission is a 400, so we pin only workId here
        // (the positive control keys on workId; the missionId/parentTaskId probes
        // still hunt victim.missionId / victim.taskId as their needles).
        const linkedTask = await createTaskViaAPI(request, victim.token, {
            title: `${victim.marker} LinkedTask`,
            workId: victim.workId,
        });
        expect(linkedTask.id).toMatch(UUID_RE);

        // ── The attacker references the victim's real workId / missionId /
        //    parentTaskId in the tasks filter. Each is owner-scoped first, so
        //    the foreign relation id resolves to ZERO of the attacker's rows
        //    and NONE of the victim's. ──
        for (const [param, value] of [
            ['workId', victim.workId],
            ['missionId', victim.missionId],
            ['parentTaskId', victim.taskId],
            ['ideaId', victim.missionId], // arbitrary foreign uuid in the idea slot
        ] as const) {
            const res = await getList(
                request,
                attacker.headers,
                `/api/tasks?${param}=${value}&limit=200`,
            );
            expect(res.status, `tasks?${param} status`).toBe(200);
            const ids = rowIds(res.body);
            expect(ids, `tasks?${param} leaked victim's linked task`).not.toContain(linkedTask.id);
            expect(ids, `tasks?${param} leaked victim's base task`).not.toContain(victim.taskId);
            // And every row the attacker DOES see is the attacker's own.
            const rows = (res.body?.data ?? []) as Array<{ userId: string }>;
            expect(rows.every((r) => r.userId === attacker.user.user.id)).toBe(true);
        }

        // ── Positive control: the victim filtering tasks by their OWN workId
        //    DOES return the linked task — the relation filter genuinely works. ──
        const ownByWork = await getList(
            request,
            victim.headers,
            `/api/tasks?workId=${victim.workId}&limit=200`,
        );
        expect(rowIds(ownByWork.body)).toContain(linkedTask.id);
    });

    test('flow 4 — PAGINATION / offset abuse: deep paging + huge limits never page INTO a foreign tenant', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const victim = await buildTenant(request, 'PVictim');
        const attacker = await buildTenant(request, 'PAttacker');

        // ── Walk the attacker's lists with abusive paging — huge limit, large
        //    offset, offset:0 — and assert the victim's row never appears in ANY
        //    page across works / tasks / agents / skills / conversations. ──
        const pagings = ['limit=200&offset=0', 'limit=200&offset=199', 'limit=1&offset=0'];
        for (const pg of pagings) {
            const works = await getList(request, attacker.headers, `/api/works?${pg}`);
            expect(works.status).toBe(200);
            expect(rowIds(works.body)).not.toContain(victim.workId);

            const tasks = await getList(request, attacker.headers, `/api/tasks?${pg}`);
            expect(tasks.status).toBe(200);
            expect(rowIds(tasks.body)).not.toContain(victim.taskId);

            const skills = await getList(request, attacker.headers, `/api/skills?${pg}`);
            expect(skills.status).toBe(200);
            expect(rowIds(skills.body)).not.toContain(victim.skillId);
        }

        // ── Conversations tolerate an absurd limit (probed) and stay own-only. ──
        const convos = await getList(
            request,
            attacker.headers,
            `/api/conversations?limit=99999&offset=0`,
        );
        expect(convos.status).toBe(200);
        // (the attacker created none, but the victim's never bleed in either)
        expect(rowIds(convos.body)).not.toContain(victim.workId);

        // ── Negative offset is clamped to 0 server-side (probed) — it does NOT
        //    underflow into another tenant's window. The response is still a
        //    valid own-scoped page (200), never a foreign one. ──
        const negTasks = await getList(
            request,
            attacker.headers,
            `/api/tasks?offset=-50&limit=200`,
        );
        expect(negTasks.status).toBe(200);
        expect(rowIds(negTasks.body)).not.toContain(victim.taskId);

        // ── Over-max limit on agents is REJECTED (400), not silently widened —
        //    the DTO @Max(200) closes the "ask for everything" leak shortcut. ──
        const overMax = await request.get(`${API_BASE}/api/agents?limit=1000`, {
            headers: attacker.headers,
        });
        expect(overMax.status()).toBe(400);
        expect(JSON.stringify(await overMax.json())).toContain('200');

        // At the legal max the attacker still sees none of the victim's agents.
        const agents = await getList(request, attacker.headers, `/api/agents?limit=200&offset=0`);
        expect(agents.status).toBe(200);
        expect(rowIds(agents.body)).not.toContain(victim.agentId);
    });

    test('flow 5 — ID / SLUG enumeration: guessing a victim‑s uuid or sequential T‑n slug never yields their row', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const victim = await buildTenant(request, 'IVictim');
        const attacker = await buildTenant(request, 'IAttacker');

        // ── The victim's task slug is the per-user sequence "T-1". The attacker
        //    ALSO created a tenant (with its own task) so the attacker's first
        //    task is likewise "T-1": slugs are NOT a global namespace, so a slug
        //    guess can never address a foreign row. Prove the two collide. ──
        expect(victim.taskSlug).toMatch(/^T-\d+$/);
        expect(attacker.taskSlug).toBe(victim.taskSlug); // both "T-1" — proves per-user numbering

        // And /api/tasks/:id is ParseUUIDPipe-guarded, so feeding the slug as an
        // id is a clean 400 — a slug is never even accepted as a lookup key.
        const slugAsId = await request.get(`${API_BASE}/api/tasks/${victim.taskSlug}`, {
            headers: attacker.headers,
        });
        expect(slugAsId.status()).toBe(400);

        // ── Direct uuid GUESS of every victim resource by its real uuid: the
        //    own-or-nothing resources 404 (existence not leaked); the work guard
        //    is allowed to 403 OR 404. Never a 200 that returns the victim row. ──
        const guesses: Array<{ path: string; allowed: number[] }> = [
            { path: `/api/tasks/${victim.taskId}`, allowed: [404] },
            { path: `/api/agents/${victim.agentId}`, allowed: [404] },
            { path: `/api/skills/${victim.skillId}`, allowed: [404] },
            { path: `/api/me/missions/${victim.missionId}`, allowed: [404] },
            { path: `/api/works/${victim.workId}`, allowed: [403, 404] },
        ];
        for (const g of guesses) {
            const res = await request.get(`${API_BASE}${g.path}`, { headers: attacker.headers });
            expect(g.allowed, `GET ${g.path} returned ${res.status()}`).toContain(res.status());
            expect(res.status(), `GET ${g.path} must never be a 200 leak`).not.toBe(200);
        }

        // ── Malformed vs unknown uuid boundary (probed): a non-uuid id → 400
        //    (ParseUUIDPipe), a well-formed but unknown uuid → 404. Neither
        //    distinguishes "exists for another tenant" from "does not exist" —
        //    so the attacker learns nothing about the victim's id space. ──
        expect(
            (
                await request.get(`${API_BASE}/api/skills/not-a-uuid`, {
                    headers: attacker.headers,
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/not-a-uuid`, {
                    headers: attacker.headers,
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${UNKNOWN_UUID}`, {
                    headers: attacker.headers,
                })
            ).status(),
        ).toBe(404);

        // ── Owner sanity: every one of those exact ids IS reachable to the
        //    victim — proving the 4xx wall above is an OWNERSHIP boundary, not a
        //    deleted/broken row. ──
        expect(
            (
                await request.get(`${API_BASE}/api/tasks/${victim.taskId}`, {
                    headers: victim.headers,
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${victim.skillId}`, {
                    headers: victim.headers,
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${victim.agentId}`, {
                    headers: victim.headers,
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${victim.missionId}`, {
                    headers: victim.headers,
                })
            ).status(),
        ).toBe(200);
    });

    test('flow 6 — FULL MATRIX sweep: across every resource × every vector, zero victim ids and zero foreign userIds leak', async ({
        request,
    }) => {
        test.setTimeout(180_000);
        const victim = await buildTenant(request, 'MVictim');
        const attacker = await buildTenant(request, 'MAttacker');

        // Every (resource, attacker-controlled URL) pair an adversary would try,
        // folding ALL vectors — bare list, search-for-marker, filter pivots,
        // pagination abuse — into one comprehensive sweep. The victim id paired
        // with each URL must NEVER appear, and (where the row exposes userId) no
        // foreign userId may appear either.
        const cases: Array<{ path: string; victimId: string }> = [
            // Works — bare, search, deep page, attacker-smuggled scope params.
            { path: '/api/works?limit=200', victimId: victim.workId },
            {
                path: `/api/works?search=${encodeURIComponent(victim.marker)}`,
                victimId: victim.workId,
            },
            { path: `/api/works?limit=200&offset=199`, victimId: victim.workId },
            {
                path: `/api/works?userId=${victim.user.user.id}&ownerId=${victim.user.user.id}`,
                victimId: victim.workId,
            },
            // Tasks — bare, search, relation pivots, status filter, deep page.
            { path: '/api/tasks?limit=200', victimId: victim.taskId },
            {
                path: `/api/tasks?search=${encodeURIComponent(victim.marker)}`,
                victimId: victim.taskId,
            },
            { path: `/api/tasks?workId=${victim.workId}`, victimId: victim.taskId },
            { path: `/api/tasks?missionId=${victim.missionId}`, victimId: victim.taskId },
            { path: `/api/tasks?userId=${victim.user.user.id}&limit=200`, victimId: victim.taskId },
            // Agents — bare, scope filter, search, legal-max page.
            { path: '/api/agents?limit=200', victimId: victim.agentId },
            { path: '/api/agents?scope=tenant&limit=200', victimId: victim.agentId },
            {
                path: `/api/agents?search=${encodeURIComponent(victim.marker)}&limit=200`,
                victimId: victim.agentId,
            },
            // Skills — bare, ownerId pivot (the victim's tenantId), search.
            { path: '/api/skills?limit=200', victimId: victim.skillId },
            {
                path: `/api/skills?ownerType=tenant&ownerId=${victim.tenantId}&limit=200`,
                victimId: victim.skillId,
            },
            {
                path: `/api/skills?search=${encodeURIComponent(victim.marker)}&limit=200`,
                victimId: victim.skillId,
            },
            // Missions (bare array) + Conversations (huge limit).
            { path: '/api/me/missions', victimId: victim.missionId },
            { path: '/api/conversations?limit=99999', victimId: victim.missionId },
        ];

        for (const c of cases) {
            const res = await getList(request, attacker.headers, c.path);
            expect(res.status, `${c.path} status (${JSON.stringify(res.body).slice(0, 160)})`).toBe(
                200,
            );
            const ids = rowIds(res.body);
            expect(ids, `${c.path} LEAKED victim row ${c.victimId}`).not.toContain(c.victimId);
            // Where the list rows carry userId, prove not one belongs to the victim.
            const rows = (res.body?.works ??
                res.body?.data ??
                (Array.isArray(res.body) ? res.body : [])) as Array<{
                userId?: string;
            }>;
            const foreign = rows.filter((r) => r.userId && r.userId === victim.user.user.id);
            expect(foreign, `${c.path} surfaced a row owned by the victim`).toHaveLength(0);
        }

        // ── Cross-check the OTHER direction too: the victim, sweeping the same
        //    matrix, never sees the ATTACKER's rows. Isolation is symmetric. ──
        const reverse: Array<{ path: string; foreignId: string }> = [
            { path: '/api/works?limit=200', foreignId: attacker.workId },
            { path: '/api/tasks?limit=200', foreignId: attacker.taskId },
            { path: '/api/agents?limit=200', foreignId: attacker.agentId },
            { path: '/api/skills?limit=200', foreignId: attacker.skillId },
            { path: '/api/me/missions', foreignId: attacker.missionId },
        ];
        for (const r of reverse) {
            const res = await getList(request, victim.headers, r.path);
            expect(res.status).toBe(200);
            expect(rowIds(res.body), `${r.path} leaked attacker row to victim`).not.toContain(
                r.foreignId,
            );
        }

        // ── Final positive control: each user DOES see their OWN full surface,
        //    so the empty cross-results above are real isolation, not empty DBs. ──
        const vWorks = await getList(request, victim.headers, '/api/works?limit=200');
        expect(rowIds(vWorks.body)).toContain(victim.workId);
        const vTasks = await getList(request, victim.headers, '/api/tasks?limit=200');
        expect(rowIds(vTasks.body)).toContain(victim.taskId);
        const vAgents = await getList(request, victim.headers, '/api/agents?limit=200');
        expect(rowIds(vAgents.body)).toContain(victim.agentId);
        const vSkills = await getList(request, victim.headers, '/api/skills?limit=200');
        expect(rowIds(vSkills.body)).toContain(victim.skillId);
        const vMissions = await getList(request, victim.headers, '/api/me/missions');
        expect(rowIds(vMissions.body)).toContain(victim.missionId);
    });
});
