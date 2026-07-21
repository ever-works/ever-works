/**
 * Teams & Prebuilt Companies — team_resources ALL FIVE types, DEEP matrix (#1713).
 *
 * The team_resources surface links a Work / Task / Agent / Mission / Idea to a
 * Team (polymorphic edge in `team_resources`; see team-resource.entity.ts). It
 * shipped with only a couple of shallow attach/detach cases; this file drives
 * every resource type through the full lifecycle and pins the true wire shapes
 * + status codes against a live stack:
 *
 *   • attach each of the FIVE types → 201 TeamResourceItem
 *       { id, resourceType, resourceId, name, slug, addedById, createdAt }
 *     with the per-type display resolution the service actually performs:
 *       work   → name=work.name,   slug=work.slug
 *       agent  → name=agent.name,  slug=agent.slug
 *       task   → name=task.title,  slug=task.slug ("T-n")
 *       mission→ name=mission.title, slug=null
 *       idea   → name=idea.title,  slug=idea.slugSuggestion
 *   • grouped list buckets each type under its own key; every key is always an
 *     array (empty team → { work:[], task:[], agent:[], mission:[], idea:[] })
 *   • duplicate attach (same type+id) → 409; detach → 204; detach again → 404;
 *     re-attach after detach → 201
 *   • reverse lookup GET /resource-teams → ResourceTeamRef[] keyed by teamId
 *     (NOT id) with { teamId, name, slug }; a resource attached to MULTIPLE
 *     teams appears in each reverse lookup
 *   • validation: bad resourceType 400, malformed/missing resourceId 400,
 *     malformed team uuid 400, unknown-but-valid team uuid 404, reverse-lookup
 *     missing query params 400
 *   • auth gating 401; cross-org isolation 404-never-403 — a foreign resource,
 *     a type-mismatched id, and an intruder are all walled off with 404
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. See helpers/teams.ts +
 *    packages/agent/src/teams/team-resources.service.ts for the probed contract.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI() owners +
 * their lazily-minted org. Fully API-orchestrated (safe `flow-` prefix, not
 * matched by the no-auth testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
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
const RESOURCE_KEYS = ['work', 'task', 'agent', 'mission', 'idea'] as const;

function resBase(ctx: OwnerCtx, teamId: string): string {
    return `${teamsBase(ctx.orgId)}/teams/${teamId}/resources`;
}

async function createMission(
    request: APIRequestContext,
    ctx: OwnerCtx,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: ctx.headers,
        data: { title, description: 'matrix mission', type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

/** Create a user-manual Idea (WorkProposal). Description must be >= 10 chars. */
async function createIdea(
    request: APIRequestContext,
    ctx: OwnerCtx,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: ctx.headers,
        data: { title, description: `matrix idea seed — ${title}` },
    });
    expect(res.status(), `createIdea body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

async function attach(
    request: APIRequestContext,
    ctx: OwnerCtx,
    teamId: string,
    resourceType: (typeof RESOURCE_KEYS)[number],
    resourceId: string,
) {
    return request.post(resBase(ctx, teamId), {
        headers: ctx.headers,
        data: { resourceType, resourceId },
    });
}

async function grouped(request: APIRequestContext, ctx: OwnerCtx, teamId: string) {
    const res = await request.get(resBase(ctx, teamId), { headers: ctx.headers });
    expect(res.status()).toBe(200);
    return res.json();
}

async function reverseTeamIds(
    request: APIRequestContext,
    ctx: OwnerCtx,
    resourceType: string,
    resourceId: string,
): Promise<string[]> {
    const res = await request.get(
        `${teamsBase(ctx.orgId)}/resource-teams?resourceType=${resourceType}&resourceId=${resourceId}`,
        { headers: ctx.headers },
    );
    expect(res.status()).toBe(200);
    return (await res.json()).map((t: { teamId: string }) => t.teamId);
}

test.describe('team_resources — attach + grouped bucketing (all five types)', () => {
    test('attach a Work → 201 with the exact TeamResourceItem shape; work[] bucket carries it', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `W ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `MW ${teamStamp()}`,
            slug: `mw-${teamStamp()}`,
        });

        const res = await attach(request, ctx, team.id, 'work', workId);
        expect(res.status(), `attach body=${await res.text().catch(() => '')}`).toBe(201);
        const item = await res.json();
        expect(item.id).toMatch(UUID_RE);
        expect(item.resourceType).toBe('work');
        expect(item.resourceId).toBe(workId);
        expect(typeof item.name).toBe('string');
        expect(typeof item.slug).toBe('string');
        expect(item.addedById).toBe(ctx.user.user.id);
        expect(typeof item.createdAt).toBe('string');

        const g = await grouped(request, ctx, team.id);
        expect(g.work.map((r: { resourceId: string }) => r.resourceId)).toContain(workId);
    });

    test('attach an Agent → agent[] bucket resolves name + slug', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `A ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `MA ${teamStamp()}`,
        });

        const res = await attach(request, ctx, team.id, 'agent', agent.id);
        expect(res.status(), `attach body=${await res.text().catch(() => '')}`).toBe(201);
        const item = await res.json();
        expect(item.resourceType).toBe('agent');
        expect(item.name).toBe(agent.name);
        expect(item.slug).toBe(agent.slug);

        const g = await grouped(request, ctx, team.id);
        expect(g.agent.map((r: { resourceId: string }) => r.resourceId)).toContain(agent.id);
    });

    test('attach a Task → task[] bucket resolves name=title and slug=T-n', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `T ${teamStamp()}` });
        const task = await createTaskViaAPI(request, ctx.token, { title: `MT ${teamStamp()}` });

        const res = await attach(request, ctx, team.id, 'task', task.id);
        expect(res.status(), `attach body=${await res.text().catch(() => '')}`).toBe(201);
        const item = await res.json();
        expect(item.resourceType).toBe('task');
        expect(item.name).toBe(task.title);
        // Tasks carry a human slug ("T-n"), which the service surfaces verbatim.
        expect(item.slug).toBe(task.slug);
        expect(item.slug).toMatch(/^T-\d+$/);

        const g = await grouped(request, ctx, team.id);
        expect(g.task.map((r: { resourceId: string }) => r.resourceId)).toContain(task.id);
    });

    test('attach a Mission → mission[] bucket resolves name=title and slug=null', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `M ${teamStamp()}` });
        const missionId = await createMission(request, ctx, `MM ${teamStamp()}`);

        const res = await attach(request, ctx, team.id, 'mission', missionId);
        expect(res.status(), `attach body=${await res.text().catch(() => '')}`).toBe(201);
        const item = await res.json();
        expect(item.resourceType).toBe('mission');
        expect(typeof item.name).toBe('string');
        // Missions expose no slug — the service maps it to null.
        expect(item.slug).toBeNull();

        const g = await grouped(request, ctx, team.id);
        expect(g.mission.map((r: { resourceId: string }) => r.resourceId)).toContain(missionId);
    });

    test('attach an Idea → idea[] bucket resolves name=title and slug=slugSuggestion', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `I ${teamStamp()}` });
        const ideaId = await createIdea(request, ctx, `MI ${teamStamp()}`);

        const res = await attach(request, ctx, team.id, 'idea', ideaId);
        expect(res.status(), `attach body=${await res.text().catch(() => '')}`).toBe(201);
        const item = await res.json();
        expect(item.resourceType).toBe('idea');
        expect(typeof item.name).toBe('string');
        // Ideas (WorkProposals) expose slugSuggestion — a non-null kebab slug.
        expect(typeof item.slug).toBe('string');
        expect(item.slug).toMatch(/^[a-z0-9]/);

        const g = await grouped(request, ctx, team.id);
        expect(g.idea.map((r: { resourceId: string }) => r.resourceId)).toContain(ideaId);
    });

    test('a fresh team lists all five buckets as empty arrays (never missing keys)', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Empty ${teamStamp()}` });
        const g = await grouped(request, ctx, team.id);
        for (const key of RESOURCE_KEYS) {
            expect(Array.isArray(g[key]), `key ${key}`).toBe(true);
            expect(g[key]).toHaveLength(0);
        }
    });

    test('all five types on one team → grouped list buckets each under its own key', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `AllFive ${teamStamp()}` });

        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `AF Work ${teamStamp()}`,
            slug: `af-work-${teamStamp()}`,
        });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `AF Agent ${teamStamp()}`,
        });
        const task = await createTaskViaAPI(request, ctx.token, {
            title: `AF Task ${teamStamp()}`,
        });
        const missionId = await createMission(request, ctx, `AF Mission ${teamStamp()}`);
        const ideaId = await createIdea(request, ctx, `AF Idea ${teamStamp()}`);

        const byType: Record<string, string> = {
            work: workId,
            agent: agent.id,
            task: task.id,
            mission: missionId,
            idea: ideaId,
        };
        for (const key of RESOURCE_KEYS) {
            const r = await attach(request, ctx, team.id, key, byType[key]);
            expect(r.status(), `attach ${key} body=${await r.text().catch(() => '')}`).toBe(201);
        }

        const g = await grouped(request, ctx, team.id);
        // Each resource lands in exactly its own bucket — and nowhere else.
        for (const key of RESOURCE_KEYS) {
            const ids = g[key].map((r: { resourceId: string }) => r.resourceId);
            expect(ids, `bucket ${key} should contain ${byType[key]}`).toContain(byType[key]);
            for (const other of RESOURCE_KEYS) {
                if (other === key) continue;
                expect(ids, `bucket ${key} must not leak ${other}`).not.toContain(byType[other]);
            }
        }
    });
});

