/**
 * Cross-tenant security MATRIX (part 2) — the NEWEST first-class resources.
 *
 * Two tenants (owner A, intruder B), each freshly registered, exercised across
 * the resource surface that shipped most recently and is NOT covered by the
 * baseline isolation specs (which stop at works / agents / tasks / missions /
 * orgs / skills / conversations / KB). For every newest resource this file
 * proves B can neither READ nor MUTATE A's resource, and — crucially — picks
 * DISTINCT angles from the per-feature deep specs so it is additive:
 *
 *   • TEAMS  (org-nested)          — the SUB-RESOURCE routes the teams-crud-deep
 *       cross-owner test never touches: members list/add/remove, resources
 *       list/attach/detach, PATCH, DELETE, resource-teams reverse lookup — all
 *       404 for a non-owner (404-never-403), owner untouched (positive control).
 *   • INBOUND TRIGGERS             — LIST isolation (A's list excludes B's real
 *       trigger), the `resume` management route (deep spec omitted it), and the
 *       management-vs-fire boundary: the PUBLIC fire route is HMAC-secret-gated,
 *       so an intruder without the secret → 401 while every JWT-scoped mgmt
 *       route → 404.
 *   • SCHEDULES  (read-model)      — a trigger A owns surfaces in A's aggregation
 *       ONLY; B's list stays [] even when B smuggles the matching
 *       ?sourceType=inbound_trigger / ?entityKind=trigger filter (attacker
 *       filter-as-leak-vector angle).
 *   • GOALS  (/api/me/goals)       — LIST isolation with real goals both sides +
 *       the MISSION-GOAL LINK cross-tenant vector (B links A's goal → 404; A
 *       links to B's mission → 404) + a side-effectful write matrix that leaves
 *       A's goal provably unchanged.
 *   • AGENT-APPROVALS              — the org-scoped ?organizationId= filter
 *       cannot read another user's org queue; the intruder route matrix no-ops.
 *   • AGENT-MEMORY                 — mutations fail CLOSED identically for any
 *       user in the provider-less e2e env (no id-addressed cross-user mutation
 *       is even reachable); auth-gated 401 for anon. Documents the ownerUserId
 *       stamp that enforces per-resource ownership when a provider is present.
 *   • cross-cutting               — every newest-resource base 401s for anon.
 *
 * ── Verified LIVE against http://127.0.0.1:3100 (sqlite in-memory, the CI
 *    driver) before any assertion was written. Probed contract:
 *
 *   Goals:   POST /api/me/goals { title, metricSource:{pluginId,metricId},
 *              comparator:'gte'|'lte', targetValue, unit, window:'day'|'week'|
 *              'month'|'total'|'point' } → 201 { id, status:'draft', … }
 *            Cross-user get/patch/delete/activate/pause/evaluate-now/samples on
 *              B's goal → 404 "Goal not found"; unknown uuid → 404; bad → 400.
 *            POST /api/me/missions/:id/goals { goalId } → 201 (own) / 404 when
 *              the goal OR the mission is not the caller's.
 *   Teams:   sub-resource routes on a non-owner's org → 404 (members, resources,
 *              PATCH, DELETE, org-chart, resource-teams); owner → 200/201.
 *   Triggers:GET /api/inbound-triggers → { triggers:[…] } scoped to the caller;
 *              resume/rotate on a foreign trigger → 404; fire with a wrong
 *              secret → 401.
 *   Schedules:GET /api/schedules → ScheduleView[] scoped by userId; a trigger
 *              yields id `inbound_trigger:<triggerId>`; ?sourceType / ?entityKind
 *              are strict enums (400 on typo); ?enabledOnly coerced (400 on junk).
 *   Approvals:GET /api/agent-approvals?organizationId=<uuid> is a pure WHERE
 *              filter (no ownership guard) → 200 { data:[], meta } even for a
 *              foreign org id.
 *   Memory:  all ops 400 { message:'No agent-memory provider is enabled…' } in
 *              the key-less e2e env; anon → 401.
 *
 * Isolation discipline: fresh registerUserViaAPI() principals per test; unique
 * suffixes everywhere; id membership asserted via toContain/not.toContain (never
 * global counts). Fully API-orchestrated (safe `flow-` prefix).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { buildOwnerCtx, createTeamViaAPI, teamsBase } from './helpers/teams';
import { TRIGGERS_BASE, createTriggerViaAPI, fireTrigger } from './helpers/triggers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface Goal {
    id: string;
    title: string;
    status: string;
    outcome: string | null;
}

async function createGoalViaAPI(
    request: APIRequestContext,
    token: string,
    overrides: Partial<{
        title: string;
        comparator: 'gte' | 'lte';
        targetValue: number;
        window: string;
    }> = {},
): Promise<Goal> {
    const res = await request.post(`${API_BASE}/api/me/goals`, {
        headers: authedHeaders(token),
        data: {
            title: overrides.title ?? `Goal ${stamp()}`,
            metricSource: { pluginId: 'analytics', metricId: 'signups' },
            comparator: overrides.comparator ?? 'gte',
            targetValue: overrides.targetValue ?? 100,
            unit: 'count',
            window: overrides.window ?? 'week',
        },
    });
    expect(res.status(), `createGoal body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createMissionViaAPI(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'matrix mission', type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

// ────────────────────────────────────────────────────────────────────────────
// TEAMS — org-nested sub-resource cross-tenant matrix
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — Teams sub-resources (404-never-403)', () => {
    test("intruder cannot read/mutate the MEMBER roster of another owner's team", async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Roster ${stamp()}` });
        const base = `${teamsBase(owner.orgId)}/teams/${team.id}`;

        // List roster.
        expect((await request.get(`${base}/members`, { headers: intruder.headers })).status()).toBe(
            404,
        );
        // Add a member (even naming the intruder's own user id).
        const add = await request.post(`${base}/members`, {
            headers: intruder.headers,
            data: { memberType: 'user', memberId: intruder.user.user.id },
        });
        expect(add.status()).toBe(404);
        // Remove a member.
        const remove = await request.delete(
            `${base}/members/${owner.user.user.id}?memberType=user`,
            {
                headers: intruder.headers,
            },
        );
        expect(remove.status()).toBe(404);

        // Owner's own roster read still works.
        expect((await request.get(`${base}/members`, { headers: owner.headers })).status()).toBe(
            200,
        );
    });

    test("intruder cannot read/attach/detach RESOURCES on another owner's team", async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Res ${stamp()}` });
        const base = `${teamsBase(owner.orgId)}/teams/${team.id}`;

        expect(
            (await request.get(`${base}/resources`, { headers: intruder.headers })).status(),
        ).toBe(404);
        const attach = await request.post(`${base}/resources`, {
            headers: intruder.headers,
            data: { resourceType: 'work', resourceId: UNKNOWN_UUID },
        });
        expect(attach.status()).toBe(404);
        const detach = await request.delete(`${base}/resources/work/${UNKNOWN_UUID}`, {
            headers: intruder.headers,
        });
        expect(detach.status()).toBe(404);

        // resource-teams reverse lookup in the owner's org is walled off too.
        const reverse = await request.get(
            `${teamsBase(owner.orgId)}/resource-teams?resourceType=work&resourceId=${UNKNOWN_UUID}`,
            { headers: intruder.headers },
        );
        expect(reverse.status()).toBe(404);
    });

    test("intruder cannot PATCH or DELETE another owner's team, nor read its org-chart", async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, owner, { name: `Locked ${stamp()}` });
        const base = `${teamsBase(owner.orgId)}/teams/${team.id}`;

        expect(
            (
                await request.patch(base, { headers: intruder.headers, data: { name: 'pwned' } })
            ).status(),
        ).toBe(404);
        expect((await request.delete(base, { headers: intruder.headers })).status()).toBe(404);
        expect(
            (
                await request.get(`${teamsBase(owner.orgId)}/org-chart`, {
                    headers: intruder.headers,
                })
            ).status(),
        ).toBe(404);
    });

    test('after a full intrusion sweep the team is untouched (positive control)', async ({
        request,
    }) => {
        const owner = await buildOwnerCtx(request);
        const intruder = await buildOwnerCtx(request);
        const originalName = `Fortress ${stamp()}`;
        const team = await createTeamViaAPI(request, owner, { name: originalName });
        const base = `${teamsBase(owner.orgId)}/teams/${team.id}`;

        // Hammer every mutating route as the intruder.
        await request.patch(base, {
            headers: intruder.headers,
            data: { name: 'hijack', description: 'x' },
        });
        await request.delete(base, { headers: intruder.headers });
        await request.post(`${base}/members`, {
            headers: intruder.headers,
            data: { memberType: 'user', memberId: intruder.user.user.id },
        });

        const reread = await request.get(base, { headers: owner.headers });
        expect(reread.status()).toBe(200);
        const body = await reread.json();
        expect(body.id).toBe(team.id);
        expect(body.name).toBe(originalName);
        expect(Array.isArray(body.members)).toBe(true);
        // No member was smuggled in.
        expect(body.members.map((m: { memberId: string }) => m.memberId)).not.toContain(
            intruder.user.user.id,
        );
    });
});

// ────────────────────────────────────────────────────────────────────────────
// INBOUND TRIGGERS — list isolation, resume route, mgmt-vs-fire boundary
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — Inbound Triggers', () => {
    test("a user's trigger list contains ONLY their own triggers, never a peer's", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const { trigger: aTrig } = await createTriggerViaAPI(request, a.access_token, {
            name: `A hook ${stamp()}`,
        });
        const { trigger: bTrig } = await createTriggerViaAPI(request, b.access_token, {
            name: `B hook ${stamp()}`,
        });

        const aList = await request.get(TRIGGERS_BASE, { headers: authedHeaders(a.access_token) });
        expect(aList.status()).toBe(200);
        const aIds = (await aList.json()).triggers.map((t: { id: string }) => t.id);
        expect(aIds).toContain(aTrig.id);
        expect(aIds).not.toContain(bTrig.id);

        const bList = await request.get(TRIGGERS_BASE, { headers: authedHeaders(b.access_token) });
        const bIds = (await bList.json()).triggers.map((t: { id: string }) => t.id);
        expect(bIds).toContain(bTrig.id);
        expect(bIds).not.toContain(aTrig.id);
    });

    test("every JWT-scoped management route on a peer's trigger → 404 (incl. resume)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Private ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);

        expect(
            (await request.get(`${TRIGGERS_BASE}/${trigger.id}`, { headers: iH })).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${TRIGGERS_BASE}/${trigger.id}`, {
                    headers: iH,
                    data: { name: 'x' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, { headers: iH })).status(),
        ).toBe(404);
        expect(
            (await request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, { headers: iH })).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${TRIGGERS_BASE}/${trigger.id}/rotate-secret`, { headers: iH })
            ).status(),
        ).toBe(404);
        expect(
            (await request.delete(`${TRIGGERS_BASE}/${trigger.id}`, { headers: iH })).status(),
        ).toBe(404);
    });

    test('the PUBLIC fire route is HMAC-secret-gated: a guessed/wrong secret → 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Fireable ${stamp()}`,
        });

        // The management boundary is 404 (JWT owner scope); the fire boundary is
        // the secret. A stranger without the secret cannot forge a valid signature.
        const forged = await fireTrigger(request, trigger.id, 'not-the-real-secret', '{"evt":"x"}');
        expect(forged.status()).toBe(401);

        // Sanity: the real secret still fires (proves it was the SECRET, not the id,
        // that gated the request above).
        const legit = await fireTrigger(request, trigger.id, secret, '{"evt":"y"}');
        expect(legit.status()).toBe(200);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHEDULES — read-model aggregation isolation + attacker filter vector
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — Schedules read-model', () => {
    test("a trigger surfaces in ITS OWNER's schedule aggregation with a stable id", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Sched src ${stamp()}`,
        });

        const list = await request.get(`${API_BASE}/api/schedules`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(list.status()).toBe(200);
        const rows = (await list.json()) as Array<{
            id: string;
            sourceType: string;
            ownerType: string;
            ownerId: string;
        }>;
        const row = rows.find((r) => r.id === `inbound_trigger:${trigger.id}`);
        expect(row, 'the trigger should appear as a schedule source for its owner').toBeTruthy();
        expect(row!.sourceType).toBe('inbound_trigger');
        expect(row!.ownerType).toBe('trigger');
        expect(row!.ownerId).toBe(trigger.id);
    });

    test("a peer's schedule aggregation NEVER contains the owner's trigger — even with a matching filter", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Hidden ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);
        const scheduleId = `inbound_trigger:${trigger.id}`;

        // Plain aggregation.
        const plain = await request.get(`${API_BASE}/api/schedules`, { headers: iH });
        expect(plain.status()).toBe(200);
        expect((await plain.json()).map((r: { id: string }) => r.id)).not.toContain(scheduleId);

        // Attacker narrows to exactly the source type the owner has — still nothing,
        // because every source query is filtered by the caller's own userId.
        const bySource = await request.get(`${API_BASE}/api/schedules?sourceType=inbound_trigger`, {
            headers: iH,
        });
        expect(bySource.status()).toBe(200);
        expect((await bySource.json()).map((r: { id: string }) => r.id)).not.toContain(scheduleId);

        const byKind = await request.get(`${API_BASE}/api/schedules?entityKind=trigger`, {
            headers: iH,
        });
        expect(byKind.status()).toBe(200);
        expect((await byKind.json()).map((r: { id: string }) => r.id)).not.toContain(scheduleId);
    });

    test('schedule filter params are strict enums / coerced booleans (400 on junk, no silent full-list fallback)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        expect(
            (
                await request.get(`${API_BASE}/api/schedules?sourceType=bogus`, { headers: H })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/schedules?entityKind=bogus`, { headers: H })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/schedules?enabledOnly=maybe`, { headers: H })
            ).status(),
        ).toBe(400);
        // The valid coerced boolean is accepted.
        expect(
            (
                await request.get(`${API_BASE}/api/schedules?enabledOnly=true`, { headers: H })
            ).status(),
        ).toBe(200);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// GOALS — list isolation, mission-link vector, unchanged-after-attack
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — Goals', () => {
    test("each user's goal list holds only their own goals", async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aGoal = await createGoalViaAPI(request, a.access_token, {
            title: `A metric ${stamp()}`,
        });
        const bGoal = await createGoalViaAPI(request, b.access_token, {
            title: `B metric ${stamp()}`,
        });

        const aList = await request.get(`${API_BASE}/api/me/goals`, {
            headers: authedHeaders(a.access_token),
        });
        expect(aList.status()).toBe(200);
        const aIds = (await aList.json()).map((g: { id: string }) => g.id);
        expect(aIds).toContain(aGoal.id);
        expect(aIds).not.toContain(bGoal.id);

        const bIds = (
            await (
                await request.get(`${API_BASE}/api/me/goals`, {
                    headers: authedHeaders(b.access_token),
                })
            ).json()
        ).map((g: { id: string }) => g.id);
        expect(bIds).toContain(bGoal.id);
        expect(bIds).not.toContain(aGoal.id);
    });

    test('the mission-goal LINK route enforces ownership on BOTH the goal and the mission', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aGoal = await createGoalViaAPI(request, a.access_token);
        const bGoal = await createGoalViaAPI(request, b.access_token);
        const bMission = await createMissionViaAPI(request, b.access_token, `B mission ${stamp()}`);

        // B tries to link A's goal into B's own mission → the goal isn't B's → 404.
        const linkForeignGoal = await request.post(
            `${API_BASE}/api/me/missions/${bMission}/goals`,
            {
                headers: authedHeaders(b.access_token),
                data: { goalId: aGoal.id },
            },
        );
        expect(linkForeignGoal.status()).toBe(404);

        // A tries to link A's own goal into B's mission → the mission isn't A's → 404.
        const linkForeignMission = await request.post(
            `${API_BASE}/api/me/missions/${bMission}/goals`,
            {
                headers: authedHeaders(a.access_token),
                data: { goalId: aGoal.id },
            },
        );
        expect(linkForeignMission.status()).toBe(404);

        // The legitimate same-owner link succeeds and echoes the pair.
        const ok = await request.post(`${API_BASE}/api/me/missions/${bMission}/goals`, {
            headers: authedHeaders(b.access_token),
            data: { goalId: bGoal.id },
        });
        expect(ok.status(), `own link body=${await ok.text().catch(() => '')}`).toBe(201);
        const linkBody = await ok.json();
        expect(linkBody.missionId).toBe(bMission);
        expect(linkBody.goalId).toBe(bGoal.id);
    });

    test("side-effectful write routes on a peer's goal all 404 and leave it provably unchanged", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const goal = await createGoalViaAPI(request, owner.access_token, {
            title: `Untouchable ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);
        const base = `${API_BASE}/api/me/goals/${goal.id}`;

        expect((await request.post(`${base}/activate`, { headers: iH })).status()).toBe(404);
        expect((await request.post(`${base}/pause`, { headers: iH })).status()).toBe(404);
        expect((await request.post(`${base}/evaluate-now`, { headers: iH })).status()).toBe(404);
        expect(
            (
                await request.patch(base, {
                    headers: iH,
                    data: { title: 'pwned', outcome: 'abandoned' },
                })
            ).status(),
        ).toBe(404);
        expect((await request.delete(base, { headers: iH })).status()).toBe(404);
        // Reads are walled off too.
        expect((await request.get(base, { headers: iH })).status()).toBe(404);
        expect((await request.get(`${base}/samples`, { headers: iH })).status()).toBe(404);

        // Owner re-reads: still there, still a draft, title intact, no forced outcome.
        const reread = await request.get(base, { headers: authedHeaders(owner.access_token) });
        expect(reread.status()).toBe(200);
        const body = await reread.json();
        expect(body.id).toBe(goal.id);
        expect(body.status).toBe('draft');
        expect(body.outcome).toBeNull();
        expect(body.title).toBe(goal.title);
    });

    test('an unknown-but-valid goal uuid → 404; a malformed id → 400 (ParseUUIDPipe)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const unknown = await request.get(`${API_BASE}/api/me/goals/${UNKNOWN_UUID}`, {
            headers: H,
        });
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).message).toContain('Goal not found');
        const malformed = await request.get(`${API_BASE}/api/me/goals/not-a-uuid`, { headers: H });
        expect(malformed.status()).toBe(400);
        expect(JSON.stringify(await malformed.json())).toContain('uuid is expected');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// AGENT-APPROVALS — org-scoped filter can't cross tenants; route matrix no-ops
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — Agent Approval Queue', () => {
    test("the ?organizationId= filter cannot read another user's org queue", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        // The owner mints a real org (its id is a valid uuid the intruder can smuggle).
        const ownerOrg = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `AQ Org ${stamp()}`,
        );
        expect(ownerOrg.id).toMatch(UUID_RE);

        const res = await request.get(
            `${API_BASE}/api/agent-approvals?organizationId=${ownerOrg.id}`,
            {
                headers: authedHeaders(intruder.access_token),
            },
        );
        // The org id is a pure WHERE filter with no ownership guard — but every row
        // is ALSO user-scoped, so a foreign org id yields the intruder's own (empty)
        // slice, never the owner's queue.
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test("an intruder's decision routes on any proposal id are indistinguishable from 'not found'", async ({
        request,
    }) => {
        const intruder = await registerUserViaAPI(request);
        const iH = authedHeaders(intruder.access_token);
        // No public create route exists, so the strongest observable contract is:
        // every id-addressed route returns 404 (existence is never leaked via 403).
        expect(
            (
                await request.get(`${API_BASE}/api/agent-approvals/${UNKNOWN_UUID}`, {
                    headers: iH,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/agent-approvals/${UNKNOWN_UUID}/approve`, {
                    headers: iH,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/agent-approvals/${UNKNOWN_UUID}/reject`, {
                    headers: iH,
                })
            ).status(),
        ).toBe(404);

        // Bulk approve-all is a scoped no-op — foreign/unknown ids match nothing.
        const bulk = await request.post(`${API_BASE}/api/agent-approvals/approve-all`, {
            headers: { ...iH, 'content-type': 'application/json' },
            data: { ids: [UNKNOWN_UUID] },
        });
        expect(bulk.status()).toBe(200);
        expect(await bulk.json()).toEqual({ approved: 0, skipped: 0 });
    });
});

// ────────────────────────────────────────────────────────────────────────────
// AGENT-MEMORY — fail-closed identically per user in the provider-less env
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — Agent Memory (provider-less e2e env)', () => {
    test('mutating memory ops fail CLOSED identically for two different users (no id-addressed cross-user path)', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const sessionId = `sess-${stamp()}`;
        const entryId = `entry-${stamp()}`;

        // Without a provider, both save + the id-addressed close/delete fail at the
        // facade with 400 BEFORE any per-resource ownership check can even run — so
        // there is no reachable path for B to mutate A's memory by guessing an id.
        for (const token of [a.access_token, b.access_token]) {
            const H = { ...authedHeaders(token), 'content-type': 'application/json' };
            const save = await request.post(`${API_BASE}/api/agent-memory/save`, {
                headers: H,
                data: { content: 'x' },
            });
            expect([400, 404]).toContain(save.status());
            expect(JSON.stringify(await save.json())).toMatch(/provider|does not support/i);

            const close = await request.post(
                `${API_BASE}/api/agent-memory/sessions/${sessionId}/close`,
                { headers: H },
            );
            expect([400, 404]).toContain(close.status());

            const del = await request.delete(`${API_BASE}/api/agent-memory/entries/${entryId}`, {
                headers: H,
            });
            expect([400, 404]).toContain(del.status());
        }
    });

    test('check-availability is a per-user read with the documented shape', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/agent-memory/check-availability`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('success');
        expect(typeof body.available).toBe('boolean');
        // The property is always present (null when no provider is fully configured).
        expect(body).toHaveProperty('activeProvider');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Cross-cutting — every newest-resource base rejects the anonymous caller
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-tenant — anonymous access is uniformly rejected (401)', () => {
    test('goals, schedules, approvals, triggers, memory, and org-teams all 401 without a bearer', async ({
        request,
    }) => {
        expect((await request.get(`${API_BASE}/api/me/goals`)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/schedules`)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/agent-approvals`)).status()).toBe(401);
        expect((await request.get(TRIGGERS_BASE)).status()).toBe(401);
        expect((await request.get(`${API_BASE}/api/agent-memory/sessions`)).status()).toBe(401);
        // Org-nested Teams route — the global auth guard fires before the ownership guard.
        expect((await request.get(`${teamsBase(UNKNOWN_UUID)}/teams`)).status()).toBe(401);
    });
});
