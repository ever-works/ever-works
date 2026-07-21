/**
 * Goals & Metrics — user-owned measurable targets + lifecycle, DEEP (#1670, spec FR-9..FR-14).
 *
 * Goals are standalone, `userId`-scoped rows ("income >= $1000/month via Stripe")
 * that the goal-evaluate-dispatcher reads against `metrics-provider` plugins. This
 * file drives the whole `/api/me/goals` surface end-to-end plus the Mission ↔ Goal
 * link endpoints on the MissionsController, pinning the real shapes + status codes
 * observed against a live stack.
 *
 *   • create → 201 GoalDto returned DIRECTLY (not wrapped): status=draft, outcome=null,
 *     nextCheckAt/currentValue/baselineValue/deadline all null, checkFrequencyMinutes=60.
 *     The DTO NEVER leaks userId/tenantId/organizationId (pure projection).
 *   • create normalizes: trims title, blanks description → null, round-trips
 *     metricSource.params, accepts zero / negative / float targetValue, clamps
 *     checkFrequencyMinutes to >= 15 (spec FR-12).
 *   • list → 200 bare array (mine only); get/samples → 200; samples is an append-only
 *     empty history until a real evaluation writes one.
 *   • validation (400): missing title, bad comparator/window, metricSource shape
 *     (missing/empty pluginId, non-object), non-number targetValue, unknown property
 *     (forbidNonWhitelisted), invalid `?status=` filter.
 *   • PATCH partial update; setting a non-null `outcome` is the human override →
 *     status=completed + nextCheckAt cleared; `outcome:null` clears without dropping
 *     status; `deadline:null` clears.
 *   • lifecycle state-machine: activate (draft|paused|completed → active, sets
 *     nextCheckAt, clears outcome); pause (active → paused, clears nextCheckAt);
 *     illegal transitions → 400. evaluate-now is gated to ACTIVE goals; in this env
 *     no metrics-provider plugin is registered so it returns ProviderNotFoundError
 *     (404) and — crucially — writes NO sample and leaves the goal ACTIVE (failure
 *     atomicity, spec "Reliability").
 *   • delete → 200 { deleted: true }; then get/samples/delete → 404 (cascades).
 *   • cross-user isolation: every route on another user's goal → 404 (no-leak);
 *     a foreign goal never appears in the caller's list.
 *   • Mission ↔ Goal links: POST /api/me/missions/:id/goals → 201 link dto w/ nested
 *     goal projection; one-primary-per-mission demotion; idempotent re-link; unlink →
 *     { deleted: true }; unknown goal → 404; bad goalId → 400; foreign mission → 404.
 *
 * ── Verified live (http://127.0.0.1:3100, sqlite in-memory, all flags ON) before
 *    every assertion. Fully API-orchestrated; a fresh registerUserViaAPI() owner per
 *    test (never the shared seeded user).
 */
import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const GOALS_BASE = `${API_BASE}/api/me/goals`;
const MISSIONS_BASE = `${API_BASE}/api/me/missions`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface GoalPayloadOverrides {
    title?: string;
    description?: string | null;
    metricSource?: Record<string, unknown>;
    comparator?: string;
    targetValue?: number;
    unit?: string;
    window?: string;
    baselineValue?: number | null;
    deadline?: string | null;
    checkFrequencyMinutes?: number;
}

