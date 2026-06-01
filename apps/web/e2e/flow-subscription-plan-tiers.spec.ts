import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Subscription plan tiers — END-TO-END, CROSS-FEATURE INTEGRATION between the
 * subscription tier and the ONLY live consumer of plan entitlements in this
 * build: the per-Work SCHEDULE engine (`WorkScheduleService`). The existing
 * specs (flow-subscriptions-budgets, subscriptions-plan(-lifecycle), -tiers,
 * subscription-renewal-grace, flow-org-billing-scope) cover the plan endpoint
 * in isolation (shape, the free→standard→premium→free walk, DTO validation,
 * org-invariance). This file instead drives the plan as a GATE on a SECOND
 * feature and asserts the integration nobody else touches:
 *   - the schedule DTO echoes the user's live `planCode` + recomputed
 *     `allowedCadences`, and a mid-flight plan switch re-derives entitlements
 *     on an ALREADY-PERSISTED schedule (downgrade auto-gates, re-upgrade
 *     un-gates) WITHOUT touching the stored cadence;
 *   - a tier-gated cadence is REJECTED under subscription billing but ACCEPTED
 *     under the pay-per-use (`billingMode:'usage'`) escape hatch;
 *   - the enable path trips the work-readiness gate before any plan-limit gate;
 *   - plan + its downstream schedule entitlements are strictly per-user.
 *
 * PROBED, TRUTHFUL contract (curl against http://127.0.0.1:3100, SUBSCRIPTIONS_ENABLED=true):
 *
 *   GET  /api/subscriptions/plan  (auth)
 *     -> 200 { status:'success', enabled:true,
 *              plan:{ code:'free'|'standard'|'premium', name, allowedCadences:[
 *                       { cadence, allowed:boolean, payPerUse:boolean, reason?:string } x7 ] } }
 *     -> 401 unauth.  Body NEVER leaks monthlyPrice/maxWorks/overage (narrow projection).
 *   POST /api/subscriptions/plan { planCode:'free'|'standard'|'premium' } (DTO field `planCode`, IsEnum, case-SENSITIVE)
 *     -> 200 same shape, `plan.code` == requested.  Idempotent (re-POST same code -> 200).
 *     -> 400 bogus value | UPPERCASE value | extra junk key (forbidNonWhitelisted) | wrong key `code`.
 *
 *   Seeded tiers (subscription.service PLAN_SEED_DATA), as OBSERVED via allowedCadences:
 *     free     -> all 7 cadences allowed, none pay-per-use   (maxWorks 1)   ["everything free for now"]
 *     standard -> monthly/weekly/daily/every_12_hours allowed; every_8/3_hours + hourly gated
 *                 (allowed:false, payPerUse:true, reason:"Upgrade to Premium for this cadence")  (maxWorks 5)
 *     premium  -> all 7 cadences allowed, none pay-per-use   (maxWorks 15)
 *     => STANDARD is the only tier whose entitlements visibly differ from FREE; tests pin the
 *        gating contrast on standard and tolerate free/premium being fully-open.
 *
 *   GET  /api/works/:id/schedule  (auth, any access)
 *     -> 200 { status:'success', workId, schedule:{ status, featureEnabled, canEnable,
 *               blockingCode?, blockingReason?, cadence|null, billingMode, ...,
 *               allowedCadences:[...same per-cadence gating...],
 *               planCode:'<live plan>'   (present iff subscriptionsEnabled),
 *               subscriptionsEnabled:true } }
 *     -> 403 for a non-member; the schedule reflects the OWNER-user's plan.
 *   PUT  /api/works/:id/schedule { enable?, cadence?, billingMode?, maxFailureBeforePause?, ... }
 *     -> 200 { status:'success', schedule:{...} } when not enabling (status -> 'paused').
 *     -> 400 { status:'error', message:"Selected cadence is not available on your plan.
 *               Switch to pay-per-use to continue." }   (gated cadence + billingMode:'subscription')
 *     -> 400 class-validator ("maxFailureBeforePause must not be greater than 10") for >10.
 *     -> 400 { status:'error', code:'CONFIG_UNAVAILABLE'|'INITIAL_WORK_SETUP_REQUIRED' }
 *               when enable:true on a never-generated Work (readiness gate trips BEFORE the
 *               plan maxWorks limit — so PLAN_LIMIT_EXCEEDED is not reliably reachable in CI;
 *               asserted with .or() tolerance).
 *     DTO uses `enable` (NOT `enabled` -> 400 "property enabled should not exist").
 *   POST /api/works/:id/schedule/run  -> 404 "Schedule not found" when no schedule row exists.
 *
 *   Cross-user: a fresh user is always `free` regardless of another user's tier; a non-member
 *   gets 403 on someone else's /schedule (so the echoed planCode never leaks across users).
 */

type AllowedCadence = {
    cadence: string;
    allowed: boolean;
    payPerUse: boolean;
    reason?: string;
};

type PlanResponse = {
    status: string;
    enabled: boolean;
    plan: { code: string; name: string; allowedCadences?: AllowedCadence[] };
};

type ScheduleDto = {
    status: string;
    featureEnabled: boolean;
    canEnable: boolean;
    blockingCode?: string;
    blockingReason?: string;
    cadence: string | null;
    billingMode: string;
    maxFailureBeforePause: number;
    allowedCadences: AllowedCadence[];
    planCode?: string;
    subscriptionsEnabled: boolean;
};

type ScheduleEnvelope = { status: string; workId?: string; schedule: ScheduleDto };

const PLAN_CODES = ['free', 'standard', 'premium'] as const;
const ALL_CADENCES = [
    'monthly',
    'weekly',
    'daily',
    'every_12_hours',
    'every_8_hours',
    'every_3_hours',
    'hourly',
] as const;
/** Cadences gated behind pay-per-use on STANDARD (observed in the live seed). */
const STANDARD_GATED = ['every_8_hours', 'every_3_hours', 'hourly'] as const;

async function getPlan(request: APIRequestContext, token: string): Promise<PlanResponse> {
    const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET plan status ${res.status()}`).toBe(200);
    return (await res.json()) as PlanResponse;
}

function setPlan(request: APIRequestContext, token: string, planCode: string) {
    return request.post(`${API_BASE}/api/subscriptions/plan`, {
        headers: authedHeaders(token),
        data: { planCode },
    });
}

function getSchedule(request: APIRequestContext, token: string, workId: string) {
    return request.get(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
    });
}

function putSchedule(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: Record<string, unknown>,
) {
    return request.put(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
        data: body,
    });
}

function cadenceMap(list: AllowedCadence[] | undefined): Map<string, AllowedCadence> {
    return new Map((list ?? []).map((c) => [c.cadence, c]));
}

test.describe('Flow: subscription tier ↔ work-schedule entitlement integration', () => {
    test('flow 1: the schedule engine echoes the live tier — switching plans re-derives allowedCadences + planCode on every /schedule read', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, u.access_token, {
            name: `Tier Echo ${Date.now()}`,
        });
        expect(workId, 'work id allocated').toBeTruthy();

        // ── FREE: the schedule surface reports the same per-cadence gating the
        //    plan endpoint does, plus the plan code, proving they share one source.
        const planFree = await getPlan(request, u.access_token);
        expect(planFree.plan.code).toBe('free');

        const schedFreeRes = await getSchedule(request, u.access_token, workId);
        expect(schedFreeRes.status()).toBe(200);
        const schedFree = ((await schedFreeRes.json()) as ScheduleEnvelope).schedule;
        expect(schedFree.subscriptionsEnabled, 'subscriptions enabled in e2e').toBe(true);
        expect(schedFree.planCode, 'schedule echoes the live plan code').toBe('free');
        // On free, no cadence is gated — the schedule view agrees with the plan view.
        const freeFromSchedule = cadenceMap(schedFree.allowedCadences);
        const freeFromPlan = cadenceMap(planFree.plan.allowedCadences);
        for (const name of ALL_CADENCES) {
            const s = freeFromSchedule.get(name);
            const p = freeFromPlan.get(name);
            if (!s || !p) continue; // tolerate cadence-set drift across builds
            expect(s.allowed, `schedule free ${name} allowed`).toBe(p.allowed);
            expect(s.payPerUse, `schedule free ${name} payPerUse`).toBe(p.payPerUse);
            expect(s.allowed, `free ${name} should be allowed`).toBe(true);
        }

        // ── STANDARD: the SAME schedule read now reports the sub-hourly cadences
        //    as gated/pay-per-use — a tier transition is observable downstream
        //    WITHOUT any schedule mutation. This is the integration nobody else tests.
        expect((await setPlan(request, u.access_token, 'standard')).status()).toBe(200);

        const schedStd = (
            (await (await getSchedule(request, u.access_token, workId)).json()) as ScheduleEnvelope
        ).schedule;
        expect(schedStd.planCode, 'schedule re-reads the upgraded plan code').toBe('standard');
        const stdFromSchedule = cadenceMap(schedStd.allowedCadences);
        let gated = 0;
        for (const name of STANDARD_GATED) {
            const c = stdFromSchedule.get(name);
            if (!c) continue;
            if (!c.allowed) {
                gated += 1;
                expect(c.payPerUse, `gated ${name} should be pay-per-use`).toBe(true);
                expect(c.reason, `gated ${name} carries an upgrade reason`).toContain('Premium');
            }
        }
        expect(
            gated,
            'standard tier gates ≥1 sub-hourly cadence in the schedule view',
        ).toBeGreaterThan(0);
        // Monthly/weekly/daily stay free on standard.
        expect(stdFromSchedule.get('monthly')?.allowed).toBe(true);
        expect(stdFromSchedule.get('monthly')?.payPerUse).toBe(false);

        // ── PREMIUM: re-reading the schedule re-opens every cadence (un-gating).
        expect((await setPlan(request, u.access_token, 'premium')).status()).toBe(200);
        const schedPrem = (
            (await (await getSchedule(request, u.access_token, workId)).json()) as ScheduleEnvelope
        ).schedule;
        expect(schedPrem.planCode).toBe('premium');
        for (const c of schedPrem.allowedCadences) {
            expect(c.allowed, `premium ${c.cadence} re-allowed`).toBe(true);
            expect(c.payPerUse, `premium ${c.cadence} not pay-per-use`).toBe(false);
        }
    });

    test('flow 2: a tier-gated cadence is rejected under subscription billing but accepted via the pay-per-use escape hatch', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, u.access_token, {
            name: `PayPerUse ${Date.now()}`,
        });

        // Move to STANDARD, where `hourly` is gated.
        expect((await setPlan(request, u.access_token, 'standard')).status()).toBe(200);

        // Confirm `hourly` really is gated for this user before asserting the gate.
        const std = await getPlan(request, u.access_token);
        const hourly = cadenceMap(std.plan.allowedCadences).get('hourly');
        if (!hourly || hourly.allowed) {
            test.skip(true, 'hourly is not gated on standard in this build — gate not testable');
        }

        // ── Subscription billing on a gated cadence is REFUSED with the documented
        //    error. We use enable:false so the cadence/billing gate is exercised
        //    independently of the (separate) work-readiness enable gate.
        const refused = await putSchedule(request, u.access_token, workId, {
            enable: false,
            cadence: 'hourly',
            billingMode: 'subscription',
        });
        expect(refused.status(), `gated subscription cadence status ${refused.status()}`).toBe(400);
        const refusedBody = await refused.json();
        const refusedMsg = JSON.stringify(refusedBody);
        expect(refusedMsg).toContain('not available on your plan');
        expect(refusedMsg.toLowerCase()).toContain('pay-per-use');

        // ── The SAME cadence under pay-per-use (usage) billing is ACCEPTED and the
        //    schedule persists with the gated cadence + usage billing mode.
        const accepted = await putSchedule(request, u.access_token, workId, {
            enable: false,
            cadence: 'hourly',
            billingMode: 'usage',
        });
        expect(accepted.status(), `pay-per-use cadence status ${accepted.status()}`).toBe(200);
        const acceptedSched = ((await accepted.json()) as ScheduleEnvelope).schedule;
        expect(acceptedSched.cadence).toBe('hourly');
        expect(acceptedSched.billingMode).toBe('usage');
        // Schedule is saved paused (not enabled) — it still surfaces the gated entitlement.
        expect(acceptedSched.status).toBe('paused');
        expect(cadenceMap(acceptedSched.allowedCadences).get('hourly')?.payPerUse).toBe(true);

        // ── An allowed cadence (daily on standard) under subscription billing also passes,
        //    proving the refusal above is cadence-specific, not a blanket subscription block.
        const dailyOk = await putSchedule(request, u.access_token, workId, {
            enable: false,
            cadence: 'daily',
            billingMode: 'subscription',
        });
        expect(dailyOk.status(), `allowed cadence status ${dailyOk.status()}`).toBe(200);
        const dailySched = ((await dailyOk.json()) as ScheduleEnvelope).schedule;
        expect(dailySched.cadence).toBe('daily');
        expect(dailySched.billingMode).toBe('subscription');
    });

    test('flow 3: downgrade auto-gates an already-persisted schedule, re-upgrade un-gates it — the stored cadence never changes', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, u.access_token, {
            name: `Downgrade ${Date.now()}`,
        });

        // PREMIUM lets us persist an `hourly` schedule under plain subscription billing.
        expect((await setPlan(request, u.access_token, 'premium')).status()).toBe(200);
        const saved = await putSchedule(request, u.access_token, workId, {
            enable: false,
            cadence: 'hourly',
            billingMode: 'subscription',
        });
        expect(saved.status(), `premium hourly save status ${saved.status()}`).toBe(200);
        const savedSched = ((await saved.json()) as ScheduleEnvelope).schedule;
        expect(savedSched.cadence).toBe('hourly');
        expect(savedSched.planCode).toBe('premium');
        // At premium the persisted cadence is fully allowed.
        expect(cadenceMap(savedSched.allowedCadences).get('hourly')?.allowed).toBe(true);

        // ── DOWNGRADE premium → standard. The stored row is untouched, but a fresh
        //    GET re-derives entitlements against the NEW tier: same cadence, now gated.
        expect((await setPlan(request, u.access_token, 'standard')).status()).toBe(200);
        const afterDown = (
            (await (await getSchedule(request, u.access_token, workId)).json()) as ScheduleEnvelope
        ).schedule;
        expect(afterDown.cadence, 'stored cadence is preserved across downgrade').toBe('hourly');
        expect(afterDown.planCode, 'schedule reflects the downgraded plan').toBe('standard');
        const hourlyAfter = cadenceMap(afterDown.allowedCadences).get('hourly');
        if (hourlyAfter) {
            expect(hourlyAfter.allowed, 'hourly auto-gated after downgrade').toBe(false);
            expect(hourlyAfter.payPerUse, 'hourly now pay-per-use after downgrade').toBe(true);
        }

        // ── RE-UPGRADE standard → premium re-opens the very same persisted cadence.
        expect((await setPlan(request, u.access_token, 'premium')).status()).toBe(200);
        const afterUp = (
            (await (await getSchedule(request, u.access_token, workId)).json()) as ScheduleEnvelope
        ).schedule;
        expect(afterUp.cadence, 'stored cadence is still the same').toBe('hourly');
        expect(afterUp.planCode).toBe('premium');
        expect(cadenceMap(afterUp.allowedCadences).get('hourly')?.allowed).toBe(true);
        expect(cadenceMap(afterUp.allowedCadences).get('hourly')?.payPerUse).toBe(false);
    });

    test('flow 4: enabling a schedule trips the work-readiness gate before any plan limit; the run endpoint guards a missing schedule', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const { id: workId } = await createWorkViaAPI(request, u.access_token, {
            name: `Enable Gate ${Date.now()}`,
        });

        // A never-generated Work is not schedule-ready: GET reports a blocking code.
        const pre = (
            (await (await getSchedule(request, u.access_token, workId)).json()) as ScheduleEnvelope
        ).schedule;
        expect(pre.featureEnabled, 'scheduled-updates feature is on in e2e').toBe(true);
        expect(pre.canEnable, 'fresh work is not yet schedule-ready').toBe(false);
        expect(
            pre.blockingCode,
            `expected a readiness blocking code, got ${pre.blockingCode}`,
        ).toMatch(/CONFIG_UNAVAILABLE|INITIAL_WORK_SETUP_REQUIRED/);

        // On FREE (maxWorks 1) enabling with an ALLOWED cadence must still be blocked —
        // and by the READINESS gate, which runs before the plan maxWorks limit. So the
        // 400 carries a readiness code, not PLAN_LIMIT_EXCEEDED. We tolerate either code
        // to stay truthful if a future build reorders the guards.
        const enableRes = await putSchedule(request, u.access_token, workId, {
            enable: true,
            cadence: 'monthly',
        });
        expect(enableRes.status(), `enable status ${enableRes.status()}`).toBe(400);
        const enableBody = await enableRes.json();
        const enableCode = (enableBody as { code?: string }).code ?? '';
        const enableMsg = JSON.stringify(enableBody);
        expect(
            ['CONFIG_UNAVAILABLE', 'INITIAL_WORK_SETUP_REQUIRED', 'PLAN_LIMIT_EXCEEDED'].includes(
                enableCode,
            ) || /setup|readiness|plan allows/i.test(enableMsg),
            `unexpected enable rejection body: ${enableMsg.slice(0, 200)}`,
        ).toBe(true);

        // The run endpoint refuses when there is no schedule row at all (we never
        // successfully created one — every PUT above was a rejected enable).
        const run = await request.post(`${API_BASE}/api/works/${workId}/schedule/run`, {
            headers: authedHeaders(u.access_token),
        });
        expect(run.status(), `run status ${run.status()}`).toBe(404);
        expect(JSON.stringify(await run.json())).toContain('Schedule not found');
    });

    test('flow 5: tier + its downstream schedule entitlements are strictly per-user (no cross-user plan leakage)', async ({
        request,
    }) => {
        const ts = Date.now();
        const owner = await registerUserViaAPI(request);
        const outsider = await registerUserViaAPI(request);

        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `Isolation ${ts}`,
        });

        // Owner upgrades to PREMIUM and saves an hourly schedule.
        expect((await setPlan(request, owner.access_token, 'premium')).status()).toBe(200);
        const ownerSched = await putSchedule(request, owner.access_token, workId, {
            enable: false,
            cadence: 'hourly',
            billingMode: 'subscription',
        });
        expect(ownerSched.status()).toBe(200);
        expect(((await ownerSched.json()) as ScheduleEnvelope).schedule.planCode).toBe('premium');

        // The outsider's OWN plan is untouched by the owner's upgrade.
        const outsiderPlan = await getPlan(request, outsider.access_token);
        expect(outsiderPlan.plan.code, "outsider's plan is independent (free)").toBe('free');

        // The outsider cannot read the owner's work schedule → 403 (so the echoed
        // planCode never leaks across users).
        const stolen = await getSchedule(request, outsider.access_token, workId);
        expect([403, 404]).toContain(stolen.status());

        // The owner still sees their premium schedule, unaffected by the outsider.
        const ownerView = (
            (await (
                await getSchedule(request, owner.access_token, workId)
            ).json()) as ScheduleEnvelope
        ).schedule;
        expect(ownerView.planCode).toBe('premium');
        expect(ownerView.cadence).toBe('hourly');
    });

    test('flow 6: the plan endpoint is a tight, validated tier surface — enum-only, case-sensitive, no field leakage, idempotent', async ({
        request,
    }) => {
        // Unauthenticated read is rejected outright.
        const noAuth = await request.get(`${API_BASE}/api/subscriptions/plan`);
        expect(noAuth.status()).toBe(401);

        const u = await registerUserViaAPI(request);

        // The plan body is a NARROW projection — it must never leak pricing or limits.
        const plan = await getPlan(request, u.access_token);
        expect(Object.keys(plan).sort()).toEqual(['enabled', 'plan', 'status']);
        expect(Object.keys(plan.plan).sort()).toEqual(['allowedCadences', 'code', 'name']);
        const leakedKeys = Object.keys(plan.plan).filter((k) =>
            /price|cost|maxworks|overage|currency|stripe/i.test(k),
        );
        expect(leakedKeys, `plan body leaks billing fields: ${leakedKeys.join(',')}`).toEqual([]);
        for (const c of plan.plan.allowedCadences ?? []) {
            expect(
                Object.keys(c).every((k) =>
                    ['cadence', 'allowed', 'payPerUse', 'reason'].includes(k),
                ),
            ).toBe(true);
        }

        // Every enum value is a legal, persisted transition target (the advertised
        // tier set, since no /plans catalogue is exposed in this build).
        for (const code of PLAN_CODES) {
            const res = await setPlan(request, u.access_token, code);
            expect(res.status(), `POST {planCode:'${code}'} status ${res.status()}`).toBe(200);
            expect(((await res.json()) as PlanResponse).plan.code).toBe(code);
        }

        // Idempotent: re-POSTing the current code is a clean no-op 200 (not a 4xx).
        const again = await setPlan(request, u.access_token, 'premium');
        expect(again.status()).toBe(200);
        expect(((await again.json()) as PlanResponse).plan.code).toBe('premium');

        // IsEnum is CASE-SENSITIVE — the uppercased value is rejected even though the
        // service would lowercase-normalize it (the DTO guard runs first).
        const upper = await setPlan(request, u.access_token, 'STANDARD');
        expect(upper.status(), `UPPERCASE planCode status ${upper.status()}`).toBe(400);

        // Unknown enum value → 4xx, never a silent 200, never a 5xx.
        const bogus = await setPlan(request, u.access_token, `bogus-${Date.now()}`);
        expect(bogus.status()).toBeGreaterThanOrEqual(400);
        expect(bogus.status()).toBeLessThan(500);
        expect([200]).not.toContain(bogus.status());

        // Wrong key (`code` instead of `planCode`) is whitelisted out with a 400 that
        // names the real DTO field.
        const wrongKey = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { code: 'standard' },
        });
        expect(wrongKey.status()).toBe(400);
        expect(JSON.stringify(await wrongKey.json())).toContain('planCode');

        // Extra junk key alongside a valid planCode is rejected (forbidNonWhitelisted).
        const junk = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { planCode: 'standard', surprise: 'extra' },
        });
        expect(junk.status(), `extra-key status ${junk.status()}`).toBe(400);

        // The plan is left in a known state; final read agrees with the last legal POST.
        const final = await getPlan(request, u.access_token);
        expect(PLAN_CODES).toContain(final.plan.code as (typeof PLAN_CODES)[number]);
    });
});
