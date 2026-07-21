/**
 * Teams — multi-LEVEL hierarchy + Org-Chart projections, DEEP (#1647 / #1713).
 *
 * The Teams feature ships a team-in-team hierarchy and a flat org-chart
 * projection that the web renders as a tree. This file drives the real API
 * against a live stack and pins the true tree behaviour + org-chart contract:
 *
 *   • build 3- and 4-level team trees; each node's GET-detail `childTeamIds`
 *     lists ONLY its direct children (grandchildren never leak up a level)
 *   • re-parent moves a whole subtree intact (moved node keeps its own child);
 *     the old parent loses it, the new parent gains it
 *   • re-parent to the top level via PATCH { parentTeamId: null }
 *   • cycle rejection (parent → descendant) → 409; self-parent → 409
 *   • depth cap TEAM_MAX_DEPTH=10: a 10-deep chain is fine, the 11th nested
 *     level → 422 { message: '…maximum depth of 10' }
 *   • managerAgentId on a team (create + PATCH + clear-with-null); a foreign /
 *     unknown agent id → 404 (the EW-711 IDOR boundary)
 *   • delete re-parents children to the deleted node's parent (mid-level
 *     promotes grandchildren one level; a root's child goes to top level)
 *   • GET /api/organizations/:orgId/org-chart → { organization, teams[],
 *     agents[], members[] } — flat nodes with parentTeamId / reportsToAgentId
 *     edges + teamIds projections; deep-verified to reference the REAL teams
 *     and agents (team.managerAgentId, agent.teamIds from membership,
 *     agent.reportsToAgentId from the reporting line, owner always a member)
 *   • cross-owner isolation — every route is OrganizationOwnershipGuard'd, so
 *     a non-owner is walled off with 404 (404-never-403); unauth → 401;
 *     unknown org → 404; malformed org id → 404 (guard-first); malformed
 *     teamId → 400 (ParseUUIDPipe); unknown teamId → 404
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. See helpers/teams.ts for the
 *    full probed Teams contract; org-chart shape probed here directly.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners +
 * their lazily-minted org. Fully API-orchestrated (safe `flow-` prefix, not
 * matched by the no-auth testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import {
    buildOwnerCtx,
    createTeamViaAPI,
    teamStamp,
    teamsBase,
    type OwnerCtx,
} from './helpers/teams';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface TeamDetail {
    id: string;
    parentTeamId: string | null;
    managerAgentId: string | null;
    childTeamIds: string[];
    members: Array<{ memberId: string }>;
}

interface OrgChart {
    organization: { id: string; slug: string; displayName: string };
    teams: Array<{
        id: string;
        slug: string;
        name: string;
        avatarIcon: string | null;
        parentTeamId: string | null;
        managerAgentId: string | null;
    }>;
    agents: Array<{
        id: string;
        name: string;
        title: string | null;
        status: string;
        avatarIcon: string | null;
        reportsToAgentId: string | null;
        teamIds: string[];
    }>;
    members: Array<{
        userId: string;
        name: string | null;
        avatarUrl: string | null;
        teamIds: string[];
    }>;
}

/** GET a team's detail (childTeamIds + roster). */
async function getTeam(
    request: APIRequestContext,
    ctx: OwnerCtx,
    teamId: string,
): Promise<TeamDetail> {
    const res = await request.get(`${teamsBase(ctx.orgId)}/teams/${teamId}`, {
        headers: ctx.headers,
    });
    expect(res.status(), `getTeam body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function childIds(
    request: APIRequestContext,
    ctx: OwnerCtx,
    teamId: string,
): Promise<string[]> {
    return (await getTeam(request, ctx, teamId)).childTeamIds;
}

/** GET the org-chart payload. */
async function getOrgChart(request: APIRequestContext, ctx: OwnerCtx): Promise<OrgChart> {
    const res = await request.get(`${teamsBase(ctx.orgId)}/org-chart`, { headers: ctx.headers });
    expect(res.status(), `org-chart body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Set an agent's reporting line (drives the org-chart reportsToAgentId edge). */
async function setReportsTo(
    request: APIRequestContext,
    ctx: OwnerCtx,
    agentId: string,
    reportsToAgentId: string | null,
): Promise<void> {
    const res = await request.patch(`${API_BASE}/api/agents/${agentId}`, {
        headers: ctx.headers,
        data: { reportsToAgentId },
    });
    expect(res.status(), `setReportsTo body=${await res.text().catch(() => '')}`).toBe(200);
}

test.describe('Teams — multi-level hierarchy (childTeamIds projection)', () => {
    test('a 3-level tree: each parent lists only its DIRECT child; the leaf lists none', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const mid = await createTeamViaAPI(request, ctx, {
            name: `Mid ${teamStamp()}`,
            parentTeamId: root.id,
        });
        const leaf = await createTeamViaAPI(request, ctx, {
            name: `Leaf ${teamStamp()}`,
            parentTeamId: mid.id,
        });

        expect(mid.parentTeamId).toBe(root.id);
        expect(leaf.parentTeamId).toBe(mid.id);
        // Direct-children-only at every level — the grandchild never appears under the root.
        expect(await childIds(request, ctx, root.id)).toEqual([mid.id]);
        expect(await childIds(request, ctx, mid.id)).toEqual([leaf.id]);
        expect(await childIds(request, ctx, leaf.id)).toEqual([]);
    });

    test('a 4-level tree: childTeamIds stays direct-only down the whole chain', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const l1 = await createTeamViaAPI(request, ctx, { name: `Co ${teamStamp()}` });
        const l2 = await createTeamViaAPI(request, ctx, {
            name: `Div ${teamStamp()}`,
            parentTeamId: l1.id,
        });
        const l3 = await createTeamViaAPI(request, ctx, {
            name: `Squad ${teamStamp()}`,
            parentTeamId: l2.id,
        });
        const l4 = await createTeamViaAPI(request, ctx, {
            name: `Pod ${teamStamp()}`,
            parentTeamId: l3.id,
        });

        expect(await childIds(request, ctx, l1.id)).toContain(l2.id);
        expect(await childIds(request, ctx, l1.id)).not.toContain(l3.id);
        expect(await childIds(request, ctx, l1.id)).not.toContain(l4.id);
        expect(await childIds(request, ctx, l2.id)).toEqual([l3.id]);
        expect(await childIds(request, ctx, l3.id)).toEqual([l4.id]);
        expect(await childIds(request, ctx, l4.id)).toEqual([]);
    });

    test('the flat GET-teams list carries every node with its parentTeamId edge (clients build the tree)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `FlatRoot ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `FlatChild ${teamStamp()}`,
            parentTeamId: root.id,
        });

        const list = await request.get(`${teamsBase(ctx.orgId)}/teams`, { headers: ctx.headers });
        expect(list.status()).toBe(200);
        const teams = (await list.json()) as Array<{ id: string; parentTeamId: string | null }>;
        const byId = new Map(teams.map((t) => [t.id, t]));
        expect(byId.get(root.id)?.parentTeamId).toBeNull();
        expect(byId.get(child.id)?.parentTeamId).toBe(root.id);
    });

    test('re-parent moves a whole subtree intact: old parent loses it, new parent gains it, its child follows', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const branchA = await createTeamViaAPI(request, ctx, {
            name: `BranchA ${teamStamp()}`,
            parentTeamId: root.id,
        });
        const sub = await createTeamViaAPI(request, ctx, {
            name: `Sub ${teamStamp()}`,
            parentTeamId: branchA.id,
        });
        const subChild = await createTeamViaAPI(request, ctx, {
            name: `SubChild ${teamStamp()}`,
            parentTeamId: sub.id,
        });

        // Move `sub` (and its child) from branchA up to the root.
        const patched = await request.patch(`${teamsBase(ctx.orgId)}/teams/${sub.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: root.id },
        });
        expect(patched.status()).toBe(200);
        expect((await patched.json()).parentTeamId).toBe(root.id);

        expect(await childIds(request, ctx, branchA.id)).not.toContain(sub.id);
        expect(await childIds(request, ctx, root.id)).toContain(sub.id);
        // The subtree moved intact — sub still owns its own child.
        expect(await childIds(request, ctx, sub.id)).toEqual([subChild.id]);
    });

    test('re-parent to the top level via PATCH { parentTeamId: null }', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const parent = await createTeamViaAPI(request, ctx, { name: `Parent ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `Child ${teamStamp()}`,
            parentTeamId: parent.id,
        });

        const patched = await request.patch(`${teamsBase(ctx.orgId)}/teams/${child.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: null },
        });
        expect(patched.status()).toBe(200);
        expect((await patched.json()).parentTeamId).toBeNull();
        expect(await childIds(request, ctx, parent.id)).not.toContain(child.id);
    });

    test('cycle rejection: re-parenting an ancestor under its own descendant → 409 (direct + deep)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const mid = await createTeamViaAPI(request, ctx, {
            name: `Mid ${teamStamp()}`,
            parentTeamId: root.id,
        });
        const leaf = await createTeamViaAPI(request, ctx, {
            name: `Leaf ${teamStamp()}`,
            parentTeamId: mid.id,
        });

        // root → direct child.
        const direct = await request.patch(`${teamsBase(ctx.orgId)}/teams/${root.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: mid.id },
        });
        expect(direct.status()).toBe(409);
        // root → grand-descendant.
        const deep = await request.patch(`${teamsBase(ctx.orgId)}/teams/${root.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: leaf.id },
        });
        expect(deep.status()).toBe(409);
    });

    test('self-parent → 409', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Solo ${teamStamp()}` });
        const res = await request.patch(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: team.id },
        });
        expect(res.status()).toBe(409);
    });

    test('depth cap: a 10-level chain is allowed, the 11th nested level → 422 (max depth 10)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        let parentId: string | undefined;
        for (let level = 1; level <= 10; level++) {
            const team = await createTeamViaAPI(request, ctx, {
                name: `Depth L${level} ${teamStamp()}`,
                parentTeamId: parentId,
            });
            parentId = team.id;
        }
        // Adding an 11th level under the level-10 leaf blows the cap.
        const overflow = await request.post(`${teamsBase(ctx.orgId)}/teams`, {
            headers: ctx.headers,
            data: { name: `Depth L11 ${teamStamp()}`, parentTeamId: parentId },
        });
        expect(overflow.status()).toBe(422);
        expect((await overflow.json()).message).toContain('maximum depth');
    });

    test('parent-id edge cases: unknown parent 404, foreign-org parent 404, malformed parent 400', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const other = await buildOwnerCtx(request);
        const foreignTeam = await createTeamViaAPI(request, other, {
            name: `Foreign ${teamStamp()}`,
        });

        const unknown = await request.post(`${teamsBase(owner.orgId)}/teams`, {
            headers: owner.headers,
            data: { name: 'A', parentTeamId: UNKNOWN_UUID },
        });
        expect(unknown.status()).toBe(404);

        // A real team, but in a DIFFERENT org — the parent lookup is org-scoped, so 404 (never 403).
        const foreign = await request.post(`${teamsBase(owner.orgId)}/teams`, {
            headers: owner.headers,
            data: { name: 'B', parentTeamId: foreignTeam.id },
        });
        expect(foreign.status()).toBe(404);

        const malformed = await request.post(`${teamsBase(owner.orgId)}/teams`, {
            headers: owner.headers,
            data: { name: 'C', parentTeamId: 'not-a-uuid' },
        });
        expect(malformed.status()).toBe(400);
    });
});

