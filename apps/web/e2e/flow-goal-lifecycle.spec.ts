import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-goal-lifecycle — END-TO-END INTEGRATION flows for the Goals & Metrics
 * surface (PR-8, spec FR-9..FR-14):
 *   - `apps/api/src/goals/goals.controller.ts`  (base `api/me/goals`)
 *   - the Mission ↔ Goal link routes on `apps/api/src/missions/missions.controller.ts`
 *   - `@ever-works/agent/goals` → GoalsService + GoalEvaluationService.
 *
 * ENVIRONMENT-ADAPTIVE by design. CI runs this suite with NO metrics-provider
 * plugin configured (same posture as the keyless-AI specs). Everything that does
 * NOT touch an upstream provider is asserted firmly (create/list/get/404/anon,
 * the activate/pause state-machine, the mission-link isPrimary invariant, the
 * PATCH outcome override). The ONE flow that reaches a provider — `evaluate-now`
 * — is asserted for GRACEFUL DEGRADATION only: the manual tick may fail against
 * an unconfigured provider (any 4xx/5xx tolerated) but the Goal must stay
 * consistent and readable (no crash, no half-written state).
 *
 * Endpoints exercised (status codes derived from the controller/service source):
 *   GET    /api/me/goals                     200 GoalDto[] (mine; updatedAt DESC)
 *   POST   /api/me/goals                     201 GoalDto (status=draft) | 400 (bad shape)
 *   GET    /api/me/goals/:id                 200 | 404 "Goal not found" | 400 (non-uuid) | 401 (anon)
 *   GET    /api/me/goals/:id/samples         200 GoalMetricSampleDto[]
 *   PATCH  /api/me/goals/:id                 200 (partial; outcome override) | 400 (bad outcome)
 *   DELETE /api/me/goals/:id                 200 { deleted: true } (cascades samples + links)
 *   POST   /api/me/goals/:id/activate        200 (draft|paused|completed → active) | 400 (illegal from active)
 *   POST   /api/me/goals/:id/pause           200 (active → paused) | 400 (illegal from non-active)
 *   POST   /api/me/goals/:id/evaluate-now    200 { entry, goal } | 4xx/5xx (unconfigured provider) | 400 (non-active)
 *   GET    /api/me/missions/:id/goals        200 MissionGoalLinkDto[]
 *   POST   /api/me/missions/:id/goals        201 MissionGoalLinkDto (idempotent; one primary/Mission)
 *   DELETE /api/me/missions/:id/goals/:gid   200 { deleted: true } | 404 "Goal link not found"
 *
 * Backend facts pinned from source (packages/agent/src/goals/*):
 *   - MIN_CHECK_FREQUENCY_MINUTES = 15, DEFAULT = 60. `checkFrequencyMinutes`
 *     is clamped up to 15 in GoalsService.create (values ≥1 pass the DTO's
 *     @Min(1), then Math.max(15, n) applies); the wire result is therefore
 *     clamped-to-15, but a stricter backend that 400s a sub-15 value is
 *     tolerated (probe).
 *   - Every Goal MUST carry a non-empty `metricSource.{pluginId,metricId}` to
 *     exist at all (validated on create AND re-validated on activate) — so a
 *     Goal "without a metricSource" is rejected at the entry gate (400), which
 *     is precisely what makes activation's metricSource requirement always hold.
 *   - Reads are userId-scoped with 404-no-leak (same 404 for missing vs foreign).
 *   - Invariant I-4 (FR-14): completing a Goal (auto OR human override) NEVER
 *     mutates a linked Mission's status.
 *
 * Cross-spec isolation: every flow runs on a FRESH registerUserViaAPI() user
 * (Goal + Mission rows are user-scoped). Unique suffixes come from a per-test
 * counter, never a module-scope clock. NO module-scope loads (the apps/web tsc
 * gate compiles this file; keep it side-effect-free at import time).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

/** A metricSource that is structurally valid but points at an (unconfigured) provider. */
const PLACEHOLDER_SOURCE = { pluginId: 'custom-http-metrics', metricId: 'placeholder' } as const;

type GoalStatus = 'draft' | 'active' | 'paused' | 'completed';
type GoalOutcome = 'achieved' | 'missed' | 'abandoned';
type GoalComparator = 'gte' | 'lte';
type GoalWindow = 'day' | 'week' | 'month' | 'total' | 'point';

interface GoalDto {
    id: string;
    title: string;
    description: string | null;
    metricSource: { pluginId: string; metricId: string; params?: Record<string, unknown> };
    comparator: GoalComparator;
    targetValue: number;
    unit: string;
    window: GoalWindow;
    baselineValue: number | null;
    currentValue: number | null;
    currentValueAt: string | null;
    deadline: string | null;
    checkFrequencyMinutes: number;
    nextCheckAt: string | null;
    status: GoalStatus;
    outcome: GoalOutcome | null;
    createdAt: string;
    updatedAt: string;
}

interface MissionGoalLinkDto {
    id: string;
    missionId: string;
    goalId: string;
    isPrimary: boolean;
    createdAt: string;
    goal: GoalDto | null;
}

interface MissionDto {
    id: string;
    status: string;
}

let counter = 0;
function nextSfx(label: string): string {
    counter += 1;
    const slug = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 16);
    return `${slug}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Build a valid create-Goal body; caller overrides any field. */
function goalBody(sfx: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        title: `Goal ${sfx}`,
        description: `goal lifecycle ${sfx}`,
        metricSource: { ...PLACEHOLDER_SOURCE },
        comparator: 'gte' as GoalComparator,
        targetValue: 1000,
        unit: 'usd',
        window: 'month' as GoalWindow,
        ...overrides,
    };
}

async function createGoalRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/me/goals`, { headers: authedHeaders(token), data: body });
}

