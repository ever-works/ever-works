import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-budgets-sub-resource — the per-Work BUDGETS SUB-RESOURCE
 * (`/api/works/:workId/budgets`, EW-602 `BudgetsController`) of the Ever Works
 * Missions/Ideas/Works taxonomy. Drives the real
 * `apps/api/src/budgets/budgets.controller.ts` → `WorkBudgetRepository` cap
 * rows (the WorkBudget table), the `CreateBudgetDto`/`UpdateBudgetDto`
 * class-validator lattice, and the controller's own
 * read/write-access + path-binding guards.
 *
 * Every status code, message, and JSON shape asserted below was PROBED against
 * the LIVE API at http://127.0.0.1:3100 before being written (2026-06-12).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — this file pins the SUB-RESOURCE EDGE CONTRACTS that the two
 * sibling per-Work budget specs leave open, deliberately staying clear of what
 * they already cover:
 *
 *   - `budgets.spec.ts` only pins bare unauth-401 + the list/usage array shape
 *     (and `test.skip`s the create body the moment it 400s) — no DTO lattice,
 *     no method closure, no path-binding.
 *   - `flow-budget-caps-perwork.spec.ts` pins the GLOBAL-vs-PLUGIN create/list/
 *     patch/delete HAPPY PATH + uniqueness (409), the @Min(1)/@IsInt/@IsEnum +
 *     scope-mismatch create lattice, owner-only ACL (stranger 403 / ghost 404),
 *     the usage-summary rollup, the parent-delete CASCADE, and the
 *     account→work cap NON-cascade (it sets an account cap, then checks the work
 *     summary is unaffected). It NEVER pins: the @Max ceiling on create, the
 *     PATCH-side validation lattice, the forbidNonWhitelisted rejection of an
 *     immutable scope/pluginId in a PATCH body, the pluginId/currency @Matches
 *     SECURITY regexes + @Length boundaries, the HTTP-method closure of the
 *     collection/item routes, the malformed-budgetId 404 (NOT a 400 — there is
 *     no ParseUUIDPipe on this route, unlike the agent-budget route), the
 *     same-owner CROSS-WORK path-binding guard (budget.workId !== :workId →
 *     404), or the work→account cap NON-cascade (a REAL work cap present, and
 *     the account-wide summary STILL uncapped).
 *
 *   The contracts neither sibling covers, pinned HERE:
 *     1. CREATE CEILING. monthlyCapCents @Max(100_000_000): exactly the ceiling
 *        → 201, one cent over → 400. (Siblings pin only the @Min(1) floor.)
 *     2. PATCH VALIDATION LATTICE. The UpdateBudgetDto enforces @Min(1)/@IsInt/
 *        @Max on a PATCH too: cap 0/float/over-ceiling on an EXISTING row → 400,
 *        and a bad currency → 400. (Siblings only patch VALID values.)
 *     3. IMMUTABLE-FIELD WHITELIST. PATCHing `scope`/`pluginId` is not silently
 *        ignored — forbidNonWhitelisted rejects it 400 "property scope should
 *        not exist". (Siblings assert "scope unchanged"; they never prove the
 *        WRITE is refused.)
 *     4. SECURITY VALIDATORS. pluginId @Matches(/^[A-Za-z0-9_\-.@]+$/) +
 *        @Length(1,128) and currency @Matches(/^[A-Za-z]{2,8}$/) + @Length(2,8)
 *        — injection chars / over-length on BOTH create and patch → 400; the
 *        128-char pluginId + 8-char currency boundaries are accepted.
 *     5. HTTP-METHOD CLOSURE. The collection is GET/POST only (PUT/DELETE →
 *        404); the item is PATCH/DELETE only (POST/GET item → 404, there is no
 *        single-budget GET route).
 *     6. PATH-BINDING GUARD. A budget id belonging to work A, addressed via
 *        work B's path (SAME owner), 404s — the controller re-checks
 *        budget.workId === :workId, so the {workId} segment is a hard scope, not
 *        decoration.
 *     7. WORK→ACCOUNT NON-CASCADE. With a real per-Work cap set, the
 *        account-wide summary stays capCents:null / blocked:false — the per-Work
 *        cap layer never folds INTO the account aggregate (the inverse direction
 *        from the account→work non-cascade the sibling pins).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, 2026-06-12):
 *   POST   /api/works/:workId/budgets → 201 { budget: WorkBudget }
 *     WorkBudget = { id, workId, scope:'global'|'plugin', pluginId:string|null,
 *       monthlyCapCents:number, currency:string('usd' default, stored AS-GIVEN —
 *       'USD' stays upper), allowOverage:boolean(false default), ownerType:'work',
 *       ownerId:string|null, createdAt, updatedAt }.
 *     monthlyCapCents @Max(100_000_000): 100_000_000 → 201 ; 100_000_001 → 400.
 *     pluginId @Length(1,128) @Matches: 128 chars → 201 ; 129 → 400 ;
 *       'bad id<script>' → 400 "pluginId must contain only letters, digits, …".
 *     currency @Length(2,8) @Matches(alpha): '<x>'/len>8/len<2 → 400 ; 'USD' → 201.
 *     missing scope or monthlyCapCents → 400.
 *   PATCH  /api/works/:workId/budgets/:budgetId → 200 { budget } ;
 *     cap 0 / 12.5 / 100_000_001 → 400 ; currency '<x>' → 400 ;
 *     body carrying `scope`/`pluginId` → 400 "property scope should not exist".
 *   DELETE /api/works/:workId/budgets/:budgetId → 200 { deletedId }.
 *   Malformed :budgetId (not a uuid) on PATCH/DELETE → 404 (NO ParseUUIDPipe).
 *   Method closure: PUT/DELETE collection → 404 ; POST/GET item → 404.
 *   Cross-work: PATCH/DELETE work-A's budget id via work-B's path → 404.
 *   GET /api/me/usage/account-wide with a per-Work cap present →
 *     { capCents:null, blocked:false, … } (work cap does NOT fold in).
 *
 * Cross-spec isolation: EVERY user/work here is a FRESH registerUserViaAPI() +
 * createWorkViaAPI(); this file performs ZERO account-wide cap mutations, so it
 * can never shadow a sibling's cap. Unique stamps come from a per-test counter
 * seeded off the test title, NOT a module-scope clock. Assertions pin
 * shape / status / scoping, never global counts or a billed number.
 */

