/**
 * Teams & Prebuilt Companies — LIST ORDERING + ARRAY-SHAPE CONTRACTS, DEEP (#1647 / #1713).
 *
 * The Teams surface already has CRUD / hierarchy / attach-detach coverage
 * (flow-teams-crud-deep, flow-teams-org-chart-hierarchy-deep,
 * flow-team-resources-matrix-deep). This file takes the DISTINCT angle those
 * skip: the *read-side ordering + array contracts* of the four flat
 * projections, pinned exactly against a live stack:
 *
 *   • GET /api/organizations/:org/teams — a BARE array (never {data,meta}),
 *     ordered by name ASC under the sqlite BINARY collation (case-sensitive,
 *     codepoint order: digits < UPPERCASE < lowercase) and LEXICOGRAPHIC not
 *     numeric ('Charlie10' < 'Charlie2', '10-team' < '2-team'). A mid-alphabet
 *     insert lands in sorted position (not appended); the order is stable
 *     across re-reads; an empty org → []; the list is strictly org-scoped.
 *   • The list is UN-PAGINATED and UN-FILTERED: ?limit / ?offset / ?sort /
 *     ?order / ?q / ?status / ?page are all INERT (full set, fixed name-ASC
 *     order, no client override), and an SQL-injection-style sort/filter is
 *     harmless (no 5xx, order + rows intact).
 *   • GET .../org-chart — { organization{id,slug,displayName}, teams[], agents[],
 *     members[] } with a LEAN team-node projection
 *     {id,slug,name,avatarIcon,parentTeamId,managerAgentId} (no description /
 *     createdAt / organizationId), whose order mirrors the flat list byte-for-
 *     byte. agents[] carry {id,name,title,status,avatarIcon,reportsToAgentId,
 *     teamIds} incl. tenant-wide agents; members[] always carries the tenant
 *     owner {userId,name,avatarUrl,teamIds}; a fresh org → teams:[] agents:[]
 *     members:[owner].
 *   • GET .../teams/:teamId/resources — grouped-by-type contract: EXACTLY the
 *     five keys {work,task,agent,mission,idea} (empty arrays, never missing),
 *     each bucket ordered createdAt ASC (insertion order); item shape
 *     {id,resourceType,resourceId,name,slug,addedById,createdAt}.
 *   • GET .../resource-teams — reverse lookup ResourceTeamRef[] keyed by
 *     teamId (not id) {teamId,name,slug}, ordered name ASC (BINARY), org-scoped,
 *     and [] (200, no 404 — no existence check) for an unattached/unknown id.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. The BINARY-collation ordering was
 *    reproduced with a scrambled create order; JS's default Array.sort() equals
 *    that codepoint order for the ASCII names used here, so `toEqual([...].sort())`
 *    is a faithful oracle for "ORDER BY name ASC".
 *
 * Isolation discipline: every test builds a FRESH registerUserViaAPI() owner +
 * a lazily-minted org (via buildOwnerCtx), so each org's team list contains
 * ONLY that test's rows — the shard DB's accumulation never leaks in. Fully
 * API-orchestrated (safe `flow-` prefix, not matched by the no-auth testIgnore
 * regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI } from './helpers/agents-tasks';
import {
    buildOwnerCtx,
    createTeamViaAPI,
    teamStamp,
    teamsBase,
    type OwnerCtx,
    type TeamResponse,
} from './helpers/teams';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Create the given team names IN ORDER; returns [{name,id,slug}] in create order. */
async function createTeams(
    request: APIRequestContext,
    ctx: OwnerCtx,
    names: string[],
): Promise<Array<{ name: string; id: string; slug: string }>> {
    const out: Array<{ name: string; id: string; slug: string }> = [];
    for (const name of names) {
        const t = await createTeamViaAPI(request, ctx, { name });
        out.push({ name, id: t.id, slug: t.slug });
    }
    return out;
}

