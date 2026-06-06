import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * GLOBAL budget cap — complex, multi-step, cross-feature INTEGRATION flows that
 * pin the per-Work GLOBAL monthly cap (scope='global') end-to-end and target the
 * gaps the sibling budget specs (`flow-subscriptions-budgets.spec.ts`,
 * `flow-agent-budget-enforcement.spec.ts`, `budgets.spec.ts`) do NOT already
 * cover: GLOBAL-vs-PLUGIN cap COEXISTENCE & isolation on a single Work, the
 * GLOBAL cap's CURRENCY propagating into the usage summary verbatim, PATCH
 * scope/pluginId IMMUTABILITY (whitelist rejection, not silent ignore), DELETE
 * cross-work scoping + re-delete idempotency, the full create-time validation
 * lattice, per-Work cap isolation, and MEMBER RBAC (VIEWER reads / MANAGER+
 * mutates) on the GLOBAL cap.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED LIVE (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   BudgetsController  @Controller('api/works/:workId/budgets')  (AuthSessionGuard)
 *     GET    /api/works/:id/budgets               -> 200 { budgets:[ {id,workId,scope,pluginId,
 *              monthlyCapCents,currency,allowOverage,ownerType:'work',ownerId:null,createdAt,updatedAt}, ... ] }
 *              ordered scope ASC then pluginId ASC → a 'global' row sorts BEFORE 'plugin' rows.
 *     POST   /api/works/:id/budgets               -> 201 { budget:{...} }
 *              body { scope:'global'|'plugin', pluginId?, monthlyCapCents (int 1..100_000_000),
 *                     allowOverage? (default false), currency? (Length 2..8, default 'usd') }
 *       - scope='global' WITH pluginId           -> 400 'pluginId must be omitted when scope = global'
 *       - scope='plugin' WITHOUT pluginId        -> 400 'pluginId is required when scope = plugin'
 *       - duplicate GLOBAL on same Work          -> 409 'A global budget already exists for this Work — patch it instead.'
 *       - monthlyCapCents:0                       -> 400 ['monthlyCapCents must not be less than 1']
 *       - monthlyCapCents:100000001 (> @Max)      -> 400 ['monthlyCapCents must not be greater than 100000000']
 *       - monthlyCapCents:12.5 (non-int)          -> 400 ['monthlyCapCents must be an integer number']
 *       - monthlyCapCents:100000000 (== @Max)     -> 201 (boundary inclusive)
 *       - scope:'organization' (bad enum)         -> 400 ['scope must be one of: global, plugin']
 *       - currency:'x' (Length < 2)               -> 400 ['currency must be longer than or equal to 2 characters']
 *       - UNKNOWN extra prop e.g. bogusField      -> 400 ['property bogusField should not exist']  (forbidNonWhitelisted)
 *       NOTE: currency is stored VERBATIM (NOT lower-cased): POST currency:'USD' → row.currency='USD'.
 *             ownerType backfills to 'work' on create; ownerId comes back NULL on a freshly-created row.
 *     PATCH  /api/works/:id/budgets/:budgetId     -> 200 { budget:{...} }  (monthlyCapCents/allowOverage/currency only)
 *       - body with scope and/or pluginId        -> 400 ['property scope should not exist','property pluginId should not exist']
 *       - empty body {}                           -> 200 (no-op, returns the unchanged row)
 *       - budgetId on a DIFFERENT work's path     -> 404 'Budget <id> not found on work <workId>'  (workId mismatch gate)
 *     DELETE /api/works/:id/budgets/:budgetId     -> 200 { deletedId }
 *       - budgetId on a DIFFERENT work's path     -> 404
 *       - re-DELETE an already-deleted id         -> 404 (idempotent NotFound)
 *
 *   UsageController  @Controller('api/works/:workId/usage')
 *     GET /api/works/:id/usage/summary
 *       -> 200 { workId, periodStart, periodEnd, periodLabel, currency, totalSpendCents:0,
 *                perPlugin:[], globalBudget:{ id,monthlyCapCents,allowOverage,currency,percentUsed } | null }
 *       • summary.currency MIRRORS the GLOBAL cap's currency (globalBudget?.currency ?? 'usd');
 *         a PLUGIN-only cap leaves currency='usd' default and globalBudget=null (plugin caps are
 *         NEVER surfaced in globalBudget — that field is the GLOBAL row only).
 *       • globalBudget.percentUsed = Math.round(totalSpendCents / monthlyCapCents * 100) → 0 at zero spend.
 *
 *   ACCESS (BudgetsController guards):
 *     assertReadAccess  → owner OR any work member (VIEWER+) may GET budgets + usage summary.
 *     assertWriteAccess → owner OR MANAGER-role member may POST/PATCH/DELETE; otherwise
 *                         403 'User must be the Work owner or have MANAGER role to mutate budgets'.
 *     stranger (no membership) → 403 (work exists) on read+write of an owned work's budgets.
 *     unauth → 401 across the board.
 *   MembersController POST /api/works/:id/members { email, role:'viewer'|'editor'|'manager' }
 *     adds the member DIRECTLY (the invitee must be an existing registered user; no email-accept
 *     step is needed — used here to provision deterministic VIEWER/MANAGER members for RBAC).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • NO plugin billing happens in CI → totalSpendCents is always 0, so percentUsed is always 0
 *     under any positive cap. The cap-ENFORCEMENT predicate (blocked = spend>=cap && !overage)
 *     for the account layer is covered by the sibling agent-budget spec; here the GLOBAL-cap
 *     over-budget CONTRACT is asserted via the well-formed cap roll-up the summary exposes
 *     (globalBudget + percentUsed), which is the only deterministic GLOBAL-cap signal in CI.
 *   • CROSS-SPEC ISOLATION: every flow runs on FRESH registerUserViaAPI() users + throwaway
 *     Works (unique Date.now()/nanotime names). No shared-seeded-user mutations; caps are
 *     per-Work rows that can't shadow sibling specs. Assertions use toContain / per-id lookups,
 *     never exact global counts.
 */

interface WorkBudgetRow {
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
}

const budgetsUrl = (workId: string) => `${API_BASE}/api/works/${workId}/budgets`;
const summaryUrl = (workId: string) => `${API_BASE}/api/works/${workId}/usage/summary`;

async function listBudgets(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<WorkBudgetRow[]> {
    const res = await request.get(budgetsUrl(workId), { headers: authedHeaders(token) });
    expect(res.status(), `list budgets status ${res.status()}`).toBe(200);
    return (await res.json()).budgets as WorkBudgetRow[];
}

async function createGlobalCap(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: { monthlyCapCents: number; allowOverage?: boolean; currency?: string },
): Promise<WorkBudgetRow> {
    const res = await request.post(budgetsUrl(workId), {
        headers: authedHeaders(token),
        data: { scope: 'global', ...data },
    });
    expect(res.status(), `create global cap body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).budget as WorkBudgetRow;
}

async function getSummary(request: APIRequestContext, token: string, workId: string) {
    const res = await request.get(summaryUrl(workId), { headers: authedHeaders(token) });
    expect(res.status(), `usage summary status ${res.status()}`).toBe(200);
    return res.json();
}

async function addMember(
    request: APIRequestContext,
    ownerToken: string,
    workId: string,
    email: string,
    role: 'viewer' | 'editor' | 'manager',
) {
    const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(ownerToken),
        data: { email, role },
    });
    expect(res.status(), `add ${role} member body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

test.describe('Flow: GLOBAL cap full lifecycle — create → list-order → summary roll-up → patch → delete → re-delete', () => {
    test('a GLOBAL cap is the one-per-Work row that drives the usage summary; full CRUD round-trip is observable + idempotent', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `gcap-life-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // ── Step 1: before any cap the list is empty and the summary's globalBudget
        //    is null with the DEFAULT 'usd' currency (no GLOBAL row to inherit from).
        expect(await listBudgets(request, u.access_token, work.id)).toEqual([]);
        const bare = await getSummary(request, u.access_token, work.id);
        expect(bare.globalBudget, 'no GLOBAL cap → globalBudget null').toBeNull();
        expect(bare.currency, 'no GLOBAL cap → summary falls back to usd').toBe('usd');

        // ── Step 2: create the single GLOBAL monthly cap ($30.00) with a non-default
        //    currency. The created row is scope='global', pluginId NULL, ownerType
        //    backfilled to 'work', and the currency is stored VERBATIM.
        const created = await createGlobalCap(request, u.access_token, work.id, {
            monthlyCapCents: 3000,
            allowOverage: false,
            currency: 'eur',
        });
        expect(created.id).toBeTruthy();
        expect(created.scope).toBe('global');
        expect(created.pluginId, 'GLOBAL cap carries no pluginId').toBeNull();
        expect(created.monthlyCapCents).toBe(3000);
        expect(created.allowOverage).toBe(false);
        expect(created.currency).toBe('eur');
        expect(created.ownerType, 'create backfills ownerType=work').toBe('work');
        const capId = created.id;

        // ── Step 3: exactly ONE GLOBAL row exists for the Work and it surfaces in the
        //    usage summary's globalBudget block, dictating the summary currency and the
        //    zero-spend percentUsed roll-up (the GLOBAL-cap over-budget contract in CI).
        const rows = await listBudgets(request, u.access_token, work.id);
        const globals = rows.filter((b) => b.scope === 'global');
        expect(globals, 'one GLOBAL cap per Work').toHaveLength(1);
        expect(globals[0].id).toBe(capId);

        const s1 = await getSummary(request, u.access_token, work.id);
        expect(s1.globalBudget, 'summary now carries the GLOBAL cap').not.toBeNull();
        expect(s1.globalBudget.id).toBe(capId);
        expect(s1.globalBudget.monthlyCapCents).toBe(3000);
        expect(s1.globalBudget.currency, 'summary currency mirrors the GLOBAL cap').toBe('eur');
        expect(s1.currency, 'top-level summary currency also mirrors the GLOBAL cap').toBe('eur');
        expect(s1.globalBudget.percentUsed, '0 spend under a positive cap → 0%').toBe(0);

        // ── Step 4: PATCH lifts the cap, flips overage on, and switches currency — the
        //    summary reflects every mutated field (the cap is genuinely re-read, not cached).
        const patch = await request.patch(`${budgetsUrl(work.id)}/${capId}`, {
            headers: authedHeaders(u.access_token),
            data: { monthlyCapCents: 9000, allowOverage: true, currency: 'gbp' },
        });
        expect(patch.status()).toBe(200);
        const patched = (await patch.json()).budget as WorkBudgetRow;
        expect(patched.monthlyCapCents).toBe(9000);
        expect(patched.allowOverage).toBe(true);
        expect(patched.currency).toBe('gbp');

        const s2 = await getSummary(request, u.access_token, work.id);
        expect(s2.globalBudget.monthlyCapCents).toBe(9000);
        expect(s2.globalBudget.allowOverage).toBe(true);
        expect(s2.currency).toBe('gbp');

        // ── Step 5: DELETE removes the GLOBAL cap (returns the deletedId), and the
        //    summary reverts to the uncapped null-state with the 'usd' default.
        const del = await request.delete(`${budgetsUrl(work.id)}/${capId}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBe(200);
        expect((await del.json()).deletedId).toBe(capId);

        const s3 = await getSummary(request, u.access_token, work.id);
        expect(s3.globalBudget, 'cap removed → globalBudget null again').toBeNull();
        expect(s3.currency, 'no GLOBAL cap → summary back to usd default').toBe('usd');
        expect(await listBudgets(request, u.access_token, work.id)).toEqual([]);

        // ── Step 6: re-DELETING the now-gone id is an idempotent NotFound (404), never
        //    a 500 — the row no longer exists on the work.
        const reDel = await request.delete(`${budgetsUrl(work.id)}/${capId}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(reDel.status(), 're-delete a removed cap → 404').toBe(404);
    });
});

test.describe('Flow: GLOBAL vs PLUGIN cap coexistence — two distinct rows on one Work, independently managed', () => {
    test('a Work carries one GLOBAL cap AND a PLUGIN cap side-by-side; only the GLOBAL drives the summary, and each is patched/deleted in isolation', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `gcap-coexist-${Date.now()}`,
        });

        // ── Step 1: a PLUGIN-scoped cap exists FIRST. It is NOT a GLOBAL cap, so the
        //    summary's globalBudget stays null and the currency stays the 'usd' default
        //    even though the plugin row declares a different currency.
        const pluginCreate = await request.post(budgetsUrl(work.id), {
            headers: authedHeaders(u.access_token),
            data: {
                scope: 'plugin',
                pluginId: 'openrouter',
                monthlyCapCents: 800,
                currency: 'jpy',
            },
        });
        expect(pluginCreate.status()).toBe(201);
        const pluginRow = (await pluginCreate.json()).budget as WorkBudgetRow;
        expect(pluginRow.scope).toBe('plugin');
        expect(pluginRow.pluginId).toBe('openrouter');

        const sPluginOnly = await getSummary(request, u.access_token, work.id);
        expect(
            sPluginOnly.globalBudget,
            'a PLUGIN cap is never surfaced as globalBudget',
        ).toBeNull();
        expect(sPluginOnly.currency, 'plugin-only Work → summary stays on usd default').toBe('usd');

        // ── Step 2: a GLOBAL cap is created ALONGSIDE the plugin cap. Both coexist —
        //    they are distinct rows (different ids, scopes, pluginIds). The list is
        //    ordered scope ASC, so 'global' sorts ahead of 'plugin'.
        const globalRow = await createGlobalCap(request, u.access_token, work.id, {
            monthlyCapCents: 5000,
            currency: 'usd',
        });
        expect(globalRow.id).not.toBe(pluginRow.id);

        const rows = await listBudgets(request, u.access_token, work.id);
        const byId = new Map(rows.map((b) => [b.id, b]));
        expect(byId.has(globalRow.id), 'GLOBAL row listed').toBe(true);
        expect(byId.has(pluginRow.id), 'PLUGIN row listed').toBe(true);
        const scopes = rows.map((b) => b.scope);
        expect(scopes.indexOf('global'), 'scope ASC orders global before plugin').toBeLessThan(
            scopes.indexOf('plugin'),
        );

        // ── Step 3: NOW the GLOBAL cap drives the summary; the coexisting plugin cap
        //    is irrelevant to globalBudget. percentUsed is the GLOBAL roll-up only.
        const sBoth = await getSummary(request, u.access_token, work.id);
        expect(sBoth.globalBudget, 'GLOBAL cap now present').not.toBeNull();
        expect(sBoth.globalBudget.id).toBe(globalRow.id);
        expect(sBoth.globalBudget.monthlyCapCents).toBe(5000);
        expect(sBoth.currency).toBe('usd');

        // ── Step 4: patching the GLOBAL cap does NOT touch the PLUGIN cap (independent rows).
        const patchGlobal = await request.patch(`${budgetsUrl(work.id)}/${globalRow.id}`, {
            headers: authedHeaders(u.access_token),
            data: { monthlyCapCents: 6000 },
        });
        expect(patchGlobal.status()).toBe(200);
        const afterPatch = await listBudgets(request, u.access_token, work.id);
        expect(afterPatch.find((b) => b.id === globalRow.id)!.monthlyCapCents).toBe(6000);
        expect(
            afterPatch.find((b) => b.id === pluginRow.id)!.monthlyCapCents,
            'plugin cap unchanged by GLOBAL patch',
        ).toBe(800);

        // ── Step 5: deleting the GLOBAL cap leaves the PLUGIN cap in place and the
        //    summary reverts to globalBudget null — but the plugin row is still listed.
        const delGlobal = await request.delete(`${budgetsUrl(work.id)}/${globalRow.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(delGlobal.status()).toBe(200);
        const afterDelete = await listBudgets(request, u.access_token, work.id);
        expect(
            afterDelete.some((b) => b.id === globalRow.id),
            'GLOBAL cap gone',
        ).toBe(false);
        expect(
            afterDelete.some((b) => b.id === pluginRow.id),
            'PLUGIN cap survives',
        ).toBe(true);
        const sAfter = await getSummary(request, u.access_token, work.id);
        expect(sAfter.globalBudget, 'GLOBAL gone → globalBudget null again').toBeNull();

        // ── Step 6: re-creating a GLOBAL cap is now allowed (the prior one was deleted),
        //    proving the "one GLOBAL per Work" constraint is on LIVE rows, not history.
        const recreated = await createGlobalCap(request, u.access_token, work.id, {
            monthlyCapCents: 1234,
        });
        expect(recreated.scope).toBe('global');
        expect(recreated.id).not.toBe(globalRow.id);
    });
});

test.describe('Flow: GLOBAL cap uniqueness + scope/pluginId immutability', () => {
    test('a second GLOBAL cap is a 409 conflict; PATCH cannot mutate scope/pluginId; empty PATCH is a no-op', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `gcap-unique-${Date.now()}`,
        });

        // ── Step 1: the first GLOBAL cap is created.
        const first = await createGlobalCap(request, u.access_token, work.id, {
            monthlyCapCents: 2000,
            currency: 'usd',
        });

        // ── Step 2: a SECOND GLOBAL cap on the same Work is a CONFLICT with the
        //    documented "patch it instead" guidance — the cap is one-per-Work.
        const dup = await request.post(budgetsUrl(work.id), {
            headers: authedHeaders(u.access_token),
            data: { scope: 'global', monthlyCapCents: 7777 },
        });
        expect(dup.status(), 'duplicate GLOBAL cap → 409').toBe(409);
        expect(JSON.stringify((await dup.json()).message)).toContain(
            'A global budget already exists for this Work',
        );
        // The conflict did NOT create a second row.
        expect(
            (await listBudgets(request, u.access_token, work.id)).filter(
                (b) => b.scope === 'global',
            ),
            'still exactly one GLOBAL cap after the rejected duplicate',
        ).toHaveLength(1);

        // ── Step 3: scope and pluginId are IMMUTABLE — PATCHing them is rejected by the
        //    DTO whitelist (forbidNonWhitelisted), NOT silently ignored. The cap can
        //    never be converted from GLOBAL into a PLUGIN cap.
        const mutateScope = await request.patch(`${budgetsUrl(work.id)}/${first.id}`, {
            headers: authedHeaders(u.access_token),
            data: { scope: 'plugin', pluginId: 'openrouter', monthlyCapCents: 3000 },
        });
        expect(mutateScope.status(), 'patching scope/pluginId → 400 whitelist rejection').toBe(400);
        const mutMsg = JSON.stringify((await mutateScope.json()).message);
        expect(mutMsg).toContain('scope should not exist');
        expect(mutMsg).toContain('pluginId should not exist');
        // The cap is untouched (the rejected patch was atomic — even monthlyCapCents
        // did not change).
        const stillGlobal = (await listBudgets(request, u.access_token, work.id)).find(
            (b) => b.id === first.id,
        )!;
        expect(stillGlobal.scope, 'cap is still GLOBAL').toBe('global');
        expect(stillGlobal.pluginId, 'cap still has no pluginId').toBeNull();
        expect(stillGlobal.monthlyCapCents, 'rejected patch did not change the cap').toBe(2000);

        // ── Step 4: an EMPTY patch body is an accepted no-op that echoes the unchanged row.
        const noop = await request.patch(`${budgetsUrl(work.id)}/${first.id}`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(noop.status(), 'empty PATCH → 200 no-op').toBe(200);
        expect((await noop.json()).budget.monthlyCapCents).toBe(2000);

        // ── Step 5: a LEGAL patch (cap + overage only) succeeds and is reflected.
        const legal = await request.patch(`${budgetsUrl(work.id)}/${first.id}`, {
            headers: authedHeaders(u.access_token),
            data: { monthlyCapCents: 2500, allowOverage: true },
        });
        expect(legal.status()).toBe(200);
        const legalBody = (await legal.json()).budget as WorkBudgetRow;
        expect(legalBody.monthlyCapCents).toBe(2500);
        expect(legalBody.allowOverage).toBe(true);
        expect(legalBody.scope, 'scope untouched by a legal patch').toBe('global');
    });
});

test.describe('Flow: GLOBAL cap create-time validation lattice', () => {
    test('every documented create constraint is enforced with a 4xx (never a 5xx, never a silent 200)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `gcap-valid-${Date.now()}`,
        });
        const post = (data: unknown) =>
            request.post(budgetsUrl(work.id), { headers: authedHeaders(u.access_token), data });

        // ── cap below the floor (@Min(1)).
        const zero = await post({ scope: 'global', monthlyCapCents: 0 });
        expect(zero.status()).toBe(400);
        expect(JSON.stringify((await zero.json()).message)).toContain('must not be less than 1');

        // ── cap over the ceiling (@Max(100_000_000)).
        const tooBig = await post({ scope: 'global', monthlyCapCents: 100_000_001 });
        expect(tooBig.status()).toBe(400);
        expect(JSON.stringify((await tooBig.json()).message)).toContain(
            'must not be greater than 100000000',
        );

        // ── non-integer cap (@IsInt).
        const float = await post({ scope: 'global', monthlyCapCents: 12.5 });
        expect(float.status()).toBe(400);
        expect(JSON.stringify((await float.json()).message)).toContain('must be an integer number');

        // ── bad scope enum (@IsEnum) surfaces the allowed-values message.
        const badScope = await post({ scope: 'organization', monthlyCapCents: 100 });
        expect(badScope.status()).toBe(400);
        expect(JSON.stringify((await badScope.json()).message)).toContain(
            'scope must be one of: global, plugin',
        );

        // ── currency too short (@Length(2,8)).
        const shortCcy = await post({ scope: 'global', monthlyCapCents: 100, currency: 'x' });
        expect(shortCcy.status()).toBe(400);
        expect(JSON.stringify((await shortCcy.json()).message)).toContain(
            'currency must be longer than or equal to 2 characters',
        );

        // ── GLOBAL scope must NOT carry a pluginId (controller cross-field check).
        const globalWithPlugin = await post({
            scope: 'global',
            monthlyCapCents: 100,
            pluginId: 'openrouter',
        });
        expect(globalWithPlugin.status()).toBe(400);
        expect(JSON.stringify((await globalWithPlugin.json()).message)).toContain(
            'pluginId must be omitted when scope = global',
        );

        // ── unknown extra property is whitelisted out (forbidNonWhitelisted).
        const unknownProp = await post({ scope: 'global', monthlyCapCents: 100, bogusField: true });
        expect(unknownProp.status()).toBe(400);
        expect(JSON.stringify((await unknownProp.json()).message)).toContain(
            'property bogusField should not exist',
        );

        // ── after ALL those rejections, NO GLOBAL cap was ever persisted.
        expect(
            (await listBudgets(request, u.access_token, work.id)).filter(
                (b) => b.scope === 'global',
            ),
            'no GLOBAL cap created by any rejected request',
        ).toHaveLength(0);

        // ── the @Max boundary is INCLUSIVE: exactly 100_000_000 is accepted (201).
        const atMax = await createGlobalCap(request, u.access_token, work.id, {
            monthlyCapCents: 100_000_000,
        });
        expect(atMax.monthlyCapCents).toBe(100_000_000);
        expect(atMax.scope).toBe('global');
    });
});

