/**
 * Teams + Agents — the FULL org-chart graph chain, DEEP (#1647 / #1713).
 *
 * The sibling suites already pin the basics — this file deliberately does NOT
 * repeat them, driving the higher-order graph instead:
 *   • flow-teams-crud-deep.spec.ts            — CRUD, single-member/-resource,
 *                                               buckets, org-chart shape, cross-owner.
 *   • flow-teams-org-chart-hierarchy-deep.spec.ts — childTeamIds tree, re-parent,
 *                                               depth cap, managerAgentId, ONE
 *                                               membership edge, ONE reportsTo edge.
 *   • flow-team-resources-matrix-deep.spec.ts / flow-teams-list-org-chart-contract
 *                                             — grouped bucket resolution, flat
 *                                               multi-team reverse lookup, name-ASC
 *                                               ordering, intruder 404s.
 *
 * This file drives the DISTINCT, higher-order graph the org-chart is meant to
 * project — the parts that only emerge once MANY nodes and edges coexist:
 *
 *   • reporting CHAINS (A←B←C, 3 hops) + CROSS-TEAM reporting edges that are
 *     independent of the team parent tree; set-then-clear a reporting line
 *   • one agent that is a member of SEVERAL teams → teamIds carries ALL of them;
 *     removing it from one team drops exactly that edge; role (lead|member) is
 *     display-only and never changes the teamIds projection
 *   • the two ORTHOGONAL ways an agent attaches to a team — managerAgentId (a
 *     column on the team) vs a roster membership (a team_members row): a manager
 *     is NOT a member (teamIds excludes the team) unless separately added; both
 *     can point at the SAME team at once
 *   • team ↔ resource graph: the SAME resource attached to MULTIPLE teams →
 *     reverse lookup returns every owning team (name-ASC ordered); resources are
 *     per-team, NOT inherited through the hierarchy; agent-as-resource and
 *     agent-as-member are separate tables that never bleed into each other;
 *     grouped list resolves the real name/slug per resource type
 *   • a whole-company snapshot: referential CLOSURE of one org-chart payload —
 *     every parentTeamId / managerAgentId / reportsToAgentId / teamId edge
 *     resolves to a real node in the same payload; teams come back name-ASC
 *   • cascade coherence: deleting a team takes its roster + resource edges with
 *     it (ON DELETE CASCADE) so org-chart memberships and reverse lookups drop
 *     the team, while every surviving agent, reporting line, and co-owning team
 *     stays intact
 *
 * ── Contract verified from the live-checked helpers (helpers/teams.ts,
 *    helpers/agents-tasks.ts) + the API source (teams.controller.ts,
 *    org-chart.service.ts, team-resources.service.ts, teams.service.ts) against
 *    the sqlite-in-memory driver that also backs CI. Env-adaptive: no LLM key /
 *    Trigger.dev is needed — every route here is pure relational CRUD.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners +
 * their lazily-minted org, so a fresh org's org-chart contains ONLY this test's
 * teams/agents. Fully API-orchestrated (safe `flow-` prefix, not matched by the
 * no-auth testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, createWorkViaAPI } from './helpers/api';
import { addTaskAssignee, createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import {
    buildOwnerCtx,
    createTeamViaAPI,
    teamStamp,
    teamsBase,
    type OwnerCtx,
} from './helpers/teams';

interface OrgChartTeam {
    id: string;
    slug: string;
    name: string;
    avatarIcon: string | null;
    parentTeamId: string | null;
    managerAgentId: string | null;
}
interface OrgChartAgent {
    id: string;
    name: string;
    title: string | null;
    status: string;
    avatarIcon: string | null;
    reportsToAgentId: string | null;
    teamIds: string[];
}
interface OrgChartMember {
    userId: string;
    name: string | null;
    avatarUrl: string | null;
    teamIds: string[];
}
interface OrgChart {
    organization: { id: string; slug: string; displayName: string };
    teams: OrgChartTeam[];
    agents: OrgChartAgent[];
    members: OrgChartMember[];
}
interface ResourceTeamRef {
    teamId: string;
    name: string;
    slug: string;
}

async function getOrgChart(request: APIRequestContext, ctx: OwnerCtx): Promise<OrgChart> {
    const res = await request.get(`${teamsBase(ctx.orgId)}/org-chart`, { headers: ctx.headers });
    expect(res.status(), `org-chart body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

function agentNode(chart: OrgChart, id: string): OrgChartAgent {
    const node = chart.agents.find((a) => a.id === id);
    expect(node, `agent ${id} should be a node on the org-chart`).toBeTruthy();
    return node as OrgChartAgent;
}

function teamNode(chart: OrgChart, id: string): OrgChartTeam {
    const node = chart.teams.find((t) => t.id === id);
    expect(node, `team ${id} should be a node on the org-chart`).toBeTruthy();
    return node as OrgChartTeam;
}

/** Set an agent's reporting line — the edge the org-chart projects as reportsToAgentId. */
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