async function listTeams(
    request: APIRequestContext,
    ctx: OwnerCtx,
    query = '',
): Promise<TeamResponse[]> {
    const res = await request.get(`${teamsBase(ctx.orgId)}/teams${query}`, {
        headers: ctx.headers,
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

const namesOf = (teams: Array<{ name: string }>): string[] => teams.map((t) => t.name);

/** Assert the sequence is in BINARY (codepoint) ascending order — the exact
 *  posture of sqlite `ORDER BY name ASC`. JS default sort == codepoint for ASCII. */
function expectNameAscBinary(names: string[]): void {
    expect(names).toEqual([...names].sort());
}

// A fixed scrambled create order whose BINARY-sorted result is hand-verified
// against the live stack. Every name slugifies to a DISTINCT slug (no 409s).
const SCRAMBLED = [
    'Zulu',
    'Bravo',
    'Charlie10',
    'Charlie2',
    'Delta',
    'Zebra',
    'aardvark',
    'alpha',
    '10-team',
    '2-team',
];
const SCRAMBLED_ASC = [
    '10-team',
    '2-team',
    'Bravo',
    'Charlie10',
    'Charlie2',
    'Delta',
    'Zebra',
    'Zulu',
    'aardvark',
    'alpha',
];

test.describe('Teams flat list — name-ASC ordering contract (BINARY collation)', () => {
    test('list is a bare array; a scrambled create order comes back name-ASC with every id present', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'ListShape');
        const created = await createTeams(request, ctx, SCRAMBLED);

        const teams = await listTeams(request, ctx);
        expect(Array.isArray(teams)).toBe(true); // bare array, not { data, meta }
        expect(teams).toHaveLength(SCRAMBLED.length); // org-scoped fresh org → exact
        // Every created id is present (toContain, never a global count).
        const ids = teams.map((t) => t.id);
        for (const c of created) expect(ids).toContain(c.id);
        expectNameAscBinary(namesOf(teams));
    });

    test('sqlite BINARY collation pinned: digits < UPPERCASE < lowercase, exact expected order', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'Binary');
        await createTeams(request, ctx, SCRAMBLED);

        const teams = await listTeams(request, ctx);
        // Hard pin: the whole sequence equals the hand-verified BINARY order.
        expect(namesOf(teams)).toEqual(SCRAMBLED_ASC);
    });

    test('ordering is LEXICOGRAPHIC not numeric: Charlie10 < Charlie2 and 10-team < 2-team', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'Lexico');
        await createTeams(request, ctx, ['Charlie2', 'Charlie10', '2-team', '10-team']);

        const names = namesOf(await listTeams(request, ctx));
        expect(names.indexOf('Charlie10')).toBeLessThan(names.indexOf('Charlie2'));
        expect(names.indexOf('10-team')).toBeLessThan(names.indexOf('2-team'));
        expectNameAscBinary(names);
    });

    test('duplicate display names (distinct slugs) sit adjacent; the sequence stays non-decreasing', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'DupName');
        const dup = `Bravo Dup ${teamStamp()}`;
        // Same name, two explicit distinct slugs — name is not unique, slug is.
        await createTeamViaAPI(request, ctx, { name: dup, slug: `dup-a-${teamStamp()}` });
        await createTeamViaAPI(request, ctx, { name: dup, slug: `dup-b-${teamStamp()}` });
        await createTeamViaAPI(request, ctx, { name: `Zeta Wrap ${teamStamp()}` });
        await createTeamViaAPI(request, ctx, { name: `Aaron Wrap ${teamStamp()}` });

        const names = namesOf(await listTeams(request, ctx));
        // Both duplicates present and ADJACENT (equal keys cluster).
        const first = names.indexOf(dup);
        const last = names.lastIndexOf(dup);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(last).toBe(first + 1);
        // Tie-tolerant monotonicity: comparing by name, the array is sorted.
        expectNameAscBinary(names);
    });

    test('a mid-alphabet insert lands in sorted position on re-read (not appended)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'Insert');
        await createTeams(request, ctx, ['Alpha', 'Gamma', 'Zulu']);
        const inserted = await createTeamViaAPI(request, ctx, { name: 'Mango' });

        const names = namesOf(await listTeams(request, ctx));
        const idx = names.indexOf('Mango');
        expect(idx).toBe(2); // Alpha, Gamma, Mango, Zulu — position 2, not last
        expect(names).toEqual(['Alpha', 'Gamma', 'Mango', 'Zulu']);
        expect(inserted.name).toBe('Mango');
    });

    test('ordering is deterministic and stable across repeated reads', async ({ request }) => {
        const ctx = await buildOwnerCtx(request, 'Stable');
        await createTeams(request, ctx, ['pluto', 'Ceres', 'Mars', 'earth', 'Venus']);

        const a = namesOf(await listTeams(request, ctx));
        const b = namesOf(await listTeams(request, ctx));
        const c = namesOf(await listTeams(request, ctx));
        expect(b).toEqual(a);
        expect(c).toEqual(a);
        expectNameAscBinary(a);
    });

    test('an empty org lists []; the list is strictly org-scoped (a co-owned org’s teams never leak in)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'Scope');
        // Fresh org, no teams yet.
        expect(await listTeams(request, ctx)).toEqual([]);

        const here = await createTeamViaAPI(request, ctx, { name: `Here ${teamStamp()}` });
        // A SECOND org owned by the same user.
        const org2 = await createOrganizationViaAPI(request, ctx.token, `Scope2 ${teamStamp()}`);
        const ctx2: OwnerCtx = { ...ctx, org: org2, orgId: org2.id };
        const there = await createTeamViaAPI(request, ctx2, { name: `There ${teamStamp()}` });

        const org1Ids = (await listTeams(request, ctx)).map((t) => t.id);
        const org2Ids = (await listTeams(request, ctx2)).map((t) => t.id);
        expect(org1Ids).toContain(here.id);
        expect(org1Ids).not.toContain(there.id);
        expect(org2Ids).toContain(there.id);
        expect(org2Ids).not.toContain(here.id);
    });
});