async function createGoal(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
    sfx = nextSfx('g'),
): Promise<GoalDto> {
    const res = await createGoalRaw(request, token, goalBody(sfx, overrides));
    expect(res.status(), `goal create body=${await res.text()}`).toBe(201);
    const g = (await res.json()) as GoalDto;
    expect(g.id).toMatch(UUID_RE);
    return g;
}

async function getGoal(request: APIRequestContext, token: string, id: string) {
    return request.get(`${API_BASE}/api/me/goals/${id}`, { headers: authedHeaders(token) });
}

async function lifecycle(
    request: APIRequestContext,
    token: string,
    id: string,
    verb: 'activate' | 'pause' | 'evaluate-now',
) {
    return request.post(`${API_BASE}/api/me/goals/${id}/${verb}`, {
        headers: authedHeaders(token),
        data: {},
    });
}

async function createMission(
    request: APIRequestContext,
    token: string,
    sfx: string,
): Promise<MissionDto> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: {
            title: `Mission ${sfx}`,
            description: `mission for goals ${sfx}`,
            type: 'one-shot',
        },
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = (await res.json()) as MissionDto;
    expect(m.id).toMatch(UUID_RE);
    return m;
}

async function listMissionGoals(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<MissionGoalLinkDto[]> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}/goals`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list mission goals body=${await res.text()}`).toBe(200);
    return (await res.json()) as MissionGoalLinkDto[];
}

function primaryCount(links: MissionGoalLinkDto[]): number {
    return links.filter((l) => l.isPrimary).length;
}

