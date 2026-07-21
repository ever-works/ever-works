/**
 * Teams & Prebuilt Companies — org-nested Teams API, DEEP end-to-end (#1647 / #1713).
 *
 * The Teams feature shipped a full org-nested management surface with ZERO
 * dedicated e2e coverage. This file drives the real API against a live stack
 * and pins the true response shapes + status codes, covering:
 *
 *   • Team CRUD (create → list → get detail → update → delete)
 *   • slug auto-derivation + explicit slug + duplicate-slug 409
 *   • team-in-team hierarchy: re-parent, cycle rejection (409), self-parent (409),
 *     child re-parent on parent delete
 *   • roster: add agent member / human member, list, duplicate 409, remove 204,
 *     non-org-member human → 404
 *   • team_resources: attach Work/Agent/Mission/Task, grouped list, duplicate 409,
 *     detach 204, reverse lookup (resource-teams)
 *   • org-chart payload shape
 *   • cross-owner isolation — every route is OrganizationOwnershipGuard'd, so a
 *     non-owner is walled off with 404 (404-never-403 posture, org-level too)
 *   • validation: bad slug (400), missing name (400), unauth (401), unknown org (404)
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. See helpers/teams.ts for the
 *    full probed contract.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners +
 * their lazily-minted org. Fully API-orchestrated (safe `flow-` prefix, not
 * matched by the no-auth testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import {
    buildOwnerCtx,
    createTeamViaAPI,
    teamStamp,
    teamsBase,
    type OwnerCtx,
} from './helpers/teams';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

async function createMission(
    request: APIRequestContext,
    ctx: OwnerCtx,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: ctx.headers,
        data: { title, description: 'team resource mission', type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

test.describe('Teams — CRUD, hierarchy, validation', () => {
    test('create returns the full TeamResponse shape; slug auto-derives from name', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, {
            name: `Engineering ${teamStamp()}`,
            description: 'builds things',
        });
        expect(team.id).toMatch(UUID_RE);
        expect(team.slug).toMatch(/^engineering-/);
        expect(team.description).toBe('builds things');
        expect(team.parentTeamId).toBeNull();
        expect(team.managerAgentId).toBeNull();
        expect(team.organizationId).toBe(ctx.orgId);
        expect(typeof team.createdAt).toBe('string');
        expect(typeof team.updatedAt).toBe('string');
    });

    test('explicit slug is honored; a duplicate slug in the same org → 409', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const slug = `platform-${teamStamp()}`;
        const first = await createTeamViaAPI(request, ctx, { name: 'Platform', slug });
        expect(first.slug).toBe(slug);
        const dup = await request.post(`${teamsBase(ctx.orgId)}/teams`, {
            headers: ctx.headers,
            data: { name: 'Platform 2', slug },
        });
        expect(dup.status()).toBe(409);
    });

    test('list returns a flat array; get detail carries members[] + childTeamIds[]', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Design ${teamStamp()}` });
        const list = await request.get(`${teamsBase(ctx.orgId)}/teams`, { headers: ctx.headers });
        expect(list.status()).toBe(200);
        const teams = await list.json();
        expect(Array.isArray(teams)).toBe(true);
        expect(teams.map((t: { id: string }) => t.id)).toContain(team.id);

        const detail = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        expect(body.id).toBe(team.id);
        expect(Array.isArray(body.members)).toBe(true);
        expect(Array.isArray(body.childTeamIds)).toBe(true);
    });

    test('update patches name + description and persists on re-read', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Ops ${teamStamp()}` });
        const patched = await request.patch(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
            data: { name: 'Operations', description: 'runs prod' },
        });
        expect(patched.status()).toBe(200);
        const body = await patched.json();
        expect(body.name).toBe('Operations');
        expect(body.description).toBe('runs prod');
        const reread = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, { headers: ctx.headers })
        ).json();
        expect(reread.name).toBe('Operations');
    });

    test('team-in-team: child carries parentTeamId; cycle + self-parent both 409', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const parent = await createTeamViaAPI(request, ctx, { name: `Parent ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `Child ${teamStamp()}`,
            parentTeamId: parent.id,
        });
        expect(child.parentTeamId).toBe(parent.id);

        // Making the parent a child of its own descendant would create a cycle.
        const cycle = await request.patch(`${teamsBase(ctx.orgId)}/teams/${parent.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: child.id },
        });
        expect(cycle.status()).toBe(409);
        // A team cannot be its own parent either.
        const self = await request.patch(`${teamsBase(ctx.orgId)}/teams/${parent.id}`, {
            headers: ctx.headers,
            data: { parentTeamId: parent.id },
        });
        expect(self.status()).toBe(409);
    });

    test('deleting a parent re-parents its children (child parentTeamId follows the deleted parent up)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const parent = await createTeamViaAPI(request, ctx, { name: `TopParent ${teamStamp()}` });
        const child = await createTeamViaAPI(request, ctx, {
            name: `SubChild ${teamStamp()}`,
            parentTeamId: parent.id,
        });
        const del = await request.delete(`${teamsBase(ctx.orgId)}/teams/${parent.id}`, {
            headers: ctx.headers,
        });
        expect(del.status()).toBe(204);
        // The parent is gone…
        expect(
            (
                await request.get(`${teamsBase(ctx.orgId)}/teams/${parent.id}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(404);
        // …and the child survives, re-parented to the deleted parent's parent (null here).
        const childAfter = await request.get(`${teamsBase(ctx.orgId)}/teams/${child.id}`, {
            headers: ctx.headers,
        });
        expect(childAfter.status()).toBe(200);
        expect((await childAfter.json()).parentTeamId).toBeNull();
    });

    test('validation: bad slug 400, missing name 400, unauth 401, unknown org 404', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const badSlug = await request.post(`${teamsBase(ctx.orgId)}/teams`, {
            headers: ctx.headers,
            data: { name: 'X', slug: 'Bad Slug!' },
        });
        expect(badSlug.status()).toBe(400);
        const noName = await request.post(`${teamsBase(ctx.orgId)}/teams`, {
            headers: ctx.headers,
            data: { slug: 'noname' },
        });
        expect(noName.status()).toBe(400);
        const unauth = await request.get(`${teamsBase(ctx.orgId)}/teams`);
        expect(unauth.status()).toBe(401);
        // Unknown org id → the ownership guard 404s before the param pipe.
        const unknownOrg = await request.get(`${teamsBase(UNKNOWN_UUID)}/teams`, {
            headers: ctx.headers,
        });
        expect(unknownOrg.status()).toBe(404);
    });
});

test.describe('Teams — roster (members)', () => {
    test('add an agent as a lead member; roster + detail reflect it; duplicate → 409; remove → 204', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Squad ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Bot ${teamStamp()}`,
        });

        const add = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: agent.id, role: 'lead' },
        });
        expect(add.status(), `addMember body=${await add.text().catch(() => '')}`).toBe(201);
        const member = await add.json();
        expect(member.memberType).toBe('agent');
        expect(member.memberId).toBe(agent.id);
        expect(member.role).toBe('lead');

        const roster = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
        });
        expect(roster.status()).toBe(200);
        expect((await roster.json()).map((m: { memberId: string }) => m.memberId)).toContain(
            agent.id,
        );

        // Duplicate add of the same agent → 409.
        const dup = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: agent.id },
        });
        expect(dup.status()).toBe(409);

        // Remove (memberType passed as a query param) → 204, and the roster empties.
        const remove = await request.delete(
            `${teamsBase(ctx.orgId)}/teams/${team.id}/members/${agent.id}?memberType=agent`,
            { headers: ctx.headers },
        );
        expect(remove.status()).toBe(204);
        const after = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
        });
        expect((await after.json()).map((m: { memberId: string }) => m.memberId)).not.toContain(
            agent.id,
        );
    });

    test('a human member who is NOT an org member → 404; the owner (an org member) can be added', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `People ${teamStamp()}` });
        const outsider = await registerUserViaAPI(request);

        const foreign = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: outsider.user.id },
        });
        expect(foreign.status()).toBe(404);

        const selfAdd = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: ctx.user.user.id },
        });
        expect(selfAdd.status()).toBe(201);
        expect((await selfAdd.json()).memberType).toBe('user');
    });
});

test.describe('Teams — resources', () => {
    test('attach a Work; grouped list buckets it under work[]; duplicate → 409; detach → 204', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `ResTeam ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Res Work ${teamStamp()}`,
            slug: `res-work-${teamStamp()}`,
        });

        const attach = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workId },
        });
        expect(attach.status(), `attach body=${await attach.text().catch(() => '')}`).toBe(201);
        expect((await attach.json()).resourceId).toBe(workId);

        const listed = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
            headers: ctx.headers,
        });
        expect(listed.status()).toBe(200);
        const grouped = await listed.json();
        expect(grouped.work.map((r: { resourceId: string }) => r.resourceId)).toContain(workId);
        expect(Array.isArray(grouped.task)).toBe(true);
        expect(Array.isArray(grouped.agent)).toBe(true);
        expect(Array.isArray(grouped.mission)).toBe(true);
        expect(Array.isArray(grouped.idea)).toBe(true);

        // Duplicate attach → 409.
        const dup = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workId },
        });
        expect(dup.status()).toBe(409);

        // Reverse lookup: which teams own this work.
        const reverse = await request.get(
            `${teamsBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${workId}`,
            { headers: ctx.headers },
        );
        expect(reverse.status()).toBe(200);
        expect((await reverse.json()).map((t: { teamId: string }) => t.teamId)).toContain(team.id);

        // Detach → 204, and the reverse lookup empties.
        const detach = await request.delete(
            `${teamsBase(ctx.orgId)}/teams/${team.id}/resources/work/${workId}`,
            { headers: ctx.headers },
        );
        expect(detach.status()).toBe(204);
        const reverseAfter = await request.get(
            `${teamsBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${workId}`,
            { headers: ctx.headers },
        );
        expect((await reverseAfter.json()).map((t: { teamId: string }) => t.teamId)).not.toContain(
            team.id,
        );
    });

    test('attach an Agent, a Mission, and a Task; each lands in its own bucket', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `MultiRes ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `RA ${teamStamp()}`,
        });
        const task = await createTaskViaAPI(request, ctx.token, { title: `RT ${teamStamp()}` });
        const missionId = await createMission(request, ctx, `RM ${teamStamp()}`);

        for (const [type, id] of [
            ['agent', agent.id],
            ['task', task.id],
            ['mission', missionId],
        ] as const) {
            const r = await request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
                headers: ctx.headers,
                data: { resourceType: type, resourceId: id },
            });
            expect(r.status(), `attach ${type} body=${await r.text().catch(() => '')}`).toBe(201);
        }

        const grouped = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
                headers: ctx.headers,
            })
        ).json();
        expect(grouped.agent.map((r: { resourceId: string }) => r.resourceId)).toContain(agent.id);
        expect(grouped.task.map((r: { resourceId: string }) => r.resourceId)).toContain(task.id);
        expect(grouped.mission.map((r: { resourceId: string }) => r.resourceId)).toContain(
            missionId,
        );
    });

    test('attaching a resource that belongs to another org → 404 (never 403)', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const other = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Guard ${teamStamp()}` });
        // A work owned by a DIFFERENT user/org.
        const { id: foreignWork } = await createWorkViaAPI(request, other.token, {
            name: `Foreign ${teamStamp()}`,
            slug: `foreign-${teamStamp()}`,
        });
        const attach = await request.post(`${teamsBase(owner.orgId)}/teams/${team.id}/resources`, {
            headers: owner.headers,
            data: { resourceType: 'work', resourceId: foreignWork },
        });
        expect(attach.status()).toBe(404);
    });
});

test.describe('Teams — org chart + cross-owner isolation', () => {
    test('org-chart returns { organization, teams, agents, members }', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        await createTeamViaAPI(request, ctx, { name: `Chart ${teamStamp()}` });
        const chart = await request.get(`${teamsBase(ctx.orgId)}/org-chart`, {
            headers: ctx.headers,
        });
        expect(chart.status()).toBe(200);
        const body = await chart.json();
        expect(body.organization).toBeTruthy();
        expect(Array.isArray(body.teams)).toBe(true);
        expect(Array.isArray(body.agents)).toBe(true);
        expect(Array.isArray(body.members)).toBe(true);
    });

    test('a non-owner is walled off from every team route with 404 (404-never-403)', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Secret ${teamStamp()}` });

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
        const hijack = await request.post(`${teamsBase(owner.orgId)}/teams`, {
            headers: intruder.headers,
            data: { name: 'hijack' },
        });
        expect(hijack.status()).toBe(404);
        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/org-chart`, {
                    headers: intruder.headers,
                })
            ).status(),
        ).toBe(404);

        // The owner's team is untouched.
        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/teams/${team.id}`, {
                    headers: owner.headers,
                })
            ).status(),
        ).toBe(200);
    });
});