test.describe('Teams flat list — query params are inert (server-fixed ordering)', () => {
    test('?limit and ?offset do NOT paginate — the full set returns, order unchanged', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'NoPage');
        await createTeams(request, ctx, SCRAMBLED);

        const full = namesOf(await listTeams(request, ctx));
        const limited = namesOf(await listTeams(request, ctx, '?limit=2'));
        const offset = namesOf(await listTeams(request, ctx, '?offset=5'));
        expect(limited).toEqual(full); // limit ignored
        expect(offset).toEqual(full); // offset ignored
        expect(full).toEqual(SCRAMBLED_ASC);
    });

    test('?sort=name:desc / ?order=desc cannot flip the fixed name-ASC ordering', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'NoSort');
        await createTeams(request, ctx, SCRAMBLED);

        const asc = SCRAMBLED_ASC;
        const desc = [...SCRAMBLED_ASC].reverse();
        const got = namesOf(
            await listTeams(request, ctx, '?sort=name:desc&order=desc&sortDir=desc'),
        );
        expect(got).toEqual(asc); // still ascending
        expect(got).not.toEqual(desc); // the client hint was ignored
    });

    test('?q / ?status / ?page filter hints are ignored — the whole set returns', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'NoFilter');
        await createTeams(request, ctx, SCRAMBLED);

        const got = namesOf(
            await listTeams(request, ctx, '?q=zzz-nomatch&status=archived&page=3&pageSize=1'),
        );
        expect(got).toEqual(SCRAMBLED_ASC); // filters inert, full set, ordered
    });

    test('an SQL-injection-style sort/filter is inert: no 5xx, rows + order intact afterward', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'Injection');
        await createTeams(request, ctx, SCRAMBLED);

        const evilSort = encodeURIComponent('name); DROP TABLE teams;--');
        const evilQ = encodeURIComponent("' OR '1'='1");
        const res = await request.get(`${teamsBase(ctx.orgId)}/teams?sort=${evilSort}&q=${evilQ}`, {
            headers: ctx.headers,
        });
        expect(res.status()).toBe(200); // definitely not a 5xx
        expect(namesOf(await res.json())).toEqual(SCRAMBLED_ASC);
        // The table is very much still there and unchanged.
        expect(namesOf(await listTeams(request, ctx))).toEqual(SCRAMBLED_ASC);
    });
});

