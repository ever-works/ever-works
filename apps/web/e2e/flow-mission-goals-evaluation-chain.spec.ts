import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Mission + Goals LINK + evaluation CHAIN — the cross-feature stitch that hangs a
 * PORTFOLIO of measurable Goals off a Mission and walks each Goal through its
 * lifecycle while pinning how the two subsystems stay (in)dependent. Every status
 * code, body shape and error string below was probed against the LIVE stack at
 * http://127.0.0.1:3100 (sqlite in-memory, all flags ON, NO metrics-provider
 * plugin, Trigger.dev unbound) BEFORE the assertions were written.
 *
 * ── NON-DUPLICATION ───────────────────────────────────────────────────────────
 * The single-Goal surface is already owned elsewhere and is deliberately NOT
 * re-tested here:
 *   - flow-goals-lifecycle-deep.spec.ts        — Goal CRUD shapes, normalization,
 *     the activate/pause state-machine, outcome semantics, 2-goal demotion.
 *   - flow-goals-validation-authz-matrix.spec.ts — field-by-field DTO validation +
 *     the full authz/id-shape matrix on every goals & link route.
 *   - flow-goal-lifecycle.spec.ts              — a single mission-link happy path.
 *   - flow-goals-ui-journey.spec.ts            — the /goals dashboard UI.
 * THIS file owns the CROSS-FEATURE PORTFOLIO/CHAIN angle those never touch:
 *   • a multi-Goal Mission portfolio (one primary + N secondaries) and the
 *     exactly-one-primary invariant asserted over the WHOLE set (order-independent);
 *   • the link's nested `goal` projection as a LIVE MIRROR of the standalone Goal
 *     as it is activated / paused / overridden / deleted;
 *   • the PORTFOLIO-level Invariant I-4 (spec FR-14): even when EVERY linked Goal
 *     is completed, the parent Mission never auto-completes — and completing the
 *     Mission never touches a linked Goal;
 *   • the M:N property — ONE standalone Goal linked to MANY Missions with a
 *     per-edge isPrimary, edges independent, the Goal outliving any one Mission;
 *   • primary RE-ELECTION as Goals churn (unlink / cascade-delete the primary);
 *   • container lifecycle — deleting a Mission drops its edges but leaves the
 *     standalone Goals alive (the inverse of goal-delete cascading its edges).
 *
 * ── PROBED CONTRACTS (verified live) ──────────────────────────────────────────
 *  POST /api/me/missions {description,type:'one-shot'} → 201 MissionDto status:'active'.
 *  POST /api/me/goals {title,metricSource:{pluginId,metricId},comparator,targetValue,
 *       unit,window} → 201 GoalDto status:'draft', nextCheckAt/currentValue/
 *       baselineValue/deadline/outcome all null, checkFrequencyMinutes:60. The DTO
 *       NEVER leaks userId/tenantId/organizationId.
 *  POST /api/me/missions/:id/goals {goalId,isPrimary?} → 201 MissionGoalLinkDto
 *       { id, missionId, goalId, isPrimary, createdAt, goal:GoalDto } — ALWAYS 201,
 *       even when it merely updates an existing edge's isPrimary (idempotent).
 *       Promoting a second primary demotes the incumbent (one-primary-per-mission).
 *       Unknown goal → 404 "Goal not found"; foreign/unknown mission → 404
 *       "Mission not found"; malformed id → 400 (ParseUUIDPipe / @IsUUID).
 *  GET  /api/me/missions/:id/goals → 200 MissionGoalLinkDto[] (nested goal mirrors
 *       LIVE Goal state). List ORDER is NOT stable (second-precision createdAt) —
 *       all assertions are by goalId / set membership, never positional.
 *  DELETE /api/me/missions/:id/goals/:goalId → 200 {deleted:true}; re-unlink → 404
 *       "Goal link not found".
 *  POST /api/me/goals/:id/activate → 200 status:'active', nextCheckAt set.
 *  POST /api/me/goals/:id/pause    → 200 status:'paused', nextCheckAt null.
 *  POST /api/me/goals/:id/evaluate-now — 400 "Goal must be active to evaluate now"
 *       when draft/paused; on an ACTIVE Goal in this keyless env → 404
 *       {error:'ProviderNotFoundError', message:'metrics-provider provider not
 *       found: <plugin>'} and NO sample is written (samples stay []).
 *  PATCH /api/me/goals/:id {outcome} → non-null outcome completes the Goal
 *       (status:'completed', nextCheckAt null); outcome:null clears without
 *       dropping status. Setting a linked Goal's outcome NEVER touches the Mission.
 *  POST /api/me/missions/:id/complete {outcome?} → 200 status:'completed'; the
 *       linked Goals are untouched and the edges remain.
 *  DELETE /api/me/goals/:id   → 200 {deleted:true}; cascades its mission edges.
 *  DELETE /api/me/missions/:id → 200 {deleted:true}; drops edges, standalone
 *       Goals survive.
 *
 * Cross-spec isolation: every test builds its portfolio on FRESH
 * registerUserViaAPI() users with unique stamp() suffixes; list assertions use
 * toContain / set membership on the caller's OWN ids — never global counts. No
 * module-scope data loading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface MissionRow {
    id: string;
    status: string;
    outcome: string | null;
    completedAt: string | null;
    updatedAt: string;
}

interface GoalRow {
    id: string;
    title: string;
    description: string | null;
    metricSource: { pluginId: string; metricId: string; params?: Record<string, unknown> };
    comparator: string;
    targetValue: number;
    unit: string;
    window: string;
    baselineValue: number | null;
    currentValue: number | null;
    currentValueAt: string | null;
    deadline: string | null;
    checkFrequencyMinutes: number;
    nextCheckAt: string | null;
    status: string;
    outcome: string | null;
    createdAt: string;
    updatedAt: string;
}

interface LinkRow {
    id: string;
    missionId: string;
    goalId: string;
    isPrimary: boolean;
    createdAt: string;
    goal: GoalRow | null;
}

const GOAL_DTO_KEYS = [
    'id',
    'title',
    'description',
    'metricSource',
    'comparator',
    'targetValue',
    'unit',
    'window',
    'baselineValue',
    'currentValue',
    'currentValueAt',
    'deadline',
    'checkFrequencyMinutes',
    'nextCheckAt',
    'status',
    'outcome',
    'createdAt',
    'updatedAt',
];

async function createMission(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<MissionRow> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { description: `chain mission ${stamp()}`, type: 'one-shot', ...overrides },
    });
    expect(res.status(), `mission create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createGoal(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<GoalRow> {
    const res = await request.post(`${API_BASE}/api/me/goals`, {
        headers: authedHeaders(token),
        data: {
            title: `Goal ${stamp()}`,
            metricSource: { pluginId: 'stripe', metricId: 'income' },
            comparator: 'gte',
            targetValue: 1000,
            unit: 'usd',
            window: 'month',
            ...overrides,
        },
    });
    expect(res.status(), `goal create body=${await res.text().catch(() => '')}`).toBe(201);
    const goal = (await res.json()) as GoalRow;
    expect(goal.id).toMatch(UUID_RE);
    expect(goal.status).toBe('draft');
    return goal;
}

async function linkGoal(
    request: APIRequestContext,
    token: string,
    missionId: string,
    goalId: string,
    isPrimary?: boolean,
): Promise<{ status: number; body: LinkRow }> {
    const res = await request.post(`${API_BASE}/api/me/missions/${missionId}/goals`, {
        headers: authedHeaders(token),
        data: isPrimary === undefined ? { goalId } : { goalId, isPrimary },
    });
    return { status: res.status(), body: (await res.json()) as LinkRow };
}

async function listLinks(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<{ status: number; links: LinkRow[] }> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}/goals`, {
        headers: authedHeaders(token),
    });
    const status = res.status();
    if (status !== 200) return { status, links: [] };
    return { status, links: (await res.json()) as LinkRow[] };
}

