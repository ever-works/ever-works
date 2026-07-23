import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * SUBSCRIPTION TIER → PER-WORK BUDGET → USAGE LEDGER → ACCOUNT-WIDE
 * ENFORCEMENT / GRACE — the full VERTICAL BILLING STITCH, end-to-end.
 *
 * Every subsystem below has its own deep single-layer spec already. This file
 * deliberately owns none of them in isolation; it owns the CROSS-LAYER
 * INVARIANTS that only appear when the four layers are driven together on one
 * account in one flow — the edges no single-subsystem spec can assert:
 *   • the subscription TIER lever is INERT to the spend ledger (a plan change
 *     never perturbs a per-Work cap, its usage-summary percentUsed, or the
 *     account-wide blocked state);
 *   • the per-Work three read surfaces (summary/trend/export) and the
 *     account-wide summary reconcile on ONE calendar-month engine, yet DIVERGE
 *     the moment an explicit ?period is applied (the work surfaces move, the
 *     account window stays anchored — it has no ?period);
 *   • the account-wide cap is the ONLY HARD-STOP lever (its `blocked` flips at
 *     a 0-cap even at 0 spend, and grace/overage flips it back), while the
 *     per-Work GLOBAL cap is purely ADVISORY (no `blocked` field at all);
 *   • currency propagates work-cap → usage-summary but NEVER work → account;
 *   • the whole stack is per-user siloed on all four layers at once.
 *
 * Env-adaptive & keyless-truthful: the local stack has no LLM key, so no plugin
 * usage is ever recorded — the chain's tracked spend is genuinely 0 across every
 * surface. The enforcement math is therefore asserted at the 0-spend rungs
 * (which is exactly where the 0-cap hard-stop and the div-by-zero percentUsed
 * edges live), NOT by fabricating spend the keyless stack cannot produce.
 *
 * ── NON-DUPLICATION (all probed live @ 127.0.0.1:3100, sqlite, flags ON) ────
 *   - flow-subscription-plan-tiers / flow-subscriptions-billing-multistep own
 *     the tier→schedule entitlement + the plan enum/idempotency surface. THIS
 *     file only uses the plan lever to prove tier↔budget/account NON-cascade.
 *   - flow-work-budgets-sub-resource / flow-budget-caps-perwork own the budget
 *     CRUD + DTO validation lattice. THIS file carries only the minimal
 *     guardrails needed to keep the chain honest, reflected THROUGH the usage
 *     summary + account layer.
 *   - flow-usage-tracking / flow-work-usage-sub-resource own the per-Work
 *     window engine + CSV columns + membership matrix. THIS file stitches those
 *     surfaces to the ACCOUNT window (a cross-layer reconciliation neither owns).
 *   - flow-account-usage-aggregation owns the account aggregate mechanics;
 *     flow-subscription-billing-grace owns the schedule tier-gate + dunning.
 *     THIS file owns the account cap as the STACK's hard-stop lever wired to a
 *     live per-Work cap + a live tier — the combined enforcement matrix.
 *   - flow-subscription-admin-usage owns the platform-admin RBAC matrix. THIS
 *     file touches /admin/usage only as the zero-usage chain's read-back bookend.
 *
 * ── OBSERVED CONTRACTS (verified live before assertions were written) ───────
 *  GET  /api/subscriptions/plan → 200 { status:'success', enabled:true,
 *       plan:{ code, name, allowedCadences:[{cadence,allowed,payPerUse}…] } };
 *       a fresh user is 'free'; anon → 401.
 *  POST /api/subscriptions/plan {planCode} → in THIS deploy free/standard/
 *       premium all 200 and the plan echoes back (paid self-assign is env-
 *       dependent — pinned tolerant [200,403]); a bad enum → 400 with
 *       "planCode must be one of the following values: free, standard, premium".
 *  GET/POST/PATCH/DELETE /api/works/:workId/budgets — GLOBAL cap 201 carries
 *       { id, workId, scope:'global', pluginId:null, monthlyCapCents, currency,
 *         allowOverage, ownerType:'work', ownerId:null, createdAt, updatedAt };
 *       dup global → 409, global+pluginId → 400, plugin w/o id → 400,
 *       cap 0 → 400 (Min 1), cap>100_000_000 → 400 (Max), bad scope/currency/
 *       pluginId → 400; unknown budget → 404; missing work → 404; stranger read
 *       → 403 (leaks existence), stranger write → 403 "…owner or …MANAGER…".
 *  GET  /api/works/:workId/usage/summary[?period] → { workId, periodStart,
 *       periodEnd, periodLabel, currency, totalSpendCents:0, perPlugin:[],
 *       globalBudget:null|{ id, monthlyCapCents, allowOverage, currency,
 *       percentUsed } } — currency = globalBudget.currency ?? 'usd'; NO `blocked`
 *       field. …/trend → { …, granularity:'day', buckets:[] }; bad granularity
 *       → 400. …/export → 200 text/csv, header-only body, filename echoes the
 *       resolved YYYY-MM slug; non-csv format → 400. bad period → 400.
 *  GET  /api/me/usage/account-wide → { userId, periodStart, periodEnd,
 *       currentSpendCents:0, capCents, currency:'usd', percentUsed, allowOverage,
 *       blocked }. Default: capCents null / percentUsed null / allowOverage true /
 *       blocked false. Lever = PUT /api/me/work-agent/preferences
 *       { accountWideMonthlyCapCents:string|null (regex /^\d+$/), accountWideAllowOverage }:
 *         cap "10000" + overage false → percentUsed 0, blocked false;
 *         cap "0"     + overage false → capCents 0, percentUsed null, blocked TRUE;
 *         cap "0"     + overage true  → blocked false (grace);
 *         cap null                    → uncapped (blocked false).
 *       A negative/decimal/non-numeric cap → 400 and leaves the armed cap intact.
 *  GET  /admin/usage → 403 for any non-admin ("Platform admin access required");
 *       /api/admin/usage → 404 (wrong prefix); anon → 401.
 *
 * Cross-spec isolation: every test builds on FRESH registerUserViaAPI() users
 * with unique suffixes; list/ledger assertions use the caller's OWN ids and
 * self-scoped windows — never global counts. No module-scope data loading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const PLAN_CODES = ['free', 'standard', 'premium'] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface PlanResponse {
    status: string;
    enabled: boolean;
    plan: {
        code: string;
        name: string;
        allowedCadences?: Array<{ cadence: string; allowed: boolean; payPerUse: boolean }>;
    };
}

