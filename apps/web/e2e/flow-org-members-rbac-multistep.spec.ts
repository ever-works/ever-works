/**
 * Org members + RBAC, MULTI-STEP — the org-scoped Teams membership substrate.
 *
 * The Organizations API has NO `/:id/members`/role endpoints of its own (probed
 * live: every such URL 404s; sibling flow-org-member-roles-matrix pins that
 * negative). The REAL org-scoped "member roles" surface in this product is
 * TEAMS, which nest under `/api/organizations/:orgId/...` and are object-level
 * authorized by `OrganizationOwnershipGuard` (member reads, `@OrgAdmin()`
 * writes — today both resolve to the same tenant-ownership check). This file
 * drives that surface end-to-end as the org RBAC boundary, on axes the sibling
 * team specs (flow-teams-crud-deep, flow-teams-org-chart-hierarchy-deep) and org
 * specs (switch-context, settings-persistence, billing-scope) do NOT cover:
 *
 *   • the member/ROLE matrix: agent member 'lead' vs human member default
 *     'member'; the roster + team-detail reflect each role; invalid role → 400
 *   • the org-MEMBERSHIP gate on human members: a non-org-member human → 404,
 *     the org owner (the org's member) → 201; duplicate → 409; remove → 204
 *   • org-SCOPE isolation across TWO orgs of the SAME owner (one tenant): a team
 *     created under org A is absent from org B's list + org-chart; a team id is
 *     (orgId, teamId)-scoped (A's team is 404 under B's path); a Work stamped
 *     under org B canNOT be attached to org A's team → 404 (same-org rule),
 *     while the org-A Work attaches (201 → dup 409 → reverse-lookup → detach 204)
 *   • cross-TENANT isolation: an intruder is walled off every team route → 404
 *     (404-never-403); unknown-but-valid org uuid → 404; MALFORMED org id → 404
 *     (the ownership guard fails closed BEFORE ParseUUIDPipe — so it shadows the
 *     usual 400), whereas a malformed teamId UNDER an owned org → 400 (the pipe
 *     runs after the guard passes); unauth → 401
 *   • org SETTINGS persistence + owner-only mutate: PATCH displayName/legalName/
 *     countryCode persists + re-resolves by slug; explicit-null displayName 400;
 *     unknown field 400; a non-owner PATCH is rejected ([401,404]) w/o mutation
 *   • BILLING scope: subscription plan + account-wide usage are USER-keyed and
 *     org-context-INVARIANT (the X-Scope-Slug org header never re-homes them); a
 *     non-member claiming the owner's org scope on a scoped route → 403, while
 *     the org slug resolver stays a global 200 that conveys no billing
 *
 * ── Verified live (http://127.0.0.1:3100, sqlite in-memory — the CI driver)
 *    before every assertion. Team member view: { id, memberType, memberId, role,
 *    name, createdAt } (agents also carry title). Grouped resources:
 *    { work[], task[], agent[], mission[], idea[] }. Org-chart:
 *    { organization:{id,slug,displayName}, teams[], agents[], members[] }.
 *
 * Fully API-orchestrated; FRESH registerUserViaAPI() owners per test (never the
 * shared seeded user). Safe `flow-` prefix (not matched by the no-auth
 * testIgnore regex). List assertions use toContain/not.toContain on ids —
 * never exact global counts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createOrganizationViaAPI, type Organization } from './helpers/organizations';
import { createAgentViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface Ctx {
    user: RegisteredUser;
    token: string;
    headers: { Authorization: string };
    org: Organization;
    orgId: string;
    orgSlug: string;
}

/** A fresh user + their first org (which lazily mints the tenant). */
async function buildOwner(request: APIRequestContext, label = 'RBAC'): Promise<Ctx> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const org = await createOrganizationViaAPI(request, token, `${label} Org ${stamp()}`);
    return { user, token, headers: authedHeaders(token), org, orgId: org.id, orgSlug: org.slug };
}

function orgBase(orgId: string): string {
    return `${API_BASE}/api/organizations/${orgId}`;
}

interface TeamResponse {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    parentTeamId: string | null;
    organizationId: string | null;
}