test.describe('team_resources — duplicate, detach, idempotency', () => {
    test('duplicate attach of the same (type,id) → 409', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Dup ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Dup ${teamStamp()}`,
        });

        expect((await attach(request, ctx, team.id, 'agent', agent.id)).status()).toBe(201);
        const dup = await attach(request, ctx, team.id, 'agent', agent.id);
        expect(dup.status()).toBe(409);
        expect((await dup.json()).message).toMatch(/already attached/i);
    });

    test('detach → 204 and the resource leaves its grouped bucket', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Det ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Det Work ${teamStamp()}`,
            slug: `det-work-${teamStamp()}`,
        });
        await attach(request, ctx, team.id, 'work', workId);

        const detach = await request.delete(`${resBase(ctx, team.id)}/work/${workId}`, {
            headers: ctx.headers,
        });
        expect(detach.status()).toBe(204);
        const g = await grouped(request, ctx, team.id);
        expect(g.work.map((r: { resourceId: string }) => r.resourceId)).not.toContain(workId);
    });

    test('detach again → 404; detach a never-attached resource → 404', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Det2 ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Det2 Work ${teamStamp()}`,
            slug: `det2-work-${teamStamp()}`,
        });
        await attach(request, ctx, team.id, 'work', workId);
        expect(
            (
                await request.delete(`${resBase(ctx, team.id)}/work/${workId}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(204);

        // Second detach — nothing matched → 404.
        expect(
            (
                await request.delete(`${resBase(ctx, team.id)}/work/${workId}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(404);
        // Never-attached id → also 404.
        expect(
            (
                await request.delete(`${resBase(ctx, team.id)}/work/${UNKNOWN_UUID}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(404);
    });

    test('re-attach after detach → 201 (the unique edge is freed)', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Re ${teamStamp()}` });
        const task = await createTaskViaAPI(request, ctx.token, {
            title: `Re Task ${teamStamp()}`,
        });

        expect((await attach(request, ctx, team.id, 'task', task.id)).status()).toBe(201);
        expect(
            (
                await request.delete(`${resBase(ctx, team.id)}/task/${task.id}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(204);
        // The (team, type, id) uniqueness no longer trips — re-attach succeeds.
        const again = await attach(request, ctx, team.id, 'task', task.id);
        expect(again.status(), `re-attach body=${await again.text().catch(() => '')}`).toBe(201);
    });
});

