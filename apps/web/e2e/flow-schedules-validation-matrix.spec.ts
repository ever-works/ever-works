/**
 * Schedules ("Cadence") — GET /api/schedules VALIDATION / AUTHZ / SCOPE matrix.
 *
 * `GET /api/schedules` is the read-only aggregation endpoint that unifies the
 * seven scheduled sources (recurring_task, agent_heartbeat, work_schedule,
 * mission_tick, source_validation, data_sync, inbound_trigger) into one
 * `ScheduleView[]`, scoped to the caller (userId + active Organization).
 *
 * This file is the EXHAUSTIVE MATRIX companion to flow-schedules-view-deep
 * (which pins the per-source projection shapes and happy-path filters) and to
 * flow-cross-tenant-security-matrix-2 (which spot-checks one filter + one
 * cross-user trigger). Here we drive DISTINCT angles those specs do NOT cover:
 *
 *   ── query validation, one assertion cluster per DTO field ──
 *   • sourceType  — every one of the SEVEN enum members accepted (200); a
 *     typo / wrong-case (`WORK_SCHEDULE`) / trailing-space / empty-string /
 *     bare-key / repeated-param (array) value → 400 (IsEnum, case-sensitive).
 *   • entityKind  — every one of the FIVE owner kinds accepted (200); a typo /
 *     wrong-case / plural / a sourceType value used as an entityKind / empty /
 *     array value → 400.
 *   • enabledOnly — only the exact tokens `true`/`false` coerce (200); EVERY
 *     other token — `True` `False` `0` `1` `2` `yes` `no` `maybe` `` and
 *     space-padded ` true`/`false ` — fails @IsBoolean → 400.
 *   • forbidNonWhitelisted — any unknown query param → 400, including when
 *     mixed with otherwise-valid params, and for multiple unknowns.
 *
 *   ── method + auth matrix ──
 *   • only GET is routed — POST / PUT / PATCH / DELETE → 404.
 *   • no Authorization header, a non-`Bearer` header, an empty bearer, and a
 *     garbage token all → 401; auth precedes validation (a would-be-400 query
 *     is still 401 unauthenticated).
 *   • a trailing slash (`/api/schedules/`) is still routed → 200.
 *
 *   ── scope-slug authz + cross-ORG isolation (the X-Scope-Slug mechanism) ──
 *   • unknown slug → 404 (ScopeResolverMiddleware public lookup miss).
 *   • ANOTHER user's org slug → 403 (ScopeOwnershipGuard; tenant mismatch),
 *     never a data leak.
 *   • the caller's OWN org slug → 200; a whitespace-only slug header trims to
 *     nothing → default scope → 200.
 *   • two Orgs owned by the SAME user are mutually isolated — a mission built
 *     under org1's scope is visible under org1's slug and ABSENT under org2's.
 *
 *   ── aggregated projection-shape contract (generic, across a mixed list) ──
 *   • every row carries EXACTLY the 13 ScheduleView keys with the right
 *     primitive types; the synthetic id is `${sourceType}:${ownerId}`, unique,
 *     drawn from the source/owner vocabularies.
 *   • per-source structural invariants: inbound_trigger is always event-driven
 *     (cadenceRaw null, nextRunAt null, cadenceHuman 'On event'); data_sync
 *     always carries an `Nm` cadenceRaw and a non-null next-run.
 *
 *   ── filter composition + cross-USER isolation ──
 *   • a sourceType/entityKind pair that can never co-occur → [].
 *   • enabledOnly=false is a superset of enabledOnly=true; every true-set row
 *     is enabled.
 *   • a fresh user never sees another user's rows — under no filter AND under a
 *     matching sourceType filter (structural 404-never; userId-scoped query).
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory, all feature
 *    flags ON — the CI driver) before assertions were written. Probed the full
 *    validation table, the method/auth codes, and the X-Scope-Slug 200/403/404
 *    matrix. Backed by apps/api/src/schedules/schedules.controller.ts +
 *    apps/api/src/schedules/dto/schedules-query.dto.ts +
 *    apps/api/src/scope/scope-resolver.middleware.ts + scope-ownership.guard.ts +
 *    packages/agent/src/schedules/schedules.service.ts.
 *
 * Isolation discipline: every test registers FRESH users (never the shared
 * seeded user) and uses unique suffixes, so each caller's read-model is exactly
 * the rows that test created. Fully API-orchestrated (safe `flow-` prefix).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createTaskViaAPI } from './helpers/agents-tasks';
import { createTriggerViaAPI } from './helpers/triggers';
import { createOrganizationViaAPI } from './helpers/organizations';

const SCHEDULES_BASE = `${API_BASE}/api/schedules`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_TYPES = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
] as const;

const OWNER_TYPES = ['task', 'agent', 'work', 'mission', 'trigger'] as const;

/** The exact key-set of a ScheduleView row (spec §1.3), sorted for comparison. */
const SCHEDULE_VIEW_KEYS = [
    'cadenceHuman',
    'cadenceRaw',
    'enabled',
    'id',
    'lastRunAt',
    'lastRunStatus',
    'nextRunAt',
    'ownerId',
    'ownerLink',
    'ownerName',
    'ownerType',
    'sourceType',
    'status',
];

