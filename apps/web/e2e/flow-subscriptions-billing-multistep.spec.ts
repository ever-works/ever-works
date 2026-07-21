import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-subscriptions-billing-multistep.spec.ts
 *
 * THEME: the billing surface END-TO-END — a self-serve plan tier transition
 * (free → standard → premium, `SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID` ON) that
 * then provisions PER-WORK budgets, and the read-side usage/admin/account-wide
 * surfaces those budgets feed. Sibling specs already pin the plan walk, the
 * tier↔schedule gating, the GLOBAL-cap CRUD, the billing-grace closure, and the
 * account-wide cap contract. This file deliberately drives the LEAST-covered
 * corners of the same surface:
 *
 *   • PLUGIN-scoped budgets (scope='plugin', pluginId) — create, coexistence
 *     with the global cap, per-plugin uniqueness (409), and the fact that a
 *     plugin budget NEVER populates the usage-summary `globalBudget` slot.
 *   • The full CreateBudgetDto validation matrix — pluginId charset regex,
 *     currency alpha regex + length, cap bounds, scope enum, cross-field rules.
 *   • PATCH semantics — partial patch reflected, empty-patch no-op 200,
 *     scope/pluginId IMMUTABILITY (forbidNonWhitelisted 400), cap-range 400,
 *     unknown-id 404, cross-Work-mismatch 404.
 *   • DELETE semantics — deletedId echo + list/summary reconciliation,
 *     delete-again 404, unknown/cross-Work 404.
 *   • Work-scoping posture — a stranger on someone else's budgets/usage gets a
 *     deterministic 403 that REVEALS the Work exists (unlike the Teams feature's
 *     404-never-403 wall), malformed/unknown workId → 404, unauth → 401.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100, sqlite/in-memory
 * CI driver) BEFORE ANY ASSERTION:
 *
 *   SUBSCRIPTIONS  (SubscriptionsController @Controller('api/subscriptions'), AuthSessionGuard)
 *     GET  /api/subscriptions/plan
 *       -> 200 { status:'success', enabled:true, plan:{ code:'free', name:'Free',
 *                allowedCadences:[{cadence,allowed,payPerUse,reason?} x7] } }  (fresh user → free)
 *     POST /api/subscriptions/plan { planCode:'free'|'standard'|'premium' }
 *       -> 200 { status:'success', enabled:true, plan:{ code, name:'Free'|'Standard'|'Premium',
 *                allowedCadences:[...] } }
 *          SELF-SERVE PAID IS ON in e2e: standard/premium POST → 200 (not the 403 the
 *          production gate would give). On STANDARD the sub-hourly cadences flip to
 *          { allowed:false, payPerUse:true, reason:'Upgrade to Premium for this cadence' };
 *          on FREE/PREMIUM every cadence is { allowed:true, payPerUse:false }.
 *       -> 401 unauth.
 *
 *   WORK BUDGETS  (BudgetsController @Controller('api/works/:workId/budgets'), AuthSessionGuard)
 *     budget row shape: { id, workId, scope:'global'|'plugin', pluginId:string|null,
 *       monthlyCapCents, currency:'usd', allowOverage:false, ownerType:'work', ownerId:null,
 *       createdAt, updatedAt }
 *     GET    /budgets                      -> 200 { budgets:[ ...rows ] }
 *     POST   /budgets  { scope, pluginId?, monthlyCapCents(1..100_000_000), allowOverage?, currency? }
 *       -> 201 { budget:{...} }
 *       - scope=global + pluginId          -> 400 "pluginId must be omitted when scope = global"
 *       - scope=plugin  w/o pluginId       -> 400 "pluginId is required when scope = plugin"
 *       - duplicate global                 -> 409 ; duplicate (work,plugin) -> 409 ; other plugin -> 201
 *       - pluginId '/[^A-Za-z0-9_\-.@]/'   -> 400 "pluginId must contain only letters, digits, ..."
 *       - currency non-alpha / len<2       -> 400 "currency must be an alphabetic currency code ..."
 *       - monthlyCapCents 0 / >1e8         -> 400 ["...must not be less than 1"] / ["...greater than 100000000"]
 *       - scope invalid / missing          -> 400 ["scope must be one of: global, plugin"]
 *     PATCH  /budgets/:budgetId  { monthlyCapCents?, allowOverage?, currency? }
 *       -> 200 { budget:{...updated...} } ; empty body -> 200 unchanged
 *       - scope/pluginId in body           -> 400 "property scope|pluginId should not exist" (immutable)
 *       - cap 0 / >1e8                      -> 400
 *       - unknown budgetId / wrong workId   -> 404 "Budget <id> not found on work <workId>"
 *     DELETE /budgets/:budgetId            -> 200 { deletedId } ; unknown / wrong workId -> 404
 *     ACCESS: owner OK ; stranger GET/read -> 403 "User does not have access to work <id>" (REVEALS existence)
 *             stranger POST/PATCH/DELETE   -> 403 "User must be the Work owner or have MANAGER role ..."
 *             malformed workId (no ParseUUID) -> 404 "Work <raw> not found" ; unknown uuid workId -> 404
 *             unauth -> 401.
 *
 *   WORK USAGE  (UsageController @Controller('api/works/:workId/usage'))
 *     GET /usage/summary[?period=current|YYYY-MM]
 *       -> 200 { workId, periodStart(ISO), periodEnd(ISO), periodLabel('Month YYYY'), currency:'usd',
 *                totalSpendCents:0, perPlugin:[], globalBudget:{...}|null }
 *          A PLUGIN-scoped budget does NOT surface here — globalBudget is null unless a GLOBAL cap exists.
 *          period=2026-03 -> periodStart 2026-03-01T00:00:00Z / periodEnd 2026-04-01 / periodLabel 'March 2026'
 *     GET /usage/export[?period=…][?format=csv]
 *       -> 200 text/csv; charset=utf-8, Cache-Control:no-store,
 *          Content-Disposition: attachment; filename="usage-<workId>-YYYY-MM.csv"
 *          body[0] === 'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId'
 *       - format=json -> 400 "Unsupported format 'json'. Only 'csv' is supported in V1."
 *
 *   ADMIN USAGE  (AdminUsageController @Controller('admin/usage'), IsPlatformAdminGuard)
 *     GET /api/admin/usage      -> 404 (api/-prefixed path is NOT a route — mounted at bare 'admin/usage')
 *     GET /admin/usage (unauth) -> 401 ; (non-admin) -> 403 "Platform admin access required"
 *
 *   ACCOUNT-WIDE  (AccountUsageController @Controller('api/me/usage'))
 *     GET /api/me/usage/account-wide
 *       -> 200 { userId, periodStart, periodEnd, currentSpendCents:0, capCents:null,
 *                currency:'usd', percentUsed:null, allowOverage:true, blocked:false }  (fresh)
 *       -> 401 unauth.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ISOLATION DISCIPLINE: every test builds FRESH registerUserViaAPI() users +
 * throwaway works, and only ever mutates its OWN users' plans/budgets — the
 * shared in-memory DB stays clean for sibling billing specs that assert the
 * SEEDED user is on 'free'. Fully API-orchestrated (safe `flow-` prefix, not
 * matched by the no-auth testIgnore regex). List assertions use toContain on
 * ids (never exact global counts); usage is always zero-state in CI (no plugin
 * call is billed) so spend assertions pin the well-formed zero contract.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const budgetsBase = (workId: string) => `${API_BASE}/api/works/${workId}/budgets`;