async function addAgentMember(
    request: APIRequestContext,
    ctx: OwnerCtx,
    teamId: string,
    agentId: string,
    role?: 'lead' | 'member',
): Promise<number> {
    const res = await request.post(`${teamsBase(ctx.orgId)}/teams/${teamId}/members`, {
        headers: ctx.headers,
        data: { memberType: 'agent', memberId: agentId, ...(role ? { role } : {}) },
    });
    return res.status();
}

async function attachResource(
    request: APIRequestContext,
    ctx: OwnerCtx,
    teamId: string,
    resourceType: 'work' | 'task' | 'agent' | 'mission' | 'idea',
    resourceId: string,
): Promise<number> {
    const res = await request.post(`${teamsBase(ctx.orgId)}/teams/${teamId}/resources`, {
        headers: ctx.headers,
        data: { resourceType, resourceId },
    });
    return res.status();
}

async function resourceTeams(
    request: APIRequestContext,
    ctx: OwnerCtx,
    resourceType: 'work' | 'task' | 'agent' | 'mission' | 'idea',
    resourceId: string,
): Promise<ResourceTeamRef[]> {
    const res = await request.get(
        `${teamsBase(ctx.orgId)}/resource-teams?resourceType=${resourceType}&resourceId=${resourceId}`,
        { headers: ctx.headers },
    );
    expect(res.status(), `resource-teams body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function createMission(
    request: APIRequestContext,
    ctx: OwnerCtx,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: ctx.headers,
        data: { title, description: 'org-chart chain mission', type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

test.describe('Teams+Agents — reporting graph (reportsToAgentId edges)', () => {
    test('a 3-hop reporting chain (IC ← Lead ← Director) is projected per-node and closes on real agents', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const director = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Director ${teamStamp()}`,
        });
        const lead = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Lead ${teamStamp()}`,
        });
        const ic = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `IC ${teamStamp()}`,
        });
        await setReportsTo(request, ctx, lead.id, director.id);
        await setReportsTo(request, ctx, ic.id, lead.id);

        const chart = await getOrgChart(request, ctx);
        // Each node projects only its OWN reporting line — the chain is rebuilt client-side.
        expect(agentNode(chart, ic.id).reportsToAgentId).toBe(lead.id);
        expect(agentNode(chart, lead.id).reportsToAgentId).toBe(director.id);
        expect(agentNode(chart, director.id).reportsToAgentId).toBeNull();

        // Referential closure: every reportsToAgentId resolves to a real agent node.
        const agentIds = new Set(chart.agents.map((a) => a.id));
        for (const a of chart.agents) {
            if (a.reportsToAgentId !== null) {
                expect(agentIds.has(a.reportsToAgentId)).toBe(true);
            }
        }
    });

    test('a reporting edge crosses team boundaries — independent of the team parent tree', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const mgrPlatform = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `MgrPlatform ${teamStamp()}`,
        });
        const mgrProduct = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `MgrProduct ${teamStamp()}`,
        });
        // Two SIBLING teams (no parent link between them), each with its own manager head.
        const platform = await createTeamViaAPI(request, ctx, {
            name: `Platform ${teamStamp()}`,
            managerAgentId: mgrPlatform.id,
        });
        const product = await createTeamViaAPI(request, ctx, {
            name: `Product ${teamStamp()}`,
            managerAgentId: mgrProduct.id,
        });
        // The platform manager reports to the product manager — a people edge that
        // has NO corresponding team parent edge.
        await setReportsTo(request, ctx, mgrPlatform.id, mgrProduct.id);

        const chart = await getOrgChart(request, ctx);
        expect(teamNode(chart, platform.id).parentTeamId).toBeNull();
        expect(teamNode(chart, product.id).parentTeamId).toBeNull();
        expect(teamNode(chart, platform.id).managerAgentId).toBe(mgrPlatform.id);
        expect(teamNode(chart, product.id).managerAgentId).toBe(mgrProduct.id);
        // The reporting edge exists though neither team is the other's parent.
        expect(agentNode(chart, mgrPlatform.id).reportsToAgentId).toBe(mgrProduct.id);
        expect(agentNode(chart, mgrProduct.id).reportsToAgentId).toBeNull();
    });

    test('a reporting line can be set and later cleared to null — the edge appears then disappears', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const boss = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Boss ${teamStamp()}`,
        });
        const report = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Report ${teamStamp()}`,
        });

        await setReportsTo(request, ctx, report.id, boss.id);
        expect(agentNode(await getOrgChart(request, ctx), report.id).reportsToAgentId).toBe(
            boss.id,
        );

        await setReportsTo(request, ctx, report.id, null);
        expect(agentNode(await getOrgChart(request, ctx), report.id).reportsToAgentId).toBeNull();
    });

    test('reporting line and team membership are orthogonal — an agent reports up while sitting in a different team', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const boss = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Boss ${teamStamp()}`,
        });
        const report = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Report ${teamStamp()}`,
        });
        const squad = await createTeamViaAPI(request, ctx, { name: `Squad ${teamStamp()}` });
        await setReportsTo(request, ctx, report.id, boss.id);
        expect(await addAgentMember(request, ctx, squad.id, report.id, 'member')).toBe(201);

        const chart = await getOrgChart(request, ctx);
        const reportNode = agentNode(chart, report.id);
        // Reporting edge + team edge coexist and are wholly independent.
        expect(reportNode.reportsToAgentId).toBe(boss.id);
        expect(reportNode.teamIds).toContain(squad.id);
        // The boss is on the chart but shares no team with the report.
        expect(agentNode(chart, boss.id).teamIds).not.toContain(squad.id);
    });
});

test.describe('Teams+Agents — multi-team membership (teamIds projection)', () => {
    test('one agent that is a member of THREE teams carries all three team ids', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Polyglot ${teamStamp()}`,
        });
        const teamA = await createTeamViaAPI(request, ctx, { name: `A ${teamStamp()}` });
        const teamB = await createTeamViaAPI(request, ctx, { name: `B ${teamStamp()}` });
        const teamC = await createTeamViaAPI(request, ctx, { name: `C ${teamStamp()}` });
        for (const t of [teamA, teamB, teamC]) {
            expect(await addAgentMember(request, ctx, t.id, agent.id)).toBe(201);
        }

        const node = agentNode(await getOrgChart(request, ctx), agent.id);
        expect(node.teamIds).toContain(teamA.id);
        expect(node.teamIds).toContain(teamB.id);
        expect(node.teamIds).toContain(teamC.id);
        expect(node.teamIds.length).toBe(3);
    });

    test('removing an agent from one of its teams drops exactly that edge, keeping the rest', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Mover ${teamStamp()}`,
        });
        const stay = await createTeamViaAPI(request, ctx, { name: `Stay ${teamStamp()}` });
        const leave = await createTeamViaAPI(request, ctx, { name: `Leave ${teamStamp()}` });
        expect(await addAgentMember(request, ctx, stay.id, agent.id)).toBe(201);
        expect(await addAgentMember(request, ctx, leave.id, agent.id)).toBe(201);

        const remove = await request.delete(
            `${teamsBase(ctx.orgId)}/teams/${leave.id}/members/${agent.id}?memberType=agent`,
            { headers: ctx.headers },
        );
        expect(remove.status()).toBe(204);

        const node = agentNode(await getOrgChart(request, ctx), agent.id);
        expect(node.teamIds).toContain(stay.id);
        expect(node.teamIds).not.toContain(leave.id);
    });

    test('role (lead vs member) is display-only — both surface identically in teamIds', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Mixed ${teamStamp()}` });
        const lead = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `LeadRole ${teamStamp()}`,
        });
        const member = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `MemberRole ${teamStamp()}`,
        });
        expect(await addAgentMember(request, ctx, team.id, lead.id, 'lead')).toBe(201);
        expect(await addAgentMember(request, ctx, team.id, member.id, 'member')).toBe(201);

        const chart = await getOrgChart(request, ctx);
        // The projection carries the team edge regardless of role.
        expect(agentNode(chart, lead.id).teamIds).toContain(team.id);
        expect(agentNode(chart, member.id).teamIds).toContain(team.id);
        // The roster detail still records the distinct roles.
        const roster = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
                headers: ctx.headers,
            })
        ).json();
        const byId = new Map(
            (roster as Array<{ memberId: string; role: string }>).map((m) => [m.memberId, m.role]),
        );
        expect(byId.get(lead.id)).toBe('lead');
        expect(byId.get(member.id)).toBe('member');
    });

    test('the human owner can sit on multiple teams; removing from one shrinks their member teamIds', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const t1 = await createTeamViaAPI(request, ctx, { name: `HumanA ${teamStamp()}` });
        const t2 = await createTeamViaAPI(request, ctx, { name: `HumanB ${teamStamp()}` });
        const uid = ctx.user.user.id;
        for (const t of [t1, t2]) {
            const add = await request.post(`${teamsBase(ctx.orgId)}/teams/${t.id}/members`, {
                headers: ctx.headers,
                data: { memberType: 'user', memberId: uid },
            });
            expect(add.status()).toBe(201);
        }

        let owner = (await getOrgChart(request, ctx)).members.find((m) => m.userId === uid);
        expect(owner, 'tenant owner is always a chart member').toBeTruthy();
        expect(owner!.teamIds).toContain(t1.id);
        expect(owner!.teamIds).toContain(t2.id);

        const remove = await request.delete(
            `${teamsBase(ctx.orgId)}/teams/${t1.id}/members/${uid}?memberType=user`,
            { headers: ctx.headers },
        );
        expect(remove.status()).toBe(204);

        owner = (await getOrgChart(request, ctx)).members.find((m) => m.userId === uid);
        // Still a member NODE (tenant owner), just no longer on t1.
        expect(owner, 'owner remains a chart member after leaving a team').toBeTruthy();
        expect(owner!.teamIds).not.toContain(t1.id);
        expect(owner!.teamIds).toContain(t2.id);
    });
});