interface BudgetRow {
    id: string;
    workId: string;
    scope: string;
    pluginId: string | null;
    monthlyCapCents: number;
    currency: string;
    allowOverage: boolean;
    ownerType: string;
    ownerId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface UsageSummary {
    workId: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    currency: string;
    totalSpendCents: number;
    perPlugin: Array<{ pluginId: string; capability: string; units: number; costCents: number }>;
    globalBudget: null | {
        id: string;
        monthlyCapCents: number;
        allowOverage: boolean;
        currency: string;
        percentUsed: number;
    };
}

interface AccountWide {
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

async function getPlan(
    request: APIRequestContext,
    token: string,
): Promise<{ status: number; body: PlanResponse }> {
    const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await res.json()) as PlanResponse };
}

/** Attempt a self-service plan change. Returns raw status + body (paid may 403). */
async function setPlan(
    request: APIRequestContext,
    token: string,
    planCode: string,
): Promise<{ status: number; body: { plan?: { code?: string }; message?: unknown } }> {
    const res = await request.post(`${API_BASE}/api/subscriptions/plan`, {
        headers: authedHeaders(token),
        data: { planCode },
    });
    return { status: res.status(), body: await res.json() };
}

/**
 * Move the account onto a tier as far as this deploy allows and report the
 * code that actually LANDED (read-back), tolerating the env-dependent paid
 * self-assign gate (200 sets it here; a 403 deploy leaves the prior code).
 */
async function landTier(
    request: APIRequestContext,
    token: string,
    planCode: string,
): Promise<string> {
    const res = await setPlan(request, token, planCode);
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) expect(res.body.plan?.code).toBe(planCode);
    return (await getPlan(request, token)).body.plan.code;
}

async function createBudget(
    request: APIRequestContext,
    token: string,
    workId: string,
    dto: Record<string, unknown>,
): Promise<{ status: number; body: { budget?: BudgetRow; message?: unknown } }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/budgets`, {
        headers: authedHeaders(token),
        data: dto,
    });
    return { status: res.status(), body: await res.json() };
}

async function listBudgets(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<BudgetRow[]> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/budgets`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { budgets: BudgetRow[] }).budgets;
}

async function getSummary(
    request: APIRequestContext,
    token: string,
    workId: string,
    period?: string,
): Promise<{ status: number; body: UsageSummary }> {
    const q = period ? `?period=${period}` : '';
    const res = await request.get(`${API_BASE}/api/works/${workId}/usage/summary${q}`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await res.json()) as UsageSummary };
}

async function getAccountWide(request: APIRequestContext, token: string): Promise<AccountWide> {
    const res = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as AccountWide;
}

/** Arm/clear the account-wide cap via the Work-agent preferences lever. */
async function setAccountCap(
    request: APIRequestContext,
    token: string,
    prefs: { capCents?: string | null; allowOverage?: boolean },
): Promise<number> {
    const data: Record<string, unknown> = {};
    if ('capCents' in prefs) data.accountWideMonthlyCapCents = prefs.capCents;
    if ('allowOverage' in prefs) data.accountWideAllowOverage = prefs.allowOverage;
    const res = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
        headers: authedHeaders(token),
        data,
    });
    return res.status();
}