async function createTeam(
    request: APIRequestContext,
    ctx: Ctx,
    body: { name: string; slug?: string; description?: string },
): Promise<TeamResponse> {
    const res = await request.post(`${orgBase(ctx.orgId)}/teams`, {
        headers: ctx.headers,
        data: body,
    });
    expect(res.status(), `createTeam body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** POST /api/works stamped under a given active-org scope (X-Scope-Slug). */
async function createScopedWork(
    request: APIRequestContext,
    token: string,
    scopeSlug: string,
    name: string,
): Promise<{ id: string; organizationId: string | null }> {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp()}`;
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: { ...authedHeaders(token), 'X-Scope-Slug': scopeSlug },
        data: { name, slug, description: `e2e ${name}`, organization: false },
    });
    // Probed: POST /api/works → 200 { status:'success', work:{ id, organizationId, tenantId } }.
    expect(res.status(), `createScopedWork body=${await res.text().catch(() => '')}`).toBe(200);
    const work = (await res.json()).work as { id: string; organizationId: string | null };
    return { id: work.id, organizationId: work.organizationId };
}

interface PlanResponse {
    status: string;
    enabled: boolean;
    plan: { code: string; name: string; allowedCadences?: unknown[] };
}

async function getPlan(
    request: APIRequestContext,
    token: string,
    scopeSlug?: string,
): Promise<PlanResponse> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (scopeSlug) headers['X-Scope-Slug'] = scopeSlug;
    const res = await request.get(`${API_BASE}/api/subscriptions/plan`, { headers });
    expect(res.status(), `getPlan body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Org RBAC — the org-scoped Teams membership + role matrix', () => {
    test('create-team is an OrgAdmin write that returns an org-stamped team; the roster starts empty', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, {
            name: `Squad ${stamp()}`,
            description: 'builds',
        });
        expect(team.id).toMatch(UUID_RE);
        expect(team.slug).toMatch(/^squad-/);
        expect(team.description).toBe('builds');
        expect(team.organizationId).toBe(ctx.orgId);
        expect(team.parentTeamId).toBeNull();

        // A fresh team has an empty roster; detail carries members[] + childTeamIds[].
        const detail = await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        expect(body.id).toBe(team.id);
        expect(Array.isArray(body.members)).toBe(true);
        expect(body.members).toHaveLength(0);
        expect(Array.isArray(body.childTeamIds)).toBe(true);
    });

    test('role matrix: an agent joins as LEAD and the org owner (a human member) joins with the default role MEMBER', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, { name: `Roster ${stamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Bot ${stamp()}`,
        });

        // Agent → explicit 'lead'.
        const addAgent = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: agent.id, role: 'lead' },
        });
        expect(addAgent.status(), `addAgent body=${await addAgent.text().catch(() => '')}`).toBe(
            201,
        );
        const agentMember = await addAgent.json();
        expect(agentMember.memberType).toBe('agent');
        expect(agentMember.memberId).toBe(agent.id);
        expect(agentMember.role).toBe('lead');

        // Human org-owner → role OMITTED, so it defaults to 'member' (DTO default).
        const addHuman = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: ctx.user.user.id },
        });
        expect(addHuman.status(), `addHuman body=${await addHuman.text().catch(() => '')}`).toBe(
            201,
        );
        const humanMember = await addHuman.json();
        expect(humanMember.memberType).toBe('user');
        expect(humanMember.memberId).toBe(ctx.user.user.id);
        expect(humanMember.role).toBe('member');

        // The roster + detail carry BOTH rows with their distinct roles.
        const roster = await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
        });
        expect(roster.status()).toBe(200);
        const rows = (await roster.json()) as Array<{
            memberId: string;
            role: string;
            memberType: string;
        }>;
        const byId = new Map(rows.map((r) => [r.memberId, r]));
        expect(byId.get(agent.id)?.role).toBe('lead');
        expect(byId.get(agent.id)?.memberType).toBe('agent');
        expect(byId.get(ctx.user.user.id)?.role).toBe('member');
        expect(byId.get(ctx.user.user.id)?.memberType).toBe('user');
    });

    test('membership gate: a human who is NOT an org member → 404; the org owner (a member) → 201', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, { name: `Gate ${stamp()}` });
        const outsider = await registerUserViaAPI(request);

        // A stranger is not a member of this org's tenant → cannot be added.
        const foreign = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: outsider.user.id },
        });
        expect(foreign.status()).toBe(404);

        // The owner IS the org's member → added cleanly.
        const selfAdd = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'user', memberId: ctx.user.user.id },
        });
        expect(selfAdd.status()).toBe(201);
    });

    test('roster lifecycle: duplicate member → 409; remove (memberType query) → 204 empties the roster', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, { name: `Life ${stamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `LB ${stamp()}`,
        });

        expect(
            (
                await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
                    headers: ctx.headers,
                    data: { memberType: 'agent', memberId: agent.id, role: 'lead' },
                })
            ).status(),
        ).toBe(201);

        // Re-adding the same agent (even with a different role) is a 409, not a role-update.
        const dup = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: agent.id, role: 'member' },
        });
        expect(dup.status()).toBe(409);

        // Remove requires the memberType as a query param → 204, roster empties.
        const remove = await request.delete(
            `${orgBase(ctx.orgId)}/teams/${team.id}/members/${agent.id}?memberType=agent`,
            { headers: ctx.headers },
        );
        expect(remove.status()).toBe(204);
        const after = await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
        });
        expect((await after.json()).map((m: { memberId: string }) => m.memberId)).not.toContain(
            agent.id,
        );
    });

    test('member DTO validation: invalid role 400, invalid memberType 400, malformed memberId 400, remove w/o memberType 400, unknown agent 404', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, { name: `Val ${stamp()}` });

        const badRole = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: UNKNOWN_UUID, role: 'superadmin' },
        });
        expect(badRole.status()).toBe(400);

        const badType = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'robot', memberId: UNKNOWN_UUID },
        });
        expect(badType.status()).toBe(400);

        const badId = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: 'not-a-uuid' },
        });
        expect(badId.status()).toBe(400);

        // A valid-but-unknown agent uuid passes validation, then 404s (agent not found).
        const unknownAgent = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
            data: { memberType: 'agent', memberId: UNKNOWN_UUID },
        });
        expect(unknownAgent.status()).toBe(404);

        // DELETE without the required ?memberType query → 400.
        const noQuery = await request.delete(
            `${orgBase(ctx.orgId)}/teams/${team.id}/members/${UNKNOWN_UUID}`,
            { headers: ctx.headers },
        );
        expect(noQuery.status()).toBe(400);
    });
});

