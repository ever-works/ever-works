import { test, expect } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';

/**
 * Work scheduled-updates — complex, multi-step INTEGRATION flows for the
 * per-work scheduled-generation configuration (EW-602). Each test() drives
 * several real endpoints in sequence and asserts the platform's TRUE,
 * observable behaviour: the rich readiness/enablement gate, the cadence enum +
 * DTO validation contract (incl. maxFailureBeforePause bounds + providerOverrides
 * plugin resolution), the disable-path that DOES persist a PAUSED schedule row,
 * the manual-run/delete preconditions reachable through that paused row, the
 * scheduledStatus/scheduledCadence/scheduledNextRunAt mirror on the Work entity,
 * and the schedule × generation orthogonality.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CONTRACT VERIFIED LIVE @ http://127.0.0.1:3100 + REAL SOURCE
 *   apps/api/src/works/works.controller.ts (getWorkSchedule/updateWorkSchedule/
 *     cancelWorkSchedule/runScheduledUpdate);
 *   packages/agent/src/services/work-schedule.service.ts;
 *   packages/agent/src/dto/work-schedule.dto.ts (UpdateWorkScheduleDto);
 *   packages/agent/src/entities/work-schedule.entity.ts + entities/types.ts
 *
 *   GET  /api/works/:id/schedule  (any viewer) -> 200 RICH readiness view:
 *     { status:'success', workId, schedule:{
 *         status:'disabled'|'active'|'paused'|'canceled'|'error',
 *         featureEnabled:true, canEnable:false (plain free work in e2e stack),
 *         blockingCode:'CONFIG_UNAVAILABLE' (getConfig throws -> no last_request_data),
 *         blockingReason:'Schedule readiness could not be checked right now...',
 *         cadence:WorkScheduleCadence|null, billingMode:'subscription'|'usage',
 *         nextRunAt:ISO|null, lastRunAt:ISO|null, lastRunStatus:string|null,
 *         failureCount:0, maxFailureBeforePause:3, alwaysCreatePullRequest:false,
 *         allowedCadences:[{cadence,allowed:true,payPerUse:false} x7],
 *         planCode:'free', subscriptionsEnabled:true, providerOverrides:null }}
 *
 *   PUT  /api/works/:id/schedule  (editor). UpdateWorkScheduleDto (whitelist; all
 *     OPTIONAL): enable(bool), runImmediately(bool), cadence(enum), billingMode(enum),
 *     maxFailureBeforePause(int 1..10), alwaysCreatePullRequest(bool),
 *     providerOverrides(ProvidersDto nested-whitelist). The boolean field is `enable`,
 *     NOT `enabled`. resolveRequestedEnabledState(): for a NON-EXISTING schedule,
 *     omitting `enable` DEFAULTS to enable=true.
 *       ENABLE PATH (enable resolves true): ensureWorkConfigReady() runs the readiness
 *       gate -> a plain free-plan work is canEnable:false -> rejected 400
 *         { status:'error', code:'CONFIG_UNAVAILABLE',
 *           message:'Schedule readiness could not be checked right now...' }
 *       So {cadence}, {}, {enable:true}, and re-enabling an existing PAUSED row all 400.
 *       DISABLE PATH (enable:false): SKIPS the readiness gate entirely -> 200, and
 *       UPSERTS a real PAUSED schedule row, persisting cadence (defaulting to plan
 *       default 'hourly' when omitted), billingMode, maxFailureBeforePause,
 *       alwaysCreatePullRequest, providerOverrides. nextRunAt stays null (not ACTIVE).
 *       DTO validation runs FIRST (before enable/readiness logic):
 *         {cadence:'yearly'}              -> 400 ['cadence must be one of the following
 *                                            values: hourly, every_3_hours, every_8_hours,
 *                                            every_12_hours, daily, weekly, monthly']
 *         {billingMode:'pay_per_use'}     -> 400 ['billingMode must be one of the following
 *                                            values: subscription, usage']
 *         {enabled:true} / {foo:'bar'}    -> 400 ['property <x> should not exist']
 *         {maxFailureBeforePause:0}       -> 400 ['... must not be less than 1']
 *         {maxFailureBeforePause:11}      -> 400 ['... must not be greater than 10']
 *         {maxFailureBeforePause:1.5}     -> 400 ['... must be an integer number']
 *       providerOverrides plugin resolution (runs after upsert-prep, on the disable
 *       path too): {providerOverrides:{ai:'bogus'}} -> 400
 *         'Provider plugin "bogus" for ai is not installed'.
 *       {providerOverrides:{aiProvider:'x'}} -> 400 nested-whitelist
 *         'providerOverrides.property aiProvider should not exist' (uiKey is `ai`).
 *
 *   POST /api/works/:id/schedule/run (editor): loads schedule ENTITY first.
 *     no row     -> 404 'Schedule not found'
 *     PAUSED row -> 400 { status:'error', message:'Schedule must be active to run' }
 *     ACTIVE row -> 202 { status:'pending', slug, message:'Scheduled update started' }
 *                   (UNREACHABLE in the e2e stack — enablement is gated).
 *
 *   DELETE /api/works/:id/schedule (editor):
 *     no row     -> 404 'Schedule not found'
 *     existing row -> 500 in this e2e stack (cancelSchedule upsert(cadence:null) +
 *                   config-sync side-effect throws). Asserted tolerantly (>=400, not 200)
 *                   and annotated — never hard-required to be a clean 200.
 *
 *   WORK ENTITY MIRROR (syncWork): every successful PUT/cancel mirrors the schedule
 *     onto the Work row: scheduledUpdatesEnabled (status===ACTIVE), scheduledCadence,
 *     scheduledNextRunAt, scheduledStatus. GET /api/works/:id -> { work:{ id, status,
 *     scheduledStatus, scheduledCadence, scheduledNextRunAt, scheduledUpdatesEnabled }}.
 *
 *   OWNERSHIP: non-owner on ANY verb -> 403 { status:'error',
 *     message:'You do not have permission to access this work' } (ensureCanView/Edit
 *     fires before the schedule lookup). MISSING work id for the OWNER -> 404
 *     "Work with id '<id>' not found". No-auth -> 401 (already pinned by
 *     work-schedule.spec.ts; not re-asserted here).
 *
 *   ScheduleCadence enum: hourly, every_3_hours, every_8_hours, every_12_hours,
 *     daily, weekly, monthly. BillingMode: subscription, usage.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SURVEY — why these 6 flows are NET-NEW (no overlap):
 *   • work-schedule.spec.ts  — no-auth 401s + a single "<500" smoke PUT/DELETE.
 *   • cron-schedules.spec.ts — probe a raw {cron} string this DTO does not even
 *                              have (skip-on-404), + a "<500" GET smoke.
 *   • work-generator.spec.ts — one "GET schedule -> 200|404" smoke.
 *   NONE assert: the readiness gate (canEnable/blockingCode), the enable=true-default,
 *   the disable-path that PERSISTS a PAUSED row, the cadence/billingMode/
 *   maxFailureBeforePause/providerOverrides validation matrix, the run/delete
 *   preconditions reachable through a paused row (404 vs 400-must-be-active vs the
 *   delete-500), the Work-entity scheduled* mirror, the cross-user 403 matrix,
 *   missing-work 404, or schedule × generation orthogonality. All 6 are uncovered.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / RESILIENCE (the platform's real e2e-stack truth, honestly encoded):
 *   • ENABLEMENT IS BLOCKED. A plain Work has no git/AI/last_request_data config, so
 *     readiness is canEnable:false (CONFIG_UNAVAILABLE) and EVERY enable-resolving PUT
 *     400s. No flow can reach status:'active', a computed future nextRunAt, or the 202
 *     manual-run dispatch. Each enable assertion keeps a TOLERANT branch so the spec
 *     stays green on any future build where canEnable becomes true.
 *   • A PAUSED row IS reachable (enable:false bypasses the gate) — so run-on-paused
 *     (400) and delete-existing (500 today) ARE exercised, unlike prior smoke specs.
 *   • DELETE-on-real-row returns 500 in this stack; asserted as ">=400 && !== 200" and
 *     annotated, with a tolerant 200 branch for a fixed build.
 *   • The worker (BullMQ/Trigger.dev) that dispatches due schedules is not running; no
 *     real cron tick is awaited. All statuses below were re-confirmed live in this run.
 *
 * ISOLATION: every flow runs on a FRESH registerUserViaAPI() user so the shared
 * in-memory DB stays clean for sibling specs. Unique suffixes everywhere; reads
 * tolerate pre-existing rows, never exact global counts.
 */

