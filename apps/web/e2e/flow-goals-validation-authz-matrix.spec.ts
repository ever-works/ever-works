/**
 * Goals & Metrics — VALIDATION + AUTHZ MATRIX (#1670, spec FR-9..FR-14).
 *
 * A field-by-field / route-by-route matrix over `POST` + `PATCH /api/me/goals`
 * and the Mission↔Goal link surface (`/api/me/missions/:id/goals`). Deliberately
 * DISTINCT from flow-goals-lifecycle-deep (happy CRUD, normalization, lifecycle
 * transitions, outcome semantics, link demotion/idempotency): this file exhausts
 * the negative space — one assertion cluster per DTO field with boundary values,
 * and the full authz/id-shape posture on every route.
 *
 * ── Contract pinned live (http://127.0.0.1:3100, sqlite in-memory, all flags ON):
 *
 *   CREATE (CreateGoalDto → GoalsService.create) — all → 400 unless noted:
 *     • title            missing / '' / 201-char / non-string(number|array); boundary 1..200 OK
 *     • description      10001-char / non-string; null & 10000-char OK
 *     • metricSource     missing|array → "metricSource must be an object." (service, string msg);
 *                        string|null|bool → ValidateNested "nested property ... object or array";
 *                        empty pluginId / missing metricId / pluginId>100 / metricId>200;
 *                        params non-object; JSON > 4000 chars → "metricSource is too large.";
 *                        a well-formed params object round-trips.
 *     • comparator       missing / not in {gte,lte}; both members OK
 *     • window           missing / not in {day,week,month,total,point}; all 5 members OK
 *     • targetValue      missing / string / bool / null; 0 / negative / float OK
 *     • unit             missing / '' / 33-char / non-string; boundary 1..32 OK
 *     • baselineValue    non-number → 400; number|null OK
 *     • deadline         non-ISO / '' → 400; ISO string | null OK (IsDateString)
 *     • checkFreq        0 (Min 1) / float(IsInt) → 400; <15 clamps to 15; >=15 preserved; default 60
 *     • forbidNonWhitelisted: any unknown property → 400 "property <x> should not exist"
 *
 *   PATCH (UpdateGoalDto) — same per-field rules; status is NOT writable
 *     ("property status should not exist"); outcome ∈ {achieved,missed,abandoned}|null;
 *     unknown id → 404, malformed id → 400 (ParseUUIDPipe), empty body {} → 200 no-op.
 *
 *   AUTHZ / id-shape (every route): no Bearer → 401; malformed :id → 400
 *     "Validation failed (uuid is expected)"; unknown uuid → 404 "Goal not found";
 *     another user's goal → 404 on EVERY route (404-never-403 no-leak posture).
 *
 *   LINK DTO (LinkMissionGoalDto): missing/malformed goalId → 400 "goalId must be a UUID";
 *     isPrimary non-bool → 400; unknown property → 400. Foreign/unknown goal → 404
 *     "Goal not found"; foreign/unknown mission → 404 "Mission not found"; unlink of a
 *     never-linked pair → 404 "Goal link not found"; every link route no-auth → 401.
 *
 * Fully API-orchestrated; a fresh registerUserViaAPI() owner per test (never the
 * shared seeded user). Verified against the live stack before every assertion.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const GOALS_BASE = `${API_BASE}/api/me/goals`;
const MISSIONS_BASE = `${API_BASE}/api/me/missions`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED_UUID = 'not-a-uuid';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Normalize a Nest error `message` (string | string[]) to one searchable string. */
function msg(body: { message?: unknown }): string {
    const m = body?.message;
    return Array.isArray(m) ? m.join(' | ') : String(m);
}

interface GoalOverrides {
    title?: unknown;
    description?: unknown;
    metricSource?: unknown;
    comparator?: unknown;
    targetValue?: unknown;
    unit?: unknown;
    window?: unknown;
    baselineValue?: unknown;
    deadline?: unknown;
    checkFrequencyMinutes?: unknown;
    [k: string]: unknown;
}

/** A valid CreateGoalDto body; override (or delete via `undefined`) any field. */
function goalPayload(overrides: GoalOverrides = {}): Record<string, unknown> {
    const base: Record<string, unknown> = {
        title: `Goal ${stamp()}`,
        metricSource: { pluginId: 'stripe', metricId: 'income' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'usd',
        window: 'month',
    };
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete base[k];
        else base[k] = v;
    }
    return base;
}

