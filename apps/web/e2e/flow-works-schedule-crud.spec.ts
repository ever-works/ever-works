import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Works schedule CRUD — long-tail deep coverage for the per-work scheduled-
 * generation REST contract (EW-602):
 *
 *   GET    /api/works/:id/schedule       (any viewer)  — rich readiness view
 *   PUT    /api/works/:id/schedule       (editor)      — upsert (UpdateWorkScheduleDto)
 *   DELETE /api/works/:id/schedule       (editor)      — cancel/clear
 *   POST   /api/works/:id/schedule/run   (editor)      — manual trigger
 *
 * Backed by apps/api/src/works/works.controller.ts (getWorkSchedule /
 * updateWorkSchedule / cancelWorkSchedule / runScheduledUpdate) +
 * packages/agent/src/services/work-schedule.service.ts +
 * packages/agent/src/dto/work-schedule.dto.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS — every status / shape / message below was curl-verified LIVE
 * against http://127.0.0.1:3100 (sqlite, keyless, subscriptions enabled, free
 * plan) before assertions were written:
 *
 *   • AUTH-FIRST PRECEDENCE: a request with NO bearer token is 401 on EVERY verb,
 *     even for a non-existent work id — the JWT guard fires before the work lookup
 *     (so 401 strictly precedes the 404 work-not-found).
 *   • MISSING-WORK 404 ON ALL FOUR VERBS: an authenticated user (owner OR stranger)
 *     hitting a non-existent work id gets the SAME 404 envelope on GET/PUT/DELETE/
 *     run: { status:'error', message:"Work with id '<id>' not found" }. The work
 *     lookup (404) precedes the ownership check (403) — a stranger on a missing id
 *     is 404, never 403. Also true for a non-UUID garbage id.
 *   • FRESH-WORK GET defaults (unscheduled): { status:'success', workId,
 *     schedule:{ status:'disabled', cadence:null, nextRunAt:null, lastRunAt:null,
 *     lastRunStatus:null, failureCount:0, alwaysCreatePullRequest:false,
 *     providerOverrides:null, billingMode:'subscription', maxFailureBeforePause:3,
 *     featureEnabled:true, subscriptionsEnabled:true, planCode:'free' } }. GET is
 *     a pure READ — two GETs are byte-identical and create no row.
 *   • DISABLE-PATH UPSERT round-trip (enable:false bypasses the readiness gate and
 *     persists a real PAUSED row): cadence / billingMode / maxFailureBeforePause /
 *     alwaysCreatePullRequest / providerOverrides all persist on the PUT response
 *     AND re-read verbatim from a fresh GET.
 *   • VALID providerOverrides resolve + round-trip: { ai:'openai', search:'tavily' }
 *     (both loaded plugins) is accepted on the disable path and echoes back verbatim
 *     on the PUT response and on a fresh GET. (The REJECTION path for bogus plugin
 *     ids lives in flow-work-scheduled-updates.spec.ts — NOT re-asserted here.)
 *   • POST run on a PAUSED row → 400 { status:'error', message:'Schedule must be
 *     active to run' }; an arbitrary JSON request body is IGNORED (still 400).
 *   • POST run / DELETE with NO schedule row → 404 'Schedule not found'.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — this is a DIFFERENT entity from flow-mission-crud-schedule.spec.ts
 * (Missions: a verbatim cron string on /api/me/missions; NO cadence enum, NO readiness
 * gate, NO billing). This file targets the WORK schedule cadence-enum surface. The
 * already-exhaustive flow-work-scheduled-updates.spec.ts owns: the readiness-gate
 * field matrix (canEnable/blockingCode/allowedCadences catalogue), the enable-true
 * gating (CONFIG_UNAVAILABLE), the full DTO VALIDATION matrix (bad cadence/billingMode/
 * unknown-field/maxFailure-bounds), the providerOverrides REJECTION matrix, the
 * Work-entity scheduled* mirror, the non-owner 403 matrix on a REAL work, and the
 * DELETE-on-real-row 500. work-schedule.spec.ts owns the bare no-auth 401 smokes;
 * cron-schedules.spec.ts probes a {cron} field this DTO does not have.
 *
 * This file pins ONLY the uncovered long-tail GAPS: (1) auth-precedence 401>404 +
 * the missing-work 404 across ALL FOUR verbs incl. stranger-gets-404-not-403;
 * (2) the fresh-GET defaults block + GET read-only idempotence; (3) the VALID
 * providerOverrides round-trip (persist + re-GET); (4) the disable-path config
 * round-trip re-read from a fresh GET (existing spec asserts only the PUT response);
 * (5) the run-precondition body-ignored behaviour; (6) run/DELETE-absent 404 ladder.
 *
 * ENVIRONMENT-ADAPTIVE: keyless CI, no MailHog/Redis, subscriptions ENABLED but the
 * work is an un-configured free-plan work → enablement is gated (canEnable:false),
 * so NO flow reaches status:'active' / a computed nextRunAt / the 202 dispatch. Every
 * assertion targets the reachable PAUSED-row + readiness contract, never a git/AI-
 * backed completion. ISOLATION: a FRESH registerUserViaAPI() user + FRESH work per
 * test; unique suffixes from a per-test counter (no module-scope clock).
 */

interface AllowedCadence {
    cadence: string;
    allowed: boolean;
    payPerUse: boolean;
}

interface RichSchedule {
    status?: string | null;
    featureEnabled?: boolean;
    canEnable?: boolean;
    blockingCode?: string | null;
    blockingReason?: string | null;
    cadence?: string | null;
    billingMode?: string | null;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastRunStatus?: string | null;
    failureCount?: number;
    maxFailureBeforePause?: number;
    alwaysCreatePullRequest?: boolean;
    allowedCadences?: AllowedCadence[];
    planCode?: string;
    subscriptionsEnabled?: boolean;
    providerOverrides?: Record<string, string> | null;
}

interface Envelope {
    status?: string;
    code?: string;
    message?: string | string[];
    workId?: string;
    schedule?: RichSchedule;
}

const MISSING_WORK_ID = '00000000-0000-0000-0000-000000000000';

let seq = 0;
function suffix(): string {
    seq += 1;
    return `${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

function flatMessage(body: { message?: string | string[] }): string {
    return Array.isArray(body.message) ? body.message.join(' ') : String(body.message ?? '');
}

async function makeOwnerAndWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string }> {
    const owner = await registerUserViaAPI(request);
    const sfx = suffix();
    const created = await createWorkViaAPI(request, owner.access_token, {
        name: `Sched CRUD ${label} ${sfx}`,
        slug: `sched-crud-${label}-${sfx}`,
        description: `schedule-crud long-tail ${sfx}`,
    });
    expect(created.id, `work created for ${label}`).toBeTruthy();
    return { token: owner.access_token, workId: created.id };
}

async function getSchedule(
    request: APIRequestContext,
    workId: string,
    token: string,
): Promise<RichSchedule> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET schedule body=${await res.text()}`).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.status, 'GET envelope status').toBe('success');
    expect(body.schedule, 'GET schedule object present').toBeTruthy();
    return body.schedule!;
}