/** A valid CreateGoalDto body; override any field for negative tests. */
function goalPayload(overrides: GoalPayloadOverrides = {}): Record<string, unknown> {
    return {
        title: `Goal ${stamp()}`,
        metricSource: { pluginId: 'stripe', metricId: 'income' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'usd',
        window: 'month',
        ...overrides,
    };
}

async function createGoal(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    overrides: GoalPayloadOverrides = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
    const res = await request.post(GOALS_BASE, {
        headers: authedHeaders(token),
        data: goalPayload(overrides),
    });
    expect(res.status(), `create goal body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    return { id: body.id, body };
}

async function createMission(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    title = `Mission ${stamp()}`,
): Promise<string> {
    const res = await request.post(MISSIONS_BASE, {
        headers: authedHeaders(token),
        data: { title, description: 'd', type: 'one-shot' },
    });
    expect(res.status(), `create mission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id;
}

test.describe('Goals — create & read', () => {
    test('create returns a draft GoalDto with the full pinned shape and no owner/scope leak', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const title = `Income target ${stamp()}`;
        const { id, body } = await createGoal(request, user.access_token, {
            title,
            description: 'grow monthly income',
        });
        expect(id).toMatch(UUID_RE);
        expect(body.title).toBe(title);
        expect(body.description).toBe('grow monthly income');
        expect(body.metricSource).toEqual({ pluginId: 'stripe', metricId: 'income' });
        expect(body.comparator).toBe('gte');
        expect(body.targetValue).toBe(1000);
        expect(body.unit).toBe('usd');
        expect(body.window).toBe('month');
        expect(body.baselineValue).toBeNull();
        expect(body.currentValue).toBeNull();
        expect(body.currentValueAt).toBeNull();
        expect(body.deadline).toBeNull();
        expect(body.checkFrequencyMinutes).toBe(60);
        expect(body.nextCheckAt).toBeNull();
        expect(body.status).toBe('draft');
        expect(body.outcome).toBeNull();
        expect(typeof body.createdAt).toBe('string');
        expect(typeof body.updatedAt).toBe('string');
        // Pure projection — internal ownership/scope columns are NOT on the wire.
        expect(body.userId).toBeUndefined();
        expect(body.tenantId).toBeUndefined();
        expect(body.organizationId).toBeUndefined();
    });

    test('create normalizes input: trims title, blanks description → null, keeps params, allows 0/negative/float targets', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { body } = await createGoal(request, user.access_token, {
            title: '   Spaced Title   ',
            description: '   ',
            metricSource: {
                pluginId: 'custom-http',
                metricId: 'balance',
                params: { currency: 'usd', account: 'main' },
            },
            comparator: 'lte',
            targetValue: 0,
            unit: 'usd',
            window: 'point',
            baselineValue: -5,
        });
        expect(body.title).toBe('Spaced Title');
        expect(body.description).toBeNull();
        expect(body.metricSource).toEqual({
            pluginId: 'custom-http',
            metricId: 'balance',
            params: { currency: 'usd', account: 'main' },
        });
        expect(body.targetValue).toBe(0);
        expect(body.baselineValue).toBe(-5);
        expect(body.comparator).toBe('lte');
        expect(body.window).toBe('point');

        const neg = await createGoal(request, user.access_token, {
            targetValue: -100.5,
            unit: 'c',
            window: 'total',
        });
        expect(neg.body.targetValue).toBe(-100.5);
    });

    test('checkFrequencyMinutes is clamped to >= 15 (spec FR-12); default is 60', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tooFast = await createGoal(request, user.access_token, { checkFrequencyMinutes: 5 });
        expect(tooFast.body.checkFrequencyMinutes).toBe(15);
        const generous = await createGoal(request, user.access_token, {
            checkFrequencyMinutes: 240,
        });
        expect(generous.body.checkFrequencyMinutes).toBe(240);
        const dflt = await createGoal(request, user.access_token);
        expect(dflt.body.checkFrequencyMinutes).toBe(60);
    });

    test("list returns a bare array containing the caller's goal; unauth → 401", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const list = await request.get(GOALS_BASE, { headers: authedHeaders(user.access_token) });
        expect(list.status()).toBe(200);
        const rows = await list.json();
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.map((g: { id: string }) => g.id)).toContain(id);

        expect((await request.get(GOALS_BASE)).status()).toBe(401);
    });

    test('get one returns the goal; unknown uuid → 404; malformed uuid → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);

        const got = await request.get(`${GOALS_BASE}/${id}`, { headers: H });
        expect(got.status()).toBe(200);
        expect((await got.json()).id).toBe(id);

        expect((await request.get(`${GOALS_BASE}/${UNKNOWN_UUID}`, { headers: H })).status()).toBe(
            404,
        );
        expect((await request.get(`${GOALS_BASE}/not-a-uuid`, { headers: H })).status()).toBe(400);
    });

    test('samples is a 200 append-only history — empty for a never-evaluated goal', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const res = await request.get(`${GOALS_BASE}/${id}/samples?limit=5`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

test.describe('Goals — validation (400)', () => {
    test('missing title, bad comparator, and bad window each → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const noTitle = await request.post(GOALS_BASE, {
            headers: H,
            data: { ...goalPayload(), title: undefined },
        });
        expect(noTitle.status()).toBe(400);

        const badCmp = await request.post(GOALS_BASE, {
            headers: H,
            data: goalPayload({ comparator: 'eq' }),
        });
        expect(badCmp.status()).toBe(400);

        const badWindow = await request.post(GOALS_BASE, {
            headers: H,
            data: goalPayload({ window: 'year' }),
        });
        expect(badWindow.status()).toBe(400);
    });

    test('metricSource shape is enforced: missing/empty pluginId and non-object → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const missing = await request.post(GOALS_BASE, {
            headers: H,
            data: goalPayload({ metricSource: { metricId: 'm' } }),
        });
        expect(missing.status()).toBe(400);

        const empty = await request.post(GOALS_BASE, {
            headers: H,
            data: goalPayload({ metricSource: { pluginId: '', metricId: 'm' } }),
        });
        expect(empty.status()).toBe(400);

        const asArray = await request.post(GOALS_BASE, {
            headers: H,
            data: goalPayload({ metricSource: [] as unknown as Record<string, unknown> }),
        });
        expect(asArray.status()).toBe(400);
        expect(String((await asArray.json()).message)).toMatch(/metricSource/i);
    });

    test('non-number targetValue and unknown properties are rejected (400)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const badTarget = await request.post(GOALS_BASE, {
            headers: H,
            data: { ...goalPayload(), targetValue: 'lots' },
        });
        expect(badTarget.status()).toBe(400);

        const unknownProp = await request.post(GOALS_BASE, {
            headers: H,
            data: { ...goalPayload(), bogusField: 'nope' },
        });
        expect(unknownProp.status()).toBe(400);
        expect(JSON.stringify(await unknownProp.json())).toMatch(/bogusField/);
    });

    test('list with an invalid ?status= filter → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${GOALS_BASE}?status=bogus`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(String((await res.json()).message)).toMatch(/Invalid status filter/i);
    });

    test('create without auth → 401', async ({ request }) => {
        const res = await request.post(GOALS_BASE, { data: goalPayload() });
        expect(res.status()).toBe(401);
    });
});