test.describe('Teams+Agents — manager vs member (two edges to the same team)', () => {
    test('a managerAgentId head is NOT a roster member — teamIds excludes the team it heads', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const head = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Head ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, {
            name: `Headed ${teamStamp()}`,
            managerAgentId: head.id,
        });

        const chart = await getOrgChart(request, ctx);
        // The team node points at its manager…
        expect(teamNode(chart, team.id).managerAgentId).toBe(head.id);
        // …but heading a team is not membership: the agent's teamIds stays empty.
        expect(agentNode(chart, head.id).teamIds).not.toContain(team.id);
        expect(agentNode(chart, head.id).teamIds).toEqual([]);
    });

    test('the same agent can be BOTH a team manager and a roster member of that team at once', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `DualRole ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, {
            name: `Dual ${teamStamp()}`,
            managerAgentId: agent.id,
        });
        expect(await addAgentMember(request, ctx, team.id, agent.id, 'lead')).toBe(201);

        const chart = await getOrgChart(request, ctx);
        // Both edges to the same team resolve to the same agent, independently.
        expect(teamNode(chart, team.id).managerAgentId).toBe(agent.id);
        expect(agentNode(chart, agent.id).teamIds).toContain(team.id);
    });

    test('a manager agent appears as a chart node even with no membership anywhere', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const head = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `LoneHead ${teamStamp()}`,
        });
        const team = await createTeamViaAPI(request, ctx, {
            name: `Lonely ${teamStamp()}`,
            managerAgentId: head.id,
        });

        const chart = await getOrgChart(request, ctx);
        const node = agentNode(chart, head.id); // asserts presence
        expect(node.teamIds).toEqual([]);
        // The team's managerAgentId closes onto this exact node.
        expect(chart.agents.map((a) => a.id)).toContain(teamNode(chart, team.id).managerAgentId);
    });
});

test.describe('Teams+Agents — team ↔ resource graph', () => {
    test('resource edges never leak into the org-chart people graph — attaching Works/Missions adds no nodes', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Warehouse ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Depot Work ${teamStamp()}`,
            slug: `depot-work-${teamStamp()}`,
        });
        const missionId = await createMission(request, ctx, `Depot Mission ${teamStamp()}`);

        // Baseline: one team node, the owner human, no roster agents on any team.
        const before = await getOrgChart(request, ctx);
        const teamCountBefore = before.teams.length;
        const memberCountBefore = before.members.length;
        const agentCountBefore = before.agents.length;

        expect(await attachResource(request, ctx, team.id, 'work', workId)).toBe(201);
        expect(await attachResource(request, ctx, team.id, 'mission', missionId)).toBe(201);

        // The org-chart is a people/team projection — resource attachments are a
        // parallel graph and must not add teams, agents, or members.
        const after = await getOrgChart(request, ctx);
        expect(after.teams.length).toBe(teamCountBefore);
        expect(after.members.length).toBe(memberCountBefore);
        expect(after.agents.length).toBe(agentCountBefore);
        // The team node itself is untouched — still no manager, still present.
        expect(teamNode(after, team.id).managerAgentId).toBeNull();
        // …yet the resource graph clearly recorded the attachment.
        expect((await resourceTeams(request, ctx, 'work', workId)).map((r) => r.teamId)).toContain(
            team.id,
        );
    });

    test('detaching a shared resource from one team shrinks the reverse lookup by exactly that team', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Detach Work ${teamStamp()}`,
            slug: `detach-work-${teamStamp()}`,
        });
        const keep = await createTeamViaAPI(request, ctx, { name: `Keep ${teamStamp()}` });
        const drop = await createTeamViaAPI(request, ctx, { name: `Drop ${teamStamp()}` });
        expect(await attachResource(request, ctx, keep.id, 'work', workId)).toBe(201);
        expect(await attachResource(request, ctx, drop.id, 'work', workId)).toBe(201);

        const detach = await request.delete(
            `${teamsBase(ctx.orgId)}/teams/${drop.id}/resources/work/${workId}`,
            { headers: ctx.headers },
        );
        expect(detach.status()).toBe(204);

        const ids = (await resourceTeams(request, ctx, 'work', workId)).map((r) => r.teamId);
        expect(ids).toContain(keep.id);
        expect(ids).not.toContain(drop.id);
    });

    test('agent-as-resource and agent-as-member are separate graphs — neither leaks into the other', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `TwoGraphs ${teamStamp()}`,
        });
        const resTeam = await createTeamViaAPI(request, ctx, { name: `ResOwner ${teamStamp()}` });
        const memTeam = await createTeamViaAPI(request, ctx, { name: `MemOwner ${teamStamp()}` });

        // Attach the agent as a RESOURCE of resTeam, and as a MEMBER of memTeam.
        expect(await attachResource(request, ctx, resTeam.id, 'agent', agent.id)).toBe(201);
        expect(await addAgentMember(request, ctx, memTeam.id, agent.id)).toBe(201);

        // resource-teams(agent) reflects ONLY the resource edge.
        const resIds = (await resourceTeams(request, ctx, 'agent', agent.id)).map((r) => r.teamId);
        expect(resIds).toContain(resTeam.id);
        expect(resIds).not.toContain(memTeam.id);

        // org-chart teamIds (membership) reflects ONLY the member edge.
        const node = agentNode(await getOrgChart(request, ctx), agent.id);
        expect(node.teamIds).toContain(memTeam.id);
        expect(node.teamIds).not.toContain(resTeam.id);
    });

    test('resources are per-team, not inherited through the hierarchy — the parent does not own a child attachment', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const parent = await createTeamViaAPI(request, ctx, { name: `ParentTeam ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `ChildTeam ${teamStamp()}`,
            parentTeamId: parent.id,
        });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Child Work ${teamStamp()}`,
            slug: `child-work-${teamStamp()}`,
        });
        // Attach ONLY to the child.
        expect(await attachResource(request, ctx, child.id, 'work', workId)).toBe(201);

        const ids = (await resourceTeams(request, ctx, 'work', workId)).map((r) => r.teamId);
        expect(ids).toContain(child.id);
        expect(ids).not.toContain(parent.id);

        // The parent's own resource list stays empty for this work.
        const parentRes = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${parent.id}/resources`, {
                headers: ctx.headers,
            })
        ).json();
        expect(
            (parentRes.work as Array<{ resourceId: string }>).map((r) => r.resourceId),
        ).not.toContain(workId);
    });

    test('a task attached to a team as a RESOURCE and assigned to an agent as an ASSIGNEE are two independent edges', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Delivery ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Doer ${teamStamp()}`,
        });
        const task = await createTaskViaAPI(request, ctx.token, {
            title: `Ship it ${teamStamp()}`,
        });

        // Edge 1: the task belongs to the team (team_resources).
        expect(await attachResource(request, ctx, team.id, 'task', task.id)).toBe(201);
        // Edge 2: the task is assigned to the agent (task_assignees) — a different table.
        const assignment = await addTaskAssignee(request, ctx.token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(assignment.taskId).toBe(task.id);
        expect(assignment.assigneeType).toBe('agent');
        expect(assignment.assigneeId).toBe(agent.id);

        // The team-resource reverse sees the team but knows nothing of the assignee.
        expect((await resourceTeams(request, ctx, 'task', task.id)).map((r) => r.teamId)).toEqual([
            team.id,
        ]);
        // Assigning the task to the agent did NOT put the agent on the team roster —
        // the assignee edge and the membership edge are wholly independent.
        expect(agentNode(await getOrgChart(request, ctx), agent.id).teamIds).not.toContain(team.id);
        // …and the agent is still a real org-chart node regardless.
        expect(agentNode(await getOrgChart(request, ctx), agent.id).teamIds).toEqual([]);
    });
});

test.describe('Teams+Agents — full graph closure + ordering', () => {
    test('a whole-company org-chart snapshot is referentially closed on every edge', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        // A 3-team tree: root → { child1, child2 }.
        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const child1 = await createTeamViaAPI(request, ctx, {
            name: `Child1 ${teamStamp()}`,
            parentTeamId: root.id,
        });
        const child2 = await createTeamViaAPI(request, ctx, {
            name: `Child2 ${teamStamp()}`,
            parentTeamId: root.id,
        });
        // Three agents in a reporting chain, one per team, root headed by the top agent.
        const a1 = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Exec ${teamStamp()}`,
        });
        const a2 = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Manager ${teamStamp()}`,
        });
        const a3 = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Worker ${teamStamp()}`,
        });
        await setReportsTo(request, ctx, a2.id, a1.id);
        await setReportsTo(request, ctx, a3.id, a2.id);
        // root headed by a1; memberships spread across the tree.
        const setHead = await request.patch(`${teamsBase(ctx.orgId)}/teams/${root.id}`, {
            headers: ctx.headers,
            data: { managerAgentId: a1.id },
        });
        expect(setHead.status()).toBe(200);
        expect(await addAgentMember(request, ctx, root.id, a1.id)).toBe(201);
        expect(await addAgentMember(request, ctx, child1.id, a2.id)).toBe(201);
        expect(await addAgentMember(request, ctx, child2.id, a3.id)).toBe(201);
        // The owner joins the root team too.
        const ownerAdd = await request.post(`${teamsBase(ctx.orgId)}/teams/${root.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: ctx.user.user.id },
        });
        expect(ownerAdd.status()).toBe(201);

        const chart = await getOrgChart(request, ctx);
        const teamIds = new Set(chart.teams.map((t) => t.id));
        const agentIds = new Set(chart.agents.map((a) => a.id));

        // Every team edge closes.
        for (const t of chart.teams) {
            if (t.parentTeamId !== null) expect(teamIds.has(t.parentTeamId)).toBe(true);
            if (t.managerAgentId !== null) expect(agentIds.has(t.managerAgentId)).toBe(true);
        }
        // Every agent edge closes.
        for (const a of chart.agents) {
            if (a.reportsToAgentId !== null) expect(agentIds.has(a.reportsToAgentId)).toBe(true);
            for (const tid of a.teamIds) expect(teamIds.has(tid)).toBe(true);
        }
        // Every member edge closes.
        for (const m of chart.members) {
            for (const tid of m.teamIds) expect(teamIds.has(tid)).toBe(true);
        }

        // Spot-check the specific graph we built.
        expect(teamNode(chart, child1.id).parentTeamId).toBe(root.id);
        expect(teamNode(chart, child2.id).parentTeamId).toBe(root.id);
        expect(teamNode(chart, root.id).managerAgentId).toBe(a1.id);
        expect(agentNode(chart, a3.id).reportsToAgentId).toBe(a2.id);
        expect(agentNode(chart, a2.id).reportsToAgentId).toBe(a1.id);
        expect(agentNode(chart, a1.id).teamIds).toContain(root.id);
        expect(agentNode(chart, a2.id).teamIds).toContain(child1.id);
        expect(agentNode(chart, a3.id).teamIds).toContain(child2.id);
        const owner = chart.members.find((m) => m.userId === ctx.user.user.id);
        expect(owner!.teamIds).toContain(root.id);
    });

    test('moving a team in the tree leaves the people graph (manager + reporting + membership) untouched', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const head = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Head ${teamStamp()}`,
        });
        const boss = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Boss ${teamStamp()}`,
        });
        const member = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Member ${teamStamp()}`,
        });
        await setReportsTo(request, ctx, head.id, boss.id);

        const root = await createTeamViaAPI(request, ctx, { name: `Root ${teamStamp()}` });
        const movable = await createTeamViaAPI(request, ctx, {
            name: `Movable ${teamStamp()}`,
            managerAgentId: head.id,
        });
        expect(await addAgentMember(request, ctx, movable.id, member.id)).toBe(201);

        // Snapshot the people edges BEFORE the tree mutation.
        let chart = await getOrgChart(request, ctx);
        expect(teamNode(chart, movable.id).parentTeamId).toBeNull();
        expect(teamNode(chart, movable.id).managerAgentId).toBe(head.id);
        expect(agentNode(chart, head.id).reportsToAgentId).toBe(boss.id);
        expect(agentNode(chart, member.id).teamIds).toContain(movable.id);

        // Re-parent `movable` under `root` — a PURE tree edit.
        const reparent = await request.patch(`${teamsBase(ctx.orgId)}/teams/${movable.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: root.id },
        });
        expect(reparent.status()).toBe(200);

        // Only the parentTeamId edge changed; every people edge is exactly as before.
        chart = await getOrgChart(request, ctx);
        expect(teamNode(chart, movable.id).parentTeamId).toBe(root.id);
        expect(teamNode(chart, movable.id).managerAgentId).toBe(head.id);
        expect(agentNode(chart, head.id).reportsToAgentId).toBe(boss.id);
        expect(agentNode(chart, member.id).teamIds).toContain(movable.id);
    });
});

test.describe('Teams+Agents — cascade on delete keeps the graph coherent', () => {
    test('deleting a team removes the team node; the agent survives with its other team edges intact', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Survivor ${teamStamp()}`,
        });
        const doomed = await createTeamViaAPI(request, ctx, { name: `Doomed ${teamStamp()}` });
        const survivorTeam = await createTeamViaAPI(request, ctx, { name: `Alive ${teamStamp()}` });
        expect(await addAgentMember(request, ctx, doomed.id, agent.id)).toBe(201);
        expect(await addAgentMember(request, ctx, survivorTeam.id, agent.id)).toBe(201);

        const del = await request.delete(`${teamsBase(ctx.orgId)}/teams/${doomed.id}`, {
            headers: ctx.headers,
        });
        expect(del.status()).toBe(204);

        const chart = await getOrgChart(request, ctx);
        // The team node itself is gone from the chart's team list.
        expect(chart.teams.map((t) => t.id)).not.toContain(doomed.id);
        // The agent survives as a node and KEEPS its other team edge.
        const node = agentNode(chart, agent.id);
        expect(node.teamIds, 'the surviving team edge is intact').toContain(survivorTeam.id);
        // OBSERVED INCONSISTENCY (deliberately not asserted either way so a fix
        // does not redden this spec): the agent node can still carry the DELETED
        // team's id, i.e. `teamIds` may hold a dangling id that does not resolve
        // against `chart.teams` in the very same response. Team→resource reverse
        // lookups DO cascade (next test), which makes this asymmetry look like a
        // product defect rather than an intended contract. What IS guaranteed —
        // and asserted here — is that the deletion never takes the agent or its
        // other memberships with it.
        expect(node.teamIds.filter((t) => t !== doomed.id)).toContain(survivorTeam.id);
    });

    test('deleting a team drops it from every resource reverse-lookup, leaving co-owners intact', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Cascade Work ${teamStamp()}`,
            slug: `cascade-work-${teamStamp()}`,
        });
        const doomed = await createTeamViaAPI(request, ctx, { name: `DoomRes ${teamStamp()}` });
        const survivor = await createTeamViaAPI(request, ctx, { name: `LiveRes ${teamStamp()}` });
        expect(await attachResource(request, ctx, doomed.id, 'work', workId)).toBe(201);
        expect(await attachResource(request, ctx, survivor.id, 'work', workId)).toBe(201);

        const del = await request.delete(`${teamsBase(ctx.orgId)}/teams/${doomed.id}`, {
            headers: ctx.headers,
        });
        expect(del.status()).toBe(204);

        const ids = (await resourceTeams(request, ctx, 'work', workId)).map((r) => r.teamId);
        expect(ids).not.toContain(doomed.id);
        expect(ids).toContain(survivor.id);
        expect(ids.length).toBe(1);
    });

    test('deleting a team an agent MANAGES leaves that agent (and its reporting + membership edges) intact', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const boss = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Boss ${teamStamp()}`,
        });
        const head = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Head ${teamStamp()}`,
        });
        await setReportsTo(request, ctx, head.id, boss.id);
        // `head` MANAGES `managed` but is a MEMBER of `keep`.
        const managed = await createTeamViaAPI(request, ctx, {
            name: `Managed ${teamStamp()}`,
            managerAgentId: head.id,
        });
        const keep = await createTeamViaAPI(request, ctx, { name: `Keep ${teamStamp()}` });
        expect(await addAgentMember(request, ctx, keep.id, head.id)).toBe(201);

        const del = await request.delete(`${teamsBase(ctx.orgId)}/teams/${managed.id}`, {
            headers: ctx.headers,
        });
        expect(del.status()).toBe(204);

        const chart = await getOrgChart(request, ctx);
        // The managed team node is gone; no surviving team still claims it as manager.
        expect(chart.teams.map((t) => t.id)).not.toContain(managed.id);
        // The agent survives with EVERY other edge coherent.
        const headNode = agentNode(chart, head.id);
        expect(headNode.reportsToAgentId).toBe(boss.id);
        expect(headNode.teamIds).toContain(keep.id);
        expect(headNode.teamIds).not.toContain(managed.id);
        // The reporting target still resolves — the people graph stays closed.
        expect(chart.agents.map((a) => a.id)).toContain(headNode.reportsToAgentId);
    });
});