interface WorkBudget {
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

const CAP_MAX = 100_000_000;
const NONEXISTENT_BUDGET = '00000000-0000-4000-8000-0000000000bb';

const budgetsUrl = (workId: string) => `${API_BASE}/api/works/${workId}/budgets`;
const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;

/** Per-test monotonic stamp — built from the test title, NOT a module clock. */
function stamper(title: string): () => string {
    let n = 0;
    const base = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 18);
    return () => `${base}-${n++}`;
}

/** Create a throwaway work owned by a fresh user; returns { token, userId, workId }. */
async function freshUserWithWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; userId: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const work = await createWorkViaAPI(request, u.access_token, {
        name: `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    });
    expect(work.id, 'fresh work created with an id').toBeTruthy();
    return { token: u.access_token, userId: u.user.id, workId: work.id };
}

async function createBudget(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
) {
    return request.post(budgetsUrl(workId), { headers: authedHeaders(token), data });
}

async function createGlobalOk(
    request: APIRequestContext,
    token: string,
    workId: string,
    monthlyCapCents = 5000,
): Promise<WorkBudget> {
    const res = await createBudget(request, token, workId, { scope: 'global', monthlyCapCents });
    expect(res.status(), `seed global cap body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).budget as WorkBudget;
}

test.describe('flow: per-Work budgets sub-resource — create ceiling + full DTO shape (GET/POST /api/works/:workId/budgets)', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 1 — THE CREATE CEILING + THE PERSISTED ROW SHAPE. The sibling pins
    // the @Min(1) FLOOR; here we pin the @Max(100_000_000) CEILING (exact-cap
    // 201, one-over 400) and the FULL persisted row including the polymorphic
    // owner discriminator + the as-given (un-normalized) currency casing.
    // ──────────────────────────────────────────────────────────────────
    test('monthlyCapCents accepts EXACTLY the 100,000,000c ceiling and rejects one cent over; the persisted row carries the documented shape', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'cap-ceiling');

        // Exactly the @Max ceiling is accepted (boundary inclusive).
        const atMax = await createGlobalOk(request, token, workId, CAP_MAX);
        expect(atMax.monthlyCapCents, 'the exact 100,000,000c ceiling is accepted').toBe(CAP_MAX);
        expect(atMax.scope).toBe('global');
        expect(atMax.pluginId, 'a global cap has a null pluginId').toBeNull();
        // The polymorphic owner columns backfill to the Work — ownerType pinned,
        // ownerId may be null in this build (the discriminator is the load-bearing one).
        expect(atMax.ownerType, 'owner discriminator stamps to work').toBe('work');
        expect(atMax.allowOverage, 'allowOverage defaults to false').toBe(false);
        expect(atMax.currency, 'currency defaults to usd').toBe('usd');
        expect(typeof atMax.createdAt).toBe('string');
        expect(typeof atMax.updatedAt).toBe('string');
        // workId on the row equals the path segment (the cap is bound to the Work).
        expect(atMax.workId).toBe(workId);

        // One cent past the ceiling is rejected at the DTO boundary (@Max), on a
        // FRESH plugin scope so the rejection is the ceiling — never a uniqueness 409.
        const over = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'over-ceiling',
            monthlyCapCents: CAP_MAX + 1,
        });
        expect(over.status(), 'one cent past the ceiling → 400 (@Max)').toBe(400);

        // The rejected create left no row behind — only the single global remains.
        const list = await request.get(budgetsUrl(workId), { headers: authedHeaders(token) });
        const rows = (await list.json()).budgets as WorkBudget[];
        expect(
            rows.some((b) => b.pluginId === 'over-ceiling'),
            'over-cap row did NOT persist',
        ).toBe(false);
    });

    test('currency is stored AS-GIVEN (no case normalization): an upper-case USD round-trips upper-case while the default stays lower-case usd', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'ccy-casing');

        // The default global cap sources the lower-case 'usd' entity default.
        const def = await createGlobalOk(request, token, workId);
        expect(def.currency, 'omitted currency → entity default usd (lower)').toBe('usd');

        // An explicit upper-case USD passes @Matches(/^[A-Za-z]{2,8}$/) and is stored
        // verbatim — the controller does NOT lowercase it (a casing fingerprint that
        // distinguishes the per-Work row from the lower-cased account/owner summaries).
        const res = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'usd-upper',
            monthlyCapCents: 100,
            currency: 'USD',
        });
        expect(res.status()).toBe(201);
        expect(
            (await res.json()).budget.currency,
            'USD input stored verbatim, not lowercased',
        ).toBe('USD');
    });
});