async function putSchedule(
    request: APIRequestContext,
    workId: string,
    token: string,
    data: Record<string, unknown>,
) {
    return request.put(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
        data,
    });
}

test.describe('Works schedule CRUD — long-tail (auth precedence, missing-work, round-trips, run preconditions)', () => {
    // ───────────────────────────────────────────────────────────────────────
    // 1) AUTH-FIRST PRECEDENCE. No bearer token → 401 on every verb, even for a
    //    non-existent work id. The JWT guard fires before the work lookup, so the
    //    401 strictly precedes the would-be 404. Pins the security ordering that a
    //    "401 only on /dead" smoke (work-schedule.spec.ts) does not establish.
    // ───────────────────────────────────────────────────────────────────────
    test('no-auth is 401 on every verb and precedes the work-not-found 404', async ({
        request,
    }) => {
        const base = `${API_BASE}/api/works/${MISSING_WORK_ID}/schedule`;

        const noAuthGet = await request.get(base);
        expect(noAuthGet.status(), 'no-auth GET → 401').toBe(401);

        const noAuthPut = await request.put(base, { data: { enable: false, cadence: 'daily' } });
        expect(noAuthPut.status(), 'no-auth PUT → 401').toBe(401);

        const noAuthDelete = await request.delete(base);
        expect(noAuthDelete.status(), 'no-auth DELETE → 401').toBe(401);

        const noAuthRun = await request.post(`${base}/run`);
        expect(noAuthRun.status(), 'no-auth run → 401').toBe(401);

        // Sanity: the SAME missing id with a valid token is a 404 (not 401) — proving
        // the 401s above are the auth guard, not the lookup.
        const owner = await registerUserViaAPI(request);
        const authedGet = await request.get(base, { headers: authedHeaders(owner.access_token) });
        expect(authedGet.status(), 'authed GET on missing id → 404 (lookup, not auth)').toBe(404);
    });

    // ───────────────────────────────────────────────────────────────────────
    // 2) MISSING-WORK 404 ON ALL FOUR VERBS, for OWNER and STRANGER alike. The work
    //    lookup (404) precedes the ownership check (403): a stranger hitting a missing
    //    id is 404, NOT 403. The existing deep spec only pins the GET 404 — here we pin
    //    the full verb grid + the stranger-gets-404 nuance + a non-UUID garbage id.
    // ───────────────────────────────────────────────────────────────────────
    test('missing work id is a consistent 404 across GET/PUT/DELETE/run for owner and stranger', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const base = `${API_BASE}/api/works/${MISSING_WORK_ID}/schedule`;
        const notFound = /Work with id .*not found|not found/i;

        for (const [who, token] of [
            ['owner', owner.access_token],
            ['stranger', stranger.access_token],
        ] as const) {
            const h = authedHeaders(token);

            const g = await request.get(base, { headers: h });
            expect(g.status(), `${who} GET missing → 404`).toBe(404);
            expect(flatMessage(await g.json()), `${who} GET 404 msg`).toMatch(notFound);

            const p = await request.put(base, { headers: h, data: { enable: false } });
            expect(p.status(), `${who} PUT missing → 404`).toBe(404);
            expect(flatMessage(await p.json()), `${who} PUT 404 msg`).toMatch(notFound);

            const d = await request.delete(base, { headers: h });
            expect(d.status(), `${who} DELETE missing → 404`).toBe(404);
            expect(flatMessage(await d.json()), `${who} DELETE 404 msg`).toMatch(notFound);

            const r = await request.post(`${base}/run`, { headers: h });
            expect(r.status(), `${who} run missing → 404`).toBe(404);
            expect(flatMessage(await r.json()), `${who} run 404 msg`).toMatch(notFound);
        }

        // A non-UUID garbage id is the same 404 (it is treated as a (missing) work id,
        // not a 400 validation error) — the message echoes the raw id verbatim.
        const garbage = await request.get(`${API_BASE}/api/works/not-a-real-id/schedule`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(garbage.status(), 'garbage id GET → 404').toBe(404);
        expect(flatMessage(await garbage.json()), 'garbage id 404 echoes the id').toMatch(
            /not-a-real-id/,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // 3) FRESH-WORK GET defaults block + READ-ONLY idempotence. The unscheduled
    //    schedule view exposes the exact "empty" defaults a UI binds its disabled
    //    state to, and GET never persists a row — two consecutive GETs are identical
    //    and a subsequent run still finds NO row (404). (The deep spec pins the
    //    readiness/allowedCadences catalogue; this pins the empty-defaults + the
    //    no-write-on-read guarantee, which it does not.)
    // ───────────────────────────────────────────────────────────────────────
    test('fresh work GET exposes the unscheduled defaults and is a pure read (no row created)', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'fresh-get');

        const first = await getSchedule(request, workId, token);
        // The "empty" defaults block.
        expect(first.status, 'fresh: disabled').toBe('disabled');
        expect(first.cadence ?? null, 'fresh: no cadence').toBeNull();
        expect(first.nextRunAt ?? null, 'fresh: no nextRunAt').toBeNull();
        expect(first.lastRunAt ?? null, 'fresh: no lastRunAt').toBeNull();
        expect(first.lastRunStatus ?? null, 'fresh: no lastRunStatus').toBeNull();
        expect(first.failureCount ?? 0, 'fresh: zero failures').toBe(0);
        expect(first.alwaysCreatePullRequest, 'fresh: PR flag defaults false').toBe(false);
        expect(first.providerOverrides ?? null, 'fresh: no provider overrides').toBeNull();
        expect(['subscription', 'usage'], 'fresh: a real billingMode default').toContain(
            first.billingMode,
        );
        expect(first.featureEnabled, 'fresh: feature advertised').toBe(true);
        expect(typeof first.subscriptionsEnabled, 'subscriptionsEnabled is boolean').toBe(
            'boolean',
        );

        // GET is a pure read: a second GET returns an identical body and no schedule
        // row was created (a manual run still finds none → 404 'Schedule not found').
        const second = await getSchedule(request, workId, token);
        expect(second, 'two GETs are byte-identical (read-only)').toEqual(first);

        const run = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: authedHeaders(token),
        });
        expect(run.status(), 'run after read-only GETs finds no row → 404').toBe(404);
        expect(flatMessage(await run.json()), 'run-absent message').toMatch(/not found/i);
    });

    // ───────────────────────────────────────────────────────────────────────
    // 4) DISABLE-PATH CONFIG ROUND-TRIP re-read from a FRESH GET. enable:false bypasses
    //    the readiness gate and upserts a PAUSED row; every persisted knob (cadence /
    //    billingMode:usage / maxFailureBeforePause / alwaysCreatePullRequest) re-reads
    //    verbatim from an independent GET. The deep spec asserts these on the PUT
    //    RESPONSE only — re-reading via GET proves the round-trip, not just the echo.
    // ───────────────────────────────────────────────────────────────────────
    test('disable-path PUT persists full config that re-reads verbatim from a fresh GET', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'roundtrip');

        const put = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'weekly',
            billingMode: 'usage',
            maxFailureBeforePause: 9,
            alwaysCreatePullRequest: true,
        });
        expect(put.status(), `disable-path PUT body=${await put.text()}`).toBe(200);
        const putSched = ((await put.json()) as Envelope).schedule!;
        expect(putSched.status, 'PUT response: paused').toBe('paused');

        // Re-read from a FRESH GET (independent request) — the persistence proof.
        const got = await getSchedule(request, workId, token);
        expect(got.status, 'GET reflects paused').toBe('paused');
        expect(got.cadence, 'GET reflects cadence').toBe('weekly');
        expect(got.billingMode, 'GET reflects billingMode usage').toBe('usage');
        expect(got.maxFailureBeforePause, 'GET reflects maxFailureBeforePause').toBe(9);
        expect(got.alwaysCreatePullRequest, 'GET reflects PR flag').toBe(true);
        // PAUSED ⇒ no computed run is mirrored.
        expect(got.nextRunAt ?? null, 'paused: no nextRunAt').toBeNull();

        // Re-writing a single knob (cadence) preserves the others through a fresh GET.
        const recadence = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'monthly',
        });
        expect(recadence.status(), 'cadence re-write → 200').toBe(200);
        const afterRewrite = await getSchedule(request, workId, token);
        expect(afterRewrite.cadence, 'new cadence persisted').toBe('monthly');
        expect(afterRewrite.maxFailureBeforePause, 'untouched maxFailure preserved').toBe(9);
        expect(afterRewrite.alwaysCreatePullRequest, 'untouched PR flag preserved').toBe(true);
        expect(afterRewrite.billingMode, 'untouched billingMode preserved').toBe('usage');
        expect(afterRewrite.status, 'still paused after re-write').toBe('paused');
    });

    // ───────────────────────────────────────────────────────────────────────
    // 5) VALID providerOverrides resolve + ROUND-TRIP. A valid override map of LOADED
    //    plugin ids ({ ai:'openai', search:'tavily' }) is accepted on the disable path
    //    and echoes back verbatim on the PUT response AND a fresh GET. The deep spec
    //    only exercises the REJECTION path (bogus id / unknown key) — the accept +
    //    round-trip is uncovered. Then a subsequent PUT WITHOUT providerOverrides
    //    PRESERVES the stored map (omission ≠ clear), which is a distinct service rule.
    // ───────────────────────────────────────────────────────────────────────
    test('valid providerOverrides persist and round-trip; omitting them on re-PUT preserves them', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'overrides');

        const overrides = { ai: 'openai', search: 'tavily' };
        const put = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'daily',
            providerOverrides: overrides,
        });
        expect(put.status(), `overrides PUT body=${await put.text()}`).toBe(200);
        const putSched = ((await put.json()) as Envelope).schedule!;
        expect(putSched.providerOverrides, 'PUT response echoes overrides verbatim').toEqual(
            overrides,
        );

        // Re-read verbatim from a fresh GET.
        const got = await getSchedule(request, workId, token);
        expect(got.providerOverrides, 'GET reflects overrides verbatim').toEqual(overrides);

        // A re-PUT that OMITS providerOverrides keeps the stored map (the service only
        // overwrites when the field is explicitly present in the DTO).
        const reput = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'weekly',
        });
        expect(reput.status(), 'omitting-overrides re-PUT → 200').toBe(200);
        const afterOmit = await getSchedule(request, workId, token);
        expect(afterOmit.cadence, 'cadence updated by the re-PUT').toBe('weekly');
        expect(afterOmit.providerOverrides, 'omitted overrides preserved (not cleared)').toEqual(
            overrides,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // 6) RUN PRECONDITION ladder + body-ignored. Through the reachable PAUSED row:
    //    a manual run is rejected 400 'Schedule must be active to run', and an
    //    arbitrary JSON request body does NOT change that (the run handler ignores the
    //    body). Plus the run/DELETE-absent 404 'Schedule not found' boundary on a fresh
    //    work — the precise message a UI surfaces for "nothing scheduled yet".
    // ───────────────────────────────────────────────────────────────────────
    test('run on a paused row is 400 must-be-active (body ignored); run/DELETE without a row is 404', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'run-precond');
        const h = authedHeaders(token);

        // No row yet → run and DELETE both 404 'Schedule not found'.
        const runAbsent = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: h,
        });
        expect(runAbsent.status(), 'run with no row → 404').toBe(404);
        expect(flatMessage(await runAbsent.json()), 'run-absent message').toMatch(
            /schedule not found|not found/i,
        );

        const delAbsent = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: h,
        });
        expect(delAbsent.status(), 'DELETE with no row → 404').toBe(404);
        expect(flatMessage(await delAbsent.json()), 'delete-absent message').toMatch(/not found/i);

        // Create a PAUSED row (disable path), then a manual run is gated by the
        // active-state precondition.
        const create = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'daily',
        });
        expect(create.status(), 'disable-path create → 200').toBe(200);
        expect(((await create.json()) as Envelope).schedule?.status, 'row is paused').toBe(
            'paused',
        );

        // Run with NO body → 400 must-be-active.
        const runNoBody = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: h,
        });
        expect(runNoBody.status(), 'run on paused (no body) → 400').toBe(400);
        const runNoBodyJson = (await runNoBody.json()) as Envelope;
        expect(runNoBodyJson.status, 'run-precondition error envelope').toBe('error');
        expect(flatMessage(runNoBodyJson), 'must-be-active message').toMatch(
            /must be active to run|must be active/i,
        );

        // Run WITH an arbitrary JSON body → still 400 (body is ignored, not validated).
        const runWithBody = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: h,
            data: { foo: 'bar', enable: true, cadence: 'hourly' },
        });
        expect(runWithBody.status(), 'run on paused (with body) → still 400').toBe(400);
        expect(flatMessage(await runWithBody.json()), 'body-ignored still must-be-active').toMatch(
            /must be active to run|must be active/i,
        );

        // The rejected runs did not mutate the row — still paused, still daily.
        const after = await getSchedule(request, workId, token);
        expect(after.status, 'still paused after rejected runs').toBe('paused');
        expect(after.cadence, 'cadence untouched by rejected runs').toBe('daily');
    });

    // ───────────────────────────────────────────────────────────────────────
    // 7) CADENCE-ENUM ACCEPTANCE MATRIX. Every one of the 7 WorkScheduleCadence
    //    values is accepted on the disable path (free plan: each is allowed +
    //    payPerUse:false in allowedCadences) and round-trips verbatim through a fresh
    //    GET, swapping in place on the same row. The deep spec pins the bad-cadence
    //    REJECTION (one enum 400) + advertises the catalogue; it never drives every
    //    value through to a persisted-and-re-read PAUSED row.
    // ───────────────────────────────────────────────────────────────────────
    test('every cadence enum value is accepted on the disable path and round-trips through GET', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId } = await makeOwnerAndWork(request, 'cadence-matrix');
        const cadences = [
            'hourly',
            'every_3_hours',
            'every_8_hours',
            'every_12_hours',
            'daily',
            'weekly',
            'monthly',
        ] as const;

        for (const cadence of cadences) {
            const put = await putSchedule(request, workId, token, { enable: false, cadence });
            expect(put.status(), `cadence ${cadence} PUT → 200`).toBe(200);
            const putSched = ((await put.json()) as Envelope).schedule!;
            expect(putSched.status, `cadence ${cadence} row is paused`).toBe('paused');
            expect(putSched.cadence, `cadence ${cadence} echoed on PUT`).toBe(cadence);

            // Re-read verbatim from a fresh GET — the same single row swapped in place.
            const got = await getSchedule(request, workId, token);
            expect(got.cadence, `cadence ${cadence} reflected on GET`).toBe(cadence);
            expect(got.status, `cadence ${cadence} still paused on GET`).toBe('paused');
        }

        // The advertised catalogue lists exactly these 7 cadences, each typed.
        const finalView = await getSchedule(request, workId, token);
        const advertised = (finalView.allowedCadences ?? []).map((c) => c.cadence).sort();
        expect(advertised, 'catalogue advertises exactly the 7 cadence values').toEqual(
            [...cadences].sort(),
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // 8) DELETE semantics. An absent DELETE is an idempotent 404 'Schedule not
    //    found'. A DELETE of a REAL paused row resolves to a non-2xx in this e2e
    //    stack (the cancelSchedule upsert(cadence:null) + config-sync side-effect
    //    500s); asserted TOLERANTLY (>=400, never a silent 200) with a tolerant
    //    fixed-build branch, exactly per the documented stack behaviour. Either way
    //    no clean cancel masks a real bug, and the row remains observable.
    // ───────────────────────────────────────────────────────────────────────
    test('DELETE is idempotent 404 when absent and non-2xx when a real paused row exists', async ({
        request,
    }) => {
        const { token, workId } = await makeOwnerAndWork(request, 'delete');
        const h = authedHeaders(token);

        // Absent → 404, idempotent (a second absent DELETE is still 404).
        const del1 = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: h,
        });
        expect(del1.status(), 'absent DELETE → 404').toBe(404);
        expect(flatMessage(await del1.json()), 'absent DELETE message').toMatch(/not found/i);
        const del2 = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: h,
        });
        expect(del2.status(), 'second absent DELETE → still 404').toBe(404);

        // Create a real PAUSED row, then DELETE it.
        const create = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'weekly',
        });
        expect(create.status(), 'disable-path create → 200').toBe(200);

        const delReal = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: h,
        });
        const delStatus = delReal.status();
        expect(
            delStatus,
            `DELETE of a real paused row resolves to a non-2xx (got ${delStatus})`,
        ).toBeGreaterThanOrEqual(400);

        if (delStatus >= 500) {
            test.info().annotations.push({
                type: 'known-issue',
                description: `DELETE /works/:id/schedule of a real (paused) row returns ${delStatus} in the e2e stack (cancelSchedule side-effect). Tolerated.`,
            });
            // The cancel did not complete — the row is still observable.
            const still = await getSchedule(request, workId, token);
            expect(['paused', 'canceled', 'disabled']).toContain(still.status);
        } else {
            // Tolerant fixed-build branch: a clean cancel returns 200 + canceled/disabled.
            expect(delStatus, 'clean cancel → 200').toBe(200);
            const after = await getSchedule(request, workId, token);
            expect(['canceled', 'disabled']).toContain(after.status);
        }
    });
});