test.describe('Org RBAC — org-scope isolation across TWO orgs of ONE owner (single tenant)', () => {
    test('teams are :orgId-scoped: a team created under org A is absent from org B (same owner, same tenant)', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const orgB = await createOrganizationViaAPI(request, ctx.token, `Second Org ${stamp()}`);
        // Both orgs share the one lazily-minted tenant.
        expect(orgB.tenantId).toBe(ctx.org.tenantId);

        const teamA = await createTeam(request, ctx, { name: `A-only ${stamp()}` });

        // org A lists the team; org B (same owner!) does NOT — the list is path-scoped by :orgId.
        const listA = await request.get(`${orgBase(ctx.orgId)}/teams`, { headers: ctx.headers });
        expect(listA.status()).toBe(200);
        expect((await listA.json()).map((t: { id: string }) => t.id)).toContain(teamA.id);

        const listB = await request.get(`${orgBase(orgB.id)}/teams`, { headers: ctx.headers });
        expect(listB.status()).toBe(200);
        expect((await listB.json()).map((t: { id: string }) => t.id)).not.toContain(teamA.id);

        // The org-chart is likewise disjoint: A's chart names the team, B's does not.
        const chartA = await request.get(`${orgBase(ctx.orgId)}/org-chart`, {
            headers: ctx.headers,
        });
        expect(chartA.status()).toBe(200);
        const chartABody = await chartA.json();
        expect(chartABody.organization.id).toBe(ctx.orgId);
        expect(chartABody.teams.map((t: { id: string }) => t.id)).toContain(teamA.id);

        const chartB = await request.get(`${orgBase(orgB.id)}/org-chart`, { headers: ctx.headers });
        expect(chartB.status()).toBe(200);
        const chartBBody = await chartB.json();
        expect(chartBBody.organization.id).toBe(orgB.id);
        expect(chartBBody.teams.map((t: { id: string }) => t.id)).not.toContain(teamA.id);
    });

    test('a team id is (orgId, teamId)-scoped: org A’s team is 404 when addressed under org B’s path', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const orgB = await createOrganizationViaAPI(request, ctx.token, `Cross Org ${stamp()}`);
        const teamA = await createTeam(request, ctx, { name: `Scoped ${stamp()}` });

        // The owner reaches the team via A's path…
        expect(
            (
                await request.get(`${orgBase(ctx.orgId)}/teams/${teamA.id}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(200);
        // …but the SAME team id under B's path is not found (the tuple, not just the tenant, scopes it).
        expect(
            (
                await request.get(`${orgBase(orgB.id)}/teams/${teamA.id}`, { headers: ctx.headers })
            ).status(),
        ).toBe(404);
        // A PATCH of A's team via B's path is equally walled off.
        expect(
            (
                await request.patch(`${orgBase(orgB.id)}/teams/${teamA.id}`, {
                    headers: ctx.headers,
                    data: { name: 'moved' },
                })
            ).status(),
        ).toBe(404);
    });

    test('cross-org resource attach: a Work stamped under org B canNOT be attached to org A’s team → 404 (same-org rule)', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const orgB = await createOrganizationViaAPI(request, ctx.token, `WorkScope B ${stamp()}`);
        const team = await createTeam(request, ctx, { name: `Attach ${stamp()}` });

        // A Work stamped under org B (same owner) carries B's org id.
        const workB = await createScopedWork(request, ctx.token, orgB.slug, 'B-work');
        expect(workB.organizationId).toBe(orgB.id);

        // Attaching that B-scoped Work to A's team is 404 — the resource must belong to A.
        const crossAttach = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workB.id },
        });
        expect(crossAttach.status()).toBe(404);
    });

    test('same-org resource attach lifecycle: A-scoped Work attaches (201) → grouped bucket → dup 409 → reverse-lookup → detach 204', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, { name: `Res ${stamp()}` });

        // A Work stamped under org A attaches cleanly.
        const workA = await createScopedWork(request, ctx.token, ctx.orgSlug, 'A-work');
        expect(workA.organizationId).toBe(ctx.orgId);
        const attach = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workA.id },
        });
        expect(attach.status(), `attach body=${await attach.text().catch(() => '')}`).toBe(201);
        expect((await attach.json()).resourceId).toBe(workA.id);

        // The grouped list buckets it under work[]; the other buckets exist and are arrays.
        const grouped = await (
            await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}/resources`, {
                headers: ctx.headers,
            })
        ).json();
        expect(grouped.work.map((r: { resourceId: string }) => r.resourceId)).toContain(workA.id);
        for (const bucket of ['task', 'agent', 'mission', 'idea'] as const) {
            expect(Array.isArray(grouped[bucket])).toBe(true);
        }

        // Duplicate attach → 409.
        const dup = await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/resources`, {
            headers: ctx.headers,
            data: { resourceType: 'work', resourceId: workA.id },
        });
        expect(dup.status()).toBe(409);

        // Reverse lookup finds the owning team, then detach → 204 and the reverse lookup empties.
        const reverse = await request.get(
            `${orgBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${workA.id}`,
            { headers: ctx.headers },
        );
        expect(reverse.status()).toBe(200);
        expect((await reverse.json()).map((t: { teamId: string }) => t.teamId)).toContain(team.id);

        const detach = await request.delete(
            `${orgBase(ctx.orgId)}/teams/${team.id}/resources/work/${workA.id}`,
            { headers: ctx.headers },
        );
        expect(detach.status()).toBe(204);
        const reverseAfter = await request.get(
            `${orgBase(ctx.orgId)}/resource-teams?resourceType=work&resourceId=${workA.id}`,
            { headers: ctx.headers },
        );
        expect((await reverseAfter.json()).map((t: { teamId: string }) => t.teamId)).not.toContain(
            team.id,
        );
    });
});

test.describe('Org RBAC — cross-TENANT isolation (404-never-403)', () => {
    test('an intruder (different tenant) is walled off every team route with 404; the owner’s team is untouched', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const intruder = await registerUserViaAPI(request);
        const iH = authedHeaders(intruder.access_token);
        const team = await createTeam(request, ctx, { name: `Secret ${stamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `SB ${stamp()}`,
        });

        // Reads.
        expect((await request.get(`${orgBase(ctx.orgId)}/teams`, { headers: iH })).status()).toBe(
            404,
        );
        expect(
            (await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}`, { headers: iH })).status(),
        ).toBe(404);
        expect(
            (await request.get(`${orgBase(ctx.orgId)}/org-chart`, { headers: iH })).status(),
        ).toBe(404);

        // Writes.
        expect(
            (
                await request.post(`${orgBase(ctx.orgId)}/teams`, {
                    headers: iH,
                    data: { name: 'hijack' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
                    headers: iH,
                    data: { memberType: 'agent', memberId: agent.id },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(`${orgBase(ctx.orgId)}/teams/${team.id}`, { headers: iH })
            ).status(),
        ).toBe(404);

        // The owner still fully controls their team — the 404s were the guard, not a broken team.
        expect(
            (
                await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(200);
    });

    test('id-shape contract: unknown org uuid → 404; MALFORMED org id → 404 (guard shadows the pipe); malformed teamId under an owned org → 400; unauth → 401', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const team = await createTeam(request, ctx, { name: `Shapes ${stamp()}` });

        // Unknown-but-valid org uuid: the ownership guard 404s (no such org in my tenant).
        expect(
            (
                await request.get(`${orgBase(UNKNOWN_UUID)}/teams`, { headers: ctx.headers })
            ).status(),
        ).toBe(404);

        // MALFORMED org id: the class-level OrganizationOwnershipGuard runs BEFORE the
        // :orgId ParseUUIDPipe and fails closed → 404 (NOT the usual 400). This is the
        // notable inversion — the guard shadows the pipe on the org segment.
        expect(
            (
                await request.get(`${orgBase('not-a-uuid')}/teams`, { headers: ctx.headers })
            ).status(),
        ).toBe(404);

        // Under an OWNED org the guard passes, so the :teamId ParseUUIDPipe now runs and a
        // malformed teamId → 400 — the opposite outcome from a malformed org id.
        expect(
            (
                await request.get(`${orgBase(ctx.orgId)}/teams/not-a-uuid`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(400);
        // …and an unknown-but-valid teamId under the owned org → 404.
        expect(
            (
                await request.get(`${orgBase(ctx.orgId)}/teams/${UNKNOWN_UUID}`, {
                    headers: ctx.headers,
                })
            ).status(),
        ).toBe(404);

        // No bearer → 401 (AuthSessionGuard) before any org logic.
        expect((await request.get(`${orgBase(ctx.orgId)}/teams`)).status()).toBe(401);
        expect((await request.get(`${orgBase(ctx.orgId)}/teams/${team.id}`)).status()).toBe(401);
    });
});

test.describe('Org RBAC — settings persistence + owner-only mutate', () => {
    test('owner PATCH persists displayName/legalName/countryCode and re-resolves by slug + in the tenant list', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const s = stamp();
        const patch = await request.patch(`${orgBase(ctx.orgId)}`, {
            headers: ctx.headers,
            data: { displayName: `Renamed ${s}`, legalName: `Legal ${s} LLC`, countryCode: 'US' },
        });
        expect(patch.status(), `patch body=${await patch.text().catch(() => '')}`).toBe(200);
        const patched = await patch.json();
        expect(patched.displayName).toBe(`Renamed ${s}`);
        expect(patched.legalName).toBe(`Legal ${s} LLC`);
        expect(patched.countryCode).toBe('US');

        // Durable: the global slug resolver reflects the new fields.
        const resolved = await request.get(
            `${API_BASE}/api/organizations/${encodeURIComponent(ctx.orgSlug)}`,
            { headers: ctx.headers },
        );
        expect(resolved.status()).toBe(200);
        const resolvedBody = await resolved.json();
        expect(resolvedBody.displayName).toBe(`Renamed ${s}`);
        expect(resolvedBody.countryCode).toBe('US');

        // …and the tenant-scoped list carries the renamed org.
        const list = await request.get(`${API_BASE}/api/organizations`, { headers: ctx.headers });
        expect(list.status()).toBe(200);
        const row = (await list.json()).find((o: Organization) => o.id === ctx.orgId);
        expect(row?.displayName).toBe(`Renamed ${s}`);
    });

    test('settings validation: explicit-null displayName 400, unknown field 400, bad countryCode length 400; a valid field still updates after', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);

        // displayName maps to a NOT NULL column; explicit null → 400 (ValidateIf guard), never a 500.
        expect(
            (
                await request.patch(`${orgBase(ctx.orgId)}`, {
                    headers: ctx.headers,
                    data: { displayName: null },
                })
            ).status(),
        ).toBe(400);

        // forbidNonWhitelisted → an unknown field like a fictional org `role` is 400 (no hidden role API).
        expect(
            (
                await request.patch(`${orgBase(ctx.orgId)}`, {
                    headers: ctx.headers,
                    data: { role: 'admin' },
                })
            ).status(),
        ).toBe(400);

        // countryCode is @Length(2,2): a 3-char value is a 400.
        expect(
            (
                await request.patch(`${orgBase(ctx.orgId)}`, {
                    headers: ctx.headers,
                    data: { countryCode: 'USA' },
                })
            ).status(),
        ).toBe(400);

        // A valid field still updates cleanly afterwards (the 400s were validation, not corruption).
        const ok = await request.patch(`${orgBase(ctx.orgId)}`, {
            headers: ctx.headers,
            data: { legalName: `Clean ${stamp()} LLC` },
        });
        expect(ok.status()).toBe(200);
    });

    test('a non-owner PATCH is rejected ([401,404]) and leaves the org unmutated (owner re-read proves it)', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const original = ctx.org.displayName;
        const intruder = await registerUserViaAPI(request);

        // The intruder (a tenant-less fresh user) cannot mutate the org. The exact non-2xx
        // varies by whether the caller has a tenant (401 no-tenant vs 404 foreign-tenant) —
        // both are "rejected, no mutation". Assert tolerantly, then prove no mutation.
        const hijack = await request.patch(`${orgBase(ctx.orgId)}`, {
            headers: authedHeaders(intruder.access_token),
            data: { displayName: `Hijacked ${stamp()}` },
        });
        expect(
            [401, 403, 404].includes(hijack.status()),
            `non-owner PATCH should be rejected, got ${hijack.status()}`,
        ).toBe(true);

        // Authoritative no-mutation proof: the owner re-resolves and the displayName is unchanged.
        const after = await request.get(
            `${API_BASE}/api/organizations/${encodeURIComponent(ctx.orgSlug)}`,
            { headers: ctx.headers },
        );
        expect(after.status()).toBe(200);
        expect((await after.json()).displayName).toBe(original);
    });
});

test.describe('Org RBAC — billing scope is USER-keyed + org-context-invariant', () => {
    test('subscription plan is org-invariant: identical with/without X-Scope-Slug; an upgrade under the org scope mutates the USER plan', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);

        // Fresh user starts on FREE, and the org-scoped read is the same shape + tier.
        const personal = await getPlan(request, ctx.token);
        expect(personal.plan.code).toBe('free');
        expect(personal.enabled).toBe(true);
        const scoped = await getPlan(request, ctx.token, ctx.orgSlug);
        expect(scoped.plan.code).toBe('free');
        expect(scoped.plan.allowedCadences?.length ?? 0).toBe(
            personal.plan.allowedCadences?.length ?? 0,
        );

        // Upgrade WHILE sending the org scope header — it mutates the USER plan (the bearer),
        // not an "org plan". Visible from BOTH the org-scoped AND personal read.
        const up = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: { ...authedHeaders(ctx.token), 'X-Scope-Slug': ctx.orgSlug },
            data: { planCode: 'premium' },
        });
        expect(up.status()).toBe(200);
        expect((await getPlan(request, ctx.token, ctx.orgSlug)).plan.code).toBe('premium');
        expect((await getPlan(request, ctx.token)).plan.code).toBe('premium');

        // Revert under personal scope; the org-scoped read tracks it too. (Keeps the shared DB tidy.)
        expect(
            (
                await request.post(`${API_BASE}/api/subscriptions/plan`, {
                    headers: authedHeaders(ctx.token),
                    data: { planCode: 'free' },
                })
            ).status(),
        ).toBe(200);
        expect((await getPlan(request, ctx.token, ctx.orgSlug)).plan.code).toBe('free');
    });

    test('a non-member claiming the owner’s org scope on a billing route → 403, while the slug resolver stays a global 200 conveying no billing; account-wide usage is user-keyed', async ({
        request,
    }) => {
        const ctx = await buildOwner(request);
        const peer = await registerUserViaAPI(request);

        // A non-member sending the owner's org slug as X-Scope-Slug on a scoped route is
        // rejected by ScopeOwnershipGuard → 403 (no per-org billing surface to read).
        const peerScoped = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: { ...authedHeaders(peer.access_token), 'X-Scope-Slug': ctx.orgSlug },
        });
        expect(peerScoped.status()).toBe(403);

        // Yet the org slug resolver IS global → 200 for the peer, but it conveys NO billing.
        const resolve = await request.get(
            `${API_BASE}/api/organizations/${encodeURIComponent(ctx.orgSlug)}`,
            { headers: authedHeaders(peer.access_token) },
        );
        expect(resolve.status()).toBe(200);
        expect((await resolve.json()).id).toBe(ctx.orgId);

        // Account-wide usage is keyed by the ACTING userId and org-invariant (zero in keyless CI).
        const usagePersonal = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: authedHeaders(ctx.token),
        });
        expect(usagePersonal.status()).toBe(200);
        const upBody = await usagePersonal.json();
        expect(upBody.userId).toBe(ctx.user.user.id);
        expect(upBody.currentSpendCents).toBe(0);

        const usageScoped = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: { ...authedHeaders(ctx.token), 'X-Scope-Slug': ctx.orgSlug },
        });
        expect(usageScoped.status()).toBe(200);
        const usBody = await usageScoped.json();
        expect(usBody.userId).toBe(ctx.user.user.id);
        expect(usBody.currentSpendCents).toBe(0);
    });
});

test.describe('Org RBAC — end-to-end org-admin journey', () => {
    test('org create → team → agent LEAD + human MEMBER → attach org-Work → org-chart reflects the nodes; a second org’s chart stays disjoint', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await buildOwner(request, 'Journey');

        // 1. Create a team and staff it: an agent LEAD + the human owner as a MEMBER.
        const team = await createTeam(request, ctx, { name: `Ops ${stamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `OpsBot ${stamp()}`,
        });
        expect(
            (
                await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
                    headers: ctx.headers,
                    data: { memberType: 'agent', memberId: agent.id, role: 'lead' },
                })
            ).status(),
        ).toBe(201);
        expect(
            (
                await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/members`, {
                    headers: ctx.headers,
                    data: { memberType: 'user', memberId: ctx.user.user.id, role: 'member' },
                })
            ).status(),
        ).toBe(201);

        // 2. Attach an org-A-scoped Work to the team.
        const work = await createScopedWork(request, ctx.token, ctx.orgSlug, 'journey-work');
        expect(work.organizationId).toBe(ctx.orgId);
        expect(
            (
                await request.post(`${orgBase(ctx.orgId)}/teams/${team.id}/resources`, {
                    headers: ctx.headers,
                    data: { resourceType: 'work', resourceId: work.id },
                })
            ).status(),
        ).toBe(201);

        // 3. The org-chart projects the team, the agent, and the human member together.
        const chart = await request.get(`${orgBase(ctx.orgId)}/org-chart`, {
            headers: ctx.headers,
        });
        expect(chart.status()).toBe(200);
        const chartBody = await chart.json();
        expect(chartBody.organization.id).toBe(ctx.orgId);
        expect(chartBody.teams.map((t: { id: string }) => t.id)).toContain(team.id);
        expect(chartBody.agents.map((a: { id: string }) => a.id)).toContain(agent.id);
        expect(chartBody.members.map((m: { userId: string }) => m.userId)).toContain(
            ctx.user.user.id,
        );
        // The member node projects the teams they belong to.
        const memberNode = chartBody.members.find(
            (m: { userId: string }) => m.userId === ctx.user.user.id,
        );
        expect(memberNode.teamIds).toContain(team.id);

        // 4. A second org under the SAME owner has a fully DISJOINT chart — org-scope holds
        //    even within one tenant. Its teams/agents/members never reference org A's nodes.
        const orgB = await createOrganizationViaAPI(request, ctx.token, `Journey B ${stamp()}`);
        const chartB = await request.get(`${orgBase(orgB.id)}/org-chart`, { headers: ctx.headers });
        expect(chartB.status()).toBe(200);
        const chartBBody = await chartB.json();
        expect(chartBBody.organization.id).toBe(orgB.id);
        expect(chartBBody.teams.map((t: { id: string }) => t.id)).not.toContain(team.id);
        expect(chartBBody.agents.map((a: { id: string }) => a.id)).not.toContain(agent.id);
    });
});