test.describe('Org chart — node-array contract', () => {
    async function getChart(request: APIRequestContext, ctx: OwnerCtx) {
        const res = await request.get(`${teamsBase(ctx.orgId)}/org-chart`, {
            headers: ctx.headers,
        });
        expect(res.status(), `org-chart body=${await res.text().catch(() => '')}`).toBe(200);
        return res.json();
    }

    test('top-level payload has EXACTLY { organization, teams, agents, members } with the org sub-shape', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'ChartKeys');
        const chart = await getChart(request, ctx);
        expect(Object.keys(chart).sort()).toEqual(['agents', 'members', 'organization', 'teams']);
        expect(Object.keys(chart.organization).sort()).toEqual(['displayName', 'id', 'slug']);
        expect(chart.organization.id).toBe(ctx.orgId);
        expect(chart.organization.slug).toBe(ctx.org.slug);
        expect(Array.isArray(chart.teams)).toBe(true);
        expect(Array.isArray(chart.agents)).toBe(true);
        expect(Array.isArray(chart.members)).toBe(true);
    });

    test('teams[] use the LEAN projection and mirror the flat list order byte-for-byte', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'ChartLean');
        await createTeams(request, ctx, SCRAMBLED);

        const chart = await getChart(request, ctx);
        const flatNames = namesOf(await listTeams(request, ctx));
        const chartNames = chart.teams.map((t: { name: string }) => t.name);
        expect(chartNames).toEqual(flatNames); // same ordering source
        expect(chartNames).toEqual(SCRAMBLED_ASC);
        // Lean node: no description / createdAt / organizationId / updatedAt.
        for (const node of chart.teams) {
            expect(Object.keys(node).sort()).toEqual([
                'avatarIcon',
                'id',
                'managerAgentId',
                'name',
                'parentTeamId',
                'slug',
            ]);
            expect(node).not.toHaveProperty('description');
            expect(node).not.toHaveProperty('createdAt');
            expect(node).not.toHaveProperty('organizationId');
        }
    });

    test('teams[] parentTeamId edges mirror the real tree (flat list is the source of truth)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'ChartTree');
        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `Child ${teamStamp()}`,
            parentTeamId: root.id,
        });

        const chart = await getChart(request, ctx);
        const byId = new Map(chart.teams.map((t: { id: string }) => [t.id, t]));
        expect((byId.get(root.id) as { parentTeamId: string | null }).parentTeamId).toBeNull();
        expect((byId.get(child.id) as { parentTeamId: string | null }).parentTeamId).toBe(root.id);
    });

    test('agents[] carry the full node shape; a tenant-wide agent appears with its teamIds projection', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'ChartAgents');
        const agent = await createAgentViaAPI(request, ctx.token, {
            name: `Chart Agent ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, { name: `Agent Home ${teamStamp()}` });
        // Enrol the agent so its teamIds projection is non-trivial.
        const addRes = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: agent.id, role: 'lead' },
        });
        expect(addRes.status()).toBe(201);

        const chart = await getChart(request, ctx);
        const node = chart.agents.find((a: { id: string }) => a.id === agent.id);
        expect(node, 'tenant-wide agent must appear on the chart').toBeTruthy();
        expect(Object.keys(node).sort()).toEqual([
            'avatarIcon',
            'id',
            'name',
            'reportsToAgentId',
            'status',
            'teamIds',
            'title',
        ]);
        expect(typeof node.status).toBe('string');
        expect(Array.isArray(node.teamIds)).toBe(true);
        expect(node.teamIds).toContain(team.id);
    });

    test('members[] always carries the tenant owner; teamIds is empty until the owner joins a team', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'ChartMembers');
        const ownerUserId = ctx.user.user.id;

        let chart = await getChart(request, ctx);
        let ownerNode = chart.members.find((m: { userId: string }) => m.userId === ownerUserId);
        expect(ownerNode, 'owner is always on the chart').toBeTruthy();
        expect(Object.keys(ownerNode).sort()).toEqual(['avatarUrl', 'name', 'teamIds', 'userId']);
        expect(ownerNode.teamIds).toEqual([]); // no roster membership yet

        const team = await createTeamViaAPI(request, ctx, { name: `Owner Team ${teamStamp()}` });
        const addRes = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: ownerUserId, role: 'member' },
        });
        expect(addRes.status()).toBe(201);

        chart = await getChart(request, ctx);
        ownerNode = chart.members.find((m: { userId: string }) => m.userId === ownerUserId);
        expect(ownerNode.teamIds).toContain(team.id); // projection now reflects it
    });

    test('a fresh org’s chart is teams:[], agents:[], members:[owner]', async ({ request }) => {
        const ctx = await buildOwnerCtx(request, 'ChartEmpty');
        const chart = await getChart(request, ctx);
        expect(chart.teams).toEqual([]);
        expect(chart.agents).toEqual([]);
        // Exactly the tenant owner — a fresh tenant has one human.
        expect(chart.members).toHaveLength(1);
        expect(chart.members[0].userId).toBe(ctx.user.user.id);
        expect(chart.members[0].teamIds).toEqual([]);
    });
});

test.describe('Team resources — grouped-by-type contract', () => {
    async function listResources(request: APIRequestContext, ctx: OwnerCtx, teamId: string) {
        const res = await request.get(`${teamsBase(ctx.orgId)}/teams/${teamId}/resources`, {
            headers: ctx.headers,
        });
        expect(res.status(), `resources body=${await res.text().catch(() => '')}`).toBe(200);
        return res.json();
    }

    async function attachWork(
        request: APIRequestContext,
        ctx: OwnerCtx,
        teamId: string,
        workId: string,
    ) {
        const res = await request.post(`${teamsBase(ctx.orgId)}/teams/${teamId}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workId },
        });
        expect(res.status(), `attach body=${await res.text().catch(() => '')}`).toBe(201);
        return res.json();
    }

    test('an empty team lists EXACTLY the five buckets, all empty arrays (never missing keys)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'Buckets');
        const team = await createTeamViaAPI(request, ctx, { name: `Empty Buckets ${teamStamp()}` });
        const grouped = await listResources(request, ctx, team.id);
        expect(Object.keys(grouped).sort()).toEqual(['agent', 'idea', 'mission', 'task', 'work']);
        for (const key of ['work', 'task', 'agent', 'mission', 'idea']) {
            expect(grouped[key]).toEqual([]);
        }
    });

    test('within a bucket, order is createdAt ASC (insertion order); item shape is pinned', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const ctx = await buildOwnerCtx(request, 'BucketOrder');
        const team = await createTeamViaAPI(request, ctx, { name: `Ordered ${teamStamp()}` });

        const inserted: string[] = [];
        for (let i = 0; i < 3; i++) {
            const w = await createWorkViaAPI(request, ctx.token, {
                name: `Ordered Work ${i} ${teamStamp()}`,
            });
            const item = await attachWork(request, ctx, team.id, w.id);
            // Item shape pinned on the attach response.
            expect(Object.keys(item).sort()).toEqual([
                'addedById',
                'createdAt',
                'id',
                'name',
                'resourceId',
                'resourceType',
                'slug',
            ]);
            expect(item.resourceType).toBe('work');
            expect(item.resourceId).toBe(w.id);
            expect(item.id).toMatch(UUID_RE);
            inserted.push(w.id);
            // ms-precision createdAt is preserved through the DB round-trip; a
            // gap guarantees distinct timestamps so insertion order is strict.
            if (i < 2) await sleep(1100);
        }

        const grouped = await listResources(request, ctx, team.id);
        const bucketIds = grouped.work.map((it: { resourceId: string }) => it.resourceId);
        expect(bucketIds).toEqual(inserted); // exact insertion order
        // createdAt is monotonic non-decreasing (tie-tolerant belt-and-braces).
        const times = grouped.work.map((it: { createdAt: string }) => Date.parse(it.createdAt));
        for (let i = 1; i < times.length; i++) {
            expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
        }
    });

    test('mixed resource types land each in its own bucket; the others stay []', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'MixedBuckets');
        const team = await createTeamViaAPI(request, ctx, { name: `Mixed ${teamStamp()}` });

        const work = await createWorkViaAPI(request, ctx.token, {
            name: `Mixed Work ${teamStamp()}`,
        });
        const agent = await createAgentViaAPI(request, ctx.token, {
            name: `Mixed Agent ${teamStamp()}`,
        });
        await attachWork(request, ctx, team.id, work.id);
        const attachAgent = await request.post(
            `${teamsBase(ctx.orgId)}/teams/${team.id}/resources`,
            { headers: ctx.headers, data: { resourceType: 'agent', resourceId: agent.id } },
        );
        expect(attachAgent.status()).toBe(201);

        const grouped = await listResources(request, ctx, team.id);
        expect(grouped.work.map((i: { resourceId: string }) => i.resourceId)).toEqual([work.id]);
        expect(grouped.agent.map((i: { resourceId: string }) => i.resourceId)).toEqual([agent.id]);
        // The three untouched buckets remain empty arrays.
        expect(grouped.task).toEqual([]);
        expect(grouped.mission).toEqual([]);
        expect(grouped.idea).toEqual([]);
        // The agent bucket resolves the display name.
        expect(grouped.agent[0].name).toBe(agent.name);
    });

    test('detach removes only from its own bucket and preserves the remaining insertion order', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const ctx = await buildOwnerCtx(request, 'DetachOrder');
        const team = await createTeamViaAPI(request, ctx, { name: `Detach ${teamStamp()}` });

        const works: string[] = [];
        for (let i = 0; i < 3; i++) {
            const w = await createWorkViaAPI(request, ctx.token, {
                name: `Detach W${i} ${teamStamp()}`,
            });
            await attachWork(request, ctx, team.id, w.id);
            works.push(w.id);
            if (i < 2) await sleep(1100);
        }
        // Detach the MIDDLE one.
        const del = await request.delete(
            `${teamsBase(ctx.orgId)}/teams/${team.id}/resources/work/${works[1]}`,
            { headers: ctx.headers },
        );
        expect(del.status()).toBe(204);

        const grouped = await listResources(request, ctx, team.id);
        const remaining = grouped.work.map((i: { resourceId: string }) => i.resourceId);
        expect(remaining).toEqual([works[0], works[2]]); // order of survivors intact
        expect(remaining).not.toContain(works[1]);
    });
});