async function getGoal(
    request: APIRequestContext,
    token: string,
    goalId: string,
): Promise<{ status: number; goal: GoalRow | null }> {
    const res = await request.get(`${API_BASE}/api/me/goals/${goalId}`, {
        headers: authedHeaders(token),
    });
    if (res.status() !== 200) return { status: res.status(), goal: null };
    return { status: 200, goal: (await res.json()) as GoalRow };
}

async function getMission(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<MissionRow> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

async function activate(
    request: APIRequestContext,
    token: string,
    goalId: string,
): Promise<GoalRow> {
    const res = await request.post(`${API_BASE}/api/me/goals/${goalId}/activate`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `activate body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function overrideOutcome(
    request: APIRequestContext,
    token: string,
    goalId: string,
    outcome: string | null,
): Promise<GoalRow> {
    const res = await request.patch(`${API_BASE}/api/me/goals/${goalId}`, {
        headers: authedHeaders(token),
        data: { outcome },
    });
    expect(res.status(), `override body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Build a Mission with a primary Goal + `secondaries` secondary Goals attached. */
async function buildPortfolio(
    request: APIRequestContext,
    token: string,
    secondaries = 2,
): Promise<{ mission: MissionRow; primary: GoalRow; secondary: GoalRow[] }> {
    const mission = await createMission(request, token);
    const primary = await createGoal(request, token, { title: `Primary ${stamp()}` });
    const secondary: GoalRow[] = [];
    for (let i = 0; i < secondaries; i++) {
        secondary.push(await createGoal(request, token, { title: `Secondary ${i} ${stamp()}` }));
    }
    const p = await linkGoal(request, token, mission.id, primary.id, true);
    expect(p.status).toBe(201);
    for (const g of secondary) {
        const s = await linkGoal(request, token, mission.id, g.id, false);
        expect(s.status).toBe(201);
    }
    return { mission, primary, secondary };
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Mission goal-portfolio composition', () => {
    test('a Mission projects its whole Goal portfolio with exactly one primary (order-independent)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);

        const { status, links } = await listLinks(request, token, mission.id);
        expect(status).toBe(200);
        // All three edges are present — matched by goalId, never by position
        // (createdAt is second-precision so list order is NOT deterministic).
        const goalIds = links.map((l) => l.goalId).sort();
        expect(goalIds).toEqual([primary.id, secondary[0].id, secondary[1].id].sort());
        // Exactly one primary, and it is the Goal we promoted.
        const primaries = links.filter((l) => l.isPrimary);
        expect(primaries).toHaveLength(1);
        expect(primaries[0].goalId).toBe(primary.id);
        // Every edge carries a well-formed link id + missionId back-reference.
        for (const l of links) {
            expect(l.id).toMatch(UUID_RE);
            expect(l.missionId).toBe(mission.id);
        }
    });

    test('each link nests a full GoalDto projection that mirrors the standalone Goal and leaks no owner/scope', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token, {
            description: 'track monthly income',
            baselineValue: 42,
            metricSource: { pluginId: 'stripe', metricId: 'income', params: { currency: 'usd' } },
        });
        const linked = await linkGoal(request, token, mission.id, goal.id, true);
        expect(linked.status).toBe(201);
        expect(linked.body.goal).not.toBeNull();

        const nested = linked.body.goal as GoalRow;
        // The nested projection is a faithful copy of the standalone Goal…
        expect(nested.id).toBe(goal.id);
        expect(nested.title).toBe(goal.title);
        expect(nested.baselineValue).toBe(42);
        expect(nested.metricSource).toEqual({
            pluginId: 'stripe',
            metricId: 'income',
            params: { currency: 'usd' },
        });
        expect(nested.status).toBe('draft');
        // …exposing exactly the GoalDto surface — no userId/tenantId/organizationId.
        expect(Object.keys(nested).sort()).toEqual([...GOAL_DTO_KEYS].sort());
        expect(nested).not.toHaveProperty('userId');
        expect(nested).not.toHaveProperty('tenantId');
        expect(nested).not.toHaveProperty('organizationId');
    });

    test('promoting a second Goal to primary demotes the incumbent — one-primary holds across a 3-goal set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);

        // Promote the first secondary — the original primary must be demoted.
        const promote = await linkGoal(request, token, mission.id, secondary[0].id, true);
        expect(promote.status).toBe(201);
        expect(promote.body.isPrimary).toBe(true);

        const { links } = await listLinks(request, token, mission.id);
        const primaries = links.filter((l) => l.isPrimary);
        expect(primaries).toHaveLength(1);
        expect(primaries[0].goalId).toBe(secondary[0].id);
        // The old primary is now a secondary — demoted, NOT detached.
        const old = links.find((l) => l.goalId === primary.id);
        expect(old).toBeTruthy();
        expect(old!.isPrimary).toBe(false);
    });

    test('re-linking an existing Goal is idempotent per edge (same link id, isPrimary updated, portfolio size unchanged)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, secondary } = await buildPortfolio(request, token, 1);
        const target = secondary[0];

        const before = await listLinks(request, token, mission.id);
        const edgeBefore = before.links.find((l) => l.goalId === target.id)!;
        expect(edgeBefore.isPrimary).toBe(false);

        // Re-POST the same (mission, goal) pair flipping isPrimary → still 201,
        // and it UPDATES the same edge rather than minting a duplicate.
        const relink = await linkGoal(request, token, mission.id, target.id, true);
        expect(relink.status).toBe(201);
        expect(relink.body.id).toBe(edgeBefore.id);
        expect(relink.body.isPrimary).toBe(true);

        const after = await listLinks(request, token, mission.id);
        expect(after.links).toHaveLength(before.links.length);
        expect(after.links.filter((l) => l.goalId === target.id)).toHaveLength(1);
    });
});