const usageBase = (workId: string) => `${API_BASE}/api/works/${workId}/usage`;

type BudgetRow = {
    id: string;
    workId: string;
    scope: 'global' | 'plugin';
    pluginId: string | null;
    monthlyCapCents: number;
    currency: string;
    allowOverage: boolean;
    ownerType: string;
    ownerId: string | null;
    createdAt: string;
    updatedAt: string;
};

/** Register a fresh user and create a throwaway work they own; returns both. */
async function ownerWithWork(
    request: APIRequestContext,
): Promise<{ token: string; userId: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const work = await createWorkViaAPI(request, u.access_token, { name: `bill-${stamp()}` });
    expect(work.id, 'work id resolved').toBeTruthy();
    return { token: u.access_token, userId: u.user.id, workId: work.id };
}

async function createBudget(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<BudgetRow> {
    const res = await request.post(budgetsBase(workId), {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `createBudget body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).budget as BudgetRow;
}

function assertBudgetShape(b: BudgetRow): void {
    expect(b.id).toMatch(UUID_RE);
    expect(b.ownerType).toBe('work');
    expect(b.ownerId).toBeNull();
    expect(typeof b.createdAt).toBe('string');
    expect(typeof b.updatedAt).toBe('string');
}

test.describe('Flow: self-serve plan tier → per-work budget provisioning', () => {
    test('free→standard→premium self-serve (paid allowed), then provision a budget on the upgraded work', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // A fresh user lands on FREE with the full narrow plan shape.
        const initial = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect(initial.status()).toBe(200);
        const free = await initial.json();
        expect(free.status).toBe('success');
        expect(free.enabled, 'subscriptions enabled in e2e').toBe(true);
        expect(free.plan.code).toBe('free');
        expect(free.plan.name).toBe('Free');
        for (const c of free.plan.allowedCadences ?? []) {
            expect(c.allowed, `free ${c.cadence} allowed`).toBe(true);
            expect(c.payPerUse).toBe(false);
        }

        // SELF-SERVE PAID is ON — a standard upgrade is accepted (200, not the 403 the
        // production billing gate would return) and gates the sub-hourly cadences.
        const std = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { planCode: 'standard' },
        });
        expect(std.status(), 'self-serve paid (standard) accepted').toBe(200);
        const stdBody = await std.json();
        expect(stdBody.plan.code).toBe('standard');
        expect(stdBody.plan.name).toBe('Standard');
        const stdCadences: Array<{ cadence: string; allowed: boolean; payPerUse: boolean }> =
            stdBody.plan.allowedCadences ?? [];
        const hourly = stdCadences.find((c) => c.cadence === 'hourly');
        if (hourly) {
            expect(hourly.allowed, 'hourly gated on standard').toBe(false);
            expect(hourly.payPerUse, 'hourly is pay-per-use on standard').toBe(true);
        }

        // Continue to PREMIUM — every cadence re-opens.
        const prem = await request.post(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
            data: { planCode: 'premium' },
        });
        expect(prem.status()).toBe(200);
        const premBody = await prem.json();
        expect(premBody.plan.code).toBe('premium');
        expect(premBody.plan.name).toBe('Premium');
        for (const c of premBody.plan.allowedCadences ?? []) {
            expect(c.allowed, `premium ${c.cadence} re-allowed`).toBe(true);
            expect(c.payPerUse).toBe(false);
        }

        // The upgraded user provisions a per-Work global budget — the tier change and the
        // budget surface are independent but both live under the same authenticated user.
        const work = await createWorkViaAPI(request, u.access_token, { name: `prem-${stamp()}` });
        const budget = await createBudget(request, u.access_token, work.id, {
            scope: 'global',
            monthlyCapCents: 2500,
        });
        assertBudgetShape(budget);
        expect(budget.scope).toBe('global');
        expect(budget.monthlyCapCents).toBe(2500);

        // The plan endpoint still reflects premium (POST→GET consistency) after the budget write.
        const after = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect((await after.json()).plan.code).toBe('premium');
    });

    test('the plan endpoint requires auth and defaults a brand-new user to free', async ({
        request,
    }) => {
        expect((await request.get(`${API_BASE}/api/subscriptions/plan`)).status()).toBe(401);

        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/subscriptions/plan`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // Narrow projection — never leaks pricing / limits.
        expect(Object.keys(body).sort()).toEqual(['enabled', 'plan', 'status']);
        expect(Object.keys(body.plan).sort()).toEqual(['allowedCadences', 'code', 'name']);
        expect(body.plan.code).toBe('free');
    });
});