test.describe('Resource-teams reverse lookup — keyed teamId, name-ASC', () => {
    async function reverseLookup(
        request: APIRequestContext,
        ctx: OwnerCtx,
        resourceType: string,
        resourceId: string,
    ) {
        const res = await request.get(
            `${teamsBase(ctx.orgId)}/resource-teams?resourceType=${resourceType}&resourceId=${resourceId}`,
            { headers: ctx.headers },
        );
        expect(res.status(), `reverse body=${await res.text().catch(() => '')}`).toBe(200);
        return res.json();
    }

    async function attach(
        request: APIRequestContext,
        ctx: OwnerCtx,
        teamId: string,
        workId: string,
    ) {
        const res = await request.post(`${teamsBase(ctx.orgId)}/teams/${teamId}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workId },
        });
        expect(res.status()).toBe(201);
    }

    test('a single owning team returns one ResourceTeamRef keyed by teamId (not id) with name + slug', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'RevShape');
        const team = await createTeamViaAPI(request, ctx, { name: `Owner ${teamStamp()}` });
        const work = await createWorkViaAPI(request, ctx.token, {
            name: `Rev Work ${teamStamp()}`,
        });
        await attach(request, ctx, team.id, work.id);

        const refs = await reverseLookup(request, ctx, 'work', work.id);
        expect(refs).toHaveLength(1);
        expect(Object.keys(refs[0]).sort()).toEqual(['name', 'slug', 'teamId']);
        expect(refs[0].teamId).toBe(team.id); // keyed by teamId, NOT `id`
        expect(refs[0]).not.toHaveProperty('id');
        expect(refs[0].name).toBe(team.name);
        expect(refs[0].slug).toBe(team.slug);
    });

    test('a resource on MULTIPLE teams returns them name-ASC (BINARY: lowercase after uppercase)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'RevOrder');
        const work = await createWorkViaAPI(request, ctx.token, {
            name: `Shared Work ${teamStamp()}`,
        });
        // Create the owning teams in scrambled order; reverse lookup must sort them.
        const owners = ['Zeta Owner', 'Alpha Owner', 'mid owner', 'Beta Owner'];
        for (const name of owners) {
            const t = await createTeamViaAPI(request, ctx, { name });
            await attach(request, ctx, t.id, work.id);
        }

        const refs = await reverseLookup(request, ctx, 'work', work.id);
        const names = refs.map((r: { name: string }) => r.name);
        expect(names).toHaveLength(owners.length);
        // BINARY: 'mid owner' (lowercase m) sorts AFTER 'Zeta Owner' (uppercase Z).
        expect(names).toEqual(['Alpha Owner', 'Beta Owner', 'Zeta Owner', 'mid owner']);
        expectNameAscBinary(names);
    });

    test('unattached-but-valid and unknown resource ids both return [] (200, no existence check / no 404)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'RevEmpty');
        // A real work that is never attached.
        const orphan = await createWorkViaAPI(request, ctx.token, {
            name: `Orphan ${teamStamp()}`,
        });
        expect(await reverseLookup(request, ctx, 'work', orphan.id)).toEqual([]);
        // A syntactically valid uuid that names no resource at all — still [] (no 404).
        expect(await reverseLookup(request, ctx, 'work', UNKNOWN_UUID)).toEqual([]);
    });

    test('reverse lookup is org-scoped: a work attached in one org is invisible from a co-owned org', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request, 'RevScope');
        // Work + attachment fully inside org1 (active scope is org1 here).
        const work = await createWorkViaAPI(request, ctx.token, {
            name: `Scoped Work ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, { name: `Scoped Team ${teamStamp()}` });
        await attach(request, ctx, team.id, work.id);

        // A SECOND org owned by the same user (passes the ownership guard).
        const org2 = await createOrganizationViaAPI(request, ctx.token, `RevScope2 ${teamStamp()}`);
        const ctx2: OwnerCtx = { ...ctx, org: org2, orgId: org2.id };

        // org1 sees the owning team…
        const inOrg1 = await reverseLookup(request, ctx, 'work', work.id);
        expect(inOrg1.map((r: { teamId: string }) => r.teamId)).toContain(team.id);
        // …org2's reverse lookup for the very same id is empty (per-org scoping).
        expect(await reverseLookup(request, ctx2, 'work', work.id)).toEqual([]);
    });
});
