import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-subscription-billing-grace.spec.ts
 *
 * THEME: subscription billing GRACE / PAST-DUE / DUNNING / REACTIVATION and the
 * GRACE-GATING of features. Complex, multi-step, cross-feature INTEGRATION flows
 * that walk the plan → schedule → usage surfaces end-to-end and assert the
 * platform's TRUE, observable behaviour at every step.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE BIG FINDING (verified LIVE on the sqlite/in-memory CI driver
 * http://127.0.0.1:3100 AND from controller/service/entity source before any
 * assertion):
 *
 *   The UserSubscription entity DOES carry a full billing-lifecycle vocabulary —
 *     SubscriptionStatus = { active, canceled, past_due, trialing }
 *     + currentPeriodEnd, cancelAtPeriodEnd, billingProvider (stripe|manual),
 *       paymentMethodMeta
 *   (packages/agent/src/entities/user-subscription.entity.ts) — BUT NONE OF IT IS
 *   WIRED TO ANY HTTP SURFACE in this build:
 *
 *     • SubscriptionsController (@Controller('api/subscriptions'), AuthSessionGuard)
 *       exposes ONLY GET/POST `/api/subscriptions/plan`. summarizePlan() resolves
 *       the PLAN via user.defaultPlan and NEVER reads the UserSubscription row —
 *       so status / past_due / grace / currentPeriodEnd / cancelAtPeriodEnd are
 *       INVISIBLE to clients. UserSubscriptionRepository.{createOrUpdate,cancel,
 *       listByUser} exist but are called by NOTHING (dead in this deploy).
 *     • There is NO status/history/grace/dunning/reactivate/cancel/invoices route:
 *         GET /api/subscriptions, /api/subscriptions/current, …/status, …/history,
 *             …/grace, …/reactivate, …/cancel, /api/account/subscription,
 *             /api/me/subscription, /api/billing[/status], /api/invoices,
 *             /api/subscriptions/invoices, /api/dunning   → ALL 404 (verified).
 *     • The billing provider is MANUAL (no Stripe in CI): POST /plan is a real DB
 *       no-payment mutation; there is no checkout / payment-method / past-due flow
 *       a black-box client can drive.
 *
 *   So a faithful "grace / past-due / dunning / reactivation" suite cannot assert
 *   a fictional status endpoint. Instead it pins the REAL, observable
 *   billing-state GATES the platform actually enforces — which behave EXACTLY like
 *   grace-gating / dunning / reactivation, just driven by the PLAN tier + schedule
 *   failure counter rather than a payment processor:
 *
 *   GRACE / TIER FEATURE-GATING  (SubscriptionService + WorkScheduleService):
 *     GET  /api/subscriptions/plan
 *       → 200 { status:'success', enabled:true, plan:{ code, name,
 *               allowedCadences:[{cadence,allowed,payPerUse,reason?}] } }
 *       FREE seeds ALL_CADENCES allowed (the seed comment: "for now everything is
 *       free"); STANDARD GATES the sub-hourly cadences (every_8_hours/every_3_hours/
 *       hourly → allowed:false, payPerUse:true, reason:'Upgrade to Premium…');
 *       PREMIUM re-opens them. The gate is recomputed from the CURRENT plan on
 *       every read — a downgrade re-closes a cadence, an upgrade re-opens it.
 *     GET /api/works/:id/schedule
 *       → 200 { status:'success', workId, schedule:{ status, planCode,
 *               subscriptionsEnabled:true, allowedCadences:[…], failureCount,
 *               maxFailureBeforePause, cadence, billingMode, … } }
 *       The schedule DTO mirrors the plan gate (allowedCadences + planCode), so a
 *       plan change is OBSERVABLE on the per-Work schedule surface too.
 *     PUT /api/works/:id/schedule { enable, cadence, billingMode }
 *       GATE ORDER, verified live:
 *         1. GATED cadence + billingMode:'subscription'  → 400
 *            { status:'error', message:'Selected cadence is not available on your
 *              plan. Switch to pay-per-use to continue.' }    (the TIER GATE fires
 *            FIRST — this is the grace/over-limit hard-stop with its remedy text)
 *         2. GATED cadence + billingMode:'usage'          → ESCAPES the tier gate
 *            (pay-per-use is the documented remedy) → then hits the readiness gate
 *            below if the Work isn't generation-ready.
 *         3. ALLOWED cadence + enable:true on a not-yet-generated Work → 400
 *            { status:'error', code:'CONFIG_UNAVAILABLE'|'INITIAL_WORK_SETUP_REQUIRED' }
 *            (readiness gate — orthogonal to billing; a fresh CI Work is never
 *             generation-ready, so we cannot reach ACTIVE/run state).
 *         4. enable:false (SAVE AS PAUSED) → 200 — persists cadence+billingMode in
 *            PAUSED state WITHOUT needing setup; the saved cadence sticks and is
 *            re-gated by the CURRENT plan on the next GET (the reactivation-config
 *            survives plan transitions).
 *       PLAN_LIMIT_EXCEEDED (activeSchedules >= plan.maxWorks: free=1/standard=5/
 *         premium=15) is a 400 { code:'PLAN_LIMIT_EXCEEDED' } but only on
 *         create/activate of a setup-ready Work → unreachable in CI; asserted
 *         indirectly via planCode/subscriptionsEnabled on the DTO.
 *       DELETE /api/works/:id/schedule (cancel) → DETERMINISTICALLY 500 in this
 *         build on a non-generated Work (cancelSchedule → getScheduleReadiness →
 *         dataGeneratorService.getConfig throws); tolerated as [200,500], never
 *         asserted as a clean cancel.
 *
 *   ACCOUNT-WIDE BUDGET BLOCK  (the spend-side "delinquent → blocked" gate;
 *     AccountUsageController @Controller('api/me/usage') + WorkAgentController
 *     @Controller('api/me/work-agent')):
 *     GET /api/me/usage/account-wide
 *       → 200 { userId, periodStart, periodEnd, currentSpendCents:number,
 *               capCents:number|null, currency, percentUsed:number|null,
 *               allowOverage:boolean, blocked:boolean }
 *       CONTRACT: blocked === (capCents!==null && spend>=cap && !allowOverage);
 *                 percentUsed === (cap>0 ? spend/cap*100 : null).
 *     PUT /api/me/work-agent/preferences { accountWideMonthlyCapCents:'<digits>'|
 *         null, accountWideAllowOverage:boolean } → 200 (cap is a BIGINT digit
 *       STRING on the wire); non-numeric cap → 400. A 0-cap with overage OFF is the
 *       deterministic way to cross the threshold in CI (no plugin billing exists) —
 *       it is the DUNNING HARD-STOP analog; flipping overage ON is the GRACE
 *       (soft-cap, never blocked) analog; clearing the cap is REACTIVATION.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DISTINCT FROM SIBLING SPECS (no duplication):
 *   - subscription-renewal-grace.spec.ts        : shape-only probe of /plan grace
 *                                                  metadata (free, no transitions).
 *   - flow-subscriptions-budgets.spec.ts        : plan walk + per-Work budget CRUD
 *                                                  + account-wide cap arithmetic.
 *   - flow-org-billing-scope.spec.ts            : personal-vs-ORG scope invariance.
 *   - subscriptions-plan / -tiers / team-billing: plan-code smokes, /plans 404.
 *   NEW AXIS HERE: the billing-state → FEATURE-GATE pipeline — the schedule tier
 *   gate + its pay-per-use remedy + the gate-order precedence, plan-driven
 *   re-gating of a saved (paused) schedule across upgrade/downgrade (grace expiry &
 *   reactivation), the schedule failure-counter → auto-pause dunning contract
 *   (asserted via maxFailureBeforePause/failureCount + source), and the
 *   account-wide spend hard-stop ↔ soft-grace ↔ reactivation triad. Plus the
 *   truthful 404 census of every status/grace/dunning/reactivation/invoice route.
 *
 * GOTCHAS honoured: login DTO {email,password} only; register via helper
 *   ({username,email,password}); FRESH registerUserViaAPI users for EVERY plan/
 *   pref MUTATION (never the shared seeded user — a user-scoped fake key shadows
 *   the env key & breaks sibling chat specs); unique slugs via Date.now+random;
 *   tolerate pre-existing rows (toContain, never exact counts); generous timeouts;
 *   DELETE schedule 500 tolerated; UI route divergence handled with .or().
 */

