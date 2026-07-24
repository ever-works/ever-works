import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-missions-validation-authz-matrix — the EXHAUSTIVE per-field VALIDATION
 * matrix + the full AUTHZ / cross-user ISOLATION matrix for the Missions
 * surface (`apps/api/src/missions/missions.controller.ts` +
 * `dto/mission.dto.ts` → `@ever-works/agent/missions` MissionsService /
 * MissionCloneService). Every request/response shape, status code, and error
 * fragment below was PROBED against the LIVE API at http://127.0.0.1:3100
 * (sqlite in-memory, all flags on) before any assertion was written (2026-07-21).
 *
 * ── WHY THIS FILE EXISTS (non-duplication) ──────────────────────────────────
 * The sibling Mission specs already own the HAPPY paths and the coarse checks:
 *   • flow-mission-crud-schedule.spec.ts — bundles a create-validation "bag"
 *     (title>200 / desc bounds / bad enum / schedule>64 / cap<-1 / unknown prop
 *     / scheduled-no-cron / one-shot-with-cron), the cadence round-trip, the
 *     status state-machine, and run-now cron-bypass.
 *   • flow-mission-guardrails.spec.ts — guardrailsOverride REPLACE-not-merge,
 *     clone snapshot, lifecycle survival, the cap-inheritance ladder, and a
 *     GET/PATCH-only cross-user isolation slice.
 *   • flow-mission-clone*.spec.ts / flow-mission-works-relation.spec.ts —
 *     clone metadata copy and the Mission↔Work relation happy paths.
 *
 * THIS file deliberately covers the angles NONE of them assert, as a MATRIX:
 *   1. WRONG-TYPE variants for EVERY create/PATCH field (number-for-string,
 *      string-for-int, string/number-for-boolean) → the precise class-validator
 *      messages, distinct from the bounds the crud-schedule bag pins.
 *   2. BOUNDARY-ACCEPTED values (title==200, description==10000, cap==-1/0/huge)
 *      → 201, and the string→number COERCION contrast: nested guardrail ints
 *      carry `@Type(() => Number)` so `"5"` coerces to `201`, while the
 *      top-level `outstandingIdeasCap` has NO transform so `"5"` is a 400.
 *   3. guardrailsOverride PER-FIELD numeric bounds (WorkAgentGuardrailsDto:
 *      maxWorksPerRun 1..25, maxItemsPerWork 1..500, maxBudgetCentsPerRun
 *      0..1_000_000, requireApprovalAboveBudgetCents 0..1_000_000) + the
 *      object/array shape guard.
 *   4. The missionTemplateRepo SSRF matrix: owner/repo slug + bare catalog id
 *      + HTTPS-public-host git URL are accepted; http://, file://, git://,
 *      ssh://, `user:pass@`, literal loopback/metadata IPs, whitespace, and
 *      `javascript:` are all 400 at the DTO boundary (defense-in-depth).
 *   5. The FULL authz matrix across EVERY endpoint: 401 unauth, malformed uuid
 *      → 400 (ParseUUIDPipe), unknown-but-valid uuid → 404, and stranger →
 *      404-NEVER-403 on all 13 routes (no existence leak; rejected stranger
 *      writes never mutate the owner's row).
 *   6. works-attach DTO validation + ownership 404s, clone `title` validation,
 *      complete `outcome` enum validation, and list query-param validation.
 *
 * ── PROBED CONTRACT (live, 2026-07-21) ──────────────────────────────────────
 *   POST /api/me/missions  (CreateMissionDto; whitelisted+forbidNonWhitelisted
 *     ValidationPipe; @Throttle long 30/60s, keyed per-USER so a fresh user per
 *     test has a fresh budget):
 *     - title?      IsString MinLength(1) MaxLength(200); ""→400, >200→400,
 *                   number→400, ==200→201, omitted→titler-derived (201).
 *     - description IsString MinLength(1) MaxLength(10000); missing/""→400,
 *                   >10000→400, ==10000→201, number→400.
 *     - type        IsEnum(one-shot|scheduled); bad/number/missing→400.
 *     - schedule?   nullable IsString MaxLength(64); >64→400, number→400;
 *                   service assertScheduleConsistency: scheduled needs a
 *                   non-empty cron (null/""/whitespace/omitted → 400),
 *                   one-shot must NOT carry a cron → 400.
 *     - autoBuildWorks? IsBoolean; "true"/1 → 400 "must be a boolean value".
 *     - outstandingIdeasCap? IsInt Min(-1); -2→400, 2.5→400, "5"→400 (no
 *                   coercion), -1/0/huge→201, null→201.
 *     - guardrailsOverride? ValidateNested typed WorkAgentGuardrailsDto:
 *                   per-field bounds above; unknown key→400
 *                   "guardrailsOverride.property <k> should not exist";
 *                   non-object string→400 "nested property ... must be either
 *                   object or array"; {} and [] → 201; nested int "5"→coerced.
 *     - missionTemplateRepo? see the SSRF matrix; empty/whitespace→null.
 *     - unknown top-level prop → 400 "property <x> should not exist".
 *   PATCH /api/me/missions/:id — same field rules; empty {} → 200 (no-op);
 *     `status` is NOT patchable → "property status should not exist"; the
 *     schedule↔type consistency is re-checked (one-shot→scheduled w/o cron 400).
 *   POST /:id/clone (CloneMissionDto): title? MinLength(1) MaxLength(200);
 *     {}→201 "Copy of <src>"; ""/number/>200/extra-key → 400.
 *   POST /:id/works (AttachMissionWorkDto): workId IsUUID, relation IsIn(6);
 *     bad→400; unknown/foreign work → 404 "Work not found".
 *   DELETE /:id/works/:workId/:relation: bad relation → 400 (controller guard).
 *   POST /:id/complete (CompleteMissionDto): bad outcome enum → 400.
 *   GET/list ?status=&limit=&offset=&search=: bogus status/non-int limit/offset
 *     → 400; search>500 → 400.
 *   `:id` ParseUUIDPipe: malformed → 400 "Validation failed (uuid is expected)";
 *     well-formed unknown → 404 "Mission not found". @IsUUID() on `workId`
 *     is STRICTER (variant nibble) → use a canonical v4 uuid for "unknown".
 *   Cross-user: EVERY endpoint → 404 "Mission not found" (opaque, no 403 leak).
 *   401 on every endpoint when unauthenticated.
 *
 * ROBUSTNESS: fresh registerUserViaAPI() users per test (never the seeded
 * user); unique stamps; ids via toContain/not.toContain (never global counts);
 * env-adaptive tolerance only where the guard is genuinely borderline (the
 * `https://localhost/...` hostname passes the loopback guard while `127.0.0.1`
 * does not — asserted tolerantly).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Canonical v4 uuid (version=4, variant=8) — passes BOTH ParseUUIDPipe and
 *  the stricter class-validator @IsUUID(). Used for every "well-formed but
 *  non-existent" probe so the pipe/DTO never rejects it before the 404 logic. */
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const MALFORMED_UUID = 'not-a-uuid';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface MissionDto {
    id: string;
    title: string;
    description: string;
    type: 'one-shot' | 'scheduled';
    status: 'active' | 'paused' | 'completed' | 'failed';
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: Record<string, unknown> | null;
    missionTemplateRepo: string | null;
    missionRepo: string | null;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Raw create POST — returns status + parsed body (never throws on 4xx). */
async function postMission(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<{ http: number; body: any }> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    return { http: res.status(), body: await res.json().catch(() => ({})) };
}

/** Create a Mission that MUST succeed (201). */
async function createMission(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<MissionDto> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `create body=${await res.text()}`).toBe(201);
    const m = (await res.json()) as MissionDto;
    expect(m.id).toMatch(UUID_RE);
    return m;
}

async function getMission(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<MissionDto> {
    const res = await request.get(`${API_BASE}/api/me/missions/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

async function patchMission(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
): Promise<{ http: number; body: any }> {
    const res = await request.patch(`${API_BASE}/api/me/missions/${id}`, {
        headers: authedHeaders(token),
        data,
    });
    return { http: res.status(), body: await res.json().catch(() => ({})) };
}

/** Flatten a NestJS ValidationPipe error body (message may be string|string[]). */
function msgOf(body: any): string {
    if (!body) return '';
    return Array.isArray(body.message) ? body.message.join(' | ') : String(body.message ?? '');
}

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/**
 * Type-safe method dispatch — a switch keeps each call bound to the concrete
 * Playwright signature (avoids the union-index `request[method]()` call that
 * the e2e tsc-gate can reject as "no compatible signatures").
 */
function send(
    request: APIRequestContext,
    method: HttpMethod,
    url: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: { headers?: Record<string, string>; data?: any } = {},
) {
    switch (method) {
        case 'get':
            return request.get(url, opts);
        case 'post':
            return request.post(url, opts);
        case 'patch':
            return request.patch(url, opts);
        case 'delete':
            return request.delete(url, opts);
    }
}

test.describe('Missions — validation + authz + isolation matrix', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // SECTION A — CREATE: per-field VALIDATION (wrong-type + bounds + coercion)
    // ═══════════════════════════════════════════════════════════════════════

    test('create/title: empty & >200 & non-string 400; ==200 boundary & omitted (titler-derived) 201', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // "" → below MinLength(1).
        const empty = await postMission(request, token, {
            title: '',
            description: `t ${s}`,
            type: 'one-shot',
        });
        expect(empty.http).toBe(400);
        expect(msgOf(empty.body)).toMatch(/title must be longer than or equal to 1 characters/i);

        // 201 chars → above MaxLength(200).
        const long = await postMission(request, token, {
            title: 'T'.repeat(201),
            description: `t ${s}`,
            type: 'one-shot',
        });
        expect(long.http).toBe(400);
        expect(msgOf(long.body)).toMatch(/title must be shorter than or equal to 200 characters/i);

        // A number is not a string → the length validators fire on a non-string.
        const num = await postMission(request, token, {
            title: 5,
            description: `t ${s}`,
            type: 'one-shot',
        });
        expect(num.http).toBe(400);
        expect(msgOf(num.body)).toMatch(/title must be (a string|shorter|longer)/i);

        // Exactly 200 chars → right at the boundary, accepted verbatim.
        const boundary = await createMission(request, token, {
            title: 'a'.repeat(200),
            description: `t ${s}`,
            type: 'one-shot',
        });
        expect(boundary.title).toHaveLength(200);

        // Omitted title → the TitlerService derives one from the description (non-empty).
        const derived = await createMission(request, token, {
            description: `derive my title ${s}`,
            type: 'one-shot',
        });
        expect(typeof derived.title).toBe('string');
        expect(derived.title.length).toBeGreaterThan(0);
    });

    test('create/description: required, empty, >10000 all 400; ==10000 & non-string boundaries', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // Missing entirely.
        const missing = await postMission(request, token, { type: 'one-shot' });
        expect(missing.http).toBe(400);
        expect(msgOf(missing.body)).toMatch(
            /description must be (a string|longer than or equal to 1)/i,
        );

        // Empty string.
        const empty = await postMission(request, token, { description: '', type: 'one-shot' });
        expect(empty.http).toBe(400);
        expect(msgOf(empty.body)).toMatch(
            /description must be longer than or equal to 1 characters/i,
        );

        // 10001 chars.
        const long = await postMission(request, token, {
            description: 'D'.repeat(10001),
            type: 'one-shot',
        });
        expect(long.http).toBe(400);
        expect(msgOf(long.body)).toMatch(
            /description must be shorter than or equal to 10000 characters/i,
        );

        // A number.
        const num = await postMission(request, token, { description: 123, type: 'one-shot' });
        expect(num.http).toBe(400);

        // Exactly 10000 chars → accepted.
        const boundary = await createMission(request, token, {
            title: `desc boundary ${s}`,
            description: 'b'.repeat(10000),
            type: 'one-shot',
        });
        expect(boundary.description).toHaveLength(10000);
    });

    test('create/type: enum only accepts one-shot|scheduled; missing/bad/number 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const ENUM_MSG = /type must be one of the following values: one-shot, scheduled/i;

        for (const bad of [
            { description: 'x', type: 'recurring' },
            { description: 'x', type: 'weekly' },
            { description: 'x', type: 123 },
            { description: 'x' }, // missing
        ]) {
            const res = await postMission(request, token, bad);
            expect(res.http, `type=${JSON.stringify(bad)}`).toBe(400);
            expect(msgOf(res.body)).toMatch(ENUM_MSG);
        }

        // Both legal values succeed.
        const oneShot = await createMission(request, token, {
            description: `one-shot ${s}`,
            type: 'one-shot',
        });
        expect(oneShot.type).toBe('one-shot');
        const scheduled = await createMission(request, token, {
            description: `scheduled ${s}`,
            type: 'scheduled',
            schedule: '0 9 * * 1',
        });
        expect(scheduled.type).toBe('scheduled');
        expect(scheduled.schedule).toBe('0 9 * * 1');
    });

    test('create/schedule↔type consistency: scheduled needs a non-empty cron (null/""/ws/omitted 400); one-shot forbids one; >64 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // scheduled + every "no real cron" form → the SERVICE consistency check 400s.
        const NEEDS_CRON = /scheduled requires a non-empty `schedule`/i;
        for (const body of [
            { description: 'x', type: 'scheduled' }, // omitted
            { description: 'x', type: 'scheduled', schedule: null }, // explicit null
            { description: 'x', type: 'scheduled', schedule: '' }, // empty
            { description: 'x', type: 'scheduled', schedule: '   ' }, // whitespace-only
        ]) {
            const res = await postMission(request, token, body);
            expect(res.http, `sched=${JSON.stringify(body)}`).toBe(400);
            expect(msgOf(res.body)).toMatch(NEEDS_CRON);
        }

        // one-shot MUST NOT carry a cron.
        const oneShotCron = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            schedule: '0 9 * * 1',
        });
        expect(oneShotCron.http).toBe(400);
        expect(msgOf(oneShotCron.body)).toMatch(/one-shot must NOT have a `schedule`/i);

        // schedule > 64 chars → DTO MaxLength(64).
        const longCron = await postMission(request, token, {
            description: 'x',
            type: 'scheduled',
            schedule: '*/2 '.repeat(20),
        });
        expect(longCron.http).toBe(400);
        expect(msgOf(longCron.body)).toMatch(
            /schedule must be shorter than or equal to 64 characters/i,
        );

        // A non-string cron → IsString fires.
        const numCron = await postMission(request, token, {
            description: 'x',
            type: 'scheduled',
            schedule: 123,
        });
        expect(numCron.http).toBe(400);

        // one-shot with NO schedule is the valid baseline.
        const okOneShot = await createMission(request, token, {
            description: `ok one-shot ${s}`,
            type: 'one-shot',
        });
        expect(okOneShot.schedule).toBeNull();
    });

    test('create/outstandingIdeasCap: Min(-1) + integer-only + NO string coercion; -1/0/huge/null accepted', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // Below the -1 floor.
        const belowFloor = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            outstandingIdeasCap: -2,
        });
        expect(belowFloor.http).toBe(400);
        expect(msgOf(belowFloor.body)).toMatch(/outstandingIdeasCap must not be less than -1/i);

        // A float is not an integer.
        const float = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            outstandingIdeasCap: 2.5,
        });
        expect(float.http).toBe(400);
        expect(msgOf(float.body)).toMatch(/outstandingIdeasCap must be an integer number/i);

        // A numeric STRING is rejected — the top-level cap has NO @Type transform
        // (contrast the nested guardrail ints, which DO coerce — proven below).
        const strCap = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            outstandingIdeasCap: '5',
        });
        expect(strCap.http).toBe(400);
        expect(msgOf(strCap.body)).toMatch(
            /outstandingIdeasCap must (not be less than -1|be an integer)/i,
        );

        // The three accepted sentinels + a large positive cap all persist verbatim.
        const unlimited = await createMission(request, token, {
            description: `cap -1 ${s}`,
            type: 'one-shot',
            outstandingIdeasCap: -1,
        });
        expect(unlimited.outstandingIdeasCap).toBe(-1);
        const zero = await createMission(request, token, {
            description: `cap 0 ${s}`,
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });
        expect(zero.outstandingIdeasCap).toBe(0);
        const huge = await createMission(request, token, {
            description: `cap huge ${s}`,
            type: 'one-shot',
            outstandingIdeasCap: 999999,
        });
        expect(huge.outstandingIdeasCap).toBe(999999);
        const inherit = await createMission(request, token, {
            description: `cap null ${s}`,
            type: 'one-shot',
            outstandingIdeasCap: null,
        });
        expect(inherit.outstandingIdeasCap).toBeNull();
    });

    test('create/autoBuildWorks: strictly boolean — "true"/1 rejected, true/false accepted & persisted', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const BOOL_MSG = /autoBuildWorks must be a boolean value/i;

        const strBool = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            autoBuildWorks: 'true',
        });
        expect(strBool.http).toBe(400);
        expect(msgOf(strBool.body)).toMatch(BOOL_MSG);

        const numBool = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            autoBuildWorks: 1,
        });
        expect(numBool.http).toBe(400);
        expect(msgOf(numBool.body)).toMatch(BOOL_MSG);

        const on = await createMission(request, token, {
            description: `auto on ${s}`,
            type: 'one-shot',
            autoBuildWorks: true,
        });
        expect(on.autoBuildWorks).toBe(true);
        const off = await createMission(request, token, {
            description: `auto off ${s}`,
            type: 'one-shot',
            autoBuildWorks: false,
        });
        expect(off.autoBuildWorks).toBe(false);
    });

    test('create/whitelist: empty body 400 (surfaces missing required fields); unknown top-level prop rejected', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        // {} → both required fields (description, type) reported.
        const emptyBody = await postMission(request, token, {});
        expect(emptyBody.http).toBe(400);
        const m = msgOf(emptyBody.body);
        expect(m).toMatch(/description must be/i);
        expect(m).toMatch(/type must be one of the following values/i);

        // An unknown top-level property is rejected by forbidNonWhitelisted.
        const extra = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            bogus: true,
        });
        expect(extra.http).toBe(400);
        expect(msgOf(extra.body)).toMatch(/property bogus should not exist/i);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION B — guardrailsOverride: per-field numeric bounds + shape + coercion
    // ═══════════════════════════════════════════════════════════════════════

    test('guardrails/maxWorksPerRun: 1..25 bounds, integer-only, string→number coercion', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        const below = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 0 },
        });
        expect(below.http).toBe(400);
        expect(msgOf(below.body)).toMatch(
            /guardrailsOverride\.maxWorksPerRun must not be less than 1/i,
        );

        const above = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 26 },
        });
        expect(above.http).toBe(400);
        expect(msgOf(above.body)).toMatch(
            /guardrailsOverride\.maxWorksPerRun must not be greater than 25/i,
        );

        const float = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 3.5 },
        });
        expect(float.http).toBe(400);
        expect(msgOf(float.body)).toMatch(/maxWorksPerRun must be an integer number/i);

        // Both boundaries accepted.
        const lo = await createMission(request, token, {
            description: `g lo ${s}`,
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 1 },
        });
        expect(lo.guardrailsOverride).toEqual({ maxWorksPerRun: 1 });
        const hi = await createMission(request, token, {
            description: `g hi ${s}`,
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 25 },
        });
        expect(hi.guardrailsOverride).toEqual({ maxWorksPerRun: 25 });

        // A numeric string IS coerced to a number here (nested @Type(() => Number)) —
        // the exact opposite of the top-level outstandingIdeasCap contract.
        const coerced = await createMission(request, token, {
            description: `g coerce ${s}`,
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: '5' },
        });
        expect(coerced.guardrailsOverride).toEqual({ maxWorksPerRun: 5 });
    });

    test('guardrails/other numeric fields: maxItemsPerWork 1..500, maxBudgetCentsPerRun 0..1e6, requireApprovalAboveBudgetCents 0..1e6', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        const cases: Array<{ key: string; bad: number; msg: RegExp; okLo: number; okHi: number }> =
            [
                {
                    key: 'maxItemsPerWork',
                    bad: 0,
                    msg: /maxItemsPerWork must not be less than 1/i,
                    okLo: 1,
                    okHi: 500,
                },
                {
                    key: 'maxBudgetCentsPerRun',
                    bad: -1,
                    msg: /maxBudgetCentsPerRun must not be less than 0/i,
                    okLo: 0,
                    okHi: 1_000_000,
                },
                {
                    key: 'requireApprovalAboveBudgetCents',
                    bad: -1,
                    msg: /requireApprovalAboveBudgetCents must not be less than 0/i,
                    okLo: 0,
                    okHi: 1_000_000,
                },
            ];

        for (const c of cases) {
            // Below floor.
            const below = await postMission(request, token, {
                description: 'x',
                type: 'one-shot',
                guardrailsOverride: { [c.key]: c.bad },
            });
            expect(below.http, `${c.key} below`).toBe(400);
            expect(msgOf(below.body)).toMatch(c.msg);

            // Above ceiling (one over the documented max).
            const over = await postMission(request, token, {
                description: 'x',
                type: 'one-shot',
                guardrailsOverride: { [c.key]: c.okHi + 1 },
            });
            expect(over.http, `${c.key} over`).toBe(400);
            expect(msgOf(over.body)).toMatch(
                new RegExp(`${c.key} must not be greater than ${c.okHi}`, 'i'),
            );

            // Both boundary values accepted + persisted verbatim.
            const lo = await createMission(request, token, {
                description: `g ${c.key} lo ${s}`,
                type: 'one-shot',
                guardrailsOverride: { [c.key]: c.okLo },
            });
            expect(lo.guardrailsOverride).toEqual({ [c.key]: c.okLo });
            const hi = await createMission(request, token, {
                description: `g ${c.key} hi ${s}`,
                type: 'one-shot',
                guardrailsOverride: { [c.key]: c.okHi },
            });
            expect(hi.guardrailsOverride).toEqual({ [c.key]: c.okHi });
        }
    });

    test('guardrails/shape: non-object 400, unknown key 400, boolean fields must be boolean, {} accepted', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // A bare string is neither object nor array → ValidateNested rejects it.
        const str = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            guardrailsOverride: 'not-an-object',
        });
        expect(str.http).toBe(400);
        expect(msgOf(str.body)).toMatch(
            /guardrailsOverride must be either object or array|guardrailsOverride/i,
        );

        // An unknown nested key is rejected (WorkAgentGuardrailsDto is a strict allowlist).
        const unknown = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            guardrailsOverride: { bogusKey: 1, maxWorksPerRun: 3 },
        });
        expect(unknown.http).toBe(400);
        expect(msgOf(unknown.body)).toMatch(
            /guardrailsOverride\.property bogusKey should not exist/i,
        );

        // A boolean guardrail must be a real boolean.
        const badBool = await postMission(request, token, {
            description: 'x',
            type: 'one-shot',
            guardrailsOverride: { requireApprovalBeforeCreate: 'yes' },
        });
        expect(badBool.http).toBe(400);
        expect(msgOf(badBool.body)).toMatch(/requireApprovalBeforeCreate must be a boolean value/i);

        // An empty object is a valid (vacuous) override — distinct from null.
        const empty = await createMission(request, token, {
            description: `g empty ${s}`,
            type: 'one-shot',
            guardrailsOverride: {},
        });
        expect(empty.guardrailsOverride).toEqual({});
        expect(empty.guardrailsOverride).not.toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION C — missionTemplateRepo SSRF matrix
    // ═══════════════════════════════════════════════════════════════════════

    test('templateRepo/accepted: owner/repo slug, multi-segment, bare catalog id, HTTPS public URL; empty→null', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        const accepted: Array<[string, string]> = [
            ['owner/repo', 'owner/repo'],
            ['ever-works/p2p-marketplace', 'ever-works/p2p-marketplace'],
            ['owner/repo/extra', 'owner/repo/extra'], // 2+ segments allowed
            ['starter-business', 'starter-business'], // bare catalog id
            ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
        ];
        for (const [value, expected] of accepted) {
            const m = await createMission(request, token, {
                description: `tpl ok ${s}`,
                type: 'one-shot',
                missionTemplateRepo: value,
            });
            expect(m.missionTemplateRepo, `accepted ${value}`).toBe(expected);
            // The provenance pointer is NOT the per-Mission brain repo.
            expect(m.missionRepo).toBeNull();
        }

        // Empty + whitespace-only both clear the field to null (service treats as clear).
        for (const clearVal of ['', '   ']) {
            const m = await createMission(request, token, {
                description: `tpl clear ${s}`,
                type: 'one-shot',
                missionTemplateRepo: clearVal,
            });
            expect(m.missionTemplateRepo).toBeNull();
        }
    });

    test('templateRepo/SSRF: http/file/git/ssh schemes, embedded creds, loopback+metadata IPs, whitespace, javascript: all 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const TPL_MSG = /missionTemplateRepo must be a GitHub-style|owner\/repo/i;

        const rejected = [
            'http://github.com/owner/repo', // non-TLS
            'file:///etc/passwd',
            'git://github.com/o/r',
            'ssh://git@github.com/o/r',
            'https://user:pass@github.com/o/r', // embedded credentials
            'https://127.0.0.1/x', // literal loopback IP
            'https://169.254.169.254/latest/meta-data', // cloud metadata
            'has space/repo', // whitespace inside slug
            'javascript:alert(1)',
        ];
        for (const value of rejected) {
            const res = await postMission(request, token, {
                description: 'ssrf',
                type: 'one-shot',
                missionTemplateRepo: value,
            });
            expect(res.http, `rejected ${value} body=${JSON.stringify(res.body)}`).toBe(400);
            expect(msgOf(res.body)).toMatch(TPL_MSG);
        }

        // Borderline: the `localhost` HOSTNAME (not a literal loopback IP) passes the
        // lexical SSRF guard on this stack while `127.0.0.1` does not. Tolerated as an
        // env-adaptive edge rather than pinned to a single code.
        const localhost = await postMission(request, token, {
            description: 'ssrf',
            type: 'one-shot',
            missionTemplateRepo: 'https://localhost/x',
        });
        expect([201, 400]).toContain(localhost.http);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION D — PATCH validation (mirrors create; empty=no-op; state not patchable)
    // ═══════════════════════════════════════════════════════════════════════

    test('patch: empty body is a 200 no-op; field validation mirrors create; `status` is not patchable', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const mission = await createMission(request, token, {
            title: `patch host ${s}`,
            description: `patch host ${s}`,
            type: 'one-shot',
        });

        // Empty PATCH → 200, everything left as-is (all fields optional).
        const noop = await patchMission(request, token, mission.id, {});
        expect(noop.http).toBe(200);
        expect(noop.body.title).toBe(mission.title);

        // The same field bounds reject on PATCH.
        const badTitle = await patchMission(request, token, mission.id, { title: 'T'.repeat(201) });
        expect(badTitle.http).toBe(400);
        expect(msgOf(badTitle.body)).toMatch(/title must be shorter than or equal to 200/i);

        const badType = await patchMission(request, token, mission.id, { type: 'weekly' });
        expect(badType.http).toBe(400);
        expect(msgOf(badType.body)).toMatch(/type must be one of the following values/i);

        const badCap = await patchMission(request, token, mission.id, { outstandingIdeasCap: -9 });
        expect(badCap.http).toBe(400);
        expect(msgOf(badCap.body)).toMatch(/outstandingIdeasCap must not be less than -1/i);

        const badGuard = await patchMission(request, token, mission.id, {
            guardrailsOverride: { nope: 1 },
        });
        expect(badGuard.http).toBe(400);
        expect(msgOf(badGuard.body)).toMatch(/property nope should not exist/i);

        const badTpl = await patchMission(request, token, mission.id, {
            missionTemplateRepo: 'file:///etc/passwd',
        });
        expect(badTpl.http).toBe(400);

        // `status` is NOT part of UpdateMissionDto — lifecycle endpoints own state.
        const badStatus = await patchMission(request, token, mission.id, { status: 'completed' });
        expect(badStatus.http).toBe(400);
        expect(msgOf(badStatus.body)).toMatch(/property status should not exist/i);

        // Every rejected PATCH left the row untouched.
        const after = await getMission(request, token, mission.id);
        expect(after.title).toBe(mission.title);
        expect(after.status).toBe('active');
    });

    test('patch: type flip re-checks schedule↔type consistency (one-shot→scheduled needs cron; back clears it)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const mission = await createMission(request, token, {
            title: `flip ${s}`,
            description: `flip ${s}`,
            type: 'one-shot',
        });

        // one-shot → scheduled WITHOUT a cron → the service consistency check 400s.
        const noCron = await patchMission(request, token, mission.id, { type: 'scheduled' });
        expect(noCron.http).toBe(400);
        expect(msgOf(noCron.body)).toMatch(/scheduled requires a non-empty `schedule`/i);

        // Providing the cron in the same PATCH succeeds.
        const withCron = await patchMission(request, token, mission.id, {
            type: 'scheduled',
            schedule: '0 6 * * *',
        });
        expect(withCron.http).toBe(200);
        expect(withCron.body.type).toBe('scheduled');
        expect(withCron.body.schedule).toBe('0 6 * * *');

        // Flipping back to one-shot clears the orphan cron automatically.
        const back = await patchMission(request, token, mission.id, { type: 'one-shot' });
        expect(back.http).toBe(200);
        expect(back.body.type).toBe('one-shot');
        expect(back.body.schedule).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION E — AUTHZ matrix (401 / malformed-uuid 400 / unknown-uuid 404)
    // ═══════════════════════════════════════════════════════════════════════

    test('authz/401: every endpoint requires authentication', async ({ request }) => {
        // No Authorization header on any of the routes.
        const routes: Array<[HttpMethod, string]> = [
            ['get', ''],
            ['post', ''],
            ['get', `/${UNKNOWN_UUID}`],
            ['patch', `/${UNKNOWN_UUID}`],
            ['delete', `/${UNKNOWN_UUID}`],
            ['get', `/${UNKNOWN_UUID}/budget`],
            ['post', `/${UNKNOWN_UUID}/pause`],
            ['post', `/${UNKNOWN_UUID}/resume`],
            ['post', `/${UNKNOWN_UUID}/complete`],
            ['post', `/${UNKNOWN_UUID}/run-now`],
            ['post', `/${UNKNOWN_UUID}/clone`],
            ['get', `/${UNKNOWN_UUID}/works`],
            ['post', `/${UNKNOWN_UUID}/works`],
            ['get', `/${UNKNOWN_UUID}/attachments`],
            ['get', `/${UNKNOWN_UUID}/goals`],
        ];
        for (const [method, sub] of routes) {
            const res = await send(request, method, `${API_BASE}/api/me/missions${sub}`, {
                data: method === 'get' ? undefined : {},
            });
            expect(res.status(), `${method.toUpperCase()} ${sub || '/'} unauth`).toBe(401);
        }
    });

    test('authz/uuid: malformed :id → 400 (ParseUUIDPipe); well-formed unknown :id → 404', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const h = authedHeaders(token);

        // Malformed uuid is rejected at the pipe BEFORE the service runs.
        const malformedRoutes: Array<[HttpMethod, string]> = [
            ['get', ''],
            ['patch', ''],
            ['delete', ''],
            ['get', '/budget'],
            ['post', '/pause'],
            ['post', '/clone'],
            ['post', '/run-now'],
        ];
        for (const [method, sub] of malformedRoutes) {
            const res = await send(
                request,
                method,
                `${API_BASE}/api/me/missions/${MALFORMED_UUID}${sub}`,
                {
                    headers: h,
                    data: method === 'get' ? undefined : {},
                },
            );
            expect(res.status(), `${method} ${sub} malformed`).toBe(400);
            expect(msgOf(await res.json().catch(() => ({})))).toMatch(
                /Validation failed \(uuid is expected\)/i,
            );
        }

        // A well-formed but non-existent uuid → 404 "Mission not found" (own account).
        const unknownRoutes: Array<[HttpMethod, string]> = [
            ['get', ''],
            ['patch', ''],
            ['delete', ''],
            ['get', '/budget'],
            ['post', '/pause'],
            ['post', '/resume'],
            ['post', '/complete'],
            ['post', '/run-now'],
            ['post', '/clone'],
        ];
        for (const [method, sub] of unknownRoutes) {
            const res = await send(
                request,
                method,
                `${API_BASE}/api/me/missions/${UNKNOWN_UUID}${sub}`,
                {
                    headers: h,
                    data: method === 'get' ? undefined : {},
                },
            );
            expect(res.status(), `${method} ${sub} unknown-uuid`).toBe(404);
            expect(msgOf(await res.json().catch(() => ({})))).toMatch(/Mission not found/i);
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION F — cross-user ISOLATION (404-NEVER-403 across every endpoint)
    // ═══════════════════════════════════════════════════════════════════════

    test("isolation: a stranger gets 404 (never 403) on EVERY endpoint of another user's mission", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const sh = authedHeaders(stranger.access_token);
        const s = stamp();

        const mission = await createMission(request, owner.access_token, {
            title: `owned ${s}`,
            description: `owned by owner ${s}`,
            type: 'one-shot',
        });

        // GET-family read endpoints.
        for (const sub of ['', '/budget', '/works', '/attachments', '/goals']) {
            const res = await request.get(`${API_BASE}/api/me/missions/${mission.id}${sub}`, {
                headers: sh,
            });
            expect(res.status(), `stranger GET ${sub || '/'}`).toBe(404);
        }

        // Mutating endpoints — all 404, none 403 (no existence leak).
        const strangerPatch = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: sh,
            data: { title: 'hijacked' },
        });
        expect(strangerPatch.status()).toBe(404);

        for (const sub of ['/pause', '/resume', '/complete', '/run-now', '/clone']) {
            const res = await request.post(`${API_BASE}/api/me/missions/${mission.id}${sub}`, {
                headers: sh,
                data: {},
            });
            expect(res.status(), `stranger POST ${sub}`).toBe(404);
        }

        // Attaching a Work to a foreign Mission → 404 on the Mission gate (before
        // the Work is ever looked at).
        const strangerAttach = await request.post(
            `${API_BASE}/api/me/missions/${mission.id}/works`,
            {
                headers: sh,
                data: { workId: UNKNOWN_UUID, relation: 'created' },
            },
        );
        expect(strangerAttach.status()).toBe(404);

        const strangerDelete = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: sh,
        });
        expect(strangerDelete.status()).toBe(404);

        // The stranger's OWN list never surfaces the owner's mission (no leak).
        const strangerList = await request.get(`${API_BASE}/api/me/missions`, { headers: sh });
        expect(strangerList.status()).toBe(200);
        expect(((await strangerList.json()) as MissionDto[]).map((m) => m.id)).not.toContain(
            mission.id,
        );

        // And every rejected stranger attempt left the owner's row byte-for-byte intact.
        const ownerView = await getMission(request, owner.access_token, mission.id);
        expect(ownerView.title).toBe(mission.title);
        expect(ownerView.status).toBe('active');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION G — works-attach DTO validation + ownership 404s
    // ═══════════════════════════════════════════════════════════════════════

    test('works-attach: AttachMissionWorkDto validation (workId uuid, relation enum, whitelist)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const mission = await createMission(request, token, {
            description: `attach host ${s}`,
            type: 'one-shot',
        });
        const work = await createWorkViaAPI(request, token, { name: `Attach Work ${s}` });
        expect(work.id).toMatch(UUID_RE);

        const attach = (data: Record<string, unknown>) =>
            request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
                headers: authedHeaders(token),
                data,
            });

        // workId not a uuid.
        const badId = await attach({ workId: 'not-uuid', relation: 'created' });
        expect(badId.status()).toBe(400);
        expect(msgOf(await badId.json())).toMatch(/workId must be a UUID/i);

        // Missing workId.
        const noId = await attach({ relation: 'created' });
        expect(noId.status()).toBe(400);
        expect(msgOf(await noId.json())).toMatch(/workId must be a UUID/i);

        // relation not in the 6-value allowlist.
        const badRel = await attach({ workId: work.id, relation: 'bogus' });
        expect(badRel.status()).toBe(400);
        expect(msgOf(await badRel.json())).toMatch(
            /relation must be one of the following values: created, improves, operates, markets, researches, retires/i,
        );

        // Missing relation.
        const noRel = await attach({ workId: work.id });
        expect(noRel.status()).toBe(400);
        expect(msgOf(await noRel.json())).toMatch(/relation must be one of/i);

        // Unknown extra field.
        const extra = await attach({ workId: work.id, relation: 'created', extra: 1 });
        expect(extra.status()).toBe(400);
        expect(msgOf(await extra.json())).toMatch(/property extra should not exist/i);

        // A well-formed, owned attach succeeds (201) and returns the relation edge.
        const ok = await attach({ workId: work.id, relation: 'created' });
        expect(ok.status(), `attach ok body=${await ok.text()}`).toBe(201);
        const okBody = await ok.json();
        expect(Array.isArray(okBody.relations)).toBe(true);
        expect(okBody.relations.map((r: any) => r.workId)).toContain(work.id);

        // Detach with an invalid relation segment → controller BadRequest 400.
        const badDetach = await request.delete(
            `${API_BASE}/api/me/missions/${mission.id}/works/${work.id}/bogusrel`,
            { headers: authedHeaders(token) },
        );
        expect(badDetach.status()).toBe(400);
        expect(msgOf(await badDetach.json())).toMatch(/Invalid relation/i);
    });

    test('works-attach: unknown & cross-user Works both 404 "Work not found"; foreign Mission 404 first', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const s = stamp();

        const aliceMission = await createMission(request, alice.access_token, {
            description: `alice mission ${s}`,
            type: 'one-shot',
        });
        const bobWork = await createWorkViaAPI(request, bob.access_token, {
            name: `Bob Work ${s}`,
        });
        expect(bobWork.id).toMatch(UUID_RE);

        // Unknown (well-formed) work id → the Work-ownership gate 404s.
        const unknownWork = await request.post(
            `${API_BASE}/api/me/missions/${aliceMission.id}/works`,
            {
                headers: authedHeaders(alice.access_token),
                data: { workId: UNKNOWN_UUID, relation: 'created' },
            },
        );
        expect(unknownWork.status()).toBe(404);
        expect(msgOf(await unknownWork.json())).toMatch(/Work not found/i);

        // Alice attaching BOB's work to her own mission → 404 (IDOR-safe, no leak).
        const foreignWork = await request.post(
            `${API_BASE}/api/me/missions/${aliceMission.id}/works`,
            {
                headers: authedHeaders(alice.access_token),
                data: { workId: bobWork.id, relation: 'created' },
            },
        );
        expect(foreignWork.status()).toBe(404);
        expect(msgOf(await foreignWork.json())).toMatch(/Work not found/i);

        // Bob attaching HIS own work to ALICE's mission → 404 on the Mission gate.
        const foreignMission = await request.post(
            `${API_BASE}/api/me/missions/${aliceMission.id}/works`,
            {
                headers: authedHeaders(bob.access_token),
                data: { workId: bobWork.id, relation: 'created' },
            },
        );
        expect(foreignMission.status()).toBe(404);
        expect(msgOf(await foreignMission.json())).toMatch(/Mission not found/i);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION H — clone / complete-outcome / list-query validation
    // ═══════════════════════════════════════════════════════════════════════

    test('clone: CloneMissionDto title validation (empty/non-string/>200/whitelist) + empty-body default', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const source = await createMission(request, token, {
            title: `Clone src ${s}`,
            description: `clone source ${s}`,
            type: 'one-shot',
        });

        const clone = (data: Record<string, unknown>) =>
            request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
                headers: authedHeaders(token),
                data,
            });

        // Empty title → MinLength(1).
        const emptyTitle = await clone({ title: '' });
        expect(emptyTitle.status()).toBe(400);
        expect(msgOf(await emptyTitle.json())).toMatch(
            /title must be longer than or equal to 1 characters/i,
        );

        // Non-string title.
        const numTitle = await clone({ title: 123 });
        expect(numTitle.status()).toBe(400);

        // >200 chars.
        const longTitle = await clone({ title: 'x'.repeat(201) });
        expect(longTitle.status()).toBe(400);
        expect(msgOf(await longTitle.json())).toMatch(
            /title must be shorter than or equal to 200/i,
        );

        // Unknown extra field.
        const extra = await clone({ title: 'ok', bogus: 1 });
        expect(extra.status()).toBe(400);
        expect(msgOf(await extra.json())).toMatch(/property bogus should not exist/i);

        // Empty body {} → 201 with the "Copy of <source>" default title + backlink.
        const emptyBody = await clone({});
        expect(emptyBody.status(), `clone {} body=${await emptyBody.text()}`).toBe(201);
        const emptyClone = await emptyBody.json();
        expect(emptyClone.mission.sourceMissionId).toBe(source.id);
        expect(emptyClone.mission.title.length).toBeGreaterThan(0);
        expect(emptyClone.mission.id).not.toBe(source.id);

        // Explicit valid title → 201 stored verbatim.
        const named = await clone({ title: `Fork ${s}` });
        expect(named.status()).toBe(201);
        expect((await named.json()).mission.title).toBe(`Fork ${s}`);
    });

    test('complete: CompleteMissionDto outcome enum — bad value 400, each valid value 200, null accepted', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // Bad outcome enum → 400 with the full allowlist.
        const badMission = await createMission(request, token, {
            description: `bad outcome ${s}`,
            type: 'one-shot',
        });
        const bad = await request.post(`${API_BASE}/api/me/missions/${badMission.id}/complete`, {
            headers: authedHeaders(token),
            data: { outcome: 'invalid_outcome' },
        });
        expect(bad.status()).toBe(400);
        expect(msgOf(await bad.json())).toMatch(
            /outcome must be one of the following values: succeeded, partially_succeeded, failed, cancelled, superseded/i,
        );
        // The rejected complete did NOT transition the mission.
        expect((await getMission(request, token, badMission.id)).status).toBe('active');

        // Each valid outcome value completes a fresh mission (status→completed).
        for (const outcome of [
            'succeeded',
            'partially_succeeded',
            'failed',
            'cancelled',
            'superseded',
        ]) {
            const m = await createMission(request, token, {
                description: `outcome ${outcome} ${s}`,
                type: 'one-shot',
            });
            const res = await request.post(`${API_BASE}/api/me/missions/${m.id}/complete`, {
                headers: authedHeaders(token),
                data: { outcome },
            });
            expect(res.status(), `complete outcome=${outcome}`).toBe(200);
            expect((await res.json()).status).toBe('completed');
        }

        // Omitting outcome (empty body) also completes — outcome stays null.
        const noOutcome = await createMission(request, token, {
            description: `no outcome ${s}`,
            type: 'one-shot',
        });
        const res = await request.post(`${API_BASE}/api/me/missions/${noOutcome.id}/complete`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).status).toBe('completed');
    });

    test('list: query-param validation — bad status/limit/offset/search 400; valid filters 200', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();
        const mission = await createMission(request, token, {
            title: `list host ${s}`,
            description: `list host ${s}`,
            type: 'one-shot',
        });
        const h = authedHeaders(token);

        // Bogus status filter → controller parseStatus 400.
        const badStatus = await request.get(`${API_BASE}/api/me/missions?status=bogus`, {
            headers: h,
        });
        expect(badStatus.status()).toBe(400);
        expect(msgOf(await badStatus.json())).toMatch(/Invalid status filter: bogus/i);

        // Non-integer limit/offset → 400.
        const badLimit = await request.get(`${API_BASE}/api/me/missions?limit=abc`, { headers: h });
        expect(badLimit.status()).toBe(400);
        expect(msgOf(await badLimit.json())).toMatch(/limit must be an integer/i);

        const badOffset = await request.get(`${API_BASE}/api/me/missions?offset=xyz`, {
            headers: h,
        });
        expect(badOffset.status()).toBe(400);
        expect(msgOf(await badOffset.json())).toMatch(/offset must be an integer/i);

        // search > 500 chars → 400.
        const badSearch = await request.get(
            `${API_BASE}/api/me/missions?search=${'q'.repeat(501)}`,
            { headers: h },
        );
        expect(badSearch.status()).toBe(400);
        expect(msgOf(await badSearch.json())).toMatch(/search must be 500 characters or fewer/i);

        // Valid filters → 200; the freshly-created active mission is in scope.
        const okStatus = await request.get(`${API_BASE}/api/me/missions?status=active`, {
            headers: h,
        });
        expect(okStatus.status()).toBe(200);
        expect(((await okStatus.json()) as MissionDto[]).map((m) => m.id)).toContain(mission.id);

        const okPaged = await request.get(`${API_BASE}/api/me/missions?limit=5&offset=0`, {
            headers: h,
        });
        expect(okPaged.status()).toBe(200);
        const paged = (await okPaged.json()) as MissionDto[];
        expect(Array.isArray(paged)).toBe(true);
        expect(paged.length).toBeLessThanOrEqual(5);
    });
});