test.describe('The link is a live mirror of Goal lifecycle', () => {
    test('activating then pausing a linked Goal is reflected in the Mission link view', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token);
        await linkGoal(request, token, mission.id, goal.id, true);

        // Draft → the mirror shows draft + no schedule.
        let mirror = (await listLinks(request, token, mission.id)).links.find(
            (l) => l.goalId === goal.id,
        )!;
        expect(mirror.goal!.status).toBe('draft');
        expect(mirror.goal!.nextCheckAt).toBeNull();

        // Activate → the mirror shows active + a scheduled nextCheckAt.
        await activate(request, token, goal.id);
        mirror = (await listLinks(request, token, mission.id)).links.find(
            (l) => l.goalId === goal.id,
        )!;
        expect(mirror.goal!.status).toBe('active');
        expect(mirror.goal!.nextCheckAt).not.toBeNull();

        // Pause → the mirror shows paused + cleared schedule.
        const paused = await request.post(`${API_BASE}/api/me/goals/${goal.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(paused.status()).toBe(200);
        mirror = (await listLinks(request, token, mission.id)).links.find(
            (l) => l.goalId === goal.id,
        )!;
        expect(mirror.goal!.status).toBe('paused');
        expect(mirror.goal!.nextCheckAt).toBeNull();
    });

    test('a human outcome override on a linked Goal is mirrored, and the parent Mission is untouched (I-4)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token);
        await linkGoal(request, token, mission.id, goal.id, true);
        const before = await getMission(request, token, mission.id);

        // Override the Goal → completed + outcome; the mirror reflects it.
        const overridden = await overrideOutcome(request, token, goal.id, 'abandoned');
        expect(overridden.status).toBe('completed');
        expect(overridden.outcome).toBe('abandoned');
        expect(overridden.nextCheckAt).toBeNull();

        const mirror = (await listLinks(request, token, mission.id)).links.find(
            (l) => l.goalId === goal.id,
        )!;
        expect(mirror.goal!.status).toBe('completed');
        expect(mirror.goal!.outcome).toBe('abandoned');

        // Invariant I-4: NOTHING on the Mission changed.
        const after = await getMission(request, token, mission.id);
        expect(after.status).toBe('active');
        expect(after.status).toBe(before.status);
        expect(after.outcome).toBeNull();
        expect(after.completedAt).toBeNull();
    });

    test('deleting a linked Goal removes exactly its edge and leaves sibling edges intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);
        const victim = secondary[0];

        const del = await request.delete(`${API_BASE}/api/me/goals/${victim.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        const { links } = await listLinks(request, token, mission.id);
        const survivors = links.map((l) => l.goalId).sort();
        expect(survivors).toEqual([primary.id, secondary[1].id].sort());
        expect(links.map((l) => l.goalId)).not.toContain(victim.id);
        // The deleted Goal itself is gone.
        expect((await getGoal(request, token, victim.id)).status).toBe(404);
    });
});