async function makeWork(request: APIRequestContext, token: string): Promise<string> {
    const work = await createWorkViaAPI(request, token, { name: `Budget Work ${stamp()}` });
    expect(work.id).toMatch(UUID_RE);
    return work.id;
}

// ───────────────────────────────────────────────────────────────────────────
test.describe('Chain layer 1 → the subscription tier lever is INERT to the spend ledger', () => {
    test('a fresh account is FREE with a well-formed cadence allowance envelope; a bad tier never lands; anon 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const { status, body } = await getPlan(request, token);
        expect(status).toBe(200);
        expect(body.status).toBe('success');
        expect(body.enabled).toBe(true);
        expect(body.plan.code).toBe('free');
        expect(body.plan.name).toBe('Free');
        // The allowance envelope is an array of cadence gates (shape, not policy).
        expect(Array.isArray(body.plan.allowedCadences)).toBe(true);
        for (const a of body.plan.allowedCadences ?? []) {
            expect(typeof a.cadence).toBe('string');
            expect(typeof a.allowed).toBe('boolean');
            expect(typeof a.payPerUse).toBe('boolean');
        }

        // A bad enum never mints a tier; the plan stays free.
        const bad = await setPlan(request, token, 'platinum');
        expect(bad.status).toBe(400);
        expect(msgOf(bad.body)).toMatch(/free, standard, premium/);
        expect((await getPlan(request, token)).body.plan.code).toBe('free');

        // Anonymous read is walled off.
        expect((await request.get(`${API_BASE}/api/subscriptions/plan`)).status()).toBe(401);
    });

    test('cycling the tier free→standard→premium→free leaves a live per-Work GLOBAL cap and its usage-summary percentUsed byte-identical (tier does NOT cascade into the cap layer)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        // Provision a per-Work GLOBAL cap under the default (free) tier.
        const created = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 40_000,
            currency: 'usd',
        });
        expect(created.status).toBe(201);
        const capId = created.body.budget!.id;

        const baseline = await getSummary(request, token, workId);
        expect(baseline.body.globalBudget?.monthlyCapCents).toBe(40_000);
        expect(baseline.body.globalBudget?.percentUsed).toBe(0);

        // Walk every tier and re-read the SAME cap's summary projection.
        for (const code of ['standard', 'premium', 'free']) {
            const landed = await landTier(request, token, code);
            const after = await getSummary(request, token, workId);
            // The cap row is untouched by the tier change: same id, cap, currency,
            // and a still-0 percentUsed (no plugin usage the keyless stack could add).
            expect(after.body.globalBudget?.id).toBe(capId);
            expect(after.body.globalBudget?.monthlyCapCents).toBe(40_000);
            expect(after.body.globalBudget?.currency).toBe('usd');
            expect(after.body.globalBudget?.percentUsed).toBe(0);
            expect(after.body.totalSpendCents).toBe(0);
            // Sanity: the tier lever did move (or the deploy pinned it) — either
            // way it is a valid tier code and orthogonal to the cap above.
            expect(PLAN_CODES).toContain(landed as (typeof PLAN_CODES)[number]);
        }
    });

    test('an armed account-wide HARD-STOP survives every tier transition — the block is a spend-ledger fact, not a plan entitlement', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Arm a 0-cap hard stop (blocked at 0 spend, no overage).
        expect(await setAccountCap(request, token, { capCents: '0', allowOverage: false })).toBe(
            200,
        );
        expect((await getAccountWide(request, token)).blocked).toBe(true);

        // Cycle tiers; the block is invariant across all of them.
        for (const code of ['standard', 'premium', 'free', 'premium']) {
            await landTier(request, token, code);
            const acct = await getAccountWide(request, token);
            expect(acct.blocked).toBe(true);
            expect(acct.capCents).toBe(0);
            expect(acct.currentSpendCents).toBe(0);
        }

        // Releasing the block is a LEDGER action (overage), never a tier action.
        expect(await setAccountCap(request, token, { allowOverage: true })).toBe(200);
        expect((await getAccountWide(request, token)).blocked).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('Chain layer 2/3 → the per-Work read surfaces reconcile with the account window, then diverge under ?period', () => {
    test('summary + trend + export share ONE half-open [start,end) work window that also matches the account-wide calendar-month bounds under the default period', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const summary = await getSummary(request, token, workId);
        expect(summary.status).toBe(200);
        expect(summary.body.workId).toBe(workId);
        // Zero-state, keyless-truthful ledger.
        expect(summary.body.totalSpendCents).toBe(0);
        expect(summary.body.perPlugin).toEqual([]);
        expect(summary.body.globalBudget).toBeNull();
        // The work surface carries NO `blocked` field — it is advisory, not a gate.
        expect('blocked' in (summary.body as unknown as Record<string, unknown>)).toBe(false);

        const trendRes = await request.get(`${API_BASE}/api/works/${workId}/usage/trend`, {
            headers: authedHeaders(token),
        });
        expect(trendRes.status()).toBe(200);
        const trend = (await trendRes.json()) as {
            periodStart: string;
            periodEnd: string;
            granularity: string;
            buckets: unknown[];
        };
        // Summary and trend agree byte-for-byte on the window and it is half-open.
        expect(trend.periodStart).toBe(summary.body.periodStart);
        expect(trend.periodEnd).toBe(summary.body.periodEnd);
        expect(trend.granularity).toBe('day');
        expect(trend.buckets).toEqual([]);
        expect(Date.parse(summary.body.periodStart)).toBeLessThan(
            Date.parse(summary.body.periodEnd),
        );

        // The account-wide summary rides the SAME calendar-month bounds.
        const acct = await getAccountWide(request, token);
        expect(acct.periodStart).toBe(summary.body.periodStart);
        expect(acct.periodEnd).toBe(summary.body.periodEnd);
        expect(acct.currentSpendCents).toBe(0);
    });

    test('an explicit YYYY-MM ?period shifts the three work surfaces TOGETHER (export filename slug echoes it) while the account window stays anchored to the current month', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const period = '2026-03';
        const summary = await getSummary(request, token, workId, period);
        expect(summary.status).toBe(200);
        expect(summary.body.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(summary.body.periodEnd).toBe('2026-04-01T00:00:00.000Z');

        const trendRes = await request.get(
            `${API_BASE}/api/works/${workId}/usage/trend?period=${period}`,
            { headers: authedHeaders(token) },
        );
        const trend = (await trendRes.json()) as { periodStart: string; periodEnd: string };
        expect(trend.periodStart).toBe(summary.body.periodStart);
        expect(trend.periodEnd).toBe(summary.body.periodEnd);

        // The export streams a header-only CSV whose filename slug echoes the period.
        const exportRes = await request.get(
            `${API_BASE}/api/works/${workId}/usage/export?period=${period}`,
            { headers: authedHeaders(token) },
        );
        expect(exportRes.status()).toBe(200);
        expect(exportRes.headers()['content-type']).toContain('text/csv');
        expect(exportRes.headers()['content-disposition']).toContain(
            `filename="usage-${workId}-2026-03.csv"`,
        );
        const csv = (await exportRes.text()).trim();
        expect(csv).toBe(
            'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId',
        );

        // The account-wide surface has NO ?period knob — it stays on the current
        // month, so its window DIVERGES from the historical work window above.
        const acct = await getAccountWide(request, token);
        expect(acct.periodStart).not.toBe(summary.body.periodStart);
        expect(Date.parse(acct.periodStart)).toBeGreaterThan(Date.parse(summary.body.periodStart));
    });

    test('the period grammar rejects a bad shape vs a bad month uniformly across summary/trend/export, and the granularity/format gates hold', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);
        const h = authedHeaders(token);

        for (const surface of ['summary', 'trend', 'export']) {
            const badShape = await request.get(
                `${API_BASE}/api/works/${workId}/usage/${surface}?period=marchish`,
                { headers: h },
            );
            expect(badShape.status()).toBe(400);
            expect(msgOf(await badShape.json())).toMatch(/invalid period/i);

            const badMonth = await request.get(
                `${API_BASE}/api/works/${workId}/usage/${surface}?period=2026-13`,
                { headers: h },
            );
            expect(badMonth.status()).toBe(400);
            expect(msgOf(await badMonth.json())).toMatch(/invalid month/i);
        }

        // Surface-specific gates: trend only 'day', export only 'csv'.
        const badGran = await request.get(
            `${API_BASE}/api/works/${workId}/usage/trend?granularity=hour`,
            { headers: h },
        );
        expect(badGran.status()).toBe(400);
        expect(msgOf(await badGran.json())).toMatch(/granularity/i);

        const badFmt = await request.get(
            `${API_BASE}/api/works/${workId}/usage/export?format=json`,
            { headers: h },
        );
        expect(badFmt.status()).toBe(400);
        expect(msgOf(await badFmt.json())).toMatch(/format/i);
    });

    test('a PLUGIN-scoped cap coexists with the GLOBAL cap but never enters the usage-summary globalBudget slot nor the account aggregate', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const global = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 60_000,
        });
        expect(global.status).toBe(201);
        const plugin = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'openai',
            monthlyCapCents: 25_000,
            allowOverage: true,
        });
        expect(plugin.status).toBe(201);
        expect(plugin.body.budget!.scope).toBe('plugin');
        expect(plugin.body.budget!.pluginId).toBe('openai');

        // Both rows persist independently…
        const rows = await listBudgets(request, token, workId);
        expect(rows.map((b) => b.id)).toContain(global.body.budget!.id);
        expect(rows.map((b) => b.id)).toContain(plugin.body.budget!.id);
        expect(rows.filter((b) => b.scope === 'global')).toHaveLength(1);
        expect(rows.filter((b) => b.scope === 'plugin')).toHaveLength(1);

        // …but the usage summary's single globalBudget slot only ever binds the
        // GLOBAL row; the plugin cap is invisible to it.
        const summary = await getSummary(request, token, workId);
        expect(summary.body.globalBudget?.id).toBe(global.body.budget!.id);
        expect(summary.body.globalBudget?.monthlyCapCents).toBe(60_000);

        // And neither per-Work cap folds into the account-wide aggregate.
        const acct = await getAccountWide(request, token);
        expect(acct.capCents).toBeNull();
        expect(acct.blocked).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('Chain layer 4 → the account-wide cap is the ONLY hard-stop lever; the per-Work cap is advisory', () => {
    test('the full enforcement ladder on one account: uncapped → positive-cap(0%) → 0-cap HARD-STOP → grace overage → cleared, with the arithmetic pinned at every rung', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Rung 0 — a fresh account is uncapped and never blocked; overage defaults on.
        const zero = await getAccountWide(request, token);
        expect(zero.capCents).toBeNull();
        expect(zero.percentUsed).toBeNull();
        expect(zero.allowOverage).toBe(true);
        expect(zero.blocked).toBe(false);
        expect(zero.currency).toBe('usd');

        // Rung 1 — a positive cap at 0 spend: percentUsed is exactly 0, not blocked.
        expect(
            await setAccountCap(request, token, { capCents: '10000', allowOverage: false }),
        ).toBe(200);
        const positive = await getAccountWide(request, token);
        expect(positive.capCents).toBe(10_000);
        expect(positive.percentUsed).toBe(0);
        expect(positive.allowOverage).toBe(false);
        expect(positive.blocked).toBe(false);

        // Rung 2 — collapse the cap to 0 with no overage: the hard stop fires even
        // at 0 spend (0 ≥ 0), and percentUsed goes NULL (div-by-zero guard).
        expect(await setAccountCap(request, token, { capCents: '0' })).toBe(200);
        const hardStop = await getAccountWide(request, token);
        expect(hardStop.capCents).toBe(0);
        expect(hardStop.percentUsed).toBeNull();
        expect(hardStop.blocked).toBe(true);

        // Rung 3 — flip overage on: grace releases the block WITHOUT changing the cap.
        expect(await setAccountCap(request, token, { allowOverage: true })).toBe(200);
        const grace = await getAccountWide(request, token);
        expect(grace.capCents).toBe(0);
        expect(grace.allowOverage).toBe(true);
        expect(grace.blocked).toBe(false);

        // Rung 4 — clear the cap entirely: back to the uncapped zero-state.
        expect(await setAccountCap(request, token, { capCents: null })).toBe(200);
        const cleared = await getAccountWide(request, token);
        expect(cleared.capCents).toBeNull();
        expect(cleared.percentUsed).toBeNull();
        expect(cleared.blocked).toBe(false);
    });

    test('the per-Work GLOBAL cap has NO hard-stop: a cap set to its 100,000,000c ceiling still reports percentUsed 0 and exposes no `blocked` field, while the account cap alone gates', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        // The per-Work cap is purely advisory — even at the max ceiling it never
        // yields a block or a non-zero percentUsed at 0 spend.
        const capped = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 100_000_000,
            allowOverage: false,
        });
        expect(capped.status).toBe(201);
        const summary = await getSummary(request, token, workId);
        expect(summary.body.globalBudget?.monthlyCapCents).toBe(100_000_000);
        expect(summary.body.globalBudget?.percentUsed).toBe(0);
        expect('blocked' in (summary.body as unknown as Record<string, unknown>)).toBe(false);
        expect('blocked' in (summary.body.globalBudget as Record<string, unknown>)).toBe(false);

        // The ONLY blocking lever is the account cap — arm it and the account
        // (not the work) reports blocked, proving the two layers are separate.
        expect(await setAccountCap(request, token, { capCents: '0', allowOverage: false })).toBe(
            200,
        );
        expect((await getAccountWide(request, token)).blocked).toBe(true);
        // The work cap is entirely unmoved by the account block.
        const after = await getSummary(request, token, workId);
        expect(after.body.globalBudget?.monthlyCapCents).toBe(100_000_000);
        expect(after.body.globalBudget?.percentUsed).toBe(0);
    });

    test('the two cap layers are ORTHOGONAL: arming the account hard-stop never touches the work cap row, and deleting the work cap never changes the account block', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const created = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 55_000,
            currency: 'usd',
        });
        expect(created.status).toBe(201);
        const capId = created.body.budget!.id;

        // Arm the account hard-stop — the work cap row is byte-identical after.
        expect(await setAccountCap(request, token, { capCents: '0', allowOverage: false })).toBe(
            200,
        );
        expect((await getAccountWide(request, token)).blocked).toBe(true);
        const rows = await listBudgets(request, token, workId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(capId);
        expect(rows[0].monthlyCapCents).toBe(55_000);

        // Delete the work cap — the account block is unaffected (still blocked).
        const del = await request.delete(`${API_BASE}/api/works/${workId}/budgets/${capId}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deletedId: capId });
        expect(await listBudgets(request, token, workId)).toHaveLength(0);
        expect((await getAccountWide(request, token)).blocked).toBe(true);
    });

    test('a rejected account-cap write (regex /^\\d+$/) is atomic: a negative, decimal, or non-numeric cap 400s and leaves a previously-armed cap intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Arm a known-good cap first.
        expect(await setAccountCap(request, token, { capCents: '7500', allowOverage: false })).toBe(
            200,
        );
        expect((await getAccountWide(request, token)).capCents).toBe(7500);

        // Every malformed cap is rejected with the regex message…
        for (const bad of ['-5', '12.50', 'abc', '9999999999 ']) {
            const res = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
                headers: authedHeaders(token),
                data: { accountWideMonthlyCapCents: bad },
            });
            expect(res.status()).toBe(400);
            expect(msgOf(await res.json())).toMatch(/accountWideMonthlyCapCents/);
        }

        // …and the armed cap survived every rejection untouched.
        const acct = await getAccountWide(request, token);
        expect(acct.capCents).toBe(7500);
        expect(acct.percentUsed).toBe(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('Chain read-back → a keyless chain tracks 0 spend, and only the account-wide window is the owner’s self-serve view', () => {
    test('after provisioning tier + global + plugin caps, every ledger surface is a truthful zero: summary totals 0, trend empty, export header-only, account currentSpend 0', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        await landTier(request, token, 'premium');
        expect(
            (
                await createBudget(request, token, workId, {
                    scope: 'global',
                    monthlyCapCents: 80_000,
                })
            ).status,
        ).toBe(201);
        expect(
            (
                await createBudget(request, token, workId, {
                    scope: 'plugin',
                    pluginId: 'tavily',
                    monthlyCapCents: 15_000,
                })
            ).status,
        ).toBe(201);

        // No LLM key ⇒ no plugin usage rows ⇒ the ledger is genuinely empty.
        const summary = await getSummary(request, token, workId);
        expect(summary.body.totalSpendCents).toBe(0);
        expect(summary.body.perPlugin).toEqual([]);
        expect(summary.body.globalBudget?.percentUsed).toBe(0);

        const trendRes = await request.get(`${API_BASE}/api/works/${workId}/usage/trend`, {
            headers: authedHeaders(token),
        });
        expect(((await trendRes.json()) as { buckets: unknown[] }).buckets).toEqual([]);

        const exportRes = await request.get(`${API_BASE}/api/works/${workId}/usage/export`, {
            headers: authedHeaders(token),
        });
        expect((await exportRes.text()).trim().split('\n')).toHaveLength(1); // header only

        expect((await getAccountWide(request, token)).currentSpendCents).toBe(0);
    });

    test('the cross-user admin aggregate is closed to the chain’s owner (403), the api-prefixed path is 404, and anon is 401 — the account-wide rollup is the ONLY self-serve spend window', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A normal (non-platform-admin) owner cannot read the cross-user table.
        const admin = await request.get(`${API_BASE}/admin/usage`, {
            headers: authedHeaders(token),
        });
        expect(admin.status()).toBe(403);
        expect(msgOf(await admin.json())).toMatch(/platform admin/i);

        // The api-prefixed spelling is not a route at all.
        expect(
            (
                await request.get(`${API_BASE}/api/admin/usage`, { headers: authedHeaders(token) })
            ).status(),
        ).toBe(404);

        // Anonymous → 401 on the admin surface.
        expect((await request.get(`${API_BASE}/admin/usage`)).status()).toBe(401);

        // The owner's own window is self-scoped to their user id.
        const acct = await getAccountWide(request, token);
        expect(acct.userId).toBe(user.user.id);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('Whole-stack isolation → tier, work caps, work usage and account block are all per-user siloed', () => {
    test('two accounts hold independent state on ALL FOUR layers at once, and neither can read nor mutate the other’s Work budgets/usage', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aWork = await makeWork(request, alice.access_token);
        const bWork = await makeWork(request, bob.access_token);

        // Divergent state per user across every layer.
        await landTier(request, alice.access_token, 'premium');
        await landTier(request, bob.access_token, 'free');
        expect(
            (
                await createBudget(request, alice.access_token, aWork, {
                    scope: 'global',
                    monthlyCapCents: 90_000,
                })
            ).status,
        ).toBe(201);
        expect(
            await setAccountCap(request, alice.access_token, {
                capCents: '0',
                allowOverage: false,
            }),
        ).toBe(200);
        // Bob provisions nothing and arms no cap.

        // Layer-by-layer: Alice's state is hers alone.
        expect((await getAccountWide(request, alice.access_token)).blocked).toBe(true);
        expect((await getAccountWide(request, bob.access_token)).blocked).toBe(false);
        expect((await getAccountWide(request, bob.access_token)).capCents).toBeNull();
        expect(await listBudgets(request, bob.access_token, bWork)).toHaveLength(0);
        expect(await listBudgets(request, alice.access_token, aWork)).toHaveLength(1);
        // Bob's tier is independent of Alice's premium.
        expect(PLAN_CODES).toContain(
            (await getPlan(request, bob.access_token)).body.plan
                .code as (typeof PLAN_CODES)[number],
        );

        // Bob is a stranger to Alice's Work — reads leak existence via 403.
        const b = authedHeaders(bob.access_token);
        const readBudgets = await request.get(`${API_BASE}/api/works/${aWork}/budgets`, {
            headers: b,
        });
        expect(readBudgets.status()).toBe(403);
        expect(msgOf(await readBudgets.json())).toMatch(/does not have access/i);
        const readUsage = await request.get(`${API_BASE}/api/works/${aWork}/usage/summary`, {
            headers: b,
        });
        expect(readUsage.status()).toBe(403);

        // …and cannot mutate a cap on it (owner/MANAGER required).
        const write = await createBudget(request, bob.access_token, aWork, {
            scope: 'plugin',
            pluginId: 'brave',
            monthlyCapCents: 100,
        });
        expect(write.status).toBe(403);
        expect(msgOf(write.body)).toMatch(/owner or have MANAGER role/i);

        // Alice's stack is provably untouched by Bob's failed writes.
        expect(await listBudgets(request, alice.access_token, aWork)).toHaveLength(1);
        expect((await getAccountWide(request, alice.access_token)).blocked).toBe(true);
    });

    test('the budgets + usage surfaces close correctly on a missing/malformed Work and on anonymous access across all three usage reads', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);

        // A well-formed-but-unknown Work id → 404 on both budgets and usage
        // (id resolves before the access check; no ParseUUID on this route).
        const ghostBudgets = await request.get(`${API_BASE}/api/works/${UNKNOWN_UUID}/budgets`, {
            headers: h,
        });
        expect(ghostBudgets.status()).toBe(404);
        expect(msgOf(await ghostBudgets.json())).toMatch(/work .* not found/i);
        expect(
            (
                await request.get(`${API_BASE}/api/works/${UNKNOWN_UUID}/usage/summary`, {
                    headers: h,
                })
            ).status(),
        ).toBe(404);

        // A MALFORMED (non-UUID) Work id also 404s — this route has no ParseUUIDPipe,
        // so the id is looked up (miss) rather than pre-rejected 400.
        const malformed = await request.get(`${API_BASE}/api/works/not-a-uuid/budgets`, {
            headers: h,
        });
        expect(malformed.status()).toBe(404);
        expect(msgOf(await malformed.json())).toMatch(/work .* not found/i);

        // Anonymous → 401 across budgets + all three usage surfaces.
        const realWork = await makeWork(request, token);
        expect((await request.get(`${API_BASE}/api/works/${realWork}/budgets`)).status()).toBe(401);
        for (const surface of ['summary', 'trend', 'export']) {
            expect(
                (await request.get(`${API_BASE}/api/works/${realWork}/usage/${surface}`)).status(),
            ).toBe(401);
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('Budget spine → the cap lifecycle is reflected THROUGH the usage summary and stays decoupled from the account layer', () => {
    test('create → PATCH-up → DELETE round-trips the summary.globalBudget slot (populated → recomputed → null) while the account-wide summary is invariant throughout', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const accountBefore = await getAccountWide(request, token);

        // Create → summary binds the cap with percentUsed 0.
        const created = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 20_000,
        });
        expect(created.status).toBe(201);
        const capId = created.body.budget!.id;
        expect((await getSummary(request, token, workId)).body.globalBudget?.monthlyCapCents).toBe(
            20_000,
        );

        // PATCH the cap up → summary reflects the new ceiling; percentUsed still 0.
        const patched = await request.patch(`${API_BASE}/api/works/${workId}/budgets/${capId}`, {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 65_000, allowOverage: true },
        });
        expect(patched.status()).toBe(200);
        expect(((await patched.json()) as { budget: BudgetRow }).budget.monthlyCapCents).toBe(
            65_000,
        );
        const afterPatch = await getSummary(request, token, workId);
        expect(afterPatch.body.globalBudget?.monthlyCapCents).toBe(65_000);
        expect(afterPatch.body.globalBudget?.allowOverage).toBe(true);
        expect(afterPatch.body.globalBudget?.percentUsed).toBe(0);

        // An empty PATCH is a no-op 200 returning the unchanged row.
        const noop = await request.patch(`${API_BASE}/api/works/${workId}/budgets/${capId}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(noop.status()).toBe(200);
        expect(((await noop.json()) as { budget: BudgetRow }).budget.monthlyCapCents).toBe(65_000);

        // DELETE → summary.globalBudget collapses back to null; delete-again 404.
        const del = await request.delete(`${API_BASE}/api/works/${workId}/budgets/${capId}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect((await getSummary(request, token, workId)).body.globalBudget).toBeNull();
        expect(
            (
                await request.delete(`${API_BASE}/api/works/${workId}/budgets/${capId}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);

        // Through the entire CRUD arc the account-wide window never moved.
        const accountAfter = await getAccountWide(request, token);
        expect(accountAfter.capCents).toBe(accountBefore.capCents);
        expect(accountAfter.blocked).toBe(accountBefore.blocked);
        expect(accountAfter.periodStart).toBe(accountBefore.periodStart);
    });

    test('currency is a WORK-layer fact: a non-USD GLOBAL cap sets the usage-summary currency, but the account-wide summary stays usd (no cross-layer currency propagation)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        // Default (no cap) → summary currency falls back to usd.
        expect((await getSummary(request, token, workId)).body.currency).toBe('usd');

        // A EUR global cap → the summary currency + the budget row echo eur.
        const created = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 30_000,
            currency: 'eur',
        });
        expect(created.status).toBe(201);
        expect(created.body.budget!.currency).toBe('eur');
        const summary = await getSummary(request, token, workId);
        expect(summary.body.currency).toBe('eur');
        expect(summary.body.globalBudget?.currency).toBe('eur');

        // The account-wide layer has no per-Work currency — it stays usd.
        expect((await getAccountWide(request, token)).currency).toBe('usd');

        // Deleting the cap reverts the summary currency to the usd fallback.
        await request.delete(`${API_BASE}/api/works/${workId}/budgets/${created.body.budget!.id}`, {
            headers: authedHeaders(token),
        });
        expect((await getSummary(request, token, workId)).body.currency).toBe('usd');
    });

    test('the cap-create guardrails keep the chain honest: global uniqueness 409, scope↔pluginId cross-rules 400, and the persisted row carries the documented ownerType/ownerId shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const first = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 12_345,
        });
        expect(first.status).toBe(201);
        const row = first.body.budget!;
        // The documented persisted shape (polymorphic owner columns).
        expect(row.workId).toBe(workId);
        expect(row.scope).toBe('global');
        expect(row.pluginId).toBeNull();
        expect(row.allowOverage).toBe(false);
        expect(row.currency).toBe('usd');
        expect(row.ownerType).toBe('work');
        expect(row.ownerId).toBeNull();
        expect(row.id).toMatch(UUID_RE);

        // A second global on the same Work → 409 (patch it instead).
        const dup = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 999,
        });
        expect(dup.status).toBe(409);
        expect(msgOf(dup.body)).toMatch(/global budget already exists/i);

        // Cross-field scope rules.
        const globalWithPlugin = await createBudget(request, token, workId, {
            scope: 'global',
            pluginId: 'openai',
            monthlyCapCents: 100,
        });
        expect(globalWithPlugin.status).toBe(400);
        expect(msgOf(globalWithPlugin.body)).toMatch(/pluginId must be omitted/i);

        const pluginNoId = await createBudget(request, token, workId, {
            scope: 'plugin',
            monthlyCapCents: 100,
        });
        expect(pluginNoId.status).toBe(400);
        expect(msgOf(pluginNoId.body)).toMatch(/pluginId is required/i);
    });

    test('the DTO bounds + security validators reject every bad create shape 400 and NEVER leave a partial row on the Work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const workId = await makeWork(request, token);

        const badShapes: Array<{ dto: Record<string, unknown>; re: RegExp }> = [
            {
                dto: { scope: 'plugin', pluginId: 'p1', monthlyCapCents: 0 },
                re: /not be less than 1/i,
            },
            {
                dto: { scope: 'plugin', pluginId: 'p2', monthlyCapCents: 200_000_000 },
                re: /not be greater than 100000000/i,
            },
            {
                dto: { scope: 'squad', monthlyCapCents: 100 },
                re: /scope must be one of: global, plugin/i,
            },
            {
                dto: { scope: 'plugin', pluginId: 'p3', monthlyCapCents: 100, currency: 'US$' },
                re: /alphabetic currency code/i,
            },
            {
                dto: { scope: 'plugin', pluginId: 'bad id!', monthlyCapCents: 100 },
                re: /pluginId must contain only/i,
            },
        ];

        for (const { dto, re } of badShapes) {
            const res = await createBudget(request, token, workId, dto);
            expect(res.status).toBe(400);
            expect(msgOf(res.body)).toMatch(re);
        }

        // After every rejection the Work still has ZERO budgets — no partial writes.
        expect(await listBudgets(request, token, workId)).toHaveLength(0);
    });
});