test.describe('flow: per-Work budgets — the PATCH validation lattice + immutable-field whitelist', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 2 — THE PATCH SIDE. The sibling only patches VALID values; here we
    // prove UpdateBudgetDto enforces the SAME @Min/@IsInt/@Max lattice on a
    // PATCH, and — crucially — that the immutable scope/pluginId are not just
    // ignored but REJECTED 400 by forbidNonWhitelisted.
    // ──────────────────────────────────────────────────────────────────
    test('PATCH enforces @Min(1)/@IsInt/@Max + currency @Matches on an EXISTING row — cap 0 / float / over-ceiling / bad currency all 400, and the row is untouched', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'patch-lattice');
        const row = await createGlobalOk(request, token, workId, 5000);
        const itemUrl = `${budgetsUrl(workId)}/${row.id}`;

        // Cap 0 (@Min(1)), fractional (@IsInt), and over-ceiling (@Max) are each a
        // PATCH-side 400 — the cap-math gate can never be fed a malformed cap.
        for (const [cap, why] of [
            [0, 'patch cap 0 → 400 (@Min(1))'],
            [12.5, 'patch fractional cap → 400 (@IsInt)'],
            [CAP_MAX + 1, 'patch over-ceiling cap → 400 (@Max)'],
        ] as const) {
            const res = await request.patch(itemUrl, {
                headers: authedHeaders(token),
                data: { monthlyCapCents: cap },
            });
            expect(res.status(), why).toBe(400);
        }

        // A non-alphabetic currency is rejected by the security @Matches on PATCH too.
        const badCcy = await request.patch(itemUrl, {
            headers: authedHeaders(token),
            data: { currency: '<x>' },
        });
        expect(badCcy.status(), 'patch injection currency → 400 (@Matches)').toBe(400);

        // Every rejected patch left the cap at its seeded value (no partial write).
        const after = await request.get(budgetsUrl(workId), { headers: authedHeaders(token) });
        const fresh = ((await after.json()).budgets as WorkBudget[]).find((b) => b.id === row.id)!;
        expect(fresh.monthlyCapCents, 'rejected patches never mutated the cap').toBe(5000);
        expect(fresh.currency, 'rejected currency patch never mutated the currency').toBe('usd');
    });

    test('scope + pluginId are immutable: a PATCH carrying either is REFUSED 400 by forbidNonWhitelisted (not silently dropped), and a currency-only PATCH is a clean partial write', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'patch-immutable');
        const row = await createGlobalOk(request, token, workId, 5000);
        const itemUrl = `${budgetsUrl(workId)}/${row.id}`;

        // forbidNonWhitelisted: the PATCH DTO has no `scope` property, so sending one
        // is a hard 400 with the documented message — proving immutability is ENFORCED
        // at the boundary, not merely "the value happens not to change".
        const withScope = await request.patch(itemUrl, {
            headers: authedHeaders(token),
            data: { scope: 'plugin', pluginId: 'sneaky', monthlyCapCents: 4321 },
        });
        expect(withScope.status(), 'PATCH with scope/pluginId → 400 whitelist').toBe(400);
        const msg = JSON.stringify((await withScope.json()).message);
        expect(msg, 'rejects the immutable scope property').toMatch(/scope should not exist/i);
        expect(msg, 'rejects the immutable pluginId property').toMatch(
            /pluginId should not exist/i,
        );

        // The rejected PATCH was atomic — the co-sent cap (4321) did NOT slip through.
        const after = await request.get(budgetsUrl(workId), { headers: authedHeaders(token) });
        const unchanged = ((await after.json()).budgets as WorkBudget[]).find(
            (b) => b.id === row.id,
        )!;
        expect(unchanged.scope, 'scope stays global').toBe('global');
        expect(unchanged.pluginId, 'pluginId stays null').toBeNull();
        expect(
            unchanged.monthlyCapCents,
            'co-sent cap did NOT slip through the rejected patch',
        ).toBe(5000);

        // A currency-only PATCH is a clean PARTIAL write — only currency moves; cap +
        // overage are preserved (the service writes only the named, whitelisted fields).
        const ccyOnly = await request.patch(itemUrl, {
            headers: authedHeaders(token),
            data: { currency: 'gbp' },
        });
        expect(ccyOnly.status()).toBe(200);
        const patched = (await ccyOnly.json()).budget as WorkBudget;
        expect(patched.currency, 'currency-only patch sets currency').toBe('gbp');
        expect(patched.monthlyCapCents, 'currency-only patch preserves the cap').toBe(5000);
        expect(patched.allowOverage, 'currency-only patch preserves overage').toBe(false);
    });
});