test.describe('The evaluation chain — gating tied to Goal state', () => {
    test('evaluate-now on a linked Goal is gated to ACTIVE; draft and paused both → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token);
        await linkGoal(request, token, mission.id, goal.id, true);

        // Draft → cannot evaluate.
        const draftEval = await request.post(`${API_BASE}/api/me/goals/${goal.id}/evaluate-now`, {
            headers: authedHeaders(token),
        });
        expect(draftEval.status()).toBe(400);
        expect(msgOf(await draftEval.json())).toMatch(/must be active to evaluate/i);

        // Activate → pause → still cannot evaluate a paused Goal.
        await activate(request, token, goal.id);
        await request.post(`${API_BASE}/api/me/goals/${goal.id}/pause`, {
            headers: authedHeaders(token),
        });
        const pausedEval = await request.post(`${API_BASE}/api/me/goals/${goal.id}/evaluate-now`, {
            headers: authedHeaders(token),
        });
        expect(pausedEval.status()).toBe(400);
        expect(msgOf(await pausedEval.json())).toMatch(/must be active to evaluate/i);
    });

    test('evaluate-now on an ACTIVE linked Goal degrades on the unconfigured provider and writes NO sample', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token, {
            metricSource: { pluginId: 'custom-http', metricId: 'subscribers' },
        });
        await linkGoal(request, token, mission.id, goal.id, true);
        await activate(request, token, goal.id);

        const evalRes = await request.post(`${API_BASE}/api/me/goals/${goal.id}/evaluate-now`, {
            headers: authedHeaders(token),
        });
        // Env-adaptive: keyless stack has NO metrics-provider → 404
        // ProviderNotFoundError. If a real provider were wired it would be 200.
        expect([200, 404, 500, 502, 503]).toContain(evalRes.status());
        if (evalRes.status() === 404) {
            const body = await evalRes.json();
            expect(msgOf(body)).toMatch(/provider not found/i);
            expect(body.error).toBe('ProviderNotFoundError');
        }

        // Whatever the provider did, the Goal stays consistent + readable, and
        // when the read failed no observation row was appended.
        const after = await getGoal(request, token, goal.id);
        expect(after.status).toBe(200);
        if (evalRes.status() !== 200) {
            expect(after.goal!.status).toBe('active');
            expect(after.goal!.currentValue).toBeNull();
            const samples = await request.get(`${API_BASE}/api/me/goals/${goal.id}/samples`, {
                headers: authedHeaders(token),
            });
            expect(samples.status()).toBe(200);
            expect(await samples.json()).toEqual([]);
        }
        // The Mission link mirror still shows the (still-active) Goal.
        const mirror = (await listLinks(request, token, mission.id)).links.find(
            (l) => l.goalId === goal.id,
        )!;
        expect(['active', 'completed']).toContain(mirror.goal!.status);
    });

    test('a linked Goal walks draft→active→paused→active with the mirror tracking every hop, evaluate-now gated throughout', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token);
        await linkGoal(request, token, mission.id, goal.id, false);

        const mirrorStatus = async (): Promise<string> =>
            (await listLinks(request, token, mission.id)).links.find((l) => l.goalId === goal.id)!
                .goal!.status;

        expect(await mirrorStatus()).toBe('draft');

        const a1 = await activate(request, token, goal.id);
        expect(a1.status).toBe('active');
        expect(a1.nextCheckAt).not.toBeNull();
        expect(await mirrorStatus()).toBe('active');

        const pause = await request.post(`${API_BASE}/api/me/goals/${goal.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(pause.status()).toBe(200);
        expect(await mirrorStatus()).toBe('paused');

        const a2 = await activate(request, token, goal.id);
        expect(a2.status).toBe('active');
        expect(await mirrorStatus()).toBe('active');

        // Activating an already-active Goal is an illegal hop.
        const dup = await request.post(`${API_BASE}/api/me/goals/${goal.id}/activate`, {
            headers: authedHeaders(token),
        });
        expect(dup.status()).toBe(400);
    });
});

test.describe('Portfolio-level Invariant I-4 (FR-14)', () => {
    test('completing EVERY linked Goal (achieved/missed/abandoned) leaves the Mission ACTIVE with no outcome', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);

        // Drive the whole portfolio to COMPLETED with three DISTINCT outcomes.
        await overrideOutcome(request, token, primary.id, 'achieved');
        await overrideOutcome(request, token, secondary[0].id, 'missed');
        await overrideOutcome(request, token, secondary[1].id, 'abandoned');

        // Every linked Goal is completed (mirror confirms), each with its outcome…
        const { links } = await listLinks(request, token, mission.id);
        expect(links.every((l) => l.goal!.status === 'completed')).toBe(true);
        const byGoal = new Map(links.map((l) => [l.goalId, l.goal!.outcome]));
        expect(byGoal.get(primary.id)).toBe('achieved');
        expect(byGoal.get(secondary[0].id)).toBe('missed');
        expect(byGoal.get(secondary[1].id)).toBe('abandoned');

        // …yet the Mission NEVER auto-completes — all-goals-done ≠ mission-done.
        const after = await getMission(request, token, mission.id);
        expect(after.status).toBe('active');
        expect(after.outcome).toBeNull();
        expect(after.completedAt).toBeNull();
    });

    test('completing the Mission with a verdict leaves every linked Goal untouched and still attached', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 1);
        // Put the Goals in mixed states first.
        await activate(request, token, primary.id);
        const secBefore = await getGoal(request, token, secondary[0].id);
        expect(secBefore.goal!.status).toBe('draft');

        const complete = await request.post(`${API_BASE}/api/me/missions/${mission.id}/complete`, {
            headers: authedHeaders(token),
            data: { outcome: 'partially_succeeded' },
        });
        expect(complete.status()).toBe(200);
        const completed = (await complete.json()) as MissionRow;
        expect(completed.status).toBe('completed');
        expect(completed.outcome).toBe('partially_succeeded');
        expect(completed.completedAt).not.toBeNull();

        // Goals are exactly as they were — the Mission verdict never cascades down.
        expect((await getGoal(request, token, primary.id)).goal!.status).toBe('active');
        expect((await getGoal(request, token, secondary[0].id)).goal!.status).toBe('draft');
        // …and the edges survive Mission completion.
        const { links } = await listLinks(request, token, mission.id);
        expect(links.map((l) => l.goalId).sort()).toEqual([primary.id, secondary[0].id].sort());
    });

    test('reactivating a completed linked Goal clears its outcome in the mirror and still never touches the Mission', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token);
        const goal = await createGoal(request, token);
        await linkGoal(request, token, mission.id, goal.id, true);

        await overrideOutcome(request, token, goal.id, 'achieved'); // → completed
        // Reactivate the completed Goal: outcome cleared, back to active.
        const reactivated = await activate(request, token, goal.id);
        expect(reactivated.status).toBe('active');
        expect(reactivated.outcome).toBeNull();
        expect(reactivated.nextCheckAt).not.toBeNull();

        const mirror = (await listLinks(request, token, mission.id)).links.find(
            (l) => l.goalId === goal.id,
        )!;
        expect(mirror.goal!.status).toBe('active');
        expect(mirror.goal!.outcome).toBeNull();

        // Mission untouched through the complete→reactivate churn.
        const m = await getMission(request, token, mission.id);
        expect(m.status).toBe('active');
        expect(m.outcome).toBeNull();
    });
});

test.describe('M:N — one Goal across many Missions', () => {
    test('the same Goal linked to two Missions gets independent edges with a per-edge isPrimary', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const shared = await createGoal(request, token, { title: `Shared ${stamp()}` });
        const missionA = await createMission(request, token, { description: 'Mission A' });
        const missionB = await createMission(request, token, { description: 'Mission B' });

        const eA = await linkGoal(request, token, missionA.id, shared.id, true);
        const eB = await linkGoal(request, token, missionB.id, shared.id, false);
        expect(eA.status).toBe(201);
        expect(eB.status).toBe(201);

        // Distinct edge rows, same underlying Goal, INDEPENDENT isPrimary.
        expect(eA.body.id).not.toBe(eB.body.id);
        expect(eA.body.goalId).toBe(shared.id);
        expect(eB.body.goalId).toBe(shared.id);
        expect(eA.body.isPrimary).toBe(true);
        expect(eB.body.isPrimary).toBe(false);

        // Each Mission sees the shared Goal exactly once with its own flag.
        const a = await listLinks(request, token, missionA.id);
        const b = await listLinks(request, token, missionB.id);
        expect(a.links.map((l) => l.goalId)).toEqual([shared.id]);
        expect(b.links.map((l) => l.goalId)).toEqual([shared.id]);
        expect(a.links[0].isPrimary).toBe(true);
        expect(b.links[0].isPrimary).toBe(false);
    });

    test('a shared Goal lifecycle change is mirrored in EVERY Mission that links it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const shared = await createGoal(request, token, { title: `Shared ${stamp()}` });
        const missionA = await createMission(request, token, { description: 'Mission A' });
        const missionB = await createMission(request, token, { description: 'Mission B' });
        await linkGoal(request, token, missionA.id, shared.id, true);
        await linkGoal(request, token, missionB.id, shared.id, false);

        await activate(request, token, shared.id);

        for (const mId of [missionA.id, missionB.id]) {
            const mirror = (await listLinks(request, token, mId)).links.find(
                (l) => l.goalId === shared.id,
            )!;
            expect(mirror.goal!.status).toBe('active');
            expect(mirror.goal!.nextCheckAt).not.toBeNull();
        }
    });

    test('unlinking a shared Goal from one Mission leaves the other edge and the standalone Goal intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const shared = await createGoal(request, token, { title: `Shared ${stamp()}` });
        const missionA = await createMission(request, token, { description: 'Mission A' });
        const missionB = await createMission(request, token, { description: 'Mission B' });
        await linkGoal(request, token, missionA.id, shared.id, true);
        await linkGoal(request, token, missionB.id, shared.id, false);

        const unlink = await request.delete(
            `${API_BASE}/api/me/missions/${missionA.id}/goals/${shared.id}`,
            { headers: authedHeaders(token) },
        );
        expect(unlink.status()).toBe(200);
        expect(await unlink.json()).toEqual({ deleted: true });

        // A is empty, B still holds the edge, the Goal itself is alive.
        expect((await listLinks(request, token, missionA.id)).links).toHaveLength(0);
        expect((await listLinks(request, token, missionB.id)).links.map((l) => l.goalId)).toEqual([
            shared.id,
        ]);
        expect((await getGoal(request, token, shared.id)).status).toBe(200);

        // Re-unlinking the now-absent A edge → 404 "Goal link not found".
        const again = await request.delete(
            `${API_BASE}/api/me/missions/${missionA.id}/goals/${shared.id}`,
            { headers: authedHeaders(token) },
        );
        expect(again.status()).toBe(404);
        expect(msgOf(await again.json())).toMatch(/goal link not found/i);
    });

    test('deleting a shared Goal cascades its edges out of every linking Mission at once', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const shared = await createGoal(request, token, { title: `Shared ${stamp()}` });
        const missionA = await createMission(request, token, { description: 'Mission A' });
        const missionB = await createMission(request, token, { description: 'Mission B' });
        // A second, un-shared Goal on B survives the delete as a control.
        const keep = await createGoal(request, token, { title: `Keep ${stamp()}` });
        await linkGoal(request, token, missionA.id, shared.id, true);
        await linkGoal(request, token, missionB.id, shared.id, false);
        await linkGoal(request, token, missionB.id, keep.id, false);

        const del = await request.delete(`${API_BASE}/api/me/goals/${shared.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);

        // Both Missions lose the shared edge; B keeps its un-shared Goal.
        expect((await listLinks(request, token, missionA.id)).links).toHaveLength(0);
        const b = await listLinks(request, token, missionB.id);
        expect(b.links.map((l) => l.goalId)).toEqual([keep.id]);
    });
});