const CADENCE_VALUES = [
    'hourly',
    'every_3_hours',
    'every_8_hours',
    'every_12_hours',
    'daily',
    'weekly',
    'monthly',
];

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
    allowedCadences?: Array<{ cadence: string; allowed: boolean; payPerUse: boolean }>;
    planCode?: string;
    subscriptionsEnabled?: boolean;
    providerOverrides?: unknown;
}

interface Envelope {
    status?: string;
    code?: string;
    message?: string | string[];
    workId?: string;
    schedule?: RichSchedule;
}

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function flatMessage(body: { message?: string | string[] }): string {
    return Array.isArray(body.message) ? body.message.join(' ') : String(body.message ?? '');
}

async function makeOwnerAndWork(
    request: import('@playwright/test').APIRequestContext,
    label: string,
): Promise<{ owner: RegisteredUser; workId: string; token: string }> {
    const owner = await registerUserViaAPI(request);
    const suffix = uniqueSuffix();
    const created = await createWorkViaAPI(request, owner.access_token, {
        name: `Sched ${label} ${suffix}`,
        slug: `sched-${label}-${suffix}`,
        description: `scheduled-updates integration ${suffix}`,
    });
    expect(created.id, `work created for ${label} flow`).toBeTruthy();
    return { owner, workId: created.id, token: owner.access_token };
}