test.describe('flow: per-Work budgets — the pluginId + currency SECURITY validators (create side)', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 3 — THE @Matches / @Length SECURITY REGEXES. These guard against
    // CRLF/HTML injection landing in budget-alert emails + error messages. The
    // sibling pins scope/cap/enum rules but NEVER the pluginId/currency
    // character-class + length boundaries.
    // ──────────────────────────────────────────────────────────────────
    test('pluginId rejects injection chars and over-128 length, accepts the 128-char boundary; currency rejects non-alpha + out-of-[2,8] length, accepts the 8-char boundary', async ({
        request,
    }) => {
        const s = stamper('plugin-ccy-security');
        const { token, workId } = await freshUserWithWork(request, 'security-validators');

        // pluginId @Matches(/^[A-Za-z0-9_\-.@]+$/): a space + angle brackets are out of
        // the safe identifier class → 400 with the documented message.
        const badPlugin = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'bad id<script>',
            monthlyCapCents: 100,
        });
        expect(badPlugin.status(), 'pluginId with injection chars → 400').toBe(400);
        expect(JSON.stringify((await badPlugin.json()).message)).toMatch(
            /pluginId must contain only/i,
        );

        // @Length(1,128): 129 chars → 400, exactly 128 → 201 (boundary inclusive).
        const over = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'a'.repeat(129),
            monthlyCapCents: 100,
        });
        expect(over.status(), 'pluginId length 129 → 400').toBe(400);
        const at = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `b${'b'.repeat(127)}`, // 128 chars
            monthlyCapCents: 100,
        });
        expect(at.status(), 'pluginId length 128 → 201 (boundary)').toBe(201);
        expect(((await at.json()).budget as WorkBudget).pluginId!.length).toBe(128);

        // currency @Matches(/^[A-Za-z]{2,8}$/) + @Length(2,8): html / too-long / too-short
        // are each 400; exactly 8 alpha chars is accepted.
        for (const [ccy, why] of [
            ['<b>x', 'html currency → 400'],
            ['toolongcur', 'currency length 9 → 400'],
            ['u', 'currency length 1 → 400'],
        ] as const) {
            const res = await createBudget(request, token, workId, {
                scope: 'plugin',
                pluginId: `ccy-${s()}`,
                monthlyCapCents: 100,
                currency: ccy,
            });
            expect(res.status(), why).toBe(400);
        }
        const okCcy = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `ccy-${s()}`,
            monthlyCapCents: 100,
            currency: 'abcdefgh', // 8 alpha chars
        });
        expect(okCcy.status(), 'currency length 8 alpha → 201 (boundary)').toBe(201);
    });

    test('a create missing the required scope or monthlyCapCents is rejected 400 (neither leaks a partial row)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'required-fields');

        // An empty body fails @IsEnum(scope) + @IsInt(monthlyCapCents) (both required).
        const empty = await createBudget(request, token, workId, {});
        expect(empty.status(), 'empty create body → 400').toBe(400);

        // scope present but the required monthlyCapCents missing → 400.
        const noCap = await createBudget(request, token, workId, { scope: 'global' });
        expect(noCap.status(), 'create missing monthlyCapCents → 400').toBe(400);

        // No partial row leaked from either rejected create.
        const list = await request.get(budgetsUrl(workId), { headers: authedHeaders(token) });
        expect(((await list.json()).budgets as WorkBudget[]).length, 'no partial create row').toBe(
            0,
        );
    });
});