test.describe('Teams — managerAgentId (the reporting head of a team)', () => {
    test('create a team with a managerAgentId; it persists and surfaces on the org-chart node', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Head ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, {
            name: `Managed ${teamStamp()}`,
            managerAgentId: agent.id,
        });
        expect(team.managerAgentId).toBe(agent.id);

        const chart = await getOrgChart(request, ctx);
        const node = chart.teams.find((t) => t.id === team.id);
        expect(node, 'team should be on the org-chart').toBeTruthy();
        expect(node!.managerAgentId).toBe(agent.id);
        // …and the referenced agent is a real node in the same chart.
        expect(chart.agents.map((a) => a.id)).toContain(agent.id);
    });

    test('PATCH sets a managerAgentId, then clears it with null', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Mgr ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, { name: `Team ${teamStamp()}` });
        expect(team.managerAgentId).toBeNull();

        const set = await request.patch(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
            data: { managerAgentId: agent.id },
        });
        expect(set.status()).toBe(200);
        expect((await set.json()).managerAgentId).toBe(agent.id);

        const clear = await request.patch(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
            data: { managerAgentId: null },
        });
        expect(clear.status()).toBe(200);
        expect((await clear.json()).managerAgentId).toBeNull();
    });

    test("another owner's agent as managerAgentId → 404; unknown agent → 404 (create + update)", async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const other = await buildOwnerCtx(request);
        const foreignAgent = await createAgentViaAPI(request, other.token, {
            scope: 'tenant',
            name: `Foreign ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, owner, { name: `Guard ${teamStamp()}` });

        const createForeign = await request.post(`${teamsBase(owner.orgId)}/teams`, {
            headers: owner.headers,
            data: { name: 'X', managerAgentId: foreignAgent.id },
        });
        expect(createForeign.status()).toBe(404);

        const updateForeign = await request.patch(`${teamsBase(owner.orgId)}/teams/${team.id}`, {
            headers: owner.headers,
            data: { managerAgentId: foreignAgent.id },
        });
        expect(updateForeign.status()).toBe(404);

        const unknown = await request.patch(`${teamsBase(owner.orgId)}/teams/${team.id}`, {
            headers: owner.headers,
            data: { managerAgentId: UNKNOWN_UUID },
        });
        expect(unknown.status()).toBe(404);
    });
});

test.describe('Teams — org-chart projection (deep node references)', () => {
    test('org-chart returns { organization, teams[], agents[], members[] } with the exact node keys', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Chart ${teamStamp()}` });
        const chart = await getOrgChart(request, ctx);

        expect(chart.organization.id).toBe(ctx.orgId);
        expect(typeof chart.organization.slug).toBe('string');
        expect(typeof chart.organization.displayName).toBe('string');
        expect(Array.isArray(chart.teams)).toBe(true);
        expect(Array.isArray(chart.agents)).toBe(true);
        expect(Array.isArray(chart.members)).toBe(true);

        const node = chart.teams.find((t) => t.id === team.id);
        expect(node).toBeTruthy();
        expect(Object.keys(node!).sort()).toEqual(
            ['avatarIcon', 'id', 'managerAgentId', 'name', 'parentTeamId', 'slug'].sort(),
        );
    });

    test('org-chart team nodes mirror the real tree edges (ids + parentTeamId)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `CRoot ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `CChild ${teamStamp()}`,
            parentTeamId: root.id,
        });

        const chart = await getOrgChart(request, ctx);
        const ids = chart.teams.map((t) => t.id);
        expect(ids).toContain(root.id);
        expect(ids).toContain(child.id);
        expect(chart.teams.find((t) => t.id === root.id)!.parentTeamId).toBeNull();
        expect(chart.teams.find((t) => t.id === child.id)!.parentTeamId).toBe(root.id);
    });

    test('an agent added to a team surfaces that team in its org-chart teamIds projection', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Squad ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Member ${teamStamp()}`,
        });

        // Before membership: the agent is on the chart but in no team.
        let chart = await getOrgChart(request, ctx);
        let node = chart.agents.find((a) => a.id === agent.id);
        expect(node, 'tenant agent should appear on the chart').toBeTruthy();
        expect(node!.teamIds).not.toContain(team.id);

        const add = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: agent.id, role: 'lead' },
        });
        expect(add.status()).toBe(201);

        chart = await getOrgChart(request, ctx);
        node = chart.agents.find((a) => a.id === agent.id);
        expect(node!.teamIds).toContain(team.id);
    });

    test('org-chart reportsToAgentId reflects the reporting line set on the agent', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const head = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Boss ${teamStamp()}`,
        });
        const report = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Report ${teamStamp()}`,
        });
        await setReportsTo(request, ctx, report.id, head.id);

        const chart = await getOrgChart(request, ctx);
        const reportNode = chart.agents.find((a) => a.id === report.id);
        const headNode = chart.agents.find((a) => a.id === head.id);
        expect(reportNode, 'report agent on chart').toBeTruthy();
        expect(headNode, 'head agent on chart').toBeTruthy();
        expect(reportNode!.reportsToAgentId).toBe(head.id);
        expect(headNode!.reportsToAgentId).toBeNull();
        // The reporting target is itself a real node in the chart — the edge closes.
        expect(chart.agents.map((a) => a.id)).toContain(reportNode!.reportsToAgentId);
    });

    test('org-chart members always includes the owning human (tenant owner), teamIds empty by default', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        await createTeamViaAPI(request, ctx, { name: `Any ${teamStamp()}` });
        const chart = await getOrgChart(request, ctx);
        const owner = chart.members.find((m) => m.userId === ctx.user.user.id);
        expect(owner, 'tenant owner should be a chart member').toBeTruthy();
        expect(Array.isArray(owner!.teamIds)).toBe(true);
        expect(owner!.teamIds).toEqual([]);
    });

    test('adding the owner to a team surfaces that team in their member teamIds projection', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `HumanTeam ${teamStamp()}` });
        const add = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: ctx.user.user.id },
        });
        expect(add.status()).toBe(201);

        const chart = await getOrgChart(request, ctx);
        const owner = chart.members.find((m) => m.userId === ctx.user.user.id);
        expect(owner!.teamIds).toContain(team.id);
    });
});

test.describe('Teams — delete re-parenting inside a tree', () => {
    test('deleting a mid-level node promotes its children one level up to its own parent', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const mid = await createTeamViaAPI(request, ctx, {
            name: `Mid ${teamStamp()}`,
            parentTeamId: root.id,
        });
        const leaf = await createTeamViaAPI(request, ctx, {
            name: `Leaf ${teamStamp()}`,
            parentTeamId: mid.id,
        });

        const del = await request.delete(`${teamsBase(ctx.orgId)}/teams/${mid.id}`, {
            headers: ctx.headers,
        });
        expect(del.status()).toBe(204);
        // mid is gone; leaf survives, re-parented to root (mid's parent).
        expect(
            (
                await request.get(`${teamsBase(ctx.orgId)}/teams/${mid.id}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(404);
        expect((await getTeam(request, ctx, leaf.id)).parentTeamId).toBe(root.id);
        expect(await childIds(request, ctx, root.id)).toContain(leaf.id);
    });

    test("deleting a root re-parents its child to the top level (deleted parent's parent is null)", async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const root = await createTeamViaAPI(request, ctx, { name: `TopRoot ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `OnlyChild ${teamStamp()}`,
            parentTeamId: root.id,
        });

        const del = await request.delete(`${teamsBase(ctx.orgId)}/teams/${root.id}`, {
            headers: ctx.headers,
        });
        expect(del.status()).toBe(204);
        expect((await getTeam(request, ctx, child.id)).parentTeamId).toBeNull();
    });
});

test.describe('Teams — org-chart validation + cross-owner isolation', () => {
    test('a non-owner is walled off from the org-chart and team tree with 404 (404-never-403)', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Secret ${teamStamp()}` });

        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/org-chart`, {
                    headers: intruder.headers,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/teams`, { headers: intruder.headers })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/teams/${team.id}`, {
                    headers: intruder.headers,
                })
            ).status(),
        ).toBe(404);
        // The owner still reaches their own chart untouched.
        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/org-chart`, { headers: owner.headers })
            ).status(),
        ).toBe(200);
    });

    test('org-chart access gating: unauth 401, unknown org 404, malformed org id 404 (guard-first)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        expect((await request.get(`${teamsBase(ctx.orgId)}/org-chart`)).status()).toBe(401);
        expect(
            (
                await request.get(`${teamsBase(UNKNOWN_UUID)}/org-chart`, { headers: ctx.headers })
            ).status(),
        ).toBe(404);
        // The ownership guard runs before the ParseUUIDPipe, so a malformed org id 404s (not 400).
        const malformedOrg = await request.get(
            `${API_BASE}/api/organizations/not-a-uuid/org-chart`,
            { headers: ctx.headers },
        );
        expect([400, 404]).toContain(malformedOrg.status());
        expect(malformedOrg.status()).toBe(404);
    });

    test('team-id param codes under a valid owned org: malformed 400, unknown 404', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const malformed = await request.get(`${teamsBase(ctx.orgId)}/teams/not-a-uuid`, {
            headers: ctx.headers,
        });
        expect(malformed.status()).toBe(400);
        const unknown = await request.get(`${teamsBase(ctx.orgId)}/teams/${UNKNOWN_UUID}`, {
            headers: ctx.headers,
        });
        expect(unknown.status()).toBe(404);
    });
});