test.describe('Goals — update & the outcome override', () => {
    test('PATCH patches title/targetValue/deadline without changing status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const patch = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { title: 'Renamed', targetValue: 2000, deadline: '2027-01-01T00:00:00.000Z' },
        });
        expect(patch.status()).toBe(200);
        const body = await patch.json();
        expect(body.title).toBe('Renamed');
        expect(body.targetValue).toBe(2000);
        expect(body.deadline).toBe('2027-01-01T00:00:00.000Z');
        expect(body.status).toBe('draft');
    });

    test('PATCH deadline:null clears an existing deadline', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token, {
            deadline: '2027-06-01T00:00:00.000Z',
        });
        const cleared = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { deadline: null },
        });
        expect(cleared.status()).toBe(200);
        expect((await cleared.json()).deadline).toBeNull();
    });

    test('setting a non-null outcome is the human override → status=completed, nextCheckAt cleared', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const done = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { outcome: 'abandoned' },
        });
        expect(done.status()).toBe(200);
        const body = await done.json();
        expect(body.outcome).toBe('abandoned');
        expect(body.status).toBe('completed');
        expect(body.nextCheckAt).toBeNull();
    });

    test('an invalid outcome value → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const res = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { outcome: 'bogus' },
        });
        expect(res.status()).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(/achieved.*missed.*abandoned/);
    });

    test('outcome:null on an active goal clears the outcome without dropping the active status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);
        // Complete via override, re-activate (clears outcome), then explicitly clear.
        await request.patch(`${GOALS_BASE}/${id}`, { headers: H, data: { outcome: 'achieved' } });
        const reactivated = await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });
        expect(reactivated.status()).toBe(200);
        expect((await reactivated.json()).status).toBe('active');

        const cleared = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: H,
            data: { outcome: null },
        });
        expect(cleared.status()).toBe(200);
        const body = await cleared.json();
        expect(body.outcome).toBeNull();
        expect(body.status).toBe('active');
    });
});