test.describe('flow: per-Work budgets — HTTP-method closure + malformed-id + path-binding scope', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 4 — THE ROUTE SURFACE ITSELF. The collection is GET/POST only and
    // the item is PATCH/DELETE only; a malformed budget id 404s (NO
    // ParseUUIDPipe, unlike the agent-budget route's 400); and the {workId}
    // segment is a HARD scope — a budget id is bound to its Work's path.
    // ──────────────────────────────────────────────────────────────────
    test('the collection is GET/POST-only and the item is PATCH/DELETE-only — every other verb is 404 (no single-budget GET route)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'method-closure');
        const row = await createGlobalOk(request, token, workId, 3000);
        const h = authedHeaders(token);
        const itemUrl = `${budgetsUrl(workId)}/${row.id}`;

        // Collection: PUT + DELETE (no :budgetId) have no handler → 404.
        expect(
            (
                await request.put(budgetsUrl(workId), {
                    headers: h,
                    data: { scope: 'global', monthlyCapCents: 1 },
                })
            ).status(),
            'PUT collection → 404',
        ).toBe(404);
        expect(
            (await request.delete(budgetsUrl(workId), { headers: h })).status(),
            'DELETE collection (no id) → 404',
        ).toBe(404);

        // Item: POST + GET on a concrete budget id have no handler → 404 (the read-side
        // is the LIST only; there is no `GET /budgets/:id`).
        expect(
            (await request.post(itemUrl, { headers: h, data: {} })).status(),
            'POST item → 404',
        ).toBe(404);
        expect((await request.get(itemUrl, { headers: h })).status(), 'GET item → 404').toBe(404);

        // The supported verbs still work (proving the 404s are method-not-found, not a
        // dead route): the list GET is 200 and a DELETE removes the row.
        expect(
            (await request.get(budgetsUrl(workId), { headers: h })).status(),
            'GET collection still 200',
        ).toBe(200);
        const del = await request.delete(itemUrl, { headers: h });
        expect(del.status(), 'DELETE item still 200').toBe(200);
        expect((await del.json()).deletedId).toBe(row.id);
    });

    test('a malformed (non-UUID) budgetId 404s on PATCH and DELETE — this route has NO ParseUUIDPipe (contrast the agent-budget route 400), and a well-formed-but-absent id 404s too', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'malformed-id');
        // Seed a row so the work resolves and we reach the budget lookup (not a work 404).
        await createGlobalOk(request, token, workId, 2000);
        const h = authedHeaders(token);

        // 'not-a-uuid' is NOT parsed/validated at the param boundary — the handler runs,
        // the repo lookup misses → NotFoundException 404 (NOT a 400 ParseUUIDPipe error).
        expect(
            (
                await request.patch(`${budgetsUrl(workId)}/not-a-uuid`, {
                    headers: h,
                    data: { monthlyCapCents: 100 },
                })
            ).status(),
            'PATCH malformed budgetId → 404 (no ParseUUIDPipe)',
        ).toBe(404);
        expect(
            (await request.delete(`${budgetsUrl(workId)}/not-a-uuid`, { headers: h })).status(),
            'DELETE malformed budgetId → 404',
        ).toBe(404);

        // A syntactically-valid UUID that does not exist on this work also 404s.
        expect(
            (
                await request.patch(`${budgetsUrl(workId)}/${NONEXISTENT_BUDGET}`, {
                    headers: h,
                    data: { monthlyCapCents: 100 },
                })
            ).status(),
            'PATCH absent budgetId → 404',
        ).toBe(404);
    });

    test('the {workId} segment is a HARD scope: a budget id from work A, addressed via work B (SAME owner) PATCH/DELETE, 404s — the controller re-binds budget.workId === :workId', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // ONE owner, TWO works — so this is the PATH-BINDING guard, not ACL.
        const workA = await createWorkViaAPI(request, token, {
            name: `bind-A-${Date.now().toString(36)}`,
        });
        const workB = await createWorkViaAPI(request, token, {
            name: `bind-B-${Date.now().toString(36)}`,
        });
        expect(workA.id).not.toBe(workB.id);

        const rowA = await createGlobalOk(request, token, workA.id, 5000);
        const h = authedHeaders(token);

        // Addressing work-A's budget id through work-B's path: the work resolves (the
        // owner DOES own work B), but budget.workId (A) !== :workId (B) → 404. The id
        // alone is not enough; it is scoped to its parent Work's path.
        expect(
            (
                await request.patch(`${budgetsUrl(workB.id)}/${rowA.id}`, {
                    headers: h,
                    data: { monthlyCapCents: 999 },
                })
            ).status(),
            "PATCH work-A's budget via work-B's path → 404",
        ).toBe(404);
        expect(
            (await request.delete(`${budgetsUrl(workB.id)}/${rowA.id}`, { headers: h })).status(),
            "DELETE work-A's budget via work-B's path → 404",
        ).toBe(404);

        // The budget is intact under its OWN work's path (the cross-work calls were
        // no-ops, never partial mutations).
        const listA = await request.get(budgetsUrl(workA.id), { headers: h });
        const stillThere = ((await listA.json()).budgets as WorkBudget[]).find(
            (b) => b.id === rowA.id,
        );
        expect(stillThere?.monthlyCapCents, "work-A's cap untouched by the cross-work calls").toBe(
            5000,
        );
    });
});