test.describe('Flow: plugin-scoped budgets coexist with the global cap', () => {
    test('global + two plugin budgets coexist as independent rows in one Work', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);

        const global = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });
        assertBudgetShape(global);
        expect(global.scope).toBe('global');
        expect(global.pluginId, 'global budget carries no pluginId').toBeNull();
        expect(global.currency).toBe('usd');
        expect(global.allowOverage).toBe(false);

        const openai = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'openai',
            monthlyCapCents: 300,
        });
        assertBudgetShape(openai);
        expect(openai.scope).toBe('plugin');
        expect(openai.pluginId).toBe('openai');
        expect(openai.monthlyCapCents).toBe(300);

        const anthropic = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'anthropic',
            monthlyCapCents: 200,
        });
        expect(anthropic.pluginId).toBe('anthropic');

        // All three coexist and are distinct rows.
        const list = await request.get(budgetsBase(workId), { headers: authedHeaders(token) });
        expect(list.status()).toBe(200);
        const rows = (await list.json()).budgets as BudgetRow[];
        const byId = new Map(rows.map((r): [string, BudgetRow] => [r.id, r]));
        expect(byId.has(global.id)).toBe(true);
        expect(byId.has(openai.id)).toBe(true);
        expect(byId.has(anthropic.id)).toBe(true);
        expect(new Set([global.id, openai.id, anthropic.id]).size, 'three distinct ids').toBe(3);
    });

    test('per-plugin uniqueness: duplicate global 409, duplicate (work,plugin) 409, other plugin 201', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        await createBudget(request, token, workId, { scope: 'global', monthlyCapCents: 500 });
        await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'openai',
            monthlyCapCents: 300,
        });

        // Second global on the same Work → 409.
        const dupGlobal = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'global', monthlyCapCents: 999 },
        });
        expect(dupGlobal.status(), 'duplicate global → 409').toBe(409);

        // Second budget for the SAME plugin → 409.
        const dupPlugin = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'plugin', pluginId: 'openai', monthlyCapCents: 111 },
        });
        expect(dupPlugin.status(), 'duplicate (work,plugin) → 409').toBe(409);

        // A DIFFERENT plugin is a fresh unique row → 201.
        const other = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'plugin', pluginId: 'tavily', monthlyCapCents: 150 },
        });
        expect(other.status(), 'distinct plugin → 201').toBe(201);
        expect((await other.json()).budget.pluginId).toBe('tavily');
    });

    test('a plugin-scoped budget NEVER populates the usage-summary globalBudget slot', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);

        // Plugin-only budget present.
        await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'openai',
            monthlyCapCents: 300,
        });
        const sumPluginOnly = await request.get(`${usageBase(workId)}/summary`, {
            headers: authedHeaders(token),
        });
        expect(sumPluginOnly.status()).toBe(200);
        const s1 = await sumPluginOnly.json();
        expect(s1.workId).toBe(workId);
        expect(s1.totalSpendCents, 'zero spend in CI').toBe(0);
        expect(Array.isArray(s1.perPlugin)).toBe(true);
        expect(s1.perPlugin.length).toBe(0);
        expect(s1.globalBudget, 'plugin budget must NOT surface as the global cap').toBeNull();

        // Now add a GLOBAL cap — only THAT populates globalBudget (with the global cap value,
        // never the plugin cap).
        const global = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
        });
        const sumWithGlobal = await request.get(`${usageBase(workId)}/summary`, {
            headers: authedHeaders(token),
        });
        const s2 = await sumWithGlobal.json();
        expect(s2.globalBudget, 'global cap now surfaces').not.toBeNull();
        expect(s2.globalBudget.id).toBe(global.id);
        expect(s2.globalBudget.monthlyCapCents, 'reflects the GLOBAL cap, not the plugin cap').toBe(
            5000,
        );
        expect(s2.globalBudget.percentUsed, '0 spend / cap → 0%').toBe(0);
    });

    test('cross-field scope rules: global+pluginId 400, plugin without pluginId 400', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);

        const globalWithPlugin = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'global', pluginId: 'openai', monthlyCapCents: 100 },
        });
        expect(globalWithPlugin.status()).toBe(400);
        expect(JSON.stringify(await globalWithPlugin.json())).toContain('pluginId must be omitted');

        const pluginNoId = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'plugin', monthlyCapCents: 100 },
        });
        expect(pluginNoId.status()).toBe(400);
        expect(JSON.stringify(await pluginNoId.json())).toContain('pluginId is required');
    });
});