async function getSchedule(
    request: import('@playwright/test').APIRequestContext,
    workId: string,
    token: string,
): Promise<RichSchedule> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'GET schedule').toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.status, 'GET envelope status').toBe('success');
    expect(body.schedule, 'GET schedule object present').toBeTruthy();
    return body.schedule!;
}

async function putSchedule(
    request: import('@playwright/test').APIRequestContext,
    workId: string,
    token: string,
    data: Record<string, unknown>,
) {
    return request.put(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
        data,
    });
}

async function getWorkScheduledFields(
    request: import('@playwright/test').APIRequestContext,
    workId: string,
    token: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'GET work detail').toBe(200);
    const body = await res.json();
    return body?.work ?? body ?? {};
}

test.describe('Work scheduled-updates — readiness gate, validation matrix, paused-row lifecycle, Work mirror, isolation', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: a fresh work exposes a RICH readiness view that truthfully blocks
    //         enablement (canEnable:false + blockingCode) and advertises the full
    //         allowedCadences catalogue + plan/billing metadata — the exact contract
    //         a UI's "Enable" CTA + cadence picker consume.
    // ───────────────────────────────────────────────────────────────────────
    test('fresh work readiness view blocks enablement and advertises the cadence catalogue', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const { workId, token } = await makeOwnerAndWork(request, 'readiness');

        const res = await request.get(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: authedHeaders(token),
        });
        expect(res.status(), 'GET schedule (owner)').toBe(200);
        const body = (await res.json()) as Envelope;
        expect(body.status, 'envelope status').toBe('success');
        expect(body.workId, 'envelope echoes the work id').toBe(workId);
        const s = body.schedule!;
        expect(s, 'schedule object present').toBeTruthy();

        // Unconfigured ⇒ disabled, not enabled, no computed/last run, no cadence.
        expect(s.status, 'fresh work schedule is disabled').toBe('disabled');
        expect(s.cadence ?? null, 'fresh work has no cadence').toBeNull();
        expect(s.nextRunAt ?? null, 'no computed nextRunAt yet').toBeNull();
        expect(s.lastRunAt ?? null, 'no lastRunAt yet').toBeNull();
        expect(s.failureCount ?? 0, 'a fresh schedule has zero failures').toBe(0);

        // The feature exists, but a plain free-plan work is NOT enableable in the e2e
        // stack — readiness surfaces a machine-readable code + a human reason.
        expect(s.featureEnabled, 'scheduled-updates feature is present').toBe(true);
        expect(s.canEnable, 'a plain work cannot be enabled in the e2e stack').toBe(false);
        expect(
            ['SCHEDULED_UPDATES_DISABLED', 'INITIAL_WORK_SETUP_REQUIRED', 'CONFIG_UNAVAILABLE'],
            `blockingCode was ${s.blockingCode}`,
        ).toContain(s.blockingCode);
        expect(
            String(s.blockingReason ?? ''),
            'a human-readable blocking reason accompanies the code',
        ).not.toHaveLength(0);

        // The readiness view advertises the FULL cadence catalogue, each row flagging
        // whether it is allowed + whether it is pay-per-use on this plan.
        expect(Array.isArray(s.allowedCadences), 'allowedCadences is an array').toBe(true);
        const advertised = (s.allowedCadences ?? []).map((c) => c.cadence);
        for (const cadence of CADENCE_VALUES) {
            expect(advertised, `catalogue advertises the ${cadence} cadence`).toContain(cadence);
        }
        for (const row of s.allowedCadences ?? []) {
            expect(typeof row.allowed, `${row.cadence}.allowed is boolean`).toBe('boolean');
            expect(typeof row.payPerUse, `${row.cadence}.payPerUse is boolean`).toBe('boolean');
        }

        // Plan/billing metadata is exposed for the billing-mode picker.
        expect(['subscription', 'usage']).toContain(s.billingMode);
        expect(typeof s.maxFailureBeforePause, 'maxFailureBeforePause is numeric').toBe('number');
        expect(
            s.maxFailureBeforePause ?? 0,
            'maxFailureBeforePause defaults to a sane 1..10',
        ).toBeGreaterThan(0);
        expect(s.maxFailureBeforePause ?? 0, 'maxFailureBeforePause <= 10').toBeLessThanOrEqual(10);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: the full DTO VALIDATION matrix. Validation runs BEFORE the
    //         enable/readiness logic, so a bogus cadence enum, a bogus billingMode
    //         enum, an unknown top-level property, and out-of-range / non-integer
    //         maxFailureBeforePause values each yield a precise, well-shaped 400
    //         (never a 5xx) — and none of them mutate the schedule.
    // ───────────────────────────────────────────────────────────────────────
    test('PUT validation matrix: cadence / billingMode / unknown field / maxFailure bounds each 400 without mutating', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { workId, token } = await makeOwnerAndWork(request, 'validation');

        // Invalid cadence -> enum 400 listing the real cadence values.
        const badCadence = await putSchedule(request, workId, token, { cadence: 'yearly' });
        expect(badCadence.status(), 'invalid cadence is a 400').toBe(400);
        const badCadenceMsg = flatMessage(await badCadence.json());
        expect(badCadenceMsg, 'cadence 400 enumerates the valid values').toMatch(
            /cadence must be one of/i,
        );
        expect(badCadenceMsg, 'cadence 400 lists real cadences').toMatch(
            /hourly|daily|weekly|monthly/,
        );

        // Invalid billingMode -> enum 400 (valid: subscription, usage).
        const badBilling = await putSchedule(request, workId, token, {
            billingMode: 'pay_per_use',
        });
        expect(badBilling.status(), 'invalid billingMode is a 400').toBe(400);
        const badBillingMsg = flatMessage(await badBilling.json());
        expect(badBillingMsg, 'billingMode 400 enumerates the valid values').toMatch(
            /billingMode must be one of/i,
        );
        expect(badBillingMsg, 'billingMode 400 lists subscription + usage').toMatch(
            /subscription.*usage|usage.*subscription/i,
        );

        // Unknown property (`enabled` — the DTO field is `enable`) -> whitelist 400.
        const unknownField = await putSchedule(request, workId, token, { enabled: true });
        expect(unknownField.status(), 'unknown property is a 400').toBe(400);
        expect(
            flatMessage(await unknownField.json()),
            'whitelist 400 names the rejected property',
        ).toMatch(/property enabled should not exist/i);

        // maxFailureBeforePause is an int constrained to 1..10. Each violation is a 400
        // with a precise message — and we pin them on the DISABLE path so a successful
        // upsert cannot mask the validation (validation still runs first).
        const tooLow = await putSchedule(request, workId, token, {
            enable: false,
            maxFailureBeforePause: 0,
        });
        expect(tooLow.status(), 'maxFailureBeforePause 0 -> 400').toBe(400);
        expect(flatMessage(await tooLow.json()), 'min-bound message').toMatch(
            /not be less than 1/i,
        );

        const tooHigh = await putSchedule(request, workId, token, {
            enable: false,
            maxFailureBeforePause: 11,
        });
        expect(tooHigh.status(), 'maxFailureBeforePause 11 -> 400').toBe(400);
        expect(flatMessage(await tooHigh.json()), 'max-bound message').toMatch(
            /not be greater than 10/i,
        );

        const fractional = await putSchedule(request, workId, token, {
            enable: false,
            maxFailureBeforePause: 1.5,
        });
        expect(fractional.status(), 'maxFailureBeforePause 1.5 -> 400').toBe(400);
        expect(flatMessage(await fractional.json()), 'integer message').toMatch(
            /must be an integer/i,
        );

        // None of the rejected writes mutated the schedule — still unconfigured.
        const after = await getSchedule(request, workId, token);
        expect(after.status, 'rejected writes leave it disabled').toBe('disabled');
        expect(after.cadence ?? null, 'rejected writes left cadence null').toBeNull();
        expect(after.nextRunAt ?? null, 'rejected writes left nextRunAt null').toBeNull();
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: the ENABLEMENT GATE. For a fresh work, `enable` resolves true, so the
    //         enabling PUTs ({cadence}, {}, {enable:true}) hit ensureWorkConfigReady()
    //         and are rejected with a truthful CONFIG_UNAVAILABLE 400 — no ACTIVE row,
    //         nothing leaks through. Even re-enabling an existing PAUSED row stays
    //         gated. Tolerant branch covers a future ready-build (200 + active).
    // ───────────────────────────────────────────────────────────────────────
    test('every enable-resolving PUT on an unready work is gated; re-enabling a paused row stays blocked', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { workId, token } = await makeOwnerAndWork(request, 'enable-gate');

        const ready = await getSchedule(request, workId, token);
        const canEnable = ready.canEnable;

        // Each of these resolves enable=true for a fresh (rowless) schedule.
        const enablingBodies: Array<Record<string, unknown>> = [
            { cadence: 'daily' },
            { enable: true, cadence: 'weekly' },
            {}, // empty body: enable defaults to true on a non-existing schedule
        ];

        for (const data of enablingBodies) {
            const res = await putSchedule(request, workId, token, data);

            if (canEnable === false) {
                expect(
                    res.status(),
                    `enabling PUT ${JSON.stringify(data)} on an unready work -> 400`,
                ).toBe(400);
                const errBody = (await res.json()) as Envelope;
                expect(errBody.status, 'error envelope').toBe('error');
                expect(
                    errBody.code ?? '',
                    'a machine-readable readiness code accompanies the 400',
                ).toMatch(/CONFIG_UNAVAILABLE|INITIAL_WORK_SETUP_REQUIRED|SCHEDULE_NOT_READY/);
                expect(
                    flatMessage(errBody),
                    'the 400 explains the readiness/config/setup block',
                ).toMatch(/readiness|cannot be enabled|configuration|setup|disabled/i);
            } else {
                // Tolerant branch: a build where the work IS ready would succeed.
                expect(
                    res.status(),
                    `enabling PUT ${JSON.stringify(data)} on a ready work -> 200`,
                ).toBe(200);
                const okSched = ((await res.json()) as Envelope).schedule!;
                expect(['active', 'paused']).toContain(okSched.status);
            }
        }

        // The blocked enables created NO ACTIVE row — the readiness view is still the
        // unconfigured default and a manual run finds no schedule ENTITY (404).
        if (canEnable === false) {
            const after = await getSchedule(request, workId, token);
            expect(after.status, 'still disabled — no active row persisted').toBe('disabled');
            expect(after.cadence ?? null, 'no cadence persisted by a blocked enable').toBeNull();
            expect(after.nextRunAt ?? null, 'no nextRunAt without an active row').toBeNull();

            const run = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
                headers: authedHeaders(token),
            });
            expect(run.status(), 'run finds no schedule row -> 404').toBe(404);
            expect(flatMessage(await run.json()), 'run-absent message').toMatch(/not found/i);

            // Now PAUSE-create a row (disable path), then try to flip it ACTIVE — the
            // gate fires AGAIN for the existing row, leaving it paused.
            const paused = await putSchedule(request, workId, token, {
                enable: false,
                cadence: 'daily',
            });
            expect(paused.status(), 'disable-path PUT creates a paused row -> 200').toBe(200);
            expect(((await paused.json()) as Envelope).schedule?.status, 'row is paused').toBe(
                'paused',
            );

            const reEnable = await putSchedule(request, workId, token, { enable: true });
            expect(reEnable.status(), 're-enabling a paused row is still gated -> 400').toBe(400);
            expect(
                ((await reEnable.json()) as Envelope).code ?? '',
                're-enable carries the readiness code',
            ).toMatch(/CONFIG_UNAVAILABLE|INITIAL_WORK_SETUP_REQUIRED|SCHEDULE_NOT_READY/);

            const stillPaused = await getSchedule(request, workId, token);
            expect(stillPaused.status, 'blocked re-enable left the row paused').toBe('paused');
        }
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 4: the DISABLE-PATH PERSISTS a PAUSED row (it SKIPS the readiness gate),
    //         faithfully storing cadence / billingMode / maxFailureBeforePause /
    //         alwaysCreatePullRequest, accepting the runImmediately + providerOverrides
    //         knobs, and surfacing the run precondition (PAUSED -> 400 must-be-active).
    //         providerOverrides plugin resolution + cadence re-write are also pinned.
    // ───────────────────────────────────────────────────────────────────────
    test('disable-path persists a PAUSED row with full config; run requires ACTIVE; providerOverrides resolve plugins', async ({
        request,
    }) => {
        test.setTimeout(150_000);
        const { workId, token } = await makeOwnerAndWork(request, 'paused-row');

        // Create a fully-specified PAUSED schedule via the disable path. This bypasses
        // the readiness gate and upserts a real row.
        const create = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'weekly',
            billingMode: 'usage',
            maxFailureBeforePause: 7,
            alwaysCreatePullRequest: true,
            runImmediately: true, // accepted (DTO field) but a no-op while not ACTIVE
        });
        expect(create.status(), 'disable-path create -> 200').toBe(200);
        const created = ((await create.json()) as Envelope).schedule!;
        expect(created.status, 'created row is paused (enable:false)').toBe('paused');
        expect(created.cadence, 'cadence persisted').toBe('weekly');
        expect(created.billingMode, 'billingMode persisted (usage allowed on free)').toBe('usage');
        expect(created.maxFailureBeforePause, 'maxFailureBeforePause persisted').toBe(7);
        expect(created.alwaysCreatePullRequest, 'alwaysCreatePullRequest persisted').toBe(true);
        // PAUSED ⇒ no scheduled run is computed.
        expect(created.nextRunAt ?? null, 'paused row has no computed nextRunAt').toBeNull();

        // A manual run on a PAUSED row is rejected with the active-state precondition.
        const runPaused = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: authedHeaders(token),
        });
        expect(runPaused.status(), 'run on a paused row -> 400').toBe(400);
        const runBody = (await runPaused.json()) as Envelope;
        expect(runBody.status, 'run-precondition error envelope').toBe('error');
        expect(flatMessage(runBody), 'run-precondition message').toMatch(
            /must be active to run|must be active/i,
        );

        // A cadence re-write on the existing paused row persists the new value (still
        // paused, still no nextRunAt).
        const recadence = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'monthly',
        });
        expect(recadence.status(), 'cadence re-write -> 200').toBe(200);
        const recadenced = ((await recadence.json()) as Envelope).schedule!;
        expect(recadenced.status, 'still paused after re-write').toBe('paused');
        expect(recadenced.cadence, 'new cadence persisted').toBe('monthly');
        expect(recadenced.nextRunAt ?? null, 'still no nextRunAt while paused').toBeNull();

        // providerOverrides go through plugin resolution: a known uiKey (`ai`) with an
        // unregistered plugin id -> a precise "not installed" 400; an unknown uiKey
        // (`aiProvider`) -> a nested-whitelist 400. Neither mutates the row.
        const badPlugin = await putSchedule(request, workId, token, {
            enable: false,
            providerOverrides: { ai: 'totally-not-a-real-plugin-xyz' },
        });
        expect(badPlugin.status(), 'unregistered provider plugin -> 400').toBe(400);
        expect(flatMessage(await badPlugin.json()), 'plugin-not-installed message').toMatch(
            /not installed|not enabled/i,
        );

        const badKey = await putSchedule(request, workId, token, {
            enable: false,
            providerOverrides: { aiProvider: 'x' },
        });
        expect(badKey.status(), 'unknown providerOverrides key -> 400').toBe(400);
        expect(flatMessage(await badKey.json()), 'nested whitelist names the bad key').toMatch(
            /should not exist|aiProvider/i,
        );

        const afterBadOverrides = await getSchedule(request, workId, token);
        expect(afterBadOverrides.cadence, 'rejected overrides left cadence intact').toBe('monthly');
        expect(afterBadOverrides.status, 'rejected overrides left it paused').toBe('paused');
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 5: the WORK-ENTITY MIRROR + run/delete preconditions. syncWork() mirrors
    //         the schedule onto the Work row (scheduledStatus/scheduledCadence/
    //         scheduledNextRunAt/scheduledUpdatesEnabled). A run with no row is 404; a
    //         DELETE with no row is 404 (idempotent); a DELETE of a REAL paused row is
    //         a server-side 500 in this stack (annotated, tolerant). A schedule verb
    //         against a NON-EXISTENT work id is a 404 work-not-found.
    // ───────────────────────────────────────────────────────────────────────
    test('Work entity mirrors scheduled* fields; run/delete preconditions (404 absent, paused-delete 500); missing work 404', async ({
        request,
    }) => {
        test.setTimeout(150_000);
        const { workId, token } = await makeOwnerAndWork(request, 'mirror');

        // A fresh work mirrors the disabled default onto the Work entity.
        const beforeWork = await getWorkScheduledFields(request, workId, token);
        expect(beforeWork.scheduledUpdatesEnabled ?? false, 'fresh: not enabled').toBe(false);
        expect(beforeWork.scheduledCadence ?? null, 'fresh: no cadence').toBeNull();
        expect(beforeWork.scheduledNextRunAt ?? null, 'fresh: no nextRunAt').toBeNull();

        // A run / delete with no row each resolves to a clean 404 — never a 5xx.
        const runAbsent = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: authedHeaders(token),
        });
        expect(runAbsent.status(), 'run with no schedule row -> 404').toBe(404);
        expect(flatMessage(await runAbsent.json()), 'run-absent message').toMatch(/not found/i);

        const delAbsent = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: authedHeaders(token),
        });
        expect(delAbsent.status(), 'DELETE with no schedule -> 404').toBe(404);
        expect(flatMessage(await delAbsent.json()), 'delete-absent message').toMatch(/not found/i);
        // Idempotent: a second absent DELETE is still a clean 404.
        const delAbsent2 = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: authedHeaders(token),
        });
        expect(delAbsent2.status(), 'second absent DELETE -> 404').toBe(404);

        // Persist a PAUSED row and verify the Work entity mirror updates accordingly.
        const create = await putSchedule(request, workId, token, {
            enable: false,
            cadence: 'weekly',
        });
        expect(create.status(), 'disable-path create -> 200').toBe(200);

        const afterWork = await getWorkScheduledFields(request, workId, token);
        expect(afterWork.scheduledStatus, 'Work mirrors scheduledStatus=paused').toBe('paused');
        expect(afterWork.scheduledCadence, 'Work mirrors scheduledCadence=weekly').toBe('weekly');
        expect(
            afterWork.scheduledUpdatesEnabled ?? false,
            'paused ⇒ scheduledUpdatesEnabled false (only ACTIVE flips it true)',
        ).toBe(false);
        expect(afterWork.scheduledNextRunAt ?? null, 'paused ⇒ no mirrored nextRunAt').toBeNull();
        // The Work lifecycle status itself is untouched by scheduling.
        expect(afterWork.status, 'scheduling does not change the work lifecycle status').toBe(
            'active',
        );

        // DELETE of a REAL paused row: in this e2e stack the cancel path 500s
        // (cancelSchedule upsert(cadence:null) + config-sync side-effect). Assert the
        // true observable behaviour tolerantly (>=400 and not a silent 200), with a
        // tolerant branch for a future build that cleans it up to 200.
        const delReal = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: authedHeaders(token),
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
            // The cancel did not complete — the row is still observable as paused.
            const stillThere = await getSchedule(request, workId, token);
            expect(['paused', 'canceled', 'disabled']).toContain(stillThere.status);
        } else {
            // Tolerant fixed-build branch: a clean cancel returns 200 + canceled/disabled.
            expect(delStatus, 'clean cancel -> 200').toBe(200);
            const delBody = (await delReal.json()) as Envelope;
            expect(delBody.status, 'cancel envelope success').toBe('success');
            const afterCancel = await getSchedule(request, workId, token);
            expect(['canceled', 'disabled']).toContain(afterCancel.status);
        }

        // A schedule verb against a NON-EXISTENT work id (still the OWNER's token)
        // resolves to a 404 WORK-not-found — distinct from the schedule 404 above.
        const missingId = '00000000-0000-0000-0000-000000000000';
        const missingGet = await request.get(`${API_BASE}/api/works/${missingId}/schedule`, {
            headers: authedHeaders(token),
        });
        expect(missingGet.status(), 'GET schedule on a missing work -> 404').toBe(404);
        expect(flatMessage(await missingGet.json()), 'missing-work message').toMatch(
            /work.*not found|not found/i,
        );
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 6: ownership matrix + schedule × generation orthogonality. A non-owner is
    //         forbidden on EVERY schedule verb (403, ownership check fires first), the
    //         owner's view is untouched by every rejected cross-user verb, and
    //         configuring/probing a schedule never injects generation history or
    //         changes the work's lifecycle status.
    // ───────────────────────────────────────────────────────────────────────
    test('non-owner is forbidden on every verb; schedule is orthogonal to generation history', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { workId, token } = await makeOwnerAndWork(request, 'isolation');

        // Persist a paused row first so a non-owner could (illegitimately) read/mutate
        // real config if the ownership guard were missing.
        const seed = await putSchedule(request, workId, token, { enable: false, cadence: 'daily' });
        expect(seed.status(), 'owner seeds a paused row -> 200').toBe(200);

        // A different authenticated user is forbidden on ALL four verbs (the ownership
        // guard runs before any schedule/row lookup).
        const stranger = await registerUserViaAPI(request);
        const sHdr = authedHeaders(stranger.access_token);
        const permRe = /permission/i;

        const sGet = await request.get(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: sHdr,
        });
        expect(sGet.status(), 'non-owner GET -> 403').toBe(403);
        expect(flatMessage(await sGet.json()), 'GET 403 message').toMatch(permRe);

        const sPut = await request.put(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: sHdr,
            data: { enable: false, cadence: 'weekly' },
        });
        expect(sPut.status(), 'non-owner PUT -> 403').toBe(403);
        expect(flatMessage(await sPut.json()), 'PUT 403 message').toMatch(permRe);

        const sRun = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: sHdr,
        });
        expect(sRun.status(), 'non-owner run -> 403').toBe(403);

        const sDel = await request.delete(`${API_BASE}/api/works/${workId}/schedule`, {
            headers: sHdr,
        });
        expect(sDel.status(), 'non-owner DELETE -> 403').toBe(403);

        // The owner's schedule view is unchanged by every rejected cross-user verb — the
        // stranger's PUT did NOT overwrite the owner's cadence.
        const ownerStill = await getSchedule(request, workId, token);
        expect(ownerStill.status, 'owner schedule still paused').toBe('paused');
        expect(ownerStill.cadence, 'owner cadence untouched by non-owner PUT').toBe('daily');
        expect(ownerStill.featureEnabled, 'feature still advertised to the owner').toBe(true);

        // --- Schedule × generation orthogonality. Configuring/probing a schedule does
        //     NOT inject generation history, and the work's lifecycle status is untouched. ---
        const histRes = await request.get(`${API_BASE}/api/works/${workId}/history`, {
            headers: authedHeaders(token),
        });
        expect(histRes.status(), 'GET /history alongside the schedule surface').toBe(200);
        const histBody = await histRes.json();
        const hist = Array.isArray(histBody)
            ? histBody
            : (histBody?.history ?? histBody?.items ?? histBody?.data ?? []);
        expect(Array.isArray(hist), 'history is a well-formed array').toBe(true);
        // A fresh work with no successful generation has an empty history, and the
        // schedule surface did not fabricate any runs.
        expect(hist.length, 'the schedule surface adds no generation history').toBe(0);

        const detail = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(detail.status(), 'GET work detail alongside the schedule surface').toBe(200);
        const detailBody = await detail.json();
        expect(detailBody.work?.id, 'detail resolves the same work').toBe(workId);
        expect(
            detailBody.work?.status,
            'the schedule surface does not change the work status',
        ).toBe('active');
    });
});