interface ScheduleView {
    id: string;
    sourceType: string;
    ownerType: string;
    ownerId: string;
    ownerName: string;
    ownerLink: string;
    cadenceRaw: string | null;
    cadenceHuman: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    status: string;
    enabled: boolean;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Authed headers, optionally carrying an X-Scope-Slug to resolve a scope. */
function scopedHeaders(token: string, slug?: string): Record<string, string> {
    const h: Record<string, string> = { ...authedHeaders(token) };
    if (slug !== undefined) h['x-scope-slug'] = slug;
    return h;
}

/** Raw GET (caller asserts the status). */
function getRaw(request: APIRequestContext, token: string, query = '', slug?: string) {
    return request.get(`${SCHEDULES_BASE}${query}`, { headers: scopedHeaders(token, slug) });
}

/** GET expecting 200 → the parsed ScheduleView[]. */
async function getSchedules(
    request: APIRequestContext,
    token: string,
    query = '',
    slug?: string,
): Promise<ScheduleView[]> {
    const res = await getRaw(request, token, query, slug);
    expect(res.status(), `schedules body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Create a SCHEDULED Mission (cron cadence) under the caller's active scope. */
async function createScheduledMission(
    request: APIRequestContext,
    token: string,
    title: string,
    slug?: string,
    schedule = '0 9 * * *',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: scopedHeaders(token, slug),
        data: { title, description: 'schedules matrix mission', type: 'scheduled', schedule },
    });
    expect(res.status(), `createScheduledMission body=${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return (await res.json()).id as string;
}

/** Make an existing Task recurring (RRULE) → a recurring_task row. */
async function makeTaskRecurring(
    request: APIRequestContext,
    token: string,
    taskId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        data: { recurrenceRule: 'FREQ=DAILY;INTERVAL=1' },
    });
    expect(res.status(), `makeTaskRecurring body=${await res.text().catch(() => '')}`).toBe(200);
}

/**
 * Create a tenant Agent carrying a `heartbeatCadence` (posted directly since
 * the shared createAgentViaAPI helper's typed body omits the field). A brand
 * new Agent is DRAFT → its heartbeat row projects as disabled.
 */
async function createAgentWithHeartbeat(
    request: APIRequestContext,
    token: string,
    name: string,
    heartbeatCadence = '0 * * * *',
): Promise<{ id: string }> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name, heartbeatCadence },
    });
    expect(res.status(), `createAgentWithHeartbeat body=${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// sourceType — enum validation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules validation — sourceType', () => {
    test('every one of the seven sourceType enum members is accepted → 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        for (const st of SOURCE_TYPES) {
            const res = await getRaw(request, user.access_token, `?sourceType=${st}`);
            expect(res.status(), `sourceType=${st}`).toBe(200);
            // A valid filter always yields a (possibly empty) array of that source only.
            const list: ScheduleView[] = await res.json();
            expect(Array.isArray(list)).toBe(true);
            expect(list.every((r) => r.sourceType === st)).toBe(true);
        }
    });

    test('a typo / wrong-case / padded / empty / bare-key / repeated sourceType → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { headers: authedHeaders(user.access_token) };
        // near-miss token, uppercase (IsEnum is case-sensitive), trailing space,
        // empty string (@IsOptional does NOT skip ''), and a bare key.
        for (const q of [
            '?sourceType=recurring',
            '?sourceType=WORK_SCHEDULE',
            '?sourceType=data_sync%20',
            '?sourceType=',
            '?sourceType',
            '?sourceType=task', // a valid entityKind, but not a sourceType
        ]) {
            const res = await request.get(`${SCHEDULES_BASE}${q}`, H);
            expect(res.status(), `expected 400 for ${q}`).toBe(400);
        }
        // A repeated param arrives as string[] → not a single enum member → 400.
        const arr = await request.get(
            `${SCHEDULES_BASE}?sourceType=data_sync&sourceType=work_schedule`,
            H,
        );
        expect(arr.status(), 'repeated sourceType (array)').toBe(400);
        const body = await arr.json();
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// entityKind — enum validation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules validation — entityKind', () => {
    test('every one of the five entityKind owner types is accepted → 200', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        for (const ek of OWNER_TYPES) {
            const res = await getRaw(request, user.access_token, `?entityKind=${ek}`);
            expect(res.status(), `entityKind=${ek}`).toBe(200);
            const list: ScheduleView[] = await res.json();
            expect(Array.isArray(list)).toBe(true);
            expect(list.every((r) => r.ownerType === ek)).toBe(true);
        }
    });

    test('a typo / wrong-case / plural / cross-enum / empty / repeated entityKind → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = { headers: authedHeaders(user.access_token) };
        for (const q of [
            '?entityKind=nope',
            '?entityKind=TASK', // wrong case
            '?entityKind=works', // plural of a real member
            '?entityKind=work_schedule', // a sourceType value, not an owner type
            '?entityKind=task%20', // trailing space
            '?entityKind=', // empty string
        ]) {
            const res = await request.get(`${SCHEDULES_BASE}${q}`, H);
            expect(res.status(), `expected 400 for ${q}`).toBe(400);
        }
        const arr = await request.get(`${SCHEDULES_BASE}?entityKind=task&entityKind=agent`, H);
        expect(arr.status(), 'repeated entityKind (array)').toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// enabledOnly — boolean coercion
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules validation — enabledOnly', () => {
    test('only the exact tokens true/false coerce and are accepted → 200 (filter applied)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // A Work always projects an ENABLED data_sync row — a stable probe that
        // the coerced boolean actually reaches the filter without erroring.
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `EO Work ${stamp()}`,
            slug: `eo-work-${stamp()}`,
        });
        const dataSyncId = `data_sync:${workId}`;

        const onTrue = await getSchedules(request, user.access_token, '?enabledOnly=true');
        expect(onTrue.map((r) => r.id)).toContain(dataSyncId);
        expect(onTrue.every((r) => r.enabled === true)).toBe(true);

        const onFalse = await getSchedules(request, user.access_token, '?enabledOnly=false');
        expect(onFalse.map((r) => r.id)).toContain(dataSyncId);
    });

    test('any non-true/false enabledOnly token fails @IsBoolean → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = { headers: authedHeaders(user.access_token) };
        for (const v of [
            'True',
            'False',
            '0',
            '1',
            '2',
            'yes',
            'no',
            'maybe',
            '', // empty string is NOT skipped by @IsOptional
            'false%20', // trailing space breaks the exact-token transform
            '%20true', // leading space likewise
        ]) {
            const res = await request.get(`${SCHEDULES_BASE}?enabledOnly=${v}`, H);
            expect(res.status(), `expected 400 for enabledOnly='${v}'`).toBe(400);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// forbidNonWhitelisted — unknown query params
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules validation — unknown params (forbidNonWhitelisted)', () => {
    test('a single unknown query param → 400 with a "should not exist" message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${SCHEDULES_BASE}?bogus=1`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.statusCode).toBe(400);
        expect(Array.isArray(body.message)).toBe(true);
        expect(body.message.join(' ')).toContain('should not exist');
    });

    test('an unknown param mixed with a VALID param is still rejected → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${SCHEDULES_BASE}?entityKind=work&nope=1`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
    });

    test('multiple unknown params → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${SCHEDULES_BASE}?a=1&b=2`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP method + auth matrix
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules — method & auth matrix', () => {
    test('only GET is routed — POST / PUT / PATCH / DELETE → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const H = { headers: authedHeaders(user.access_token) };
        expect((await request.post(SCHEDULES_BASE, H)).status()).toBe(404);
        expect((await request.put(SCHEDULES_BASE, H)).status()).toBe(404);
        expect((await request.patch(SCHEDULES_BASE, H)).status()).toBe(404);
        expect((await request.delete(SCHEDULES_BASE, H)).status()).toBe(404);
    });

    test('missing / malformed / empty / garbage bearer → 401; auth precedes validation', async ({
        request,
    }) => {
        // No header at all.
        expect((await request.get(SCHEDULES_BASE)).status()).toBe(401);
        // Token without the "Bearer " scheme prefix.
        expect(
            (
                await request.get(SCHEDULES_BASE, { headers: { Authorization: 'sometoken' } })
            ).status(),
        ).toBe(401);
        // "Bearer" with an empty value.
        expect(
            (await request.get(SCHEDULES_BASE, { headers: { Authorization: 'Bearer ' } })).status(),
        ).toBe(401);
        // A well-formed-looking but invalid token.
        expect(
            (
                await request.get(SCHEDULES_BASE, {
                    headers: { Authorization: 'Bearer garbageXYZ' },
                })
            ).status(),
        ).toBe(401);
        // Even an otherwise-400 (invalid param) is 401 without a token — the JWT
        // guard fires before the ValidationPipe.
        expect((await request.get(`${SCHEDULES_BASE}?sourceType=bogus`)).status()).toBe(401);
    });

    test('a trailing slash is still routed → 200', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${SCHEDULES_BASE}/`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// scope-slug authz + cross-ORG isolation (X-Scope-Slug)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules — scope-slug authz & cross-org isolation', () => {
    test('an unknown X-Scope-Slug → 404 (public slug lookup miss)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await getRaw(request, user.access_token, '', `no-such-slug-${stamp()}`);
        expect(res.status()).toBe(404);
    });

    test("another user's org slug → 403 (ScopeOwnershipGuard, tenant mismatch) — no data leak", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(request, owner.access_token, `Own ${stamp()}`);
        // A scheduled mission exists inside the owner's org.
        await createScheduledMission(request, owner.access_token, `Sec ${stamp()}`, org.slug);

        const intruder = await registerUserViaAPI(request);
        const res = await getRaw(request, intruder.access_token, '', org.slug);
        // 403, not 200-with-data and not 404 — the guard blocks cross-tenant scope hijack.
        expect(res.status()).toBe(403);
    });

    test("the caller's OWN org slug → 200; a whitespace-only slug trims to default scope → 200", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(request, user.access_token, `Mine ${stamp()}`);

        expect((await getRaw(request, user.access_token, '', org.slug)).status()).toBe(200);
        // "   " trims to empty in the middleware → legacy/default scope, not a 404.
        expect((await getRaw(request, user.access_token, '', '   ')).status()).toBe(200);
    });

    test('two Orgs of the same user are mutually isolated in the read-model', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org1 = await createOrganizationViaAPI(request, user.access_token, `A ${stamp()}`);
        const missionId = await createScheduledMission(
            request,
            user.access_token,
            `Org1 ${stamp()}`,
            org1.slug,
        );
        const org2 = await createOrganizationViaAPI(request, user.access_token, `B ${stamp()}`);

        const inOrg1 = (await getSchedules(request, user.access_token, '', org1.slug)).map(
            (r) => r.id,
        );
        const inOrg2 = (await getSchedules(request, user.access_token, '', org2.slug)).map(
            (r) => r.id,
        );

        // Distinct non-null org ids → the row belongs to exactly one scope.
        expect(inOrg1).toContain(`mission_tick:${missionId}`);
        expect(inOrg2).not.toContain(`mission_tick:${missionId}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregated projection-shape contract (generic, across a mixed list)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules — projection-shape contract', () => {
    /** Build a user whose read-model spans four heterogeneous sources. */
    async function buildMixedUser(request: APIRequestContext) {
        const user = await registerUserViaAPI(request);
        await createScheduledMission(request, user.access_token, `Mix M ${stamp()}`);
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Mix W ${stamp()}`,
            slug: `mix-w-${stamp()}`,
        });
        const task = await createTaskViaAPI(request, user.access_token, {
            title: `Mix T ${stamp()}`,
        });
        await makeTaskRecurring(request, user.access_token, task.id);
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `Mix Hook ${stamp()}`,
            kind: 'webhook',
        });
        return { user, workId, taskId: task.id, triggerId: trigger.id };
    }

    test('every row carries EXACTLY the 13 ScheduleView keys with correct primitive types', async ({
        request,
    }) => {
        const { user } = await buildMixedUser(request);
        const list = await getSchedules(request, user.access_token);
        expect(list.length).toBeGreaterThanOrEqual(4);

        for (const row of list) {
            expect(Object.keys(row).sort(), `keys of ${row.id}`).toEqual(SCHEDULE_VIEW_KEYS);
            expect(typeof row.id).toBe('string');
            expect(typeof row.sourceType).toBe('string');
            expect(typeof row.ownerType).toBe('string');
            expect(typeof row.ownerId).toBe('string');
            expect(typeof row.ownerName).toBe('string');
            expect(typeof row.ownerLink).toBe('string');
            expect(row.ownerLink.startsWith('/')).toBe(true);
            expect(typeof row.cadenceHuman).toBe('string');
            expect(row.cadenceHuman.length).toBeGreaterThan(0);
            expect(typeof row.status).toBe('string');
            expect(typeof row.enabled).toBe('boolean');
            // Nullable columns are string|null, never undefined.
            for (const k of ['cadenceRaw', 'nextRunAt', 'lastRunAt', 'lastRunStatus'] as const) {
                expect(row[k] === null || typeof row[k] === 'string', `${row.id}.${k}`).toBe(true);
            }
        }
    });

    test('the synthetic id is ${sourceType}:${ownerId}, unique, drawn from the vocabularies', async ({
        request,
    }) => {
        const { user } = await buildMixedUser(request);
        const list = await getSchedules(request, user.access_token);
        const ids = list.map((r) => r.id);
        // Ids are unique across the whole read-model.
        expect(new Set(ids).size).toBe(ids.length);
        for (const row of list) {
            expect(row.id).toBe(`${row.sourceType}:${row.ownerId}`);
            expect(SOURCE_TYPES).toContain(row.sourceType as (typeof SOURCE_TYPES)[number]);
            expect(OWNER_TYPES).toContain(row.ownerType as (typeof OWNER_TYPES)[number]);
        }
    });

    test('inbound_trigger rows are always event-driven (no cadence, no next-run)', async ({
        request,
    }) => {
        const { user, triggerId } = await buildMixedUser(request);
        const list = await getSchedules(request, user.access_token);
        const triggers = list.filter((r) => r.sourceType === 'inbound_trigger');
        expect(triggers.map((r) => r.id)).toContain(`inbound_trigger:${triggerId}`);
        for (const row of triggers) {
            expect(row.cadenceRaw).toBeNull();
            expect(row.nextRunAt).toBeNull();
            expect(row.cadenceHuman).toBe('On event');
            // With no target Agent the owner is its own 'trigger'; with one it reuses 'agent'.
            expect(['trigger', 'agent']).toContain(row.ownerType);
        }
    });

    test('data_sync rows always carry an "Nm" cadenceRaw and a non-null next-run', async ({
        request,
    }) => {
        const { user, workId } = await buildMixedUser(request);
        const list = await getSchedules(request, user.access_token);
        const syncs = list.filter((r) => r.sourceType === 'data_sync');
        expect(syncs.map((r) => r.id)).toContain(`data_sync:${workId}`);
        for (const row of syncs) {
            expect(row.cadenceRaw).toMatch(/^\d+m$/);
            expect(row.nextRunAt).not.toBeNull();
            expect(row.ownerType).toBe('work');
            expect(row.status).toBe('active');
            expect(row.enabled).toBe(true);
            expect(row.ownerId).toMatch(UUID_RE);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// filter composition + cross-USER isolation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Schedules — filter composition & cross-user isolation', () => {
    test('a sourceType/entityKind pair that can never co-occur → []', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        // Give the user real rows of BOTH kinds so the empty result is the
        // filter intersection, not just an empty account.
        await createWorkViaAPI(request, user.access_token, {
            name: `X Work ${stamp()}`,
            slug: `x-work-${stamp()}`,
        });
        await createAgentWithHeartbeat(request, user.access_token, `X Agent ${stamp()}`);

        // agent_heartbeat rows are owned by 'agent', never 'work' → intersection empty.
        const list = await getSchedules(
            request,
            user.access_token,
            '?sourceType=agent_heartbeat&entityKind=work',
        );
        expect(list).toEqual([]);
    });

    test('enabledOnly=false is a superset of enabledOnly=true; every true-set row is enabled', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // One always-enabled source (data_sync) + one always-disabled source
        // (a DRAFT agent heartbeat).
        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Sup Work ${stamp()}`,
            slug: `sup-work-${stamp()}`,
        });
        const agent = await createAgentWithHeartbeat(
            request,
            user.access_token,
            `Sup Ag ${stamp()}`,
        );

        const trueSet = await getSchedules(request, user.access_token, '?enabledOnly=true');
        const falseSet = await getSchedules(request, user.access_token, '?enabledOnly=false');
        const trueIds = new Set(trueSet.map((r) => r.id));
        const falseIds = new Set(falseSet.map((r) => r.id));

        // Every true-set row is enabled.
        expect(trueSet.every((r) => r.enabled === true)).toBe(true);
        // true ⊆ false.
        for (const id of trueIds) expect(falseIds.has(id)).toBe(true);
        // The enabled data_sync survives both; the draft agent heartbeat only the false set.
        expect(trueIds.has(`data_sync:${workId}`)).toBe(true);
        expect(trueIds.has(`agent_heartbeat:${agent.id}`)).toBe(false);
        expect(falseIds.has(`agent_heartbeat:${agent.id}`)).toBe(true);
    });

    test("a fresh user never sees another user's rows — unfiltered AND under a matching filter", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const aliceMission = await createScheduledMission(
            request,
            alice.access_token,
            `Al ${stamp()}`,
        );
        const { trigger: aliceTrigger } = await createTriggerViaAPI(request, alice.access_token, {
            name: `Al Hook ${stamp()}`,
            kind: 'webhook',
        });

        const bob = await registerUserViaAPI(request);
        // Bob's unfiltered read-model excludes ALL of Alice's rows.
        const bobAll = (await getSchedules(request, bob.access_token)).map((r) => r.id);
        expect(bobAll).not.toContain(`mission_tick:${aliceMission}`);
        expect(bobAll).not.toContain(`inbound_trigger:${aliceTrigger.id}`);

        // Even a filter that matches Alice's row types can't surface them for Bob.
        const bobTriggers = await getSchedules(
            request,
            bob.access_token,
            '?sourceType=inbound_trigger',
        );
        expect(bobTriggers.map((r) => r.id)).not.toContain(`inbound_trigger:${aliceTrigger.id}`);

        // And Alice still sees her own (sanity that the rows exist at all).
        const aliceAll = (await getSchedules(request, alice.access_token)).map((r) => r.id);
        expect(aliceAll).toContain(`mission_tick:${aliceMission}`);
        expect(aliceAll).toContain(`inbound_trigger:${aliceTrigger.id}`);
    });
});