test.describe('Flow: budget DTO validation matrix', () => {
    test('pluginId is restricted to a safe identifier charset (regex 400)', async ({ request }) => {
        const { token, workId } = await ownerWithWork(request);
        const bad = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'plugin', pluginId: 'bad plugin!', monthlyCapCents: 100 },
        });
        expect(bad.status()).toBe(400);
        expect(JSON.stringify((await bad.json()).message)).toContain('pluginId must contain only');

        // A dotted/@ id IS in the allowed charset → 201.
        const ok = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'plugin', pluginId: 'org.scope@v1', monthlyCapCents: 100 },
        });
        expect(ok.status(), 'dotted/@ pluginId is a legal identifier').toBe(201);
        expect((await ok.json()).budget.pluginId).toBe('org.scope@v1');
    });

    test('currency must be a 2-8 char alphabetic code (regex + length 400)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);

        const digits = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'global', monthlyCapCents: 100, currency: 'us1' },
        });
        expect(digits.status()).toBe(400);
        expect(JSON.stringify((await digits.json()).message)).toContain(
            'currency must be an alphabetic',
        );

        const tooShort = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'global', monthlyCapCents: 100, currency: 'u' },
        });
        expect(tooShort.status()).toBe(400);
    });

    test('monthlyCapCents bounds + scope enum are enforced (400)', async ({ request }) => {
        const { token, workId } = await ownerWithWork(request);

        // Below the floor (@Min(1)).
        const zero = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'global', monthlyCapCents: 0 },
        });
        expect(zero.status()).toBe(400);
        expect(JSON.stringify((await zero.json()).message)).toContain('must not be less than 1');

        // Above the ceiling (@Max(100_000_000)).
        const over = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'global', monthlyCapCents: 100_000_001 },
        });
        expect(over.status()).toBe(400);
        expect(JSON.stringify((await over.json()).message)).toContain(
            'must not be greater than 100000000',
        );

        // Unknown scope enum → 400 with the allowed-values message.
        const badScope = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { scope: 'team', monthlyCapCents: 100 },
        });
        expect(badScope.status()).toBe(400);
        expect(JSON.stringify((await badScope.json()).message)).toContain(
            'scope must be one of: global, plugin',
        );

        // Missing scope entirely → same enum guard.
        const missingScope = await request.post(budgetsBase(workId), {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 100 },
        });
        expect(missingScope.status()).toBe(400);
    });
});