test.describe('Goals — lifecycle state machine', () => {
    test('activate draft → active sets nextCheckAt and clears outcome; activating an active goal → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);

        const act = await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });
        expect(act.status()).toBe(200);
        const body = await act.json();
        expect(body.status).toBe('active');
        expect(body.outcome).toBeNull();
        expect(typeof body.nextCheckAt).toBe('string');
        expect(Number.isFinite(Date.parse(body.nextCheckAt))).toBe(true);

        const again = await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });
        expect(again.status()).toBe(400);
        expect(String((await again.json()).message)).toMatch(
            /cannot be activated from status "active"/i,
        );
    });

    test('pause active → paused clears nextCheckAt; pausing a draft or paused goal → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);

        // Pausing a draft is illegal.
        expect((await request.post(`${GOALS_BASE}/${id}/pause`, { headers: H })).status()).toBe(
            400,
        );

        await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });
        const paused = await request.post(`${GOALS_BASE}/${id}/pause`, { headers: H });
        expect(paused.status()).toBe(200);
        const body = await paused.json();
        expect(body.status).toBe('paused');
        expect(body.nextCheckAt).toBeNull();

        // Pausing again (already paused) is illegal.
        const twice = await request.post(`${GOALS_BASE}/${id}/pause`, { headers: H });
        expect(twice.status()).toBe(400);
        expect(String((await twice.json()).message)).toMatch(
            /cannot be paused from status "paused"/i,
        );
    });

    test('re-activating a completed (human-overridden) goal clears its outcome', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);
        const completed = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: H,
            data: { outcome: 'missed' },
        });
        expect((await completed.json()).status).toBe('completed');

        const reactivated = await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });
        expect(reactivated.status()).toBe(200);
        const body = await reactivated.json();
        expect(body.status).toBe('active');
        expect(body.outcome).toBeNull();
    });

    test('evaluate-now is gated to ACTIVE goals; draft/paused → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);

        const draftEval = await request.post(`${GOALS_BASE}/${id}/evaluate-now`, { headers: H });
        expect(draftEval.status()).toBe(400);
        expect(String((await draftEval.json()).message)).toMatch(/must be active/i);

        await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });
        await request.post(`${GOALS_BASE}/${id}/pause`, { headers: H });
        const pausedEval = await request.post(`${GOALS_BASE}/${id}/evaluate-now`, { headers: H });
        expect(pausedEval.status()).toBe(400);
    });

    test('evaluate-now on an active goal is provider-gated (no metrics provider here) and writes NO sample', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);
        await request.post(`${GOALS_BASE}/${id}/activate`, { headers: H });

        const ev = await request.post(`${GOALS_BASE}/${id}/evaluate-now`, { headers: H });
        // Env-adaptive: no `metrics-provider` plugin is registered, so the source
        // can't resolve → ProviderNotFoundError (404). Tolerate a live provider (200)
        // or a transient upstream failure.
        expect([200, 404, 500, 502, 503]).toContain(ev.status());
        if (ev.status() === 404) {
            expect(String((await ev.json()).error ?? '')).toMatch(/provider/i);
        }

        if (!ev.ok()) {
            // Failure atomicity: the goal is untouched (still ACTIVE) and no observation row was appended.
            const after = await request.get(`${GOALS_BASE}/${id}`, { headers: H });
            expect((await after.json()).status).toBe('active');
            const samples = await request.get(`${GOALS_BASE}/${id}/samples`, { headers: H });
            expect(await samples.json()).toEqual([]);
        }
    });

    test('full lifecycle: create → activate → pause → activate → override-complete → reactivate', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);
        const post = async (path: string): Promise<string> => {
            const res = await request.post(`${GOALS_BASE}/${id}${path}`, { headers: H });
            expect(res.status(), `POST ${path} body=${await res.text().catch(() => '')}`).toBe(200);
            return (await res.json()).status;
        };
        expect(await post('/activate')).toBe('active');
        expect(await post('/pause')).toBe('paused');
        expect(await post('/activate')).toBe('active');

        const completed = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: H,
            data: { outcome: 'achieved' },
        });
        expect(completed.status()).toBe(200);
        expect((await completed.json()).status).toBe('completed');

        expect(await post('/activate')).toBe('active');
    });
});