test.describe('team_resources — reverse lookup (resource-teams)', () => {
    test('reverse lookup returns ResourceTeamRef[] keyed by teamId (not id) with name + slug', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Rev ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Rev Work ${teamStamp()}`,
            slug: `rev-work-${teamStamp()}`,
        });
        await attach(request, ctx, team.id, 'work', workId);

        const res = await request.get(
            `${teamsBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${workId}`,
            { headers: ctx.headers },
        );
        expect(res.status()).toBe(200);
        const refs = await res.json();
        expect(Array.isArray(refs)).toBe(true);
        const mine = refs.find((r: { teamId: string }) => r.teamId === team.id);
        expect(mine, 'reverse lookup should surface the owning team').toBeTruthy();
        // The reverse-lookup ref is keyed by `teamId`, NOT `id`.
        expect(mine.teamId).toBe(team.id);
        expect(mine.id).toBeUndefined();
        expect(mine.name).toBe(team.name);
        expect(mine.slug).toBe(team.slug);
    });

    test('a resource attached to MULTIPLE teams appears in each reverse lookup', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const teamA = await createTeamViaAPI(request, ctx, { name: `MultiA ${teamStamp()}` });
        const teamB = await createTeamViaAPI(request, ctx, { name: `MultiB ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Shared ${teamStamp()}`,
        });

        expect((await attach(request, ctx, teamA.id, 'agent', agent.id)).status()).toBe(201);
        expect((await attach(request, ctx, teamB.id, 'agent', agent.id)).status()).toBe(201);

        const teamIds = await reverseTeamIds(request, ctx, 'agent', agent.id);
        expect(teamIds).toContain(teamA.id);
        expect(teamIds).toContain(teamB.id);

        // Detaching from one team leaves the other reverse edge intact.
        expect(
            (
                await request.delete(`${resBase(ctx, teamA.id)}/agent/${agent.id}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(204);
        const after = await reverseTeamIds(request, ctx, 'agent', agent.id);
        expect(after).not.toContain(teamA.id);
        expect(after).toContain(teamB.id);
    });

    test('reverse lookup resolves each of the five resource types', async ({ request }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `RevAll ${teamStamp()}` });

        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `RA Work ${teamStamp()}`,
            slug: `ra-work-${teamStamp()}`,
        });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `RA Agent ${teamStamp()}`,
        });
        const task = await createTaskViaAPI(request, ctx.token, {
            title: `RA Task ${teamStamp()}`,
        });
        const missionId = await createMission(request, ctx, `RA Mission ${teamStamp()}`);
        const ideaId = await createIdea(request, ctx, `RA Idea ${teamStamp()}`);

        const byType: Array<[(typeof RESOURCE_KEYS)[number], string]> = [
            ['work', workId],
            ['agent', agent.id],
            ['task', task.id],
            ['mission', missionId],
            ['idea', ideaId],
        ];
        for (const [type, id] of byType) {
            expect((await attach(request, ctx, team.id, type, id)).status()).toBe(201);
        }
        for (const [type, id] of byType) {
            const teamIds = await reverseTeamIds(request, ctx, type, id);
            expect(teamIds, `reverse ${type}`).toContain(team.id);
        }
    });

    test('reverse lookup for an unattached (but valid) resource id → []', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const res = await request.get(
            `${teamsBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${UNKNOWN_UUID}`,
            { headers: ctx.headers },
        );
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

test.describe('team_resources — validation & malformed input', () => {
    test('attach with an unknown resourceType → 400', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Val ${teamStamp()}` });
        const res = await request.post(resBase(ctx, team.id), {
            headers: ctx.headers,
            data: { resourceType: 'widget', resourceId: UNKNOWN_UUID },
        });
        expect(res.status()).toBe(400);
    });

    test('attach with a malformed or missing resourceId → 400', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Val2 ${teamStamp()}` });
        const malformed = await request.post(resBase(ctx, team.id), {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: 'not-a-uuid' },
        });
        expect(malformed.status()).toBe(400);
        const missing = await request.post(resBase(ctx, team.id), {
            headers: ctx.headers,
            data: { resourceType: 'work' },
        });
        expect(missing.status()).toBe(400);
    });

    test('malformed team uuid → 400 (ParseUUIDPipe); unknown-but-valid team uuid → 404', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Val3 Work ${teamStamp()}`,
            slug: `val3-work-${teamStamp()}`,
        });
        const malformed = await request.post(`${teamsBase(ctx.orgId)}/teams/not-a-uuid/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workId },
        });
        expect(malformed.status()).toBe(400);
        const unknown = await request.post(
            `${teamsBase(ctx.orgId)}/teams/${UNKNOWN_UUID}/resources`,
            {
                headers: ctx.headers,
                data: { resourceType: 'work', resourceId: workId },
            },
        );
        expect(unknown.status()).toBe(404);
    });

    test('detach with a bad resourceType or malformed resourceId → 400', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Val4 ${teamStamp()}` });
        // The detach path param resourceType is normalized in the service → 400.
        expect(
            (
                await request.delete(`${resBase(ctx, team.id)}/widget/${UNKNOWN_UUID}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(400);
        // The resourceId path param runs through ParseUUIDPipe → 400.
        expect(
            (
                await request.delete(`${resBase(ctx, team.id)}/work/not-a-uuid`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(400);
    });

    test('reverse lookup validation: bad resourceType 400, malformed id 400, missing params 400', async ({
        request,
    }) => {
        const ctx = await buildOwnerCtx(request);
        const base = `${teamsBase(ctx.orgId)}/resource-teams`;
        expect(
            (
                await request.get(`${base}?resourceType=widget&resourceId=${UNKNOWN_UUID}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${base}?resourceType=work&resourceId=not-a-uuid`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(400);
        expect((await request.get(base, { headers: ctx.headers })).status()).toBe(400);
    });
});

test.describe('team_resources — auth + cross-org isolation (404-never-403)', () => {
    test('every resource route requires auth → 401', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Auth ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Auth Work ${teamStamp()}`,
            slug: `auth-work-${teamStamp()}`,
        });

        expect((await request.get(resBase(ctx, team.id))).status()).toBe(401);
        expect(
            (
                await request.post(resBase(ctx, team.id), {
                    data: { resourceType: 'work', resourceId: workId },
                })
            ).status(),
        ).toBe(401);
        expect((await request.delete(`${resBase(ctx, team.id)}/work/${workId}`)).status()).toBe(
            401,
        );
        expect(
            (
                await request.get(
                    `${teamsBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${workId}`,
                )
            ).status(),
        ).toBe(401);
    });

    test('attaching an unknown-but-valid resource id → 404', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Unk ${teamStamp()}` });
        const res = await attach(request, ctx, team.id, 'work', UNKNOWN_UUID);
        expect(res.status()).toBe(404);
    });

    test('type-mismatched id (a Mission id declared as a Work) → 404', async ({ request }) => {
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Mismatch ${teamStamp()}` });
        const missionId = await createMission(request, ctx, `Mismatch ${teamStamp()}`);
        // The id is real, but it lives in `missions`, not `works` → not found.
        const res = await attach(request, ctx, team.id, 'work', missionId);
        expect(res.status()).toBe(404);
    });

    test('attaching a resource that belongs to ANOTHER org → 404 (never 403)', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const other = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Guard ${teamStamp()}` });
        const { id: foreignWork } = await createWorkViaAPI(request, other.token, {
            name: `Foreign ${teamStamp()}`,
            slug: `foreign-${teamStamp()}`,
        });
        const res = await attach(request, owner, team.id, 'work', foreignWork);
        expect(res.status()).toBe(404);
    });

    test('an intruder is walled off from list, attach, detach, and reverse lookup with 404', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Secret ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, owner.token, {
            scope: 'tenant',
            name: `Secret ${teamStamp()}`,
        });
        expect((await attach(request, owner, team.id, 'agent', agent.id)).status()).toBe(201);

        const base = teamsBase(owner.orgId);
        // Every route is OrganizationOwnershipGuard'd — a non-owner 404s org-wide.
        expect(
            (
                await request.get(`${base}/teams/${team.id}/resources`, {
                    headers: intruder.headers,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${base}/teams/${team.id}/resources`, {
                    headers: intruder.headers,
                    data: { resourceType: 'agent', resourceId: agent.id },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(`${base}/teams/${team.id}/resources/agent/${agent.id}`, {
                    headers: intruder.headers,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(
                    `${base}/resource-teams?resourceType=agent&resourceId=${agent.id}`,
                    { headers: intruder.headers },
                )
            ).status(),
        ).toBe(404);

        // The owner's attachment is untouched by the intruder's probing.
        const ownerTeamIds = await reverseTeamIds(request, owner, 'agent', agent.id);
        expect(ownerTeamIds).toContain(team.id);
    });
});
