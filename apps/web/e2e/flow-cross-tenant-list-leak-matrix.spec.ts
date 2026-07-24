/**
 * Cross-tenant LIST-scoping leak matrix — the ownership-PARAMETER zoo × every
 * user-scoped list endpoint, with first-class coverage of the resources the
 * existing leak specs omit (missions / goals / inbound-triggers).
 *
 * A fresh peer B must NEVER see owner A's rows through ANY list query — no
 * matter which ownership-shaped parameter name an attacker smuggles into the
 * query string, and no matter whether the endpoint's DTO rejects the param or
 * silently strips it. Every list endpoint is server-side scoped to the caller's
 * OWN userId; the parameters below can only ever NARROW the caller's own rows,
 * never widen to a foreign tenant.
 *
 * ── Distinct from the two sibling matrices (this file is ADDITIVE, not a
 *    re-run):
 *   • flow-cross-tenant-leak-matrix.spec.ts owns the SEMANTIC-VECTOR angle —
 *     search terms, honoured relation filters (workId/missionId/parentTaskId),
 *     pagination/offset abuse and id/slug enumeration — on works/tasks/agents/
 *     skills/conversations. It never touches missions, goals, or inbound-
 *     triggers, and it does not systematically prove the param-NAME zoo.
 *   • flow-cross-tenant-security-matrix-2.spec.ts owns teams sub-resources,
 *     the trigger fire/mgmt boundary, schedules, goal-mission links and
 *     agent-approvals/agent-memory.
 *   THIS file owns: (a) the full ownership-param-NAME zoo
 *   [userId, ownerId, owner, tenant, org_id, organizationId, tenantId] applied
 *   uniformly to all 8 list endpoints; (b) the forbidNonWhitelisted-400 vs
 *   silently-stripped-200 DICHOTOMY as an explicit contract; (c) missions /
 *   goals / inbound-triggers list scoping + two-sided symmetry that the other
 *   leak spec never exercises.
 *
 * ── Verified LIVE against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before any assertion was written:
 *
 *   Default list shapes (fresh user, no rows):
 *     GET /api/works            → { status:'success', works:[], total:0, limit:20, offset:0 }
 *     GET /api/agents           → { data:[], meta:{ total, limit:50, offset:0 } }
 *     GET /api/tasks            → { data:[], meta:{ total, limit:50, offset:0 } }
 *     GET /api/skills           → { data:[], meta:{ total, limit:50, offset:0 } }
 *     GET /api/conversations    → { conversations:[], total:0 }
 *     GET /api/me/missions      → []                       (bare array)
 *     GET /api/me/goals         → []                       (bare array)
 *     GET /api/inbound-triggers → { triggers:[] }
 *
 *   Ownership-param zoo (attacker B smuggles A's userId as ?<name>=<A.uid>):
 *     works / tasks / conversations / missions / goals / inbound-triggers
 *       → the unknown param is STRIPPED, request 200s, B's own (empty) page is
 *         returned — A's row never appears.
 *     agents → EVERY zoo name is rejected 400 { message:['property <name>
 *         should not exist'] } (ListAgentsQueryDto is forbidNonWhitelisted; its
 *         only filters are scope/status/missionId/ideaId/workId/search/limit/offset).
 *     skills → the zoo names are rejected 400 EXCEPT `ownerId`, which is a
 *         WHITELISTED filter (ListSkillsQueryDto: ownerType/ownerId/search/
 *         limit/offset). The service calls findByUserIdFiltered(auth.userId,…),
 *         so ?ownerId=<A.uid> is ANDed with B's own userId → 0 rows for B while
 *         A's identical query returns A's skill. (The sharpest pivot: a filter
 *         that LOOKS like a scope override is provably ANDed with the caller.)
 *
 *   Whitelisted relation/scope filters cannot be weaponised:
 *     GET /api/agents?workId=<A.work> / ?missionId=<A.mission> / ?scope=tenant
 *       → 200 { data:[], … } for B (filter ANDed with B.userId), while A's own
 *         ?scope=tenant returns A's agent.
 *     GET /api/agents?limit=99999 → 400 ["limit must not be greater than 200"].
 *
 *   Direct id access on A's row as B:
 *     works → 403 (the works guard surfaces existence); agents / tasks /
 *     missions / skills / conversations / goals / inbound-triggers → 404 (no
 *     existence leak). A's own id → 200 (positive control).
 *
 *   Id boundary: malformed (non-uuid) id → 400 (ParseUUIDPipe) on agents /
 *     tasks / skills / conversations / me.goals / me.missions / inbound-
 *     triggers; works treats a non-uuid as a slug → 404. Unknown-but-valid uuid
 *     → 404 for every user-scoped resource.
 *
 *   Anonymous (no bearer) → 401 on every list base and every id route.
 *
 * ── Isolation discipline: FRESH registerUserViaAPI() principals per test (never
 *    the shared seeded user); unique suffixes via Date.now()+random; id
 *    membership asserted with toContain / not.toContain (the shard DB accumulates
 *    rows across tests, so never assert global counts); a fresh peer that created
 *    nothing has a deterministically EMPTY page, which we assert directly; codes
 *    asserted tolerantly ([403,404]) only where two valid policies coexist.
 *    Fully API-orchestrated with the safe `flow-` prefix.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    registerUserViaAPI,
    createWorkViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import { TRIGGERS_BASE, createTriggerViaAPI } from './helpers/triggers';

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

/** Every ownership-shaped query-param name an attacker might reach for. */
const OWNERSHIP_PARAM_ZOO = [
    'userId',
    'ownerId',
    'owner',
    'tenant',
    'org_id',
    'organizationId',
    'tenantId',
] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── local create helpers (no shared helper exists for these) ─────────────────