test.describe('Goals — deletion & cross-user isolation', () => {
    test('delete returns { deleted: true }; the goal and its subroutes are then 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createGoal(request, user.access_token);
        const H = authedHeaders(user.access_token);

        const del = await request.delete(`${GOALS_BASE}/${id}`, { headers: H });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        expect((await request.get(`${GOALS_BASE}/${id}`, { headers: H })).status()).toBe(404);
        expect((await request.get(`${GOALS_BASE}/${id}/samples`, { headers: H })).status()).toBe(
            404,
        );
        expect((await request.delete(`${GOALS_BASE}/${id}`, { headers: H })).status()).toBe(404);
    });

    test("cross-user isolation: every route on another user's goal → 404 (no-leak)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const { id } = await createGoal(request, owner.access_token);
        const iH = authedHeaders(intruder.access_token);

        expect((await request.get(`${GOALS_BASE}/${id}`, { headers: iH })).status()).toBe(404);
        expect((await request.get(`${GOALS_BASE}/${id}/samples`, { headers: iH })).status()).toBe(
            404,
        );
        expect(
            (
                await request.patch(`${GOALS_BASE}/${id}`, {
                    headers: iH,
                    data: { title: 'hijack' },
                })
            ).status(),
        ).toBe(404);
        expect((await request.post(`${GOALS_BASE}/${id}/activate`, { headers: iH })).status()).toBe(
            404,
        );
        expect((await request.post(`${GOALS_BASE}/${id}/pause`, { headers: iH })).status()).toBe(
            404,
        );
        expect(
            (await request.post(`${GOALS_BASE}/${id}/evaluate-now`, { headers: iH })).status(),
        ).toBe(404);
        expect((await request.delete(`${GOALS_BASE}/${id}`, { headers: iH })).status()).toBe(404);
    });

    test("a foreign goal never appears in the caller's list", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const { id } = await createGoal(request, owner.access_token);
        const mine = await createGoal(request, intruder.access_token);

        const list = await request.get(GOALS_BASE, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(list.status()).toBe(200);
        const ids = (await list.json()).map((g: { id: string }) => g.id);
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(id);
    });
});