test.describe('Primary re-election through churn', () => {
    test('unlinking the primary Goal leaves the Mission with no primary; a secondary can be re-elected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);

        // Detach the primary edge.
        const unlink = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/goals/${primary.id}`,
            { headers: authedHeaders(token) },
        );
        expect(unlink.status()).toBe(200);

        // No primary remains — the two secondaries are both non-primary.
        let links = (await listLinks(request, token, mission.id)).links;
        expect(links).toHaveLength(2);
        expect(links.some((l) => l.isPrimary)).toBe(false);

        // Re-elect one secondary as the new sole primary.
        const promote = await linkGoal(request, token, mission.id, secondary[0].id, true);
        expect(promote.status).toBe(201);
        links = (await listLinks(request, token, mission.id)).links;
        const primaries = links.filter((l) => l.isPrimary);
        expect(primaries).toHaveLength(1);
        expect(primaries[0].goalId).toBe(secondary[0].id);
    });

    test('cascade-deleting the primary Goal leaves the Mission with no primary; a surviving secondary is promotable', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);

        // Delete the PRIMARY goal outright — its edge cascades away.
        const del = await request.delete(`${API_BASE}/api/me/goals/${primary.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);

        let links = (await listLinks(request, token, mission.id)).links;
        expect(links.map((l) => l.goalId).sort()).toEqual(
            [secondary[0].id, secondary[1].id].sort(),
        );
        expect(links.some((l) => l.isPrimary)).toBe(false);

        // A surviving secondary is freely promotable to the vacant primary slot.
        await linkGoal(request, token, mission.id, secondary[1].id, true);
        links = (await listLinks(request, token, mission.id)).links;
        expect(links.filter((l) => l.isPrimary).map((l) => l.goalId)).toEqual([secondary[1].id]);
    });
});