async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<{ id: string }> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'leak-matrix mission', type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createGoal(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<{ id: string }> {
    const res = await request.post(`${API_BASE}/api/me/goals`, {
        headers: authedHeaders(token),
        data: {
            title,
            metricSource: { pluginId: 'analytics', metricId: 'signups' },
            comparator: 'gte',
            targetValue: 100,
            unit: 'count',
            window: 'week',
        },
    });
    expect(res.status(), `createGoal body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createSkill(
    request: APIRequestContext,
    user: RegisteredUser,
    title: string,
): Promise<{ id: string; userId: string }> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(user.access_token),
        data: {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title,
            description: 'leak-matrix probe skill',
            instructionsMd: '# instructions\nbody',
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createConversation(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<{ id: string }> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: { title },
    });
    expect(res.status(), `createConversation body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/**
 * A list-endpoint descriptor: how to create one row and how to pull the id
 * array out of the (per-resource) list envelope.
 */
interface ListResource {
    label: string;
    listPath: string;
    idRoutePath: (id: string) => string;
    rows: (body: unknown) => Array<{ id: string; userId?: string }>;
    create: (
        request: APIRequestContext,
        user: RegisteredUser,
        s: string,
    ) => Promise<{ id: string }>;
    /** Direct-GET code for a foreign row (works surfaces 403; the rest 404). */
    crossGetCodes: number[];
    /** Malformed-id code (ParseUUIDPipe 400; works treats non-uuid as slug → 404). */
    malformedCode: number;
}

function rowsFrom(paths: string[]): (body: unknown) => Array<{ id: string; userId?: string }> {
    return (body: unknown) => {
        if (Array.isArray(body)) return body as Array<{ id: string; userId?: string }>;
        const b = body as Record<string, unknown>;
        for (const p of paths) {
            if (Array.isArray(b?.[p])) return b[p] as Array<{ id: string; userId?: string }>;
        }
        return [];
    };
}

const worksRes: ListResource = {
    label: 'works',
    listPath: '/api/works',
    idRoutePath: (id) => `/api/works/${id}`,
    rows: rowsFrom(['works']),
    create: (request, user, s) =>
        createWorkViaAPI(request, user.access_token, {
            name: `Leak Work ${s}`,
            slug: `leak-work-${s}`,
        }),
    crossGetCodes: [403, 404],
    malformedCode: 404,
};

const tasksRes: ListResource = {
    label: 'tasks',
    listPath: '/api/tasks',
    idRoutePath: (id) => `/api/tasks/${id}`,
    rows: rowsFrom(['data']),
    create: (request, user, s) =>
        createTaskViaAPI(request, user.access_token, { title: `Leak Task ${s}` }),
    crossGetCodes: [404],
    malformedCode: 400,
};

const conversationsRes: ListResource = {
    label: 'conversations',
    listPath: '/api/conversations',
    idRoutePath: (id) => `/api/conversations/${id}`,
    rows: rowsFrom(['conversations']),
    create: (request, user, s) => createConversation(request, user.access_token, `Leak Convo ${s}`),
    crossGetCodes: [404],
    malformedCode: 400,
};

const missionsRes: ListResource = {
    label: 'missions',
    listPath: '/api/me/missions',
    idRoutePath: (id) => `/api/me/missions/${id}`,
    rows: rowsFrom(['data']),
    create: (request, user, s) => createMission(request, user.access_token, `Leak Mission ${s}`),
    crossGetCodes: [404],
    malformedCode: 400,
};

const goalsRes: ListResource = {
    label: 'goals',
    listPath: '/api/me/goals',
    idRoutePath: (id) => `/api/me/goals/${id}`,
    rows: rowsFrom(['data']),
    create: (request, user, s) => createGoal(request, user.access_token, `Leak Goal ${s}`),
    crossGetCodes: [404],
    malformedCode: 400,
};

const triggersRes: ListResource = {
    label: 'inbound-triggers',
    listPath: '/api/inbound-triggers',
    idRoutePath: (id) => `/api/inbound-triggers/${id}`,
    rows: rowsFrom(['triggers']),
    create: async (request, user, s) => {
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `Leak Trigger ${s}`,
        });
        return { id: trigger.id };
    },
    crossGetCodes: [404],
    malformedCode: 400,
};

/** The endpoints whose DTO silently STRIPS unknown params (zoo → 200, no leak). */
const IGNORE_RESOURCES: ListResource[] = [
    worksRes,
    tasksRes,
    conversationsRes,
    missionsRes,
    goalsRes,
    triggersRes,
];

/** All eight, used by the direct-GET / anon / positive-control sweeps. */
const agentsRes: ListResource = {
    label: 'agents',
    listPath: '/api/agents',
    idRoutePath: (id) => `/api/agents/${id}`,
    rows: rowsFrom(['data']),
    create: (request, user, s) =>
        createAgentViaAPI(request, user.access_token, { scope: 'tenant', name: `Leak Agent ${s}` }),
    crossGetCodes: [404],
    malformedCode: 400,
};

const skillsRes: ListResource = {
    label: 'skills',
    listPath: '/api/skills',
    idRoutePath: (id) => `/api/skills/${id}`,
    rows: rowsFrom(['data']),
    create: (request, user, s) => createSkill(request, user, `Leak Skill ${s}`),
    crossGetCodes: [404],
    malformedCode: 400,
};

const ALL_RESOURCES: ListResource[] = [...IGNORE_RESOURCES, agentsRes, skillsRes];

// ════════════════════════════════════════════════════════════════════════════
// A — the ownership-param zoo never widens a fresh peer's list (strip → 200)
// ════════════════════════════════════════════════════════════════════════════
test.describe('Ownership-param zoo never widens a fresh peer (silently-stripped resources)', () => {
    for (const res of IGNORE_RESOURCES) {
        test(`${res.label}: B's list stays empty for every ?<ownership-param>=<A.uid>, A's own row is present`, async ({
            request,
        }) => {
            const a = await registerUserViaAPI(request);
            const b = await registerUserViaAPI(request);
            const s = stamp();
            const aRow = await res.create(request, a, s);

            // Positive control: A's own plain list DOES contain A's row, and every
            // returned row (where userId is projected) belongs to A.
            const aPlain = await request.get(`${API_BASE}${res.listPath}`, {
                headers: authedHeaders(a.access_token),
            });
            expect(aPlain.status()).toBe(200);
            const aRows = res.rows(await aPlain.json());
            expect(aRows.map((r) => r.id)).toContain(aRow.id);
            for (const r of aRows) {
                if (r.userId !== undefined) expect(r.userId).toBe(a.user.id);
            }

            // B smuggles A's identity through every ownership-shaped param name.
            for (const name of OWNERSHIP_PARAM_ZOO) {
                // value = A's userId (claiming to be A) AND, in a second pass,
                // A's row id (claiming to address A's row) — neither widens scope.
                for (const value of [a.user.id, aRow.id]) {
                    const res_ = await request.get(`${API_BASE}${res.listPath}?${name}=${value}`, {
                        headers: authedHeaders(b.access_token),
                    });
                    expect(res_.status(), `${res.label} ?${name}=${value}`).toBe(200);
                    const rows = res.rows(await res_.json());
                    expect(
                        rows.map((r) => r.id),
                        `${res.label} ?${name} leaked A's row`,
                    ).not.toContain(aRow.id);
                    // A fresh peer that created nothing sees a deterministically empty page.
                    expect(rows.length, `${res.label} ?${name} widened B's page`).toBe(0);
                }
            }
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// B — strict-DTO resources reject the zoo (forbidNonWhitelisted 400)
// ════════════════════════════════════════════════════════════════════════════
test.describe('Strict-DTO resources reject the ownership-param zoo (400), never leak', () => {
    test('agents: every ownership-param name is rejected 400 "should not exist"; A never appears in B', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const aAgent = await createAgentViaAPI(request, a.access_token, {
            scope: 'tenant',
            name: `Strict Agent ${s}`,
        });
        const bH = authedHeaders(b.access_token);

        for (const name of OWNERSHIP_PARAM_ZOO) {
            const r = await request.get(`${API_BASE}/api/agents?${name}=${a.user.id}`, {
                headers: bH,
            });
            expect(r.status(), `agents ?${name}`).toBe(400);
            expect(JSON.stringify(await r.json())).toContain('should not exist');
        }

        // A stray `scope=<uuid>` is rejected by the enum, not silently ignored.
        const badScope = await request.get(`${API_BASE}/api/agents?scope=${a.user.id}`, {
            headers: bH,
        });
        expect(badScope.status()).toBe(400);

        // B's clean list never contains A's agent; A's own list does.
        const bList = await request.get(`${API_BASE}/api/agents`, { headers: bH });
        expect(agentsRes.rows(await bList.json()).map((r) => r.id)).not.toContain(aAgent.id);
        const aList = await request.get(`${API_BASE}/api/agents`, {
            headers: authedHeaders(a.access_token),
        });
        expect(agentsRes.rows(await aList.json()).map((r) => r.id)).toContain(aAgent.id);
    });

    test("skills: non-whitelisted names 400; the WHITELISTED ?ownerId is ANDed with the caller's own userId", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const aSkill = await createSkill(request, a, `Strict Skill ${s}`);
        const bH = authedHeaders(b.access_token);

        // Every zoo name EXCEPT the genuine `ownerId` filter is rejected outright.
        for (const name of OWNERSHIP_PARAM_ZOO.filter((n) => n !== 'ownerId')) {
            const r = await request.get(`${API_BASE}/api/skills?${name}=${a.user.id}`, {
                headers: bH,
            });
            expect(r.status(), `skills ?${name}`).toBe(400);
            expect(JSON.stringify(await r.json())).toContain('should not exist');
        }

        // The crown jewel: ?ownerId is a REAL, whitelisted filter — so it 200s —
        // but the service scopes by the caller's userId, so passing A's uid as
        // ownerId (even qualified with ownerType=tenant) yields ZERO rows for B…
        for (const qualifier of ['', '&ownerType=tenant']) {
            const bOwnerId = await request.get(
                `${API_BASE}/api/skills?ownerId=${a.user.id}${qualifier}`,
                { headers: bH },
            );
            expect(bOwnerId.status()).toBe(200);
            const rows = skillsRes.rows(await bOwnerId.json());
            expect(rows.map((r) => r.id)).not.toContain(aSkill.id);
            expect(rows.length).toBe(0);
        }

        // …while A's identical query returns A's own skill (proves the filter is
        // live, and that the emptiness for B is the userId AND, not a broken param).
        const aOwnerId = await request.get(
            `${API_BASE}/api/skills?ownerId=${a.user.id}&ownerType=tenant`,
            { headers: authedHeaders(a.access_token) },
        );
        expect(aOwnerId.status()).toBe(200);
        expect(skillsRes.rows(await aOwnerId.json()).map((r) => r.id)).toContain(aSkill.id);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// C — whitelisted relation/scope filters are ANDed with the caller's userId
// ════════════════════════════════════════════════════════════════════════════
test.describe("Honoured filters are ANDed with the caller's userId, not a scope override", () => {
    test("agents: smuggling A's real workId/missionId/scope/status into B's filter yields nothing", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        // A owns a work + a mission + a work/mission-scoped-ish agent surface.
        const { id: aWorkId } = await createWorkViaAPI(request, a.access_token, {
            name: `Rel Work ${s}`,
            slug: `rel-work-${s}`,
        });
        const aMission = await createMission(request, a.access_token, `Rel Mission ${s}`);
        const aAgent = await createAgentViaAPI(request, a.access_token, {
            scope: 'tenant',
            name: `Rel Agent ${s}`,
        });
        const bH = authedHeaders(b.access_token);

        for (const qs of [
            `workId=${aWorkId}`,
            `missionId=${aMission.id}`,
            `scope=tenant`,
            `status=draft`,
            `scope=tenant&status=draft`,
        ]) {
            const r = await request.get(`${API_BASE}/api/agents?${qs}`, { headers: bH });
            expect(r.status(), `agents ?${qs}`).toBe(200);
            expect(agentsRes.rows(await r.json()).length, `agents ?${qs} widened B`).toBe(0);
        }

        // A's own scope=tenant filter DOES surface A's agent (the filter works).
        const aScoped = await request.get(`${API_BASE}/api/agents?scope=tenant`, {
            headers: authedHeaders(a.access_token),
        });
        expect(agentsRes.rows(await aScoped.json()).map((r) => r.id)).toContain(aAgent.id);
    });

    test('agents: pagination knobs are DTO-clamped and never page into a foreign tenant', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aAgent = await createAgentViaAPI(request, a.access_token, {
            scope: 'tenant',
            name: `Page Agent ${stamp()}`,
        });
        const bH = authedHeaders(b.access_token);

        // limit above the DTO ceiling is a hard 400 (no silent overflow-then-leak).
        const over = await request.get(`${API_BASE}/api/agents?limit=99999`, { headers: bH });
        expect(over.status()).toBe(400);
        expect(JSON.stringify(await over.json())).toContain('limit must not be greater than 200');

        // A legal deep page still returns B's empty slice — A's agent never leaks.
        const deep = await request.get(`${API_BASE}/api/agents?limit=200&offset=0`, {
            headers: bH,
        });
        expect(deep.status()).toBe(200);
        expect(agentsRes.rows(await deep.json()).map((r) => r.id)).not.toContain(aAgent.id);
    });

    test('missions/goals/inbound-triggers: pagination params never widen a fresh peer', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const aMission = await createMission(request, a.access_token, `Pg Mission ${s}`);
        const aGoal = await createGoal(request, a.access_token, `Pg Goal ${s}`);
        const { trigger: aTrig } = await createTriggerViaAPI(request, a.access_token, {
            name: `Pg Trigger ${s}`,
        });
        const bH = authedHeaders(b.access_token);

        const cases: Array<[ListResource, string]> = [
            [missionsRes, aMission.id],
            [goalsRes, aGoal.id],
            [triggersRes, aTrig.id],
        ];
        for (const [res, aId] of cases) {
            for (const qs of ['limit=100', 'offset=1000', 'limit=1&offset=0', 'limit=99999']) {
                const r = await request.get(`${API_BASE}${res.listPath}?${qs}`, { headers: bH });
                expect(r.status(), `${res.label} ?${qs}`).toBe(200);
                expect(res.rows(await r.json()).map((x) => x.id)).not.toContain(aId);
            }
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// D — two-sided symmetry: when BOTH tenants own rows, neither list bleeds
// ════════════════════════════════════════════════════════════════════════════
test.describe('Two-sided symmetry: both tenants own a row, neither list bleeds', () => {
    for (const res of [
        missionsRes,
        goalsRes,
        triggersRes,
        conversationsRes,
        agentsRes,
        skillsRes,
    ]) {
        test(`${res.label}: A's list has A-only, B's list has B-only (id membership both ways)`, async ({
            request,
        }) => {
            const a = await registerUserViaAPI(request);
            const b = await registerUserViaAPI(request);
            const s = stamp();
            const aRow = await res.create(request, a, `${s}-a`);
            const bRow = await res.create(request, b, `${s}-b`);
            expect(aRow.id).not.toBe(bRow.id);

            const aList = await request.get(`${API_BASE}${res.listPath}`, {
                headers: authedHeaders(a.access_token),
            });
            const bList = await request.get(`${API_BASE}${res.listPath}`, {
                headers: authedHeaders(b.access_token),
            });
            expect(aList.status()).toBe(200);
            expect(bList.status()).toBe(200);
            const aIds = res.rows(await aList.json()).map((r) => r.id);
            const bIds = res.rows(await bList.json()).map((r) => r.id);

            expect(aIds).toContain(aRow.id);
            expect(aIds).not.toContain(bRow.id);
            expect(bIds).toContain(bRow.id);
            expect(bIds).not.toContain(aRow.id);
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// E — direct id access on a peer's row is 404/403, never 200
// ════════════════════════════════════════════════════════════════════════════
test.describe('Direct id access on a peer row is 404/403, never 200', () => {
    test("every resource: B GET on A's real id is walled off; A's own GET is 200", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const bH = authedHeaders(b.access_token);
        const aH = authedHeaders(a.access_token);

        for (const res of ALL_RESOURCES) {
            const row = await res.create(request, a, `${s}-${res.label}`);
            const url = `${API_BASE}${res.idRoutePath(row.id)}`;

            const cross = await request.get(url, { headers: bH });
            expect(res.crossGetCodes, `${res.label} cross-GET`).toContain(cross.status());
            expect(cross.status(), `${res.label} cross-GET must not be 200`).not.toBe(200);

            const own = await request.get(url, { headers: aH });
            expect(own.status(), `${res.label} owner-GET`).toBe(200);
        }
    });

    test("mutating id routes on a peer's row are 404 (no existence leak via 403)", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const bH = authedHeaders(b.access_token);

        // Resources with straightforward PATCH+DELETE id routes that 404 cross-tenant.
        const agent = await createAgentViaAPI(request, a.access_token, {
            scope: 'tenant',
            name: `Mut Agent ${s}`,
        });
        const skill = await createSkill(request, a, `Mut Skill ${s}`);
        const convo = await createConversation(request, a.access_token, `Mut Convo ${s}`);
        const goal = await createGoal(request, a.access_token, `Mut Goal ${s}`);
        const trig = (await createTriggerViaAPI(request, a.access_token, { name: `Mut Trig ${s}` }))
            .trigger;

        const patchTargets: Array<[string, string, Record<string, unknown>]> = [
            ['agents', `${API_BASE}/api/agents/${agent.id}`, { name: 'pwned' }],
            ['skills', `${API_BASE}/api/skills/${skill.id}`, { title: 'pwned' }],
            ['conversations', `${API_BASE}/api/conversations/${convo.id}`, { title: 'pwned' }],
            ['goals', `${API_BASE}/api/me/goals/${goal.id}`, { title: 'pwned' }],
            ['inbound-triggers', `${TRIGGERS_BASE}/${trig.id}`, { name: 'pwned' }],
        ];
        for (const [label, url, body] of patchTargets) {
            const p = await request.patch(url, { headers: bH, data: body });
            expect(p.status(), `${label} cross-PATCH`).toBe(404);
            const d = await request.delete(url, { headers: bH });
            expect(d.status(), `${label} cross-DELETE`).toBe(404);
        }

        // Positive control: A's agent survived the hijack — name intact.
        const reread = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(reread.status()).toBe(200);
        expect((await reread.json()).name).not.toBe('pwned');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// F — id boundary: malformed uuid vs unknown-but-valid uuid
// ════════════════════════════════════════════════════════════════════════════
test.describe('Id boundary: malformed vs unknown uuid', () => {
    test('a malformed (non-uuid) id is a pipe-level 400 on strict routes; works treats it as a slug (404)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const res of ALL_RESOURCES) {
            const r = await request.get(`${API_BASE}${res.idRoutePath('not-a-uuid')}`, {
                headers: H,
            });
            expect(r.status(), `${res.label} malformed id`).toBe(res.malformedCode);
        }
    });

    test('an unknown-but-valid uuid is 404 for every user-scoped resource (never 200)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        for (const res of ALL_RESOURCES) {
            const r = await request.get(`${API_BASE}${res.idRoutePath(UNKNOWN_UUID)}`, {
                headers: H,
            });
            // works surfaces 403/404 via its guard; the rest are a clean 404.
            expect(res.crossGetCodes, `${res.label} unknown uuid`).toContain(r.status());
            expect(r.status(), `${res.label} unknown uuid must not be 200`).not.toBe(200);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// G — anonymous callers are uniformly rejected (401)
// ════════════════════════════════════════════════════════════════════════════
test.describe('Anonymous callers are uniformly rejected (401)', () => {
    test('every list base 401s without a bearer', async ({ request }) => {
        for (const res of ALL_RESOURCES) {
            const r = await request.get(`${API_BASE}${res.listPath}`);
            expect(r.status(), `${res.label} anon list`).toBe(401);
        }
    });

    test('every id route 401s without a bearer (auth guard fires before ownership)', async ({
        request,
    }) => {
        for (const res of ALL_RESOURCES) {
            const r = await request.get(`${API_BASE}${res.idRoutePath(UNKNOWN_UUID)}`);
            expect(r.status(), `${res.label} anon id`).toBe(401);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// H — positive control: A's full surface survives B's leak sweep intact
// ════════════════════════════════════════════════════════════════════════════
test.describe("Positive control — A's surface survives B's full leak sweep", () => {
    test("after B hammers every list-leak vector, each of A's rows is still present & owned by A", async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const bH = authedHeaders(b.access_token);
        const aH = authedHeaders(a.access_token);

        // A builds one of every resource.
        const created = new Map<string, string>();
        for (const res of ALL_RESOURCES) {
            const row = await res.create(request, a, `${s}-${res.label}`);
            created.set(res.label, row.id);
        }

        // B sweeps every list with every ownership-param name (tolerating the
        // 400s the strict DTOs raise — a 400 is still a non-leak).
        for (const res of ALL_RESOURCES) {
            for (const name of OWNERSHIP_PARAM_ZOO) {
                const r = await request.get(`${API_BASE}${res.listPath}?${name}=${a.user.id}`, {
                    headers: bH,
                });
                expect([200, 400], `${res.label} ?${name}`).toContain(r.status());
                if (r.status() === 200) {
                    expect(res.rows(await r.json()).map((x) => x.id)).not.toContain(
                        created.get(res.label),
                    );
                }
            }
        }

        // A re-reads: every row is still visible to its owner and still A's.
        for (const res of ALL_RESOURCES) {
            const id = created.get(res.label)!;
            const list = await request.get(`${API_BASE}${res.listPath}`, { headers: aH });
            expect(list.status()).toBe(200);
            expect(
                res.rows(await list.json()).map((r) => r.id),
                `${res.label} lost row`,
            ).toContain(id);
            const detail = await request.get(`${API_BASE}${res.idRoutePath(id)}`, { headers: aH });
            expect(detail.status(), `${res.label} owner detail`).toBe(200);
        }
    });
});