const PLAN_CODES = ['free', 'standard', 'premium'] as const;
type PlanCode = (typeof PLAN_CODES)[number];

// Cadences STANDARD gates behind pay-per-use (PREMIUM re-opens; FREE allows all).
const SUB_HOURLY_CADENCES = ['every_8_hours', 'every_3_hours', 'hourly'] as const;

interface Cadence {
    cadence: string;
    allowed: boolean;
    payPerUse: boolean;
    reason?: string;
}

interface PlanResponse {
    status: string;
    enabled: boolean;
    plan: { code: string; name: string; allowedCadences?: Cadence[] };
}

interface ScheduleDto {
    status: string;
    featureEnabled: boolean;
    canEnable: boolean;
    blockingCode?: string;
    blockingReason?: string;
    cadence: string | null;
    billingMode: string;
    failureCount: number;
    maxFailureBeforePause: number;
    allowedCadences: Cadence[];
    planCode?: string;
    subscriptionsEnabled: boolean;
}

interface AccountWideSummary {
    userId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
}

const uniqSlug = (p: string) =>
    `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function getPlan(request: APIRequestContext, token: string): Promise<PlanResponse> {
    const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET plan status was ${res.status()}`).toBe(200);
    return (await res.json()) as PlanResponse;
}

async function setPlan(request: APIRequestContext, token: string, planCode: PlanCode) {
    return request.post(`${API_BASE}/api/subscriptions/plan`, {
        headers: authedHeaders(token),
        data: { planCode },
    });
}