test.describe('flow: per-Work budgets — the cap layer is INDEPENDENT of the account-wide aggregate (work→account non-cascade)', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 5 — THE RELATIONSHIP TO ACCOUNT-WIDE USAGE. The sibling proves the
    // account→work direction (an account cap does not change the work summary).
    // Here we prove the INVERSE: a real per-Work cap is present, yet the
    // account-wide summary stays uncapped/unblocked — the per-Work cap NEVER
    // folds INTO the per-user aggregate (`GET /api/me/usage/account-wide`).
    // ──────────────────────────────────────────────────────────────────
    test('a per-Work GLOBAL + PLUGIN cap does NOT fold into the account-wide summary — it stays capCents:null / blocked:false (the two cap layers are decoupled)', async ({
        request,
    }) => {
        const { token, userId, workId } = await freshUserWithWork(request, 'work-vs-account');

        // Baseline: the brand-new user's account-wide summary is uncapped + open, keyed
        // on the JWT subject. (We never MUTATE the account cap here — pure read.)
        const before = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
        expect(before.status()).toBe(200);
        const b0 = await before.json();
        expect(b0.userId).toBe(userId);
        expect(b0.capCents, 'fresh account is uncapped').toBeNull();
        expect(b0.blocked, 'fresh account is not blocked').toBe(false);

        // Set a real, non-trivial per-Work cap surface (a global + a plugin cap).
        await createGlobalOk(request, token, workId, 5000);
        const plugin = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'openai',
            monthlyCapCents: 1200,
        });
        expect(plugin.status()).toBe(201);

        // The account-wide summary is UNCHANGED — the per-Work cap is a SEPARATE layer
        // (BudgetService.summarizeForUser reads the account-wide cap on work-agent prefs,
        // NOT the per-Work WorkBudget rows), so it never raises the account capCents off
        // null nor flips `blocked`. This is the work→account non-cascade.
        const after = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
        expect(after.status()).toBe(200);
        const a0 = await after.json();
        expect(a0.userId, 'still the same user silo').toBe(userId);
        expect(a0.capCents, 'a per-Work cap does NOT become the account-wide cap').toBeNull();
        expect(a0.blocked, 'a per-Work cap does NOT block the account layer').toBe(false);
        expect(a0.currentSpendCents, 'no billed plugin calls in CI → 0 spend').toBe(0);
        // The window + currency casing are the account-wide engine's, not the work row's.
        expect(a0.currency, 'account-wide currency is the lower-case usd engine').toBe('usd');
        expect(a0.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    });
});