test.describe('Chain isolation + container lifecycle', () => {
    test('the Mission↔Goal link surface is walled off from a stranger (mission-ownership checked first)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { mission, primary } = await buildPortfolio(request, owner.access_token, 1);
        const strangerGoal = await createGoal(request, stranger.access_token, {
            title: `Intruder ${stamp()}`,
        });
        const s = authedHeaders(stranger.access_token);

        // Stranger cannot even see the owner's link list → 404 (no existence leak).
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${mission.id}/goals`, { headers: s })
            ).status(),
        ).toBe(404);
        // Stranger cannot attach their OWN goal to the owner's mission → 404 Mission
        // (mission ownership is validated before goal ownership).
        const hijack = await request.post(`${API_BASE}/api/me/missions/${mission.id}/goals`, {
            headers: s,
            data: { goalId: strangerGoal.id, isPrimary: true },
        });
        expect(hijack.status()).toBe(404);
        expect(msgOf(await hijack.json())).toMatch(/mission not found/i);
        // Stranger cannot unlink the owner's edge → 404.
        expect(
            (
                await request.delete(
                    `${API_BASE}/api/me/missions/${mission.id}/goals/${primary.id}`,
                    { headers: s },
                )
            ).status(),
        ).toBe(404);
        // Anonymous → 401 on the link surface.
        expect(
            (await request.get(`${API_BASE}/api/me/missions/${mission.id}/goals`)).status(),
        ).toBe(401);
        expect(
            (
                await request.post(`${API_BASE}/api/me/missions/${mission.id}/goals`, {
                    data: { goalId: primary.id },
                })
            ).status(),
        ).toBe(401);
    });

    test("attaching a stranger's Goal to my OWN Mission is a 404 Goal (both sides ownership-gated, no leak)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const myMission = await createMission(request, owner.access_token);
        const foreignGoal = await createGoal(request, stranger.access_token, {
            title: `Foreign ${stamp()}`,
        });

        // My mission is fine, but the goal belongs to someone else → 404 Goal.
        const res = await request.post(`${API_BASE}/api/me/missions/${myMission.id}/goals`, {
            headers: authedHeaders(owner.access_token),
            data: { goalId: foreignGoal.id },
        });
        expect(res.status()).toBe(404);
        expect(msgOf(await res.json())).toMatch(/goal not found/i);

        // A well-formed but non-existent goal → same 404 Goal (indistinguishable).
        const ghost = await request.post(`${API_BASE}/api/me/missions/${myMission.id}/goals`, {
            headers: authedHeaders(owner.access_token),
            data: { goalId: UNKNOWN_UUID },
        });
        expect(ghost.status()).toBe(404);
        expect(msgOf(await ghost.json())).toMatch(/goal not found/i);

        // A malformed goalId is rejected before ownership → 400 (@IsUUID);
        // a malformed missionId in the path → 400 (ParseUUIDPipe).
        const badGoal = await request.post(`${API_BASE}/api/me/missions/${myMission.id}/goals`, {
            headers: authedHeaders(owner.access_token),
            data: { goalId: 'not-a-uuid' },
        });
        expect(badGoal.status()).toBe(400);
        const badMission = await request.get(`${API_BASE}/api/me/missions/not-a-uuid/goals`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(badMission.status()).toBe(400);
        // A well-formed but unknown missionId on the list route → 404 Mission.
        const unknownMission = await request.get(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/goals`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(unknownMission.status()).toBe(404);
        expect(msgOf(await unknownMission.json())).toMatch(/mission not found/i);
    });

    test('deleting a Mission drops its Goal edges but leaves the standalone Goals alive (goals outlive missions)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { mission, primary, secondary } = await buildPortfolio(request, token, 2);
        // Share the primary with a SECOND mission to prove only THIS mission's
        // edges vanish, not the Goal or its other edges.
        const other = await createMission(request, token, { description: 'Keeper' });
        await linkGoal(request, token, other.id, primary.id, true);

        const del = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);

        // Every standalone Goal survives the container's deletion…
        for (const g of [primary, ...secondary]) {
            expect((await getGoal(request, token, g.id)).status).toBe(200);
        }
        // …and the OTHER mission's edge to the shared Goal is untouched.
        const keeper = await listLinks(request, token, other.id);
        expect(keeper.links.map((l) => l.goalId)).toEqual([primary.id]);
    });
});