test.describe('Goals — Mission ↔ Goal links', () => {
    test('link a goal to a mission → 201 link dto with nested goal; list contains it; unlink → { deleted: true }', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const missionId = await createMission(request, user.access_token);
        const { id: goalId } = await createGoal(request, user.access_token);

        // Empty to start.
        const before = await request.get(`${MISSIONS_BASE}/${missionId}/goals`, { headers: H });
        expect(before.status()).toBe(200);
        expect(await before.json()).toEqual([]);

        const link = await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
            headers: H,
            data: { goalId, isPrimary: true },
        });
        expect(link.status()).toBe(201);
        const linkBody = await link.json();
        expect(linkBody.id).toMatch(UUID_RE);
        expect(linkBody.missionId).toBe(missionId);
        expect(linkBody.goalId).toBe(goalId);
        expect(linkBody.isPrimary).toBe(true);
        expect(linkBody.goal.id).toBe(goalId);

        const list = await request.get(`${MISSIONS_BASE}/${missionId}/goals`, { headers: H });
        const rows = await list.json();
        expect(rows.map((l: { goalId: string }) => l.goalId)).toContain(goalId);

        const unlink = await request.delete(`${MISSIONS_BASE}/${missionId}/goals/${goalId}`, {
            headers: H,
        });
        expect(unlink.status()).toBe(200);
        expect(await unlink.json()).toEqual({ deleted: true });

        // Unlinking again → 404.
        expect(
            (
                await request.delete(`${MISSIONS_BASE}/${missionId}/goals/${goalId}`, {
                    headers: H,
                })
            ).status(),
        ).toBe(404);
    });

    test('one-primary-per-mission: promoting a second primary demotes the first', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const missionId = await createMission(request, user.access_token);
        const { id: g1 } = await createGoal(request, user.access_token);
        const { id: g2 } = await createGoal(request, user.access_token);

        expect(
            (
                await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
                    headers: H,
                    data: { goalId: g1, isPrimary: true },
                })
            ).status(),
        ).toBe(201);
        expect(
            (
                await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
                    headers: H,
                    data: { goalId: g2, isPrimary: true },
                })
            ).status(),
        ).toBe(201);

        const rows = await (
            await request.get(`${MISSIONS_BASE}/${missionId}/goals`, { headers: H })
        ).json();
        const primaries = rows.filter((l: { isPrimary: boolean }) => l.isPrimary);
        expect(primaries.length).toBe(1);
        expect(primaries[0].goalId).toBe(g2);
    });

    test('re-linking an existing goal is idempotent (updates isPrimary only)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const missionId = await createMission(request, user.access_token);
        const { id: goalId } = await createGoal(request, user.access_token);

        const first = await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
            headers: H,
            data: { goalId, isPrimary: true },
        });
        expect(first.status()).toBe(201);
        const firstId = (await first.json()).id;

        const second = await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
            headers: H,
            data: { goalId, isPrimary: false },
        });
        expect(second.status()).toBe(201);
        const secondBody = await second.json();
        expect(secondBody.id).toBe(firstId); // same edge row
        expect(secondBody.isPrimary).toBe(false);

        const rows = await (
            await request.get(`${MISSIONS_BASE}/${missionId}/goals`, { headers: H })
        ).json();
        expect(rows.filter((l: { goalId: string }) => l.goalId === goalId).length).toBe(1);
    });

    test('link validation: unknown goal → 404, malformed goalId → 400, foreign mission → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const H = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token);
        const { id: goalId } = await createGoal(request, owner.access_token);

        const unknownGoal = await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
            headers: H,
            data: { goalId: UNKNOWN_UUID },
        });
        expect(unknownGoal.status()).toBe(404);
        expect(String((await unknownGoal.json()).message)).toMatch(/Goal not found/i);

        const badId = await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
            headers: H,
            data: { goalId: 'not-a-uuid' },
        });
        expect(badId.status()).toBe(400);

        // A different user cannot link to the owner's mission (mission ownership is 404-no-leak).
        const foreign = await request.post(`${MISSIONS_BASE}/${missionId}/goals`, {
            headers: authedHeaders(intruder.access_token),
            data: { goalId },
        });
        expect(foreign.status()).toBe(404);
    });
});