test.describe('Flow: budget PATCH semantics', () => {
    test('PATCH cap + overage + currency is reflected and persists on re-read', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });

        const patch = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 1000, allowOverage: true, currency: 'eur' },
        });
        expect(patch.status()).toBe(200);
        const patched = (await patch.json()).budget as BudgetRow;
        expect(patched.monthlyCapCents).toBe(1000);
        expect(patched.allowOverage).toBe(true);
        expect(patched.currency).toBe('eur');
        // scope/pluginId are untouched.
        expect(patched.scope).toBe('global');
        expect(patched.pluginId).toBeNull();

        const reread = await request.get(budgetsBase(workId), { headers: authedHeaders(token) });
        const row = (await reread.json()).budgets.find((b: BudgetRow) => b.id === budget.id);
        expect(row.monthlyCapCents).toBe(1000);
        expect(row.allowOverage).toBe(true);
        expect(row.currency).toBe('eur');
    });

    test('PATCH with an empty body is a no-op 200 that returns the unchanged budget', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 640,
        });
        const noop = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(noop.status()).toBe(200);
        const same = (await noop.json()).budget as BudgetRow;
        expect(same.id).toBe(budget.id);
        expect(same.monthlyCapCents).toBe(640);
    });

    test('scope and pluginId are IMMUTABLE — patching them is rejected 400 (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });

        const patchScope = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: { scope: 'plugin' },
        });
        expect(patchScope.status()).toBe(400);
        expect(JSON.stringify((await patchScope.json()).message)).toContain(
            'property scope should not exist',
        );

        const patchPlugin = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: { pluginId: 'openai' },
        });
        expect(patchPlugin.status()).toBe(400);
        expect(JSON.stringify((await patchPlugin.json()).message)).toContain(
            'property pluginId should not exist',
        );
    });

    test('PATCH cap out of range (0 / over-max) is rejected 400', async ({ request }) => {
        const { token, workId } = await ownerWithWork(request);
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });

        const zero = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 0 },
        });
        expect(zero.status()).toBe(400);

        const over = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 100_000_001 },
        });
        expect(over.status()).toBe(400);
    });

    test('PATCH an unknown budget or a budget from another Work → 404', async ({ request }) => {
        const { token, workId } = await ownerWithWork(request);
        const other = await createWorkViaAPI(request, token, { name: `patch-other-${stamp()}` });
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });

        // Unknown (but valid uuid) budget id under a real work → 404.
        const unknown = await request.patch(`${budgetsBase(workId)}/${UNKNOWN_UUID}`, {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 700 },
        });
        expect(unknown.status()).toBe(404);
        expect(JSON.stringify(await unknown.json())).toContain('not found on work');

        // Real budget id but addressed via the WRONG work (cross-Work mismatch) → 404.
        const mismatch = await request.patch(`${budgetsBase(other.id)}/${budget.id}`, {
            headers: authedHeaders(token),
            data: { monthlyCapCents: 700 },
        });
        expect(mismatch.status()).toBe(404);
    });
});