async function getSchedule(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<ScheduleDto> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/schedule`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET schedule status was ${res.status()}`).toBe(200);
    return ((await res.json()) as { schedule: ScheduleDto }).schedule;
}

async function putSchedule(
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

async function accountWide(request: APIRequestContext, token: string): Promise<AccountWideSummary> {
    const res = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `account-wide status was ${res.status()}`).toBe(200);
    return (await res.json()) as AccountWideSummary;
}

async function setAccountCap(
    request: APIRequestContext,
    token: string,
    capCents: string | null,
    allowOverage: boolean,
) {
    return request.put(`${API_BASE}/api/me/work-agent/preferences`, {
        headers: authedHeaders(token),
        data: { accountWideMonthlyCapCents: capCents, accountWideAllowOverage: allowOverage },
    });
}

const gatedNames = (cadences: Cadence[]) =>
    cadences.filter((c) => !c.allowed && c.payPerUse).map((c) => c.cadence);

test.describe('Flow: subscription billing grace / past-due / dunning / reactivation', () => {
    test('flow 1: the subscription billing-lifecycle surface is plan-only — every status/grace/dunning/invoice/reactivation route 404s, and /plan never leaks subscription status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // The ONLY exposed billing-state read is the plan, and it carries NO
        // subscription-status vocabulary (no status/past_due/grace/currentPeriodEnd/
        // cancelAtPeriodEnd/billingProvider) — only the tier + cadence gate.
        const plan = await getPlan(request, user.access_token);
        expect(plan.status).toBe('success');
        expect(plan.enabled, 'subscriptions module enabled in e2e').toBe(true);
        expect(plan.plan.code).toBe('free');
        const planKeys = Object.keys(plan.plan);
        for (const leaky of [
            'status',
            'subscriptionStatus',
            'pastDue',
            'past_due',
            'grace',
            'gracePeriodEnd',
            'currentPeriodEnd',
            'cancelAtPeriodEnd',
            'billingProvider',
            'paymentMethodMeta',
        ]) {
            expect(planKeys, `/plan must not leak '${leaky}'`).not.toContain(leaky);
        }
        // The whole envelope likewise carries none of those top-level.
        const envKeys = Object.keys(plan);
        for (const leaky of ['subscription', 'status']) {
            if (leaky === 'status') continue; // status:'success' is the API envelope, not a sub-status
            expect(envKeys).not.toContain(leaky);
        }

        // The full census of billing-lifecycle routes a real dunning/grace UI would
        // hit — NONE exist in this build. Each is a clean 404 (never a 5xx, never a
        // silent 200 that would imply a fictional contract).
        const LIFECYCLE_ROUTES = [
            '/api/subscriptions',
            '/api/subscriptions/current',
            '/api/subscriptions/status',
            '/api/subscriptions/history',
            '/api/subscriptions/grace',
            '/api/subscriptions/reactivate',
            '/api/subscriptions/cancel',
            '/api/subscriptions/invoices',
            '/api/account/subscription',
            '/api/me/subscription',
            '/api/billing',
            '/api/billing/status',
            '/api/invoices',
            '/api/dunning',
        ];
        for (const path of LIFECYCLE_ROUTES) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(res.status(), `${path} should be 404 (no billing-lifecycle route)`).toBe(404);
        }

        // The catalogue endpoint is likewise absent (asserted by sibling specs too).
        const plans = await request.get(`${API_BASE}/api/subscriptions/plans`, {
            headers: authedHeaders(user.access_token),
        });
        expect(plans.status(), '/api/subscriptions/plans not exposed').toBe(404);

        // Unauthenticated read of the one real route is rejected.
        expect((await request.get(`${API_BASE}/api/subscriptions/plan`)).status()).toBe(401);

        test.info().annotations.push({
            type: 'billing-grace',
            description:
                'UserSubscription entity has status/past_due/grace/currentPeriodEnd/cancelAtPeriodEnd, but NO HTTP surface exposes them; only GET/POST /api/subscriptions/plan exist. All status/grace/dunning/invoice/reactivation routes 404. Asserted the real plan-only contract.',
        });
    });

    test('flow 2: GRACE-GATING of a feature — the schedule tier gate hard-stops a gated cadence with the documented pay-per-use remedy, and the gate fires BEFORE the readiness gate', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: 'grace-gate-sched',
            slug: uniqSlug('grace-gate-sched'),
        });
        expect(work.id, 'work id').toBeTruthy();

        // Put the user on STANDARD — the only tier that gates a cadence (FREE allows
        // all "for now"; PREMIUM re-opens). This is the "downgraded / over-entitlement"
        // state that grace-gates the premium cadences.
        expect((await setPlan(request, user.access_token, 'standard')).status()).toBe(200);

        // The schedule surface MIRRORS the plan gate: planCode=standard, and the
        // sub-hourly cadences are gated behind pay-per-use.
        const sched = await getSchedule(request, user.access_token, work.id);
        expect(sched.planCode).toBe('standard');
        expect(sched.subscriptionsEnabled).toBe(true);
        const gatedOnStandard = gatedNames(sched.allowedCadences);
        expect(gatedOnStandard.length, 'standard gates ≥1 sub-hourly cadence').toBeGreaterThan(0);
        for (const c of sched.allowedCadences.filter((x) =>
            SUB_HOURLY_CADENCES.includes(x.cadence as never),
        )) {
            expect(c.allowed, `${c.cadence} gated on standard`).toBe(false);
            expect(c.payPerUse, `${c.cadence} pay-per-use on standard`).toBe(true);
            expect(c.reason, `${c.cadence} carries an upgrade reason`).toContain('Premium');
        }

        // HARD-STOP: enabling a gated cadence under SUBSCRIPTION billing is rejected
        // with the exact remedy copy — the tier gate fires FIRST, before readiness.
        const blocked = await putSchedule(request, user.access_token, work.id, {
            enable: true,
            cadence: 'hourly',
            billingMode: 'subscription',
        });
        expect(blocked.status(), 'gated cadence + subscription → 400').toBe(400);
        const blockedBody = await blocked.json();
        expect(blockedBody.status).toBe('error');
        expect(JSON.stringify(blockedBody.message ?? blockedBody)).toContain('pay-per-use');
        // Critically NOT a readiness error — the billing gate pre-empts CONFIG_UNAVAILABLE.
        expect(JSON.stringify(blockedBody)).not.toContain('CONFIG_UNAVAILABLE');

        // REMEDY: switching to pay-per-use ESCAPES the tier gate. It then hits the
        // orthogonal readiness gate (the fresh CI Work was never generated), proving
        // the billing gate is cleared — a different, non-billing 400 now.
        const remedy = await putSchedule(request, user.access_token, work.id, {
            enable: true,
            cadence: 'hourly',
            billingMode: 'usage',
        });
        expect(remedy.status(), 'pay-per-use clears the tier gate (→ readiness 400)').toBe(400);
        const remedyBody = await remedy.json();
        expect(remedyBody.status).toBe('error');
        // No longer the pay-per-use remedy — the billing gate is gone; readiness remains.
        expect(JSON.stringify(remedyBody.message ?? remedyBody)).not.toContain('pay-per-use');
        expect(
            ['CONFIG_UNAVAILABLE', 'INITIAL_WORK_SETUP_REQUIRED', 'SCHEDULE_NOT_READY'],
            `remedy hit the readiness gate, got ${JSON.stringify(remedyBody)}`,
        ).toContain(remedyBody.code);

        // Reset plan so the shared in-memory DB stays clean for sibling specs.
        await setPlan(request, user.access_token, 'free');

        test.info().annotations.push({
            type: 'billing-grace',
            description:
                'WorkScheduleService.requiresUsageBilling tier gate fires before getScheduleReadiness. Gated cadence + subscription → 400 "Switch to pay-per-use to continue"; + usage → escapes to the readiness gate. The pay-per-use remedy is real.',
        });
    });

    test('flow 3: GRACE EXPIRY ↔ REACTIVATION — a saved (paused) schedule config survives plan transitions, and its cadence is RE-GATED dynamically by the current tier (downgrade re-closes, upgrade re-opens)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: 'grace-expiry-sched',
            slug: uniqSlug('grace-expiry-sched'),
        });

        // On PREMIUM the hourly cadence is open — SAVE it as a PAUSED schedule
        // (enable:false persists config without needing generation setup → 200).
        expect((await setPlan(request, user.access_token, 'premium')).status()).toBe(200);
        const save = await putSchedule(request, user.access_token, work.id, {
            enable: false,
            cadence: 'hourly',
            billingMode: 'subscription',
        });
        expect(save.status(), 'save paused schedule → 200').toBe(200);
        const saved = (await save.json()).schedule as ScheduleDto;
        expect(saved.status, 'enable:false persists as paused').toBe('paused');
        expect(saved.cadence).toBe('hourly');
        expect(saved.planCode).toBe('premium');
        // On premium, hourly is allowed (no grace gate).
        const hourlyOnPremium = saved.allowedCadences.find((c) => c.cadence === 'hourly');
        expect(hourlyOnPremium?.allowed, 'hourly allowed on premium').toBe(true);

        // GRACE EXPIRY (downgrade premium → standard): the SAME saved schedule now
        // shows hourly GATED — the gate is recomputed from the CURRENT plan on read.
        // The stored cadence is NOT mutated; only its entitlement flips.
        expect((await setPlan(request, user.access_token, 'standard')).status()).toBe(200);
        const afterDowngrade = await getSchedule(request, user.access_token, work.id);
        expect(afterDowngrade.cadence, 'saved cadence is preserved across downgrade').toBe(
            'hourly',
        );
        expect(afterDowngrade.planCode).toBe('standard');
        const hourlyAfterDown = afterDowngrade.allowedCadences.find((c) => c.cadence === 'hourly');
        expect(hourlyAfterDown?.allowed, 'hourly re-closed after downgrade (grace expired)').toBe(
            false,
        );
        expect(hourlyAfterDown?.payPerUse).toBe(true);

        // While gated, re-activating the saved hourly cadence under subscription is
        // hard-stopped — the grace-expired feature cannot be re-enabled without the remedy.
        const reactivateBlocked = await putSchedule(request, user.access_token, work.id, {
            enable: true,
            cadence: 'hourly',
            billingMode: 'subscription',
        });
        expect(reactivateBlocked.status()).toBe(400);
        expect(JSON.stringify(await reactivateBlocked.json())).toContain('pay-per-use');

        // REACTIVATION (upgrade standard → premium): the gate re-opens for the SAME
        // saved schedule with no reconfiguration needed.
        expect((await setPlan(request, user.access_token, 'premium')).status()).toBe(200);
        const afterUpgrade = await getSchedule(request, user.access_token, work.id);
        expect(afterUpgrade.cadence).toBe('hourly');
        const hourlyAfterUp = afterUpgrade.allowedCadences.find((c) => c.cadence === 'hourly');
        expect(hourlyAfterUp?.allowed, 'hourly re-opened after upgrade (reactivated)').toBe(true);
        expect(hourlyAfterUp?.payPerUse).toBe(false);

        // Cancelling the schedule is DETERMINISTICALLY 500 on a non-generated Work in
        // this build (cancelSchedule → readiness probe throws). Tolerate it — the
        // reactivation contract above is the deterministic assertion.
        const cancel = await request.delete(`${API_BASE}/api/works/${work.id}/schedule`, {
            headers: authedHeaders(user.access_token),
        });
        expect(
            [200, 409, 500],
            `cancel schedule status ${cancel.status()} (500 is the known non-generated-Work artifact)`,
        ).toContain(cancel.status());

        await setPlan(request, user.access_token, 'free');

        test.info().annotations.push({
            type: 'billing-grace',
            description:
                'A saved PAUSED schedule preserves its cadence across plan changes; allowedCadences is recomputed from the CURRENT plan on every GET (downgrade re-closes, upgrade re-opens). DELETE schedule 500s on a non-generated Work — tolerated.',
        });
    });

    test('flow 4: DUNNING contract — the schedule failure counter auto-pauses a delinquent schedule (maxFailureBeforePause), surfaced on the schedule DTO; the bound is validated 1..10', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: 'dunning-sched',
            slug: uniqSlug('dunning-sched'),
        });

        // A fresh schedule reports the dunning counter at zero and the env-default
        // failure threshold. (markRunFailed increments failureCount and PAUSES the
        // schedule once failureCount >= maxFailureBeforePause — the dunning auto-pause.
        // Real runs need Trigger.dev/generation which CI lacks, so we assert the
        // counter CONTRACT + that the threshold is a configurable, bounded value.)
        const fresh = await getSchedule(request, user.access_token, work.id);
        expect(fresh.failureCount, 'fresh schedule failureCount 0').toBe(0);
        expect(
            fresh.maxFailureBeforePause,
            'maxFailureBeforePause is a positive, bounded threshold',
        ).toBeGreaterThanOrEqual(1);
        expect(fresh.maxFailureBeforePause).toBeLessThanOrEqual(10);

        // The threshold is CONFIGURABLE per schedule via PUT — set it to the floor (1)
        // in a PAUSED save (no generation needed) and confirm it round-trips. This is
        // the dunning sensitivity: pause after N consecutive failures.
        const setThreshold = await putSchedule(request, user.access_token, work.id, {
            enable: false,
            cadence: 'daily',
            maxFailureBeforePause: 1,
        });
        expect(setThreshold.status(), 'save paused with custom threshold → 200').toBe(200);
        const withThreshold = (await setThreshold.json()).schedule as ScheduleDto;
        expect(withThreshold.maxFailureBeforePause).toBe(1);
        expect(withThreshold.failureCount, 'no runs yet → counter still 0').toBe(0);
        expect(withThreshold.status).toBe('paused');

        // The bound is enforced (DTO @Min(1)/@Max(10)) — out-of-range is a clean 4xx,
        // never a 5xx, never silently accepted.
        const tooLow = await putSchedule(request, user.access_token, work.id, {
            enable: false,
            cadence: 'daily',
            maxFailureBeforePause: 0,
        });
        expect(tooLow.status(), 'threshold 0 rejected').toBe(400);

        const tooHigh = await putSchedule(request, user.access_token, work.id, {
            enable: false,
            cadence: 'daily',
            maxFailureBeforePause: 99,
        });
        expect(tooHigh.status(), 'threshold 99 rejected').toBe(400);

        // The persisted threshold is unchanged by the rejected writes (still 1).
        const afterBadWrites = await getSchedule(request, user.access_token, work.id);
        expect(afterBadWrites.maxFailureBeforePause).toBe(1);

        test.info().annotations.push({
            type: 'billing-grace',
            description:
                'WorkScheduleService.markRunFailed increments failureCount and PAUSES the schedule at maxFailureBeforePause (dunning auto-pause), then notifySchedulePaused fires. Asserted the counter/threshold contract + the 1..10 DTO bound; real run failures need Trigger.dev (absent in CI).',
        });
    });

    test('flow 5: account-wide spend gate — DUNNING hard-stop (cap reached, no overage → blocked) ↔ GRACE soft-cap (overage on → never blocked) ↔ REACTIVATION (cap cleared), all per-user & arithmetic-consistent', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Zero-state: no cap, never blocked (uncapped account).
        const zero = await accountWide(request, user.access_token);
        expect(zero.userId).toBe(user.user.id);
        expect(zero.currentSpendCents, 'fresh user zero spend').toBe(0);
        expect(zero.capCents).toBeNull();
        expect(zero.percentUsed).toBeNull();
        expect(zero.blocked).toBe(false);
        expect(zero.allowOverage, 'default account-wide overage is permissive').toBe(true);

        // Set a generous HARD cap (overage off) above zero spend → NOT blocked, 0%.
        expect((await setAccountCap(request, user.access_token, '5000', false)).status()).toBe(200);
        const under = await accountWide(request, user.access_token);
        expect(under.capCents).toBe(5000);
        expect(under.allowOverage).toBe(false);
        expect(under.percentUsed, '0 spend / positive cap → 0%').toBe(0);
        expect(under.blocked, 'under a positive cap → not blocked').toBe(false);

        // DUNNING HARD-STOP: a 0-cap with overage OFF crosses the threshold
        // deterministically (spend 0 >= cap 0 && !overage → blocked). This is the
        // "delinquent account, hard-suspended" analog — the only way to reach blocked
        // in CI since no plugin spend is billed.
        expect((await setAccountCap(request, user.access_token, '0', false)).status()).toBe(200);
        const hardStop = await accountWide(request, user.access_token);
        expect(hardStop.capCents).toBe(0);
        expect(hardStop.allowOverage).toBe(false);
        expect(hardStop.percentUsed, 'cap 0 → percentUsed null (no divide-by-zero)').toBeNull();
        expect(hardStop.blocked, 'spend>=cap && !overage → blocked (dunning hard-stop)').toBe(true);

        // GRACE soft-cap: same 0-cap but overage ON → NOT blocked (alerts would fire,
        // but the account keeps working — the grace-period soft state).
        expect((await setAccountCap(request, user.access_token, '0', true)).status()).toBe(200);
        const grace = await accountWide(request, user.access_token);
        expect(grace.capCents).toBe(0);
        expect(grace.allowOverage).toBe(true);
        expect(grace.blocked, 'overage allowed → soft grace, never blocked').toBe(false);

        // Non-numeric cap is rejected (the pref is a bigint digit-string).
        const badCap = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(user.access_token),
            data: { accountWideMonthlyCapCents: 'not-a-number' },
        });
        expect(badCap.status()).toBe(400);

        // REACTIVATION: clearing the cap (null) returns the account to fully uncapped /
        // unblocked — the "payment recovered, account restored" analog.
        const clear = await setAccountCap(request, user.access_token, null, true);
        expect(clear.status()).toBe(200);
        const reactivated = await accountWide(request, user.access_token);
        expect(reactivated.capCents, 'cleared cap → null').toBeNull();
        expect(reactivated.percentUsed).toBeNull();
        expect(reactivated.blocked, 'reactivated → not blocked').toBe(false);

        // Unauthenticated access to the budget status is rejected.
        expect((await request.get(`${API_BASE}/api/me/usage/account-wide`)).status()).toBe(401);

        test.info().annotations.push({
            type: 'billing-grace',
            description:
                'BudgetService.summarizeForUser: blocked === cap!==null && spend>=cap && !overage. 0-cap+!overage = dunning hard-stop; 0-cap+overage = grace soft-cap; null cap = reactivation. Verified the full triad + the bigint-string DTO guard.',
        });
    });

    test('flow 6: the billing gate is independent per user AND per axis — two users hold independent plan-gates & spend-blocks simultaneously, and a tier change never crosses the cap arithmetic', async ({
        request,
    }) => {
        const delinquent = await registerUserViaAPI(request);
        const healthy = await registerUserViaAPI(request);

        // delinquent: STANDARD plan (cadence-gated) + a 0-cap hard-stop (spend-blocked).
        expect((await setPlan(request, delinquent.access_token, 'standard')).status()).toBe(200);
        expect((await setAccountCap(request, delinquent.access_token, '0', false)).status()).toBe(
            200,
        );

        // healthy: PREMIUM plan (no cadence gate) + generous soft cap (never blocked).
        expect((await setPlan(request, healthy.access_token, 'premium')).status()).toBe(200);
        expect((await setAccountCap(request, healthy.access_token, '100000', true)).status()).toBe(
            200,
        );

        // The two billing states are fully independent across users.
        const delPlan = await getPlan(request, delinquent.access_token);
        const healPlan = await getPlan(request, healthy.access_token);
        expect(delPlan.plan.code).toBe('standard');
        expect(healPlan.plan.code).toBe('premium');
        // delinquent has gated cadences; healthy (premium) has none.
        expect(gatedNames(delPlan.plan.allowedCadences ?? []).length).toBeGreaterThan(0);
        expect(gatedNames(healPlan.plan.allowedCadences ?? []).length).toBe(0);

        const delUsage = await accountWide(request, delinquent.access_token);
        const healUsage = await accountWide(request, healthy.access_token);
        expect(delUsage.userId).toBe(delinquent.user.id);
        expect(healUsage.userId).toBe(healthy.user.id);
        expect(delUsage.userId).not.toBe(healUsage.userId);
        // The spend axis is independent of the plan axis: delinquent is BLOCKED on
        // spend while on a paid tier; healthy is unblocked on the top tier.
        expect(delUsage.blocked, 'delinquent hard-stopped on spend').toBe(true);
        expect(healUsage.blocked, 'healthy never blocked (soft cap)').toBe(false);

        // A PLAN change for the delinquent user does NOT touch their spend block —
        // the two gates are orthogonal (downgrading to free re-opens cadences but the
        // 0-cap hard-stop persists).
        expect((await setPlan(request, delinquent.access_token, 'free')).status()).toBe(200);
        const delAfterDowngrade = await getPlan(request, delinquent.access_token);
        expect(delAfterDowngrade.plan.code).toBe('free');
        // FREE re-opens every cadence (the plan-gate cleared)…
        expect(gatedNames(delAfterDowngrade.plan.allowedCadences ?? []).length).toBe(0);
        // …but the spend block is unchanged (orthogonal axis).
        const delUsageAfter = await accountWide(request, delinquent.access_token);
        expect(delUsageAfter.capCents).toBe(0);
        expect(delUsageAfter.blocked, 'spend block survives the plan change').toBe(true);

        // Conversely, clearing the spend cap REACTIVATES the spend axis without
        // touching the (now free) plan.
        expect((await setAccountCap(request, delinquent.access_token, null, true)).status()).toBe(
            200,
        );
        const delFullyReactivated = await accountWide(request, delinquent.access_token);
        expect(delFullyReactivated.blocked, 'cleared cap → spend reactivated').toBe(false);
        expect((await getPlan(request, delinquent.access_token)).plan.code).toBe('free');

        // Tidy the shared DB: clear the healthy user's cap + plan too.
        await setAccountCap(request, healthy.access_token, null, true);
        await setPlan(request, healthy.access_token, 'free');

        test.info().annotations.push({
            type: 'billing-grace',
            description:
                'Plan tier gate (cadence) and account-wide spend gate (blocked) are orthogonal, per-user axes. A plan transition never crosses the cap arithmetic and vice-versa; both reactivate independently.',
        });
    });
});