async function createGoal(
    request: APIRequestContext,
    token: string,
    overrides: GoalOverrides = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
    const res = await request.post(GOALS_BASE, {
        headers: authedHeaders(token),
        data: goalPayload(overrides),
    });
    expect(res.status(), `create goal body=${await res.text().catch(() => '')}`).toBe(201);
    const body = await res.json();
    return { id: body.id as string, body };
}

async function createMission(request: APIRequestContext, token: string): Promise<string> {
    const res = await request.post(MISSIONS_BASE, {
        headers: authedHeaders(token),
        data: { title: `Mission ${stamp()}`, description: 'matrix', type: 'one-shot' },
    });
    expect(res.status(), `create mission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

/** POST a create payload expected to fail validation; return {status, text-message}. */
async function postExpectingReject(
    request: APIRequestContext,
    token: string,
    overrides: GoalOverrides,
): Promise<{ status: number; message: string }> {
    const res = await request.post(GOALS_BASE, {
        headers: authedHeaders(token),
        data: goalPayload(overrides),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status(), message: msg(body) };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE — one assertion cluster per DTO field
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Goals — CREATE field-validation matrix', () => {
    test('title: missing / empty / >200 / non-string all → 400; 1- and 200-char boundaries OK', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const missing = await postExpectingReject(request, tok, { title: undefined });
        expect(missing.status).toBe(400);
        expect(missing.message).toContain('title must be a string');

        const empty = await postExpectingReject(request, tok, { title: '' });
        expect(empty.status).toBe(400);
        expect(empty.message).toContain('title must be longer than or equal to 1 characters');

        const tooLong = await postExpectingReject(request, tok, { title: 'x'.repeat(201) });
        expect(tooLong.status).toBe(400);
        expect(tooLong.message).toContain('title must be shorter than or equal to 200 characters');

        for (const bad of [123, ['a'], { a: 1 }]) {
            const r = await postExpectingReject(request, tok, { title: bad });
            expect(r.status, `title=${JSON.stringify(bad)}`).toBe(400);
            expect(r.message).toContain('title must be a string');
        }

        // Boundaries are accepted (and 200-char title is stored verbatim).
        const min = await createGoal(request, tok, { title: 'a' });
        expect(min.body.title).toBe('a');
        const max = await createGoal(request, tok, { title: 'x'.repeat(200) });
        expect(max.body.title).toBe('x'.repeat(200));
    });

    test('description: >10000 or non-string → 400; null and 10000-char boundary OK', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const tooLong = await postExpectingReject(request, tok, { description: 'd'.repeat(10001) });
        expect(tooLong.status).toBe(400);
        expect(tooLong.message).toContain(
            'description must be shorter than or equal to 10000 characters',
        );

        const nonString = await postExpectingReject(request, tok, { description: 42 });
        expect(nonString.status).toBe(400);
        expect(nonString.message).toContain('description must be a string');

        const nulled = await createGoal(request, tok, { description: null });
        expect(nulled.body.description).toBeNull();
        const boundary = await createGoal(request, tok, { description: 'd'.repeat(10000) });
        expect((boundary.body.description as string).length).toBe(10000);
    });

    test('metricSource object-shape: missing|array → service string msg, string|null|bool → ValidateNested', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        // Undefined & array reach the service guard (a plain-string message).
        for (const src of [undefined, []]) {
            const r = await postExpectingReject(request, tok, { metricSource: src });
            expect(r.status, `metricSource=${JSON.stringify(src)}`).toBe(400);
            expect(r.message).toBe('metricSource must be an object.');
        }
        // Non-object primitives are caught earlier by @ValidateNested.
        for (const src of ['stripe', null, true]) {
            const r = await postExpectingReject(request, tok, { metricSource: src });
            expect(r.status, `metricSource=${JSON.stringify(src)}`).toBe(400);
            expect(r.message).toContain(
                'nested property metricSource must be either object or array',
            );
        }
    });

    test('metricSource inner ids: empty pluginId / missing metricId / over-length → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const emptyPlugin = await postExpectingReject(request, tok, {
            metricSource: { pluginId: '', metricId: 'income' },
        });
        expect(emptyPlugin.status).toBe(400);
        expect(emptyPlugin.message).toContain(
            'metricSource.pluginId must be longer than or equal to 1 characters',
        );

        const missingMetric = await postExpectingReject(request, tok, {
            metricSource: { pluginId: 'stripe' },
        });
        expect(missingMetric.status).toBe(400);
        expect(missingMetric.message).toContain('metricSource.metricId must be a string');

        const longPlugin = await postExpectingReject(request, tok, {
            metricSource: { pluginId: 'p'.repeat(101), metricId: 'income' },
        });
        expect(longPlugin.status).toBe(400);
        expect(longPlugin.message).toContain(
            'metricSource.pluginId must be shorter than or equal to 100 characters',
        );

        const longMetric = await postExpectingReject(request, tok, {
            metricSource: { pluginId: 'stripe', metricId: 'm'.repeat(201) },
        });
        expect(longMetric.status).toBe(400);
        expect(longMetric.message).toContain(
            'metricSource.metricId must be shorter than or equal to 200 characters',
        );
    });

    test('metricSource.params: non-object → 400; oversized JSON (>4000) → DoS guard 400; object round-trips', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const arrParams = await postExpectingReject(request, tok, {
            metricSource: { pluginId: 'stripe', metricId: 'income', params: [1, 2] },
        });
        expect(arrParams.status).toBe(400);
        expect(arrParams.message).toContain('metricSource.params must be an object');

        const huge = await postExpectingReject(request, tok, {
            metricSource: {
                pluginId: 'stripe',
                metricId: 'income',
                params: { blob: 'y'.repeat(5000) },
            },
        });
        expect(huge.status).toBe(400);
        expect(huge.message).toBe('metricSource is too large.');

        const ok = await createGoal(request, tok, {
            metricSource: {
                pluginId: 'custom-http',
                metricId: 'balance',
                params: { acct: 'main' },
            },
        });
        expect(ok.body.metricSource).toEqual({
            pluginId: 'custom-http',
            metricId: 'balance',
            params: { acct: 'main' },
        });
    });

    test('comparator: missing or outside {gte,lte} → 400; both members accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        for (const bad of [undefined, 'eq', 'GTE', '', 3]) {
            const r = await postExpectingReject(request, tok, { comparator: bad });
            expect(r.status, `comparator=${JSON.stringify(bad)}`).toBe(400);
            expect(r.message).toContain('comparator must be one of the following values: gte, lte');
        }
        for (const good of ['gte', 'lte']) {
            const r = await createGoal(request, tok, { comparator: good });
            expect(r.body.comparator).toBe(good);
        }
    });

    test('window: missing or outside the 5-member enum → 400; all 5 members accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        for (const bad of [undefined, 'year', 'DAY', '', 1]) {
            const r = await postExpectingReject(request, tok, { window: bad });
            expect(r.status, `window=${JSON.stringify(bad)}`).toBe(400);
            expect(r.message).toContain(
                'window must be one of the following values: day, week, month, total, point',
            );
        }
        for (const good of ['day', 'week', 'month', 'total', 'point']) {
            const r = await createGoal(request, tok, { window: good });
            expect(r.body.window).toBe(good);
        }
    });

    test('targetValue: missing / string / bool / null → 400; 0, negative, and float accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        for (const bad of [undefined, '1000', true, null]) {
            const r = await postExpectingReject(request, tok, { targetValue: bad });
            expect(r.status, `targetValue=${JSON.stringify(bad)}`).toBe(400);
            expect(r.message).toContain(
                'targetValue must be a number conforming to the specified constraints',
            );
        }
        for (const good of [0, -100, 3.14]) {
            const r = await createGoal(request, tok, { targetValue: good });
            expect(r.body.targetValue).toBe(good);
        }
    });

    test('unit: missing / empty / >32 / non-string → 400; 1- and 32-char boundaries OK', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const missing = await postExpectingReject(request, tok, { unit: undefined });
        expect(missing.status).toBe(400);
        expect(missing.message).toContain('unit must be a string');

        const empty = await postExpectingReject(request, tok, { unit: '' });
        expect(empty.status).toBe(400);
        expect(empty.message).toContain('unit must be longer than or equal to 1 characters');

        const tooLong = await postExpectingReject(request, tok, { unit: 'u'.repeat(33) });
        expect(tooLong.status).toBe(400);
        expect(tooLong.message).toContain('unit must be shorter than or equal to 32 characters');

        const nonString = await postExpectingReject(request, tok, { unit: 5 });
        expect(nonString.status).toBe(400);
        expect(nonString.message).toContain('unit must be a string');

        const min = await createGoal(request, tok, { unit: 'c' });
        expect(min.body.unit).toBe('c');
        const max = await createGoal(request, tok, { unit: 'u'.repeat(32) });
        expect(max.body.unit).toBe('u'.repeat(32));
    });

    test('baselineValue: non-number → 400; a number or explicit null are accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const bad = await postExpectingReject(request, tok, { baselineValue: '5' });
        expect(bad.status).toBe(400);
        expect(bad.message).toContain(
            'baselineValue must be a number conforming to the specified constraints',
        );

        const num = await createGoal(request, tok, { baselineValue: 42.5 });
        expect(num.body.baselineValue).toBe(42.5);
        const nulled = await createGoal(request, tok, { baselineValue: null });
        expect(nulled.body.baselineValue).toBeNull();
    });

    test('deadline: non-ISO or empty string → 400; a valid ISO string or null are accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        for (const bad of ['not-a-date', '', '2026-13-40', 12345]) {
            const r = await postExpectingReject(request, tok, { deadline: bad });
            expect(r.status, `deadline=${JSON.stringify(bad)}`).toBe(400);
            expect(r.message).toContain('deadline must be a valid ISO 8601 date string');
        }
        const iso = await createGoal(request, tok, { deadline: '2027-01-01T00:00:00.000Z' });
        expect(iso.body.deadline).toBe('2027-01-01T00:00:00.000Z');
        const nulled = await createGoal(request, tok, { deadline: null });
        expect(nulled.body.deadline).toBeNull();
    });

    test('checkFrequencyMinutes: 0 (Min 1) and floats → 400; <15 clamps to 15; >=15 kept; default 60', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const zero = await postExpectingReject(request, tok, { checkFrequencyMinutes: 0 });
        expect(zero.status).toBe(400);
        expect(zero.message).toContain('checkFrequencyMinutes must not be less than 1');

        const float = await postExpectingReject(request, tok, { checkFrequencyMinutes: 30.5 });
        expect(float.status).toBe(400);
        expect(float.message).toContain('checkFrequencyMinutes must be an integer number');

        // 1..14 are valid ints but the service clamps the stored cadence to the 15-min floor.
        const clamped = await createGoal(request, tok, { checkFrequencyMinutes: 5 });
        expect(clamped.body.checkFrequencyMinutes).toBe(15);
        const kept = await createGoal(request, tok, { checkFrequencyMinutes: 45 });
        expect(kept.body.checkFrequencyMinutes).toBe(45);
        const boundary = await createGoal(request, tok, { checkFrequencyMinutes: 15 });
        expect(boundary.body.checkFrequencyMinutes).toBe(15);
        const def = await createGoal(request, tok, { checkFrequencyMinutes: undefined });
        expect(def.body.checkFrequencyMinutes).toBe(60);
    });

    test('forbidNonWhitelisted: an unknown property on the create body → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const r = await postExpectingReject(request, user.access_token, { bogusField: 'x' });
        expect(r.status).toBe(400);
        expect(r.message).toContain('property bogusField should not exist');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — the same field rules re-applied on partial update (distinct surface)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Goals — PATCH field-validation matrix', () => {
    async function patch(
        request: APIRequestContext,
        token: string,
        id: string,
        data: Record<string, unknown>,
    ): Promise<{ status: number; message: string; body: Record<string, unknown> }> {
        const res = await request.patch(`${GOALS_BASE}/${id}`, {
            headers: authedHeaders(token),
            data,
        });
        const body = await res.json().catch(() => ({}));
        return { status: res.status(), message: msg(body), body };
    }

    test('PATCH string fields: empty/over-length title & unit → 400; a valid patch persists', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const { id } = await createGoal(request, tok);

        expect((await patch(request, tok, id, { title: '' })).status).toBe(400);
        expect((await patch(request, tok, id, { title: 'x'.repeat(201) })).message).toContain(
            'title must be shorter than or equal to 200 characters',
        );
        expect((await patch(request, tok, id, { unit: '' })).status).toBe(400);
        expect((await patch(request, tok, id, { unit: 'u'.repeat(33) })).status).toBe(400);

        const ok = await patch(request, tok, id, { title: 'renamed', unit: 'eur' });
        expect(ok.status).toBe(200);
        expect(ok.body.title).toBe('renamed');
        expect(ok.body.unit).toBe('eur');
    });

    test('PATCH enum/number fields: bad comparator/window/targetValue → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const { id } = await createGoal(request, tok);

        expect((await patch(request, tok, id, { comparator: 'eq' })).message).toContain(
            'comparator must be one of the following values: gte, lte',
        );
        expect((await patch(request, tok, id, { window: 'year' })).message).toContain(
            'window must be one of the following values: day, week, month, total, point',
        );
        expect((await patch(request, tok, id, { targetValue: '9' })).message).toContain(
            'targetValue must be a number conforming to the specified constraints',
        );
        expect((await patch(request, tok, id, { baselineValue: 'x' })).status).toBe(400);
    });

    test('PATCH metricSource is re-validated: empty pluginId & missing metricId → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const { id } = await createGoal(request, tok);

        const emptyPlugin = await patch(request, tok, id, {
            metricSource: { pluginId: '', metricId: 'income' },
        });
        expect(emptyPlugin.status).toBe(400);
        expect(emptyPlugin.message).toContain(
            'metricSource.pluginId must be longer than or equal to 1 characters',
        );

        const missingMetric = await patch(request, tok, id, {
            metricSource: { pluginId: 'stripe' },
        });
        expect(missingMetric.status).toBe(400);
        expect(missingMetric.message).toContain('metricSource.metricId must be a string');
    });

    test('PATCH deadline & checkFrequencyMinutes: bad values → 400; sub-15 cadence clamps to 15', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const { id } = await createGoal(request, tok);

        expect((await patch(request, tok, id, { deadline: 'nope' })).message).toContain(
            'deadline must be a valid ISO 8601 date string',
        );
        expect((await patch(request, tok, id, { checkFrequencyMinutes: 0 })).status).toBe(400);
        expect((await patch(request, tok, id, { checkFrequencyMinutes: 12.5 })).status).toBe(400);

        const clamped = await patch(request, tok, id, { checkFrequencyMinutes: 3 });
        expect(clamped.status).toBe(200);
        expect(clamped.body.checkFrequencyMinutes).toBe(15);
    });

    test('PATCH outcome: invalid enum → 400; `status` is not writable (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const { id } = await createGoal(request, tok);

        const badOutcome = await patch(request, tok, id, { outcome: 'won' });
        expect(badOutcome.status).toBe(400);
        expect(badOutcome.message).toContain(
            'outcome must be one of the following values: achieved, missed, abandoned',
        );

        const status = await patch(request, tok, id, { status: 'active' });
        expect(status.status).toBe(400);
        expect(status.message).toContain('property status should not exist');

        const unknown = await patch(request, tok, id, { nope: 1 });
        expect(unknown.status).toBe(400);
        expect(unknown.message).toContain('property nope should not exist');
    });

    test('PATCH id-shape: unknown uuid → 404, malformed uuid → 400, empty body {} → 200 no-op', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const { id, body: created } = await createGoal(request, tok);

        const unknown = await patch(request, tok, UNKNOWN_UUID, { title: 'x' });
        expect(unknown.status).toBe(404);
        expect(unknown.message).toContain('Goal not found');

        const malformed = await patch(request, tok, MALFORMED_UUID, { title: 'x' });
        expect(malformed.status).toBe(400);
        expect(malformed.message).toContain('uuid is expected');

        const noop = await patch(request, tok, id, {});
        expect(noop.status).toBe(200);
        expect(noop.body.id).toBe(id);
        expect(noop.body.title).toBe(created.title);
        expect(noop.body.status).toBe('draft');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHZ + id-shape — the same posture proven on EVERY route
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Goals — authz & id-shape matrix (all routes)', () => {
    test('no Bearer token → 401 on every goals route (list/create/get/samples/patch/delete/lifecycle)', async ({
        request,
    }) => {
        const calls: Array<Promise<{ status: () => number }>> = [
            request.get(GOALS_BASE),
            request.post(GOALS_BASE, { data: goalPayload() }),
            request.get(`${GOALS_BASE}/${UNKNOWN_UUID}`),
            request.get(`${GOALS_BASE}/${UNKNOWN_UUID}/samples`),
            request.patch(`${GOALS_BASE}/${UNKNOWN_UUID}`, { data: { title: 'x' } }),
            request.delete(`${GOALS_BASE}/${UNKNOWN_UUID}`),
            request.post(`${GOALS_BASE}/${UNKNOWN_UUID}/activate`),
            request.post(`${GOALS_BASE}/${UNKNOWN_UUID}/pause`),
            request.post(`${GOALS_BASE}/${UNKNOWN_UUID}/evaluate-now`),
        ];
        const results = await Promise.all(calls);
        for (const res of results) {
            expect(res.status()).toBe(401);
        }
    });

    test('malformed :id → 400 (ParseUUIDPipe) on every parameterized route', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        const bad = `${GOALS_BASE}/${MALFORMED_UUID}`;
        const results = await Promise.all([
            request.get(bad, { headers: h }),
            request.get(`${bad}/samples`, { headers: h }),
            request.patch(bad, { headers: h, data: { title: 'x' } }),
            request.delete(bad, { headers: h }),
            request.post(`${bad}/activate`, { headers: h }),
            request.post(`${bad}/pause`, { headers: h }),
            request.post(`${bad}/evaluate-now`, { headers: h }),
        ]);
        for (const res of results) {
            expect(res.status()).toBe(400);
            expect(msg(await res.json().catch(() => ({})))).toContain('uuid is expected');
        }
    });

    test('well-formed but unknown uuid → 404 "Goal not found" on every parameterized route', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);
        const gone = `${GOALS_BASE}/${UNKNOWN_UUID}`;
        const results = await Promise.all([
            request.get(gone, { headers: h }),
            request.get(`${gone}/samples`, { headers: h }),
            request.patch(gone, { headers: h, data: { title: 'x' } }),
            request.delete(gone, { headers: h }),
            request.post(`${gone}/activate`, { headers: h }),
            request.post(`${gone}/pause`, { headers: h }),
            request.post(`${gone}/evaluate-now`, { headers: h }),
        ]);
        for (const res of results) {
            expect(res.status()).toBe(404);
            expect(msg(await res.json().catch(() => ({})))).toContain('Goal not found');
        }
    });

    test("cross-user isolation: another owner's goal is 404 on EVERY route (404-never-403 no-leak)", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        const { id } = await createGoal(request, owner.access_token);
        const h = authedHeaders(attacker.access_token);
        const url = `${GOALS_BASE}/${id}`;

        const results: Array<{
            label: string;
            res: { status: () => number; json: () => Promise<unknown> };
        }> = [
            { label: 'get', res: await request.get(url, { headers: h }) },
            { label: 'samples', res: await request.get(`${url}/samples`, { headers: h }) },
            {
                label: 'patch',
                res: await request.patch(url, { headers: h, data: { title: 'hijacked' } }),
            },
            { label: 'activate', res: await request.post(`${url}/activate`, { headers: h }) },
            { label: 'pause', res: await request.post(`${url}/pause`, { headers: h }) },
            {
                label: 'evaluate-now',
                res: await request.post(`${url}/evaluate-now`, { headers: h }),
            },
            { label: 'delete', res: await request.delete(url, { headers: h }) },
        ];
        for (const { label, res } of results) {
            expect(res.status(), `${label} must not leak (403) or succeed`).toBe(404);
            const body = (await res.json().catch(() => ({}))) as { message?: unknown };
            expect(msg(body)).toContain('Goal not found');
        }

        // And the goal is untouched + invisible to the attacker's own list.
        const ownerView = await request.get(url, { headers: authedHeaders(owner.access_token) });
        expect(ownerView.status()).toBe(200);
        expect((await ownerView.json()).status).toBe('draft');
        const attackerList = await request.get(GOALS_BASE, { headers: h });
        const ids = ((await attackerList.json()) as Array<{ id: string }>).map((g) => g.id);
        expect(ids).not.toContain(id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mission ↔ Goal links — LinkMissionGoalDto validation + link/unlink authz
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Goals ↔ Mission links — DTO validation & authz matrix', () => {
    test('LinkMissionGoalDto: missing/malformed goalId, non-bool isPrimary, unknown property → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const h = authedHeaders(tok);
        const missionId = await createMission(request, tok);
        const { id: goalId } = await createGoal(request, tok);
        const url = `${MISSIONS_BASE}/${missionId}/goals`;

        const missing = await request.post(url, { headers: h, data: { isPrimary: true } });
        expect(missing.status()).toBe(400);
        expect(msg(await missing.json())).toContain('goalId must be a UUID');

        const malformed = await request.post(url, { headers: h, data: { goalId: MALFORMED_UUID } });
        expect(malformed.status()).toBe(400);
        expect(msg(await malformed.json())).toContain('goalId must be a UUID');

        const badBool = await request.post(url, {
            headers: h,
            data: { goalId, isPrimary: 'yes' },
        });
        expect(badBool.status()).toBe(400);
        expect(msg(await badBool.json())).toContain('isPrimary must be a boolean value');

        const extra = await request.post(url, { headers: h, data: { goalId, bogus: 1 } });
        expect(extra.status()).toBe(400);
        expect(msg(await extra.json())).toContain('property bogus should not exist');
    });

    test('link resolves BOTH sides with 404-no-leak: unknown/foreign goal → 404 Goal, foreign/unknown mission → 404 Mission', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerH = authedHeaders(owner.access_token);
        const strangerH = authedHeaders(stranger.access_token);

        const missionId = await createMission(request, owner.access_token);
        const { id: goalId } = await createGoal(request, owner.access_token);
        const { id: foreignGoalId } = await createGoal(request, stranger.access_token);
        const missionGoalsUrl = `${MISSIONS_BASE}/${missionId}/goals`;

        // Valid mission, but a goal that isn't the owner's → Goal not found.
        const unknownGoal = await request.post(missionGoalsUrl, {
            headers: ownerH,
            data: { goalId: UNKNOWN_UUID },
        });
        expect(unknownGoal.status()).toBe(404);
        expect(msg(await unknownGoal.json())).toContain('Goal not found');

        const foreignGoal = await request.post(missionGoalsUrl, {
            headers: ownerH,
            data: { goalId: foreignGoalId },
        });
        expect(foreignGoal.status()).toBe(404);
        expect(msg(await foreignGoal.json())).toContain('Goal not found');

        // Owner's real goal but a mission the caller doesn't own (foreign / unknown) → Mission not found.
        const foreignMission = await request.post(missionGoalsUrl, {
            headers: strangerH,
            data: { goalId: foreignGoalId },
        });
        expect(foreignMission.status()).toBe(404);
        expect(msg(await foreignMission.json())).toContain('Mission not found');

        const unknownMission = await request.post(`${MISSIONS_BASE}/${UNKNOWN_UUID}/goals`, {
            headers: ownerH,
            data: { goalId },
        });
        expect(unknownMission.status()).toBe(404);
        expect(msg(await unknownMission.json())).toContain('Mission not found');
    });

    test('link route id-shapes: malformed mission id and malformed goalId param → 400 (ParseUUIDPipe)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const h = authedHeaders(tok);
        const missionId = await createMission(request, tok);
        const { id: goalId } = await createGoal(request, tok);

        const badMission = await request.post(`${MISSIONS_BASE}/${MALFORMED_UUID}/goals`, {
            headers: h,
            data: { goalId },
        });
        expect(badMission.status()).toBe(400);
        expect(msg(await badMission.json())).toContain('uuid is expected');

        const badListMission = await request.get(`${MISSIONS_BASE}/${MALFORMED_UUID}/goals`, {
            headers: h,
        });
        expect(badListMission.status()).toBe(400);

        // Unlink parses BOTH :id and :goalId — a malformed goalId path segment → 400.
        const badUnlinkGoal = await request.delete(
            `${MISSIONS_BASE}/${missionId}/goals/${MALFORMED_UUID}`,
            {
                headers: h,
            },
        );
        expect(badUnlinkGoal.status()).toBe(400);
        expect(msg(await badUnlinkGoal.json())).toContain('uuid is expected');
    });

    test('unlink of a never-linked (mission, goal) pair → 404 "Goal link not found"; link routes need auth (401)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const h = authedHeaders(tok);
        const missionId = await createMission(request, tok);
        const { id: goalId } = await createGoal(request, tok);

        const neverLinked = await request.delete(`${MISSIONS_BASE}/${missionId}/goals/${goalId}`, {
            headers: h,
        });
        expect(neverLinked.status()).toBe(404);
        expect(msg(await neverLinked.json())).toContain('Goal link not found');

        // Every link route rejects an anonymous caller before touching ownership.
        const anon = await Promise.all([
            request.get(`${MISSIONS_BASE}/${missionId}/goals`),
            request.post(`${MISSIONS_BASE}/${missionId}/goals`, { data: { goalId } }),
            request.delete(`${MISSIONS_BASE}/${missionId}/goals/${goalId}`),
        ]);
        for (const res of anon) {
            expect(res.status()).toBe(401);
        }
    });
});