test.describe('Flow: budget DELETE semantics', () => {
    test('DELETE echoes deletedId, drops the row from list + summary, and delete-again is 404', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });

        // Summary carries the cap before delete.
        const before = await request.get(`${usageBase(workId)}/summary`, {
            headers: authedHeaders(token),
        });
        expect((await before.json()).globalBudget.id).toBe(budget.id);

        const del = await request.delete(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect((await del.json()).deletedId).toBe(budget.id);

        // List no longer contains it, and the summary's globalBudget goes back to null.
        const list = await request.get(budgetsBase(workId), { headers: authedHeaders(token) });
        expect((await list.json()).budgets.map((b: BudgetRow) => b.id)).not.toContain(budget.id);
        const after = await request.get(`${usageBase(workId)}/summary`, {
            headers: authedHeaders(token),
        });
        expect(
            (await after.json()).globalBudget,
            'cap removed → summary globalBudget null',
        ).toBeNull();

        // Deleting the already-deleted budget → 404.
        const again = await request.delete(`${budgetsBase(workId)}/${budget.id}`, {
            headers: authedHeaders(token),
        });
        expect(again.status()).toBe(404);
    });

    test('DELETE an unknown budget or one addressed via the wrong Work → 404', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        const other = await createWorkViaAPI(request, token, { name: `del-other-${stamp()}` });
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });

        const unknown = await request.delete(`${budgetsBase(workId)}/${UNKNOWN_UUID}`, {
            headers: authedHeaders(token),
        });
        expect(unknown.status()).toBe(404);

        const mismatch = await request.delete(`${budgetsBase(other.id)}/${budget.id}`, {
            headers: authedHeaders(token),
        });
        expect(mismatch.status()).toBe(404);

        // The budget is untouched by the failed cross-Work delete.
        const list = await request.get(budgetsBase(workId), { headers: authedHeaders(token) });
        expect((await list.json()).budgets.map((b: BudgetRow) => b.id)).toContain(budget.id);
    });
});