test.describe('Flow: GLOBAL cap isolation per Work + cross-work budgetId scoping', () => {
    test('each Work owns an independent GLOBAL cap; a cap is only addressable under its OWN work path', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const workA = await createWorkViaAPI(request, u.access_token, {
            name: `gcap-isoA-${Date.now()}`,
        });
        const workB = await createWorkViaAPI(request, u.access_token, {
            name: `gcap-isoB-${Date.now()}`,
        });
        expect(workA.id).not.toBe(workB.id);

        // ── Step 1: each Work gets its OWN GLOBAL cap with distinct values — the
        //    "one GLOBAL per Work" constraint is per-Work, so both succeed (no conflict
        //    between sibling Works owned by the same user).
        const capA = await createGlobalCap(request, u.access_token, workA.id, {
            monthlyCapCents: 1000,
            currency: 'usd',
        });
        const capB = await createGlobalCap(request, u.access_token, workB.id, {
            monthlyCapCents: 2000,
            currency: 'eur',
        });
        expect(capA.id).not.toBe(capB.id);

        // ── Step 2: each Work's list + summary reflect ONLY its own cap (no bleed).
        const listA = await listBudgets(request, u.access_token, workA.id);
        const listB = await listBudgets(request, u.access_token, workB.id);
        expect(listA.map((b) => b.id)).toContain(capA.id);
        expect(
            listA.map((b) => b.id),
            'workA list excludes workB cap',
        ).not.toContain(capB.id);
        expect(listB.map((b) => b.id)).toContain(capB.id);
        expect(
            listB.map((b) => b.id),
            'workB list excludes workA cap',
        ).not.toContain(capA.id);

        const sA = await getSummary(request, u.access_token, workA.id);
        const sB = await getSummary(request, u.access_token, workB.id);
        expect(sA.globalBudget.id).toBe(capA.id);
        expect(sA.globalBudget.monthlyCapCents).toBe(1000);
        expect(sA.currency).toBe('usd');
        expect(sB.globalBudget.id).toBe(capB.id);
        expect(sB.globalBudget.monthlyCapCents).toBe(2000);
        expect(sB.currency).toBe('eur');

        // ── Step 3: capA is addressable ONLY under workA's path. PATCHing it via
        //    workB's path is a 404 — the controller pins budget.workId === :workId,
        //    so a budgetId cannot be operated on through a sibling Work's route.
        const crossPatch = await request.patch(`${budgetsUrl(workB.id)}/${capA.id}`, {
            headers: authedHeaders(u.access_token),
            data: { monthlyCapCents: 9999 },
        });
        expect(crossPatch.status(), 'capA under workB path → 404').toBe(404);

        const crossDelete = await request.delete(`${budgetsUrl(workB.id)}/${capA.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(crossDelete.status(), 'delete capA under workB path → 404').toBe(404);

        // ── Step 4: the cross-work attempts left capA fully intact under its own path.
        const capAStill = (await listBudgets(request, u.access_token, workA.id)).find(
            (b) => b.id === capA.id,
        )!;
        expect(capAStill.monthlyCapCents, 'cross-work patch did not mutate capA').toBe(1000);

        // ── Step 5: deleting capA via its OWN path succeeds and does NOT disturb capB.
        const delA = await request.delete(`${budgetsUrl(workA.id)}/${capA.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(delA.status()).toBe(200);
        expect((await getSummary(request, u.access_token, workA.id)).globalBudget).toBeNull();
        expect(
            (await getSummary(request, u.access_token, workB.id)).globalBudget.id,
            'workB cap untouched by workA delete',
        ).toBe(capB.id);
    });
});

test.describe('Flow: GLOBAL cap member RBAC — VIEWER reads, only owner/MANAGER mutates', () => {
    test('a VIEWER member reads budgets+summary but is 403 on every GLOBAL-cap mutation; a MANAGER member can mutate', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);

        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `gcap-rbac-${Date.now()}`,
        });

        // Provision deterministic members directly (invitee is an existing user → no
        // email-accept step). The owner seeds an initial GLOBAL cap for read tests.
        await addMember(request, owner.access_token, work.id, viewer.email, 'viewer');
        await addMember(request, owner.access_token, work.id, manager.email, 'manager');
        const seedCap = await createGlobalCap(request, owner.access_token, work.id, {
            monthlyCapCents: 4000,
            currency: 'usd',
        });

        // ── Step 1: a VIEWER member has READ access — listing budgets and reading the
        //    usage summary both 200, and the VIEWER sees the owner-set GLOBAL cap.
        const viewerList = await listBudgets(request, viewer.access_token, work.id);
        expect(
            viewerList.map((b) => b.id),
            'VIEWER sees the GLOBAL cap',
        ).toContain(seedCap.id);
        const viewerSummary = await request.get(summaryUrl(work.id), {
            headers: authedHeaders(viewer.access_token),
        });
        expect(viewerSummary.status(), 'VIEWER reads usage summary').toBe(200);
        expect((await viewerSummary.json()).globalBudget.id).toBe(seedCap.id);

        // ── Step 2: a VIEWER is FORBIDDEN from every GLOBAL-cap WRITE — create, patch,
        //    and delete all 403 with the documented owner/MANAGER-only message.
        const viewerCreate = await request.post(budgetsUrl(work.id), {
            headers: authedHeaders(viewer.access_token),
            data: { scope: 'global', monthlyCapCents: 100 },
        });
        expect(viewerCreate.status(), 'VIEWER create → 403').toBe(403);
        expect(JSON.stringify((await viewerCreate.json()).message)).toContain(
            'User must be the Work owner or have MANAGER role to mutate budgets',
        );

        const viewerPatch = await request.patch(`${budgetsUrl(work.id)}/${seedCap.id}`, {
            headers: authedHeaders(viewer.access_token),
            data: { monthlyCapCents: 1 },
        });
        expect(viewerPatch.status(), 'VIEWER patch → 403').toBe(403);

        const viewerDelete = await request.delete(`${budgetsUrl(work.id)}/${seedCap.id}`, {
            headers: authedHeaders(viewer.access_token),
        });
        expect(viewerDelete.status(), 'VIEWER delete → 403').toBe(403);

        // ── Step 3: the VIEWER's rejected writes were inert — the seeded cap is untouched.
        const afterViewer = (await listBudgets(request, owner.access_token, work.id)).find(
            (b) => b.id === seedCap.id,
        )!;
        expect(afterViewer.monthlyCapCents, 'VIEWER could not alter the cap').toBe(4000);

        // ── Step 4: a MANAGER member CAN mutate the GLOBAL cap (write access granted by
        //    the MANAGER role) — the patch lands and is observable to all readers.
        const managerPatch = await request.patch(`${budgetsUrl(work.id)}/${seedCap.id}`, {
            headers: authedHeaders(manager.access_token),
            data: { monthlyCapCents: 8500, allowOverage: true },
        });
        expect(managerPatch.status(), 'MANAGER patch → 200').toBe(200);
        expect((await managerPatch.json()).budget.monthlyCapCents).toBe(8500);
        const ownerSeesPatch = (await listBudgets(request, owner.access_token, work.id)).find(
            (b) => b.id === seedCap.id,
        )!;
        expect(ownerSeesPatch.monthlyCapCents, 'MANAGER mutation visible to owner').toBe(8500);

        // ── Step 5: a NON-member stranger is denied BOTH read and write of this owned
        //    work's budgets (403 — the work exists but the caller has no access).
        const strangerRead = await request.get(budgetsUrl(work.id), {
            headers: authedHeaders(stranger.access_token),
        });
        expect([403, 404], `stranger read status ${strangerRead.status()}`).toContain(
            strangerRead.status(),
        );
        const strangerCreate = await request.post(budgetsUrl(work.id), {
            headers: authedHeaders(stranger.access_token),
            data: { scope: 'global', monthlyCapCents: 100 },
        });
        expect([403, 404]).toContain(strangerCreate.status());

        // ── Step 6: unauthenticated access to the GLOBAL-cap surface is a flat 401.
        expect((await request.get(budgetsUrl(work.id))).status(), 'unauth list → 401').toBe(401);
        expect(
            (
                await request.post(budgetsUrl(work.id), {
                    data: { scope: 'global', monthlyCapCents: 100 },
                })
            ).status(),
            'unauth create → 401',
        ).toBe(401);
    });
});