test.describe('flow: Goal lifecycle — CRUD, activation, evaluate-now, mission links, outcome override', () => {
    // ──────────────────────────────────────────────────────────────────
    // (a) CREATE DRAFT + THE READ SURFACE (list / get / 404-no-leak / anon 401)
    // AND THE checkFrequencyMinutes ≥15 CLAMP. A created Goal is born DRAFT
    // with outcome null and nextCheckAt null; the default cadence is 60; a
    // sub-15 cadence is clamped up to 15 (or 400 on a stricter backend).
    // ──────────────────────────────────────────────────────────────────
    test('create lands a draft goal; list/get echo it; unknown/foreign 404, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const sfx = nextSfx('draft');
        const headers = authedHeaders(owner.access_token);

        // ── Create: 201, DRAFT, defaults applied, placeholder source echoed.
        const g = await createGoal(request, owner.access_token, {}, sfx);
        expect(g.status).toBe('draft');
        expect(g.outcome).toBeNull();
        expect(g.nextCheckAt).toBeNull();
        expect(g.currentValue).toBeNull();
        expect(g.baselineValue).toBeNull();
        expect(g.comparator).toBe('gte');
        expect(g.targetValue).toBe(1000);
        expect(g.unit).toBe('usd');
        expect(g.window).toBe('month');
        expect(g.metricSource.pluginId).toBe(PLACEHOLDER_SOURCE.pluginId);
        expect(g.metricSource.metricId).toBe(PLACEHOLDER_SOURCE.metricId);
        // Default cadence is 60 when omitted.
        expect(g.checkFrequencyMinutes).toBe(60);

        // ── GET the goal → 200, byte-identical id/title.
        const got = await getGoal(request, owner.access_token, g.id);
        expect(got.status()).toBe(200);
        expect(((await got.json()) as GoalDto).title).toBe(`Goal ${sfx}`);

        // ── List → 200 and contains the created goal.
        const listRes = await request.get(`${API_BASE}/api/me/goals`, { headers });
        expect(listRes.status()).toBe(200);
        const list = (await listRes.json()) as GoalDto[];
        expect(list.map((x) => x.id)).toContain(g.id);

        // ── ≥15-minute clamp: a sub-15 cadence is clamped up to 15, OR the
        // backend rejects it (400). Probe tolerantly.
        const lowFreq = await createGoalRaw(
            request,
            owner.access_token,
            goalBody(nextSfx('freq'), { checkFrequencyMinutes: 5 }),
        );
        expect([201, 400]).toContain(lowFreq.status());
        if (lowFreq.status() === 201) {
            const clamped = (await lowFreq.json()) as GoalDto;
            expect(clamped.checkFrequencyMinutes).toBe(15);
        }

        // ── 404-no-leak: an unknown well-formed UUID → 404 "Goal not found".
        const unknown = await getGoal(request, owner.access_token, UNKNOWN_UUID);
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).message).toMatch(/not found/i);

        // ── A stranger asking for the owner's goal → the SAME opaque 404.
        const foreign = await getGoal(request, stranger.access_token, g.id);
        expect(foreign.status()).toBe(404);
        expect((await foreign.json()).message).toMatch(/not found/i);

        // ── Non-uuid path → 400 (ParseUUIDPipe, before the service).
        const nonUuid = await getGoal(request, owner.access_token, 'not-a-uuid');
        expect(nonUuid.status()).toBe(400);

        // ── Anonymous (no Authorization header) → 401.
        const anonList = await request.get(`${API_BASE}/api/me/goals`);
        expect(anonList.status()).toBe(401);
        const anonGet = await request.get(`${API_BASE}/api/me/goals/${g.id}`);
        expect(anonGet.status()).toBe(401);
    });

    // ──────────────────────────────────────────────────────────────────
    // (b) THE ACTIVATE/PAUSE STATE-MACHINE + THE metricSource REQUIREMENT.
    // A Goal cannot even be CREATED without a non-empty metricSource
    // (pluginId+metricId), so activation's "requires an evaluable source"
    // rule is guaranteed at the entry gate. A well-formed draft activates
    // (draft→active), pauses (active→paused), and re-activates (paused→
    // active); the illegal hops (activate-from-active, pause-from-draft) 400.
    // ──────────────────────────────────────────────────────────────────
    test('activate requires a metricSource; state-machine draft→active→paused→active, illegal hops 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('sm');

        // ── A Goal WITHOUT a usable metricSource is rejected at CREATE — you
        // can never reach activation without a source. Empty ids → 400.
        const noSource = await createGoalRaw(
            request,
            token,
            goalBody(nextSfx('nosrc'), { metricSource: { pluginId: '', metricId: '' } }),
        );
        expect(noSource.status()).toBe(400);
        // Omitting metricSource entirely is likewise rejected (400).
        const missingSource = await createGoalRaw(request, token, {
            title: `No Source ${sfx}`,
            description: 'no metric source',
            comparator: 'gte',
            targetValue: 10,
            unit: 'count',
            window: 'total',
        });
        expect(missingSource.status()).toBe(400);

        // ── A well-formed draft activates → 200 ACTIVE, nextCheckAt set, outcome null.
        const g = await createGoal(request, token, {}, sfx);
        const act = await lifecycle(request, token, g.id, 'activate');
        expect(act.status(), `activate body=${await act.text()}`).toBe(200);
        const active = (await act.json()) as GoalDto;
        expect(active.status).toBe('active');
        expect(active.outcome).toBeNull();
        expect(active.nextCheckAt).not.toBeNull();
        // The status survives a fresh GET — activation persisted.
        expect(((await (await getGoal(request, token, g.id)).json()) as GoalDto).status).toBe(
            'active',
        );

        // ── Activating an already-ACTIVE goal is illegal → 400 (ACTIVE is not
        // in the activatable set draft|paused|completed).
        const reAct = await lifecycle(request, token, g.id, 'activate');
        expect(reAct.status()).toBe(400);
        expect((await reAct.json()).message).toMatch(/cannot be activated/i);

        // ── active → paused → 200; nextCheckAt cleared so the dispatcher skips it.
        const pause = await lifecycle(request, token, g.id, 'pause');
        expect(pause.status()).toBe(200);
        const paused = (await pause.json()) as GoalDto;
        expect(paused.status).toBe('paused');
        expect(paused.nextCheckAt).toBeNull();

        // ── Pausing an already-PAUSED goal is illegal → 400 (only ACTIVE pauses).
        const rePause = await lifecycle(request, token, g.id, 'pause');
        expect(rePause.status()).toBe(400);
        expect((await rePause.json()).message).toMatch(/cannot be paused/i);

        // ── paused → active (re-activatable) → 200.
        const reactivate = await lifecycle(request, token, g.id, 'activate');
        expect(reactivate.status()).toBe(200);
        expect(((await reactivate.json()) as GoalDto).status).toBe('active');

        // ── Pausing a still-DRAFT goal is illegal → 400.
        const draft2 = await createGoal(request, token, {}, nextSfx('draft2'));
        const pauseDraft = await lifecycle(request, token, draft2.id, 'pause');
        expect(pauseDraft.status()).toBe(400);

        // ── Activate/pause on an unknown goal → 404 (no-leak).
        const actUnknown = await lifecycle(request, token, UNKNOWN_UUID, 'activate');
        expect(actUnknown.status()).toBe(404);
    });

    // ──────────────────────────────────────────────────────────────────
    // (c) evaluate-now DEGRADES GRACEFULLY AGAINST AN UNCONFIGURED PROVIDER.
    // The manual tick requires an ACTIVE goal (draft → 400). Once active, the
    // tick reaches MetricsFacadeService.getMetricValue; with no configured
    // 'custom-http-metrics' provider it fails (any 4xx/5xx tolerated) — but the
    // Goal MUST stay consistent: still ACTIVE, still readable, no half-written
    // sample. In an environment where the provider IS wired the tick may 200;
    // either way the post-tick Goal is valid and the samples endpoint answers 200.
    // ──────────────────────────────────────────────────────────────────
    test('evaluate-now requires active, then fails gracefully on an unconfigured provider without corrupting the goal', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('eval');

        // ── evaluate-now on a DRAFT goal is rejected → 400 "must be active".
        const draft = await createGoal(request, token, {}, sfx);
        const evalDraft = await lifecycle(request, token, draft.id, 'evaluate-now');
        expect(evalDraft.status()).toBe(400);
        expect((await evalDraft.json()).message).toMatch(/must be active/i);

        // ── Activate, then run the manual tick against the (unconfigured) provider.
        expect((await lifecycle(request, token, draft.id, 'activate')).status()).toBe(200);
        const evalRes = await lifecycle(request, token, draft.id, 'evaluate-now');
        // Graceful degradation: success (provider wired) OR a bounded failure.
        expect([200, 400, 402, 404, 409, 422, 429, 500, 502, 503, 504]).toContain(evalRes.status());

        // ── The Goal is still readable and in a consistent state afterward.
        const afterRes = await getGoal(request, token, draft.id);
        expect(afterRes.status(), 'goal readable after evaluate-now').toBe(200);
        const after = (await afterRes.json()) as GoalDto;
        if (evalRes.status() === 200) {
            // If it evaluated, the tick either kept it active or completed it
            // (achieved/missed) — never any other state.
            expect(['active', 'completed']).toContain(after.status);
            const body = (await evalRes.json()) as { entry: unknown; goal: GoalDto };
            expect(body.entry).toBeTruthy();
            expect(body.goal.id).toBe(draft.id);
        } else {
            // A failed provider read writes NOTHING: the Goal stays ACTIVE with
            // no outcome and no observed value (spec FR-5).
            expect(after.status).toBe('active');
            expect(after.outcome).toBeNull();
            expect(after.currentValue).toBeNull();
        }

        // ── The samples endpoint answers 200 regardless — a failed read appends
        // no rows, so the history is a (possibly empty) array, never a 500.
        const samplesRes = await request.get(`${API_BASE}/api/me/goals/${draft.id}/samples`, {
            headers: authedHeaders(token),
        });
        expect(samplesRes.status()).toBe(200);
        expect(Array.isArray(await samplesRes.json())).toBe(true);
    });

    // ──────────────────────────────────────────────────────────────────
    // (d) MISSION ↔ GOAL LINK/UNLINK + THE one-primary-per-Mission INVARIANT.
    // Goals are created standalone and attached to a Mission. Linking a second
    // goal as primary either FLIPS the primary (demote-before-promote) or 409s
    // — either way the invariant "at most one primary per Mission" holds.
    // Re-linking is idempotent (updates isPrimary, no new edge). Unlink removes
    // the edge but leaves the Goal itself; a second unlink 404s; deleting the
    // Goal cascades the edge away.
    // ──────────────────────────────────────────────────────────────────
    test('link/unlink goals to a mission with exactly-one-primary; idempotent re-link; delete cascades the edge', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('link');
        const headers = authedHeaders(token);

        const mission = await createMission(request, token, sfx);
        const goal1 = await createGoal(request, token, {}, nextSfx('lg1'));
        const goal2 = await createGoal(request, token, {}, nextSfx('lg2'));

        async function link(goalId: string, isPrimary: boolean) {
            return request.post(`${API_BASE}/api/me/missions/${mission.id}/goals`, {
                headers,
                data: { goalId, isPrimary },
            });
        }

        // ── Link goal1 as PRIMARY → 201; the link expands the Goal projection.
        const l1 = await link(goal1.id, true);
        expect(l1.status(), `link1 body=${await l1.text()}`).toBe(201);
        const link1 = (await l1.json()) as MissionGoalLinkDto;
        expect(link1.goalId).toBe(goal1.id);
        expect(link1.missionId).toBe(mission.id);
        expect(link1.isPrimary).toBe(true);
        expect(link1.goal?.id).toBe(goal1.id);

        let links = await listMissionGoals(request, token, mission.id);
        expect(links.length).toBe(1);
        expect(primaryCount(links)).toBe(1);
        expect(links[0].goalId).toBe(goal1.id);

        // ── Link goal2 as PRIMARY: FLIP (201, demote goal1) or 409 — either way
        // there is at most ONE primary edge on the Mission. (The shipped service
        // demotes-before-promoting → 201 flip; a stricter 409 backend is tolerated.)
        const l2 = await link(goal2.id, true);
        expect([201, 409]).toContain(l2.status());
        links = await listMissionGoals(request, token, mission.id);
        expect(primaryCount(links)).toBe(1); // the invariant holds in BOTH worlds
        const primaryGoalId = links.find((x) => x.isPrimary)?.goalId;
        if (l2.status() === 201) {
            // Demote-before-promote: both linked, goal2 the sole primary, goal1 demoted.
            expect(links.length).toBe(2);
            expect(primaryGoalId).toBe(goal2.id);
            expect(links.find((x) => x.goalId === goal1.id)?.isPrimary).toBe(false);
        } else {
            // A 409 backend keeps goal1 primary and rejects the second primary.
            expect(primaryGoalId).toBe(goal1.id);
        }

        // ── Re-linking is idempotent: re-POST goal1 with isPrimary=false updates
        // the flag in place — NO duplicate edge is created (exactly one goal1 edge).
        const reLink = await link(goal1.id, false);
        expect(reLink.status()).toBe(201);
        expect(((await reLink.json()) as MissionGoalLinkDto).isPrimary).toBe(false);
        links = await listMissionGoals(request, token, mission.id);
        expect(links.filter((x) => x.goalId === goal1.id).length).toBe(1);
        expect(links.find((x) => x.goalId === goal1.id)?.isPrimary).toBe(false);

        // ── Unlink goal1 → 200 { deleted: true }; the GOAL itself is untouched.
        // (goal1 is guaranteed linked in BOTH the flip and the 409 world.)
        const unlink = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/goals/${goal1.id}`,
            { headers },
        );
        expect(unlink.status()).toBe(200);
        expect(await unlink.json()).toEqual({ deleted: true });
        expect((await getGoal(request, token, goal1.id)).status()).toBe(200); // goal still exists
        links = await listMissionGoals(request, token, mission.id);
        expect(links.map((x) => x.goalId)).not.toContain(goal1.id);

        // ── A second unlink of the now-detached goal1 → 404 "Goal link not found".
        const unlinkAgain = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/goals/${goal1.id}`,
            { headers },
        );
        expect(unlinkAgain.status()).toBe(404);
        expect((await unlinkAgain.json()).message).toMatch(/not found/i);

        // ── Re-link goal1, then DELETE the Goal entity — the DB cascade removes
        // its mission_goals edge (no orphan edge dangling on the Mission).
        expect((await link(goal1.id, false)).status()).toBe(201);
        const delGoal = await request.delete(`${API_BASE}/api/me/goals/${goal1.id}`, { headers });
        expect(delGoal.status()).toBe(200);
        expect(await delGoal.json()).toEqual({ deleted: true });
        links = await listMissionGoals(request, token, mission.id);
        expect(links.map((x) => x.goalId)).not.toContain(goal1.id); // cascade removed the edge
    });

    // ──────────────────────────────────────────────────────────────────
    // (d′) LINK-SURFACE CROSS-USER ISOLATION + UNKNOWN-ID 404s. A user cannot
    // link a foreign Goal to their own Mission, cannot link their Goal to a
    // foreign Mission, and cannot link a nonexistent Goal — all opaque 404s.
    // ──────────────────────────────────────────────────────────────────
    test('mission-link surface is cross-user isolated and 404s unknown ids', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const sfx = nextSfx('link-iso');

        const ownerMission = await createMission(request, owner.access_token, sfx);
        const ownerGoal = await createGoal(request, owner.access_token, {}, nextSfx('og'));
        const strangerGoal = await createGoal(request, stranger.access_token, {}, nextSfx('sg'));

        async function ownerLink(missionId: string, goalId: string) {
            return request.post(`${API_BASE}/api/me/missions/${missionId}/goals`, {
                headers: authedHeaders(owner.access_token),
                data: { goalId },
            });
        }

        // ── Owner links a FOREIGN goal to their own mission → 404 (goal-side gate).
        const foreignGoal = await ownerLink(ownerMission.id, strangerGoal.id);
        expect(foreignGoal.status()).toBe(404);

        // ── Owner links their goal to a FOREIGN mission (the stranger's) → 404.
        const strangerMission = await createMission(request, stranger.access_token, nextSfx('sm'));
        const foreignMission = await ownerLink(strangerMission.id, ownerGoal.id);
        expect(foreignMission.status()).toBe(404);

        // ── Owner links a nonexistent goal → 404.
        const unknownGoal = await ownerLink(ownerMission.id, UNKNOWN_UUID);
        expect(unknownGoal.status()).toBe(404);

        // ── A stranger cannot even list the owner's mission goals → 404.
        const strangerList = await request.get(
            `${API_BASE}/api/me/missions/${ownerMission.id}/goals`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(strangerList.status()).toBe(404);
    });

    // ──────────────────────────────────────────────────────────────────
    // (e) PATCH OUTCOME OVERRIDE (spec FR-13) + INVARIANT I-4. Writing a
    // non-null `outcome` is the human override: it COMPLETES the Goal (status →
    // completed) and clears nextCheckAt — from a draft, an active, whatever.
    // `outcome: null` clears an auto/human outcome WITHOUT changing status. An
    // out-of-range outcome is rejected (400). And per invariant I-4, completing
    // a Goal NEVER touches a Mission it is linked to.
    // ──────────────────────────────────────────────────────────────────
    test('PATCH outcome override completes the goal, null clears it, bad value 400 — and never touches the mission', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('outcome');
        const headers = authedHeaders(token);

        async function patch(id: string, data: Record<string, unknown>) {
            return request.patch(`${API_BASE}/api/me/goals/${id}`, { headers, data });
        }

        // ── A human override on a DRAFT goal completes it: status→completed,
        // outcome set, nextCheckAt null.
        const g = await createGoal(request, token, {}, sfx);
        const abandon = await patch(g.id, { outcome: 'abandoned' });
        expect(abandon.status(), `patch outcome body=${await abandon.text()}`).toBe(200);
        const abandoned = (await abandon.json()) as GoalDto;
        expect(abandoned.outcome).toBe('abandoned');
        expect(abandoned.status).toBe('completed');
        expect(abandoned.nextCheckAt).toBeNull();

        // ── Clearing with outcome:null keeps the completed status but drops the outcome.
        const clear = await patch(g.id, { outcome: null });
        expect(clear.status()).toBe(200);
        const cleared = (await clear.json()) as GoalDto;
        expect(cleared.outcome).toBeNull();
        expect(cleared.status).toBe('completed');

        // ── A completed goal can be re-activated (clears any outcome) — proves the
        // override is not a dead-end.
        const reAct = await lifecycle(request, token, g.id, 'activate');
        expect(reAct.status()).toBe(200);
        const reActivated = (await reAct.json()) as GoalDto;
        expect(reActivated.status).toBe('active');
        expect(reActivated.outcome).toBeNull();

        // ── Overriding an ACTIVE goal to 'achieved' completes it too.
        const achieve = await patch(g.id, { outcome: 'achieved' });
        expect(achieve.status()).toBe(200);
        const achieved = (await achieve.json()) as GoalDto;
        expect(achieved.status).toBe('completed');
        expect(achieved.outcome).toBe('achieved');

        // ── An out-of-range outcome is rejected (DTO @IsIn) → 400.
        const bad = await patch(g.id, { outcome: 'bogus' });
        expect(bad.status()).toBe(400);

        // ── INVARIANT I-4: completing a Goal that is LINKED to a Mission does not
        // move the Mission. Link a fresh goal to an active mission, override the
        // goal to completed, and assert the mission is still exactly as it was.
        const mission = await createMission(request, token, nextSfx('i4'));
        const missionStatusBefore = mission.status;
        const linkedGoal = await createGoal(request, token, {}, nextSfx('i4g'));
        const linkRes = await request.post(`${API_BASE}/api/me/missions/${mission.id}/goals`, {
            headers,
            data: { goalId: linkedGoal.id, isPrimary: true },
        });
        expect(linkRes.status()).toBe(201);

        expect((await patch(linkedGoal.id, { outcome: 'achieved' })).status()).toBe(200);

        const missionAfter = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
        });
        expect(missionAfter.status()).toBe(200);
        expect(((await missionAfter.json()) as MissionDto).status).toBe(missionStatusBefore);
        // The link still resolves the (now completed) goal — completion doesn't unlink.
        const linksAfter = await listMissionGoals(request, token, mission.id);
        expect(linksAfter.find((x) => x.goalId === linkedGoal.id)?.goal?.status).toBe('completed');
    });
});