test.describe('Flow: work-scoping + auth posture on budgets/usage', () => {
    test('malformed workId → 404 (no ParseUUID); unknown uuid workId → 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // No ParseUUIDPipe on :workId — a non-uuid falls straight through to the
        // access check, which 404s on a missing Work rather than 400-ing the param.
        const malformed = await request.get(`${API_BASE}/api/works/not-a-uuid/budgets`, {
            headers: authedHeaders(u.access_token),
        });
        expect(malformed.status()).toBe(404);
        expect(JSON.stringify(await malformed.json())).toContain('not found');

        const unknown = await request.get(`${budgetsBase(UNKNOWN_UUID)}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(unknown.status()).toBe(404);
    });

    test('a stranger gets a deterministic 403 (which REVEALS the Work exists) across budgets + usage; unauth is 401', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);
        const budget = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 500,
        });
        const stranger = await registerUserViaAPI(request);
        const sHeaders = authedHeaders(stranger.access_token);

        // Read access: 403 (Forbidden) — the Work exists but the stranger is not a member.
        // NB: this is a REVEALS-EXISTENCE posture, distinct from the Teams feature's
        // 404-never-403 wall. We pin the true 403, tolerating 404 only for drift-safety.
        const readBudgets = await request.get(budgetsBase(workId), { headers: sHeaders });
        expect([403, 404], `stranger read budgets ${readBudgets.status()}`).toContain(
            readBudgets.status(),
        );
        expect(readBudgets.status()).toBe(403);

        const readUsage = await request.get(`${usageBase(workId)}/summary`, { headers: sHeaders });
        expect(readUsage.status()).toBe(403);

        // Write access: 403 with the manager-role message.
        const write = await request.post(budgetsBase(workId), {
            headers: sHeaders,
            data: { scope: 'global', monthlyCapCents: 100 },
        });
        expect(write.status()).toBe(403);
        expect(JSON.stringify(await write.json())).toContain('MANAGER');

        const patch = await request.patch(`${budgetsBase(workId)}/${budget.id}`, {
            headers: sHeaders,
            data: { monthlyCapCents: 999 },
        });
        expect(patch.status()).toBe(403);

        const del = await request.delete(`${budgetsBase(workId)}/${budget.id}`, {
            headers: sHeaders,
        });
        expect(del.status()).toBe(403);

        // The owner's budget is untouched by every rejected stranger mutation.
        const ownerList = await request.get(budgetsBase(workId), { headers: authedHeaders(token) });
        const row = (await ownerList.json()).budgets.find((b: BudgetRow) => b.id === budget.id);
        expect(row.monthlyCapCents, 'stranger PATCH did not mutate the cap').toBe(500);

        // Unauthenticated access is 401 across the surface.
        expect((await request.get(budgetsBase(workId))).status()).toBe(401);
        expect((await request.get(`${usageBase(workId)}/summary`)).status()).toBe(401);
    });
});

test.describe('Flow: usage read surface (period window + CSV export)', () => {
    test('usage summary resolves an explicit YYYY-MM period window as a well-formed zero-state', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);

        const res = await request.get(`${usageBase(workId)}/summary?period=2026-03`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const s = await res.json();
        expect(s.workId).toBe(workId);
        expect(s.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(s.periodEnd).toBe('2026-04-01T00:00:00.000Z');
        expect(s.periodLabel).toBe('March 2026');
        expect(s.currency).toBe('usd');
        expect(s.totalSpendCents).toBe(0);
        expect(s.perPlugin).toEqual([]);
        expect(s.globalBudget).toBeNull();

        // Garbage period + out-of-range month are both 400.
        const garbage = await request.get(`${usageBase(workId)}/summary?period=not-a-period`, {
            headers: authedHeaders(token),
        });
        expect(garbage.status()).toBe(400);
        const month13 = await request.get(`${usageBase(workId)}/summary?period=2026-13`, {
            headers: authedHeaders(token),
        });
        expect(month13.status()).toBe(400);
    });

    test('usage export streams CSV with a period-stamped filename and rejects non-csv formats', async ({
        request,
    }) => {
        const { token, workId } = await ownerWithWork(request);

        const csv = await request.get(`${usageBase(workId)}/export?period=2026-03`, {
            headers: authedHeaders(token),
        });
        expect(csv.status()).toBe(200);
        const headers = csv.headers();
        expect(headers['content-type'] || '').toContain('text/csv');
        expect(headers['cache-control'] || '').toContain('no-store');
        expect(headers['content-disposition'] || '').toContain(`usage-${workId}-2026-03.csv`);
        const text = await csv.text();
        expect(text.split(/\r?\n/)[0]).toBe(
            'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId',
        );

        // Only csv is supported in V1.
        const json = await request.get(`${usageBase(workId)}/export?format=json`, {
            headers: authedHeaders(token),
        });
        expect(json.status()).toBe(400);
        expect(JSON.stringify(await json.json())).toContain("Only 'csv' is supported");
    });
});

test.describe('Flow: admin + account-wide closure (theme bookend)', () => {
    test('admin cross-user usage is gated: api-prefixed 404, /admin/usage 401 unauth + 403 non-admin', async ({
        request,
    }) => {
        // The `api/`-prefixed path is NOT a route — the controller mounts at bare 'admin/usage'.
        expect((await request.get(`${API_BASE}/api/admin/usage`)).status()).toBe(404);

        // The real route requires auth.
        expect((await request.get(`${API_BASE}/admin/usage`)).status()).toBe(401);

        // An authenticated NON-admin is forbidden (route exists, platform-admin guard rejects).
        const u = await registerUserViaAPI(request);
        const nonAdmin = await request.get(`${API_BASE}/admin/usage`, {
            headers: authedHeaders(u.access_token),
        });
        expect(nonAdmin.status()).toBe(403);
        expect(JSON.stringify(await nonAdmin.json())).toContain('Platform admin');
    });

    test('account-wide usage summary is a well-formed uncapped zero-state for a fresh user; unauth 401', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const b = await res.json();
        expect(b.userId).toBe(u.user.id);
        expect(typeof b.periodStart).toBe('string');
        expect(typeof b.periodEnd).toBe('string');
        expect(b.currentSpendCents, 'fresh user has zero spend').toBe(0);
        expect(b.capCents, 'no cap set → null').toBeNull();
        expect(b.currency).toBe('usd');
        expect(b.percentUsed, 'no cap → percentUsed null').toBeNull();
        expect(b.allowOverage, 'account-wide overage defaults permissive').toBe(true);
        expect(b.blocked, 'no cap → never blocked').toBe(false);

        expect((await request.get(`${API_BASE}/api/me/usage/account-wide`)).status()).toBe(401);
    });
});
