import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-budgets-usage-validation-matrix — the EW-602 budgets + usage surface
 * (`apps/api/src/budgets/*`) driven as a FIELD-BY-FIELD VALIDATION MATRIX rather
 * than a lifecycle. It exercises the real controllers:
 *
 *   BudgetsController      /api/works/:workId/budgets          (CreateBudgetDto/UpdateBudgetDto lattice)
 *   UsageController        /api/works/:workId/usage/{summary,trend,export}
 *   AccountUsageController /api/me/usage/account-wide
 *   AdminUsageController   /admin/usage                        (IsPlatformAdminGuard)
 *
 * Every status code, JSON body, and error-message shape asserted below was
 * PROBED against the LIVE stack at http://127.0.0.1:3100 before being written
 * (2026-07-21).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION. A dense cluster of sibling specs already owns the budget/
 * usage HAPPY PATH, lifecycle, and coarse authz:
 *   - flow-work-budgets-sub-resource / flow-budget-caps-{global,perwork}: CRUD
 *     round-trips, the @Max ceiling, method-closure, path-binding, cascade.
 *   - flow-work-usage-sub-resource / flow-usage-tracking: period windows, CSV
 *     columns, trend buckets, member RBAC.
 *   - flow-admin-routes-authz / flow-subscription-admin-usage: the admin gate.
 *   - flow-account-usage-{contract,aggregation}: the account-wide rollup.
 *
 * This file deliberately AVOIDS re-testing those. It pins the contracts none of
 * them assert as a cohesive MATRIX:
 *   1. Per-DTO-FIELD message contract. class-validator returns an ARRAY of
 *      messages; the exact substrings + which validators co-fire (e.g. a missing
 *      monthlyCapCents fires @Max + @Min + @IsInt = 3 messages at once) are
 *      pinned per field: scope, pluginId, monthlyCapCents, allowOverage, currency.
 *   2. WRONG-TYPE / NO-IMPLICIT-COERCION column. A numeric cap sent as the STRING
 *      "5000" is NOT silently coerced to a valid int — it fails the full @IsInt
 *      trio; allowOverage:"true" and pluginId:123 fail their type validators.
 *   3. BUSINESS-ERROR vs DTO-ERROR dichotomy. The scope↔pluginId consistency gate
 *      and the uniqueness 409 return a SINGLE STRING message (controller-thrown
 *      BadRequest/Conflict), whereas DTO validation returns a string[] — a sharp,
 *      stable type distinction the client can branch on.
 *   4. UpdateBudgetDto STRICT-SUBSET posture. scope/pluginId aren't "immutable" —
 *      they simply aren't in UpdateBudgetDto, so a PATCH carrying them is a
 *      forbidNonWhitelisted 400 "property scope should not exist", NOT a
 *      value-rejection; and every update field is independently re-validated.
 *   5. USAGE period/granularity/format grammar as a 3-endpoint × N-value matrix
 *      with the EXACT split of "Invalid period …" (shape) vs "Invalid month …"
 *      (range), identical across summary/trend/export.
 *   6. Usage NUMERIC NON-NEGATIVE zero-state (totalSpendCents, percentUsed,
 *      currentSpendCents ≥ 0 / null; perPlugin + buckets are arrays).
 *   7. GUARD-BEFORE-PIPE precedence on admin/usage (a non-admin's garbage period
 *      still 403, never the 400 it would be behind the gate) + the api/-prefix
 *      asymmetry (bare admin/usage exists, api/admin/usage 404s).
 *   8. Consolidated AUTHZ + ID-RESOLUTION matrix: unauth 401, non-member READ 403
 *      (NOT 404 — this surface leaks existence to strangers by posture), unknown
 *      uuid 404, malformed uuid 404 (there is NO ParseUUIDPipe on these routes).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, 2026-07-21):
 *   WorkBudgetScope enum = 'global' | 'plugin'.
 *   POST   :workId/budgets → 201 { budget:{ id, workId, scope, pluginId|null,
 *            monthlyCapCents, currency('usd' default, stored AS-GIVEN),
 *            allowOverage(false default), ownerType:'work', ownerId:null,… } }.
 *     scope: missing/'weekly' → 400 ["scope must be one of: global, plugin"].
 *     monthlyCapCents @IsInt @Min(1) @Max(100000000): missing → 3-msg array;
 *       0/-5 → "must not be less than 1"; 10.5 → "must be an integer number";
 *       1e8+1 → "must not be greater than 100000000"; 1 and 1e8 → 201.
 *     pluginId @IsString @Length(1,128) @Matches(/^[A-Za-z0-9_\-.@]+$/):
 *       129 chars → "shorter than or equal to 128"; "open ai!" → "must contain
 *       only letters, digits, …"; "" → matches+min; 123 → +"must be a string".
 *     currency @Length(2,8) @Matches(/^[A-Za-z]{2,8}$/): 1/9 chars + digits →
 *       400; 'USD' → 201 (round-trips upper); omitted → 'usd'.
 *     allowOverage @IsBoolean: "yes" → 400; omitted → false.
 *     unknown field → 400 "property X should not exist" (forbidNonWhitelisted).
 *     scope=global+pluginId → 400 "pluginId must be omitted when scope = global"
 *       (STRING). scope=plugin w/o pluginId → 400 "pluginId is required …".
 *     duplicate global/plugin → 409 (STRING) "… already exists … patch it instead".
 *   PATCH  :workId/budgets/:id → 200 { budget }; scope/pluginId in body → 400
 *     "property scope should not exist"; empty body → 200 (no-op).
 *   DELETE :workId/budgets/:id → 200 { deletedId }.
 *   GET    :workId/usage/summary → 200 { workId, periodStart, periodEnd,
 *            periodLabel, currency, totalSpendCents:0, perPlugin:[],
 *            globalBudget:null|{…,percentUsed} }.
 *          ?period bad-shape → 400 "Invalid period 'X'. Use 'current' or 'YYYY-MM'.";
 *          ?period bad-range → 400 "Invalid month in period 'X'.".
 *   GET    :workId/usage/trend  → 200 { …, granularity:'day', buckets:[] };
 *          ?granularity=hour → 400 "Unsupported granularity 'hour'…".
 *   GET    :workId/usage/export → 200 text/csv, Cache-Control:no-store,
 *            Content-Disposition filename usage-<workId>-YYYY-MM.csv, header row
 *            "occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId";
 *          ?format=pdf → 400 "Unsupported format 'pdf'…".
 *   GET    /api/me/usage/account-wide → 200 { userId, periodStart, periodEnd,
 *            currentSpendCents:0, capCents:null, currency, percentUsed:null,
 *            allowOverage, blocked:false }; unauth → 401.
 *   GET    /admin/usage → non-admin 403 "Platform admin access required"; unauth
 *            401; api/admin/usage → 404 (wrong prefix).
 *   AUTHZ: unauth → 401; non-member READ → 403; non-member WRITE → 403; unknown
 *            work uuid → 404; malformed work/budget id → 404 (no ParseUUIDPipe).
 *
 * Cross-spec isolation: EVERY user/work is a FRESH registerUserViaAPI() +
 * createWorkViaAPI(); this file NEVER mutates account-wide caps or the seeded
 * user, and asserts shape/status/message-class, never global counts or a billed
 * number.
 */

const CAP_MAX = 100_000_000;
const NONEXISTENT_UUID = '00000000-0000-4000-8000-0000000000ab';
const MALFORMED_ID = 'not-a-uuid';

interface ErrBody {
    message: string | string[];
    error?: string;
    statusCode: number;
}

const budgetsUrl = (workId: string) => `${API_BASE}/api/works/${workId}/budgets`;
const budgetUrl = (workId: string, id: string) => `${API_BASE}/api/works/${workId}/budgets/${id}`;
const summaryUrl = (workId: string) => `${API_BASE}/api/works/${workId}/usage/summary`;
const trendUrl = (workId: string) => `${API_BASE}/api/works/${workId}/usage/trend`;
const exportUrl = (workId: string) => `${API_BASE}/api/works/${workId}/usage/export`;
const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;
const ADMIN_USAGE = `${API_BASE}/admin/usage`;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** class-validator returns string[]; controller-thrown errors return string. Normalize to an array for substring checks. */
async function messagesOf(res: APIResponse): Promise<string[]> {
    const body = (await res.json()) as ErrBody;
    return Array.isArray(body.message) ? body.message : [body.message];
}

function hasMessage(msgs: string[], substr: string): boolean {
    return msgs.some((m) => typeof m === 'string' && m.includes(substr));
}

async function freshUserWithWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; userId: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const work = await createWorkViaAPI(request, u.access_token, { name: `${label}-${stamp()}` });
    expect(work.id, 'fresh work created with an id').toBeTruthy();
    return { token: u.access_token, userId: u.user.id, workId: work.id };
}

function createBudget(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<APIResponse> {
    return request.post(budgetsUrl(workId), { headers: authedHeaders(token), data });
}

function patchBudget(
    request: APIRequestContext,
    token: string,
    workId: string,
    id: string,
    data: Record<string, unknown>,
): Promise<APIResponse> {
    return request.patch(budgetUrl(workId, id), { headers: authedHeaders(token), data });
}

/** Seed a valid GLOBAL cap and return its id. */
async function seedGlobal(
    request: APIRequestContext,
    token: string,
    workId: string,
    monthlyCapCents = 5000,
): Promise<string> {
    const res = await createBudget(request, token, workId, { scope: 'global', monthlyCapCents });
    expect(res.status(), `seed global cap: ${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).budget.id as string;
}

// ════════════════════════════════════════════════════════════════════════════
// GROUP A — CreateBudgetDto: one message-pinned assertion cluster per FIELD.
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: budgets create DTO — per-field validation matrix', () => {
    test('scope is required + @IsEnum(global|plugin): missing, bad value, and empty all 400 with the enum message; both valid members are accepted', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'scope');
        const ENUM_MSG = 'scope must be one of: global, plugin';

        for (const bad of [
            { monthlyCapCents: 5000 },
            { scope: 'weekly', monthlyCapCents: 5000 },
            { scope: '', monthlyCapCents: 5000 },
        ]) {
            const res = await createBudget(request, token, workId, bad);
            expect(res.status(), `scope reject for ${JSON.stringify(bad)}`).toBe(400);
            expect(hasMessage(await messagesOf(res), ENUM_MSG)).toBe(true);
        }

        // both valid enum members round-trip (global standalone, plugin needs pluginId)
        const g = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
        });
        expect(g.status()).toBe(201);
        const p = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `p-${stamp()}`,
            monthlyCapCents: 5000,
        });
        expect(p.status()).toBe(201);
        expect((await p.json()).budget.scope).toBe('plugin');
    });

    test('monthlyCapCents @IsInt @Min(1) @Max: missing co-fires all three validators; 0/-5 hit the floor; 10.5 hits @IsInt; 1e8+1 hits the ceiling', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'cap-bad');

        const missing = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `a-${stamp()}`,
        });
        expect(missing.status()).toBe(400);
        const mm = await messagesOf(missing);
        expect(hasMessage(mm, 'must not be greater than 100000000')).toBe(true);
        expect(hasMessage(mm, 'must not be less than 1')).toBe(true);
        expect(hasMessage(mm, 'must be an integer number')).toBe(true);

        for (const v of [0, -5]) {
            const res = await createBudget(request, token, workId, {
                scope: 'plugin',
                pluginId: `f-${stamp()}`,
                monthlyCapCents: v,
            });
            expect(res.status(), `cap=${v}`).toBe(400);
            expect(hasMessage(await messagesOf(res), 'must not be less than 1')).toBe(true);
        }

        const flo = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `i-${stamp()}`,
            monthlyCapCents: 10.5,
        });
        expect(flo.status()).toBe(400);
        expect(hasMessage(await messagesOf(flo), 'must be an integer number')).toBe(true);

        const over = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `x-${stamp()}`,
            monthlyCapCents: CAP_MAX + 1,
        });
        expect(over.status()).toBe(400);
        expect(hasMessage(await messagesOf(over), 'must not be greater than 100000000')).toBe(true);
    });

    test('monthlyCapCents boundaries: EXACTLY 1 and EXACTLY 100,000,000 are accepted (201) and the persisted row carries the documented shape', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'cap-ok');

        const lo = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `lo-${stamp()}`,
            monthlyCapCents: 1,
        });
        expect(lo.status()).toBe(201);
        expect((await lo.json()).budget.monthlyCapCents).toBe(1);

        const hi = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: CAP_MAX,
        });
        expect(hi.status()).toBe(201);
        const row = (await hi.json()).budget;
        expect(row.monthlyCapCents).toBe(CAP_MAX);
        expect(row).toMatchObject({
            workId,
            scope: 'global',
            pluginId: null,
            currency: 'usd',
            allowOverage: false,
            ownerType: 'work',
            ownerId: null,
        });
        expect(typeof row.id).toBe('string');
    });

    test('pluginId @IsString @Length(1,128) @Matches: over-128, injection chars, empty, and non-string are each 400 with the matching validator message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'pid-bad');

        const long = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'a'.repeat(129),
            monthlyCapCents: 5000,
        });
        expect(long.status()).toBe(400);
        expect(hasMessage(await messagesOf(long), 'shorter than or equal to 128 characters')).toBe(
            true,
        );

        const inj = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'open ai!<script>',
            monthlyCapCents: 5000,
        });
        expect(inj.status()).toBe(400);
        expect(
            hasMessage(
                await messagesOf(inj),
                'must contain only letters, digits, underscores, hyphens, dots, or @',
            ),
        ).toBe(true);

        const empty = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: '',
            monthlyCapCents: 5000,
        });
        expect(empty.status()).toBe(400);
        const em = await messagesOf(empty);
        expect(hasMessage(em, 'must contain only letters')).toBe(true);
        expect(hasMessage(em, 'longer than or equal to 1 characters')).toBe(true);

        const num = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 123,
            monthlyCapCents: 5000,
        });
        expect(num.status()).toBe(400);
        expect(hasMessage(await messagesOf(num), 'pluginId must be a string')).toBe(true);
    });

    test('pluginId accepts the 128-char boundary and safe-charset ids (dots/@/underscore/hyphen); the persisted row echoes pluginId + ownerType', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'pid-ok');

        const max = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 'b'.repeat(128),
            monthlyCapCents: 5000,
        });
        expect(max.status(), `128-char pluginId: ${await max.text().catch(() => '')}`).toBe(201);

        const safe = `com.acme_plugin-v2@ns-${stamp()}`.slice(0, 128);
        const ok = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: safe,
            monthlyCapCents: 5000,
        });
        expect(ok.status()).toBe(201);
        const row = (await ok.json()).budget;
        expect(row.pluginId).toBe(safe);
        expect(row.scope).toBe('plugin');
        expect(row.ownerType).toBe('work');
    });

    test('currency @Length(2,8) @Matches(alpha): 1-char, 9-char, digit-bearing, and symbol values are each 400', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'cur-bad');
        const ALPHA = 'currency must be an alphabetic currency code (e.g. USD)';

        const short = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            currency: 'u',
        });
        expect(short.status()).toBe(400);
        const sm = await messagesOf(short);
        expect(hasMessage(sm, ALPHA)).toBe(true);
        expect(hasMessage(sm, 'longer than or equal to 2 characters')).toBe(true);

        const long = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            currency: 'usdusdusd',
        });
        expect(long.status()).toBe(400);
        expect(hasMessage(await messagesOf(long), 'shorter than or equal to 8 characters')).toBe(
            true,
        );

        for (const bad of ['us1', 'US$']) {
            const res = await createBudget(request, token, workId, {
                scope: 'global',
                monthlyCapCents: 5000,
                currency: bad,
            });
            expect(res.status(), `currency=${bad}`).toBe(400);
            expect(hasMessage(await messagesOf(res), ALPHA)).toBe(true);
        }
    });

    test('currency: omitted defaults to lowercase "usd"; a valid code round-trips AS-GIVEN (no case normalization); the 8-char alpha boundary is accepted', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'cur-ok');

        const def = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `d-${stamp()}`,
            monthlyCapCents: 5000,
        });
        expect(def.status()).toBe(201);
        expect((await def.json()).budget.currency).toBe('usd');

        const upper = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            currency: 'USD',
        });
        expect(upper.status()).toBe(201);
        expect((await upper.json()).budget.currency, 'stored as-given, not lower-cased').toBe(
            'USD',
        );

        const eight = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `e-${stamp()}`,
            monthlyCapCents: 5000,
            currency: 'abcdefgh',
        });
        expect(eight.status(), '8-char alpha currency boundary').toBe(201);
    });

    test('allowOverage @IsBoolean: a non-boolean is 400; true/false are accepted; omission defaults to false', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'ovr');

        const bad = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            allowOverage: 'yes',
        });
        expect(bad.status()).toBe(400);
        expect(hasMessage(await messagesOf(bad), 'allowOverage must be a boolean value')).toBe(
            true,
        );

        const off = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: `o-${stamp()}`,
            monthlyCapCents: 5000,
        });
        expect(off.status()).toBe(201);
        expect((await off.json()).budget.allowOverage, 'defaults false').toBe(false);

        const on = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            allowOverage: true,
        });
        expect(on.status()).toBe(201);
        expect((await on.json()).budget.allowOverage).toBe(true);
    });

    test('NO implicit type coercion: a numeric cap sent as the STRING "5000" fails the full @IsInt trio; allowOverage:"true" and pluginId:123 fail their type validators', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'coerce');

        const capStr = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: '5000',
        });
        expect(capStr.status(), 'string cap is NOT coerced to a valid int').toBe(400);
        expect(hasMessage(await messagesOf(capStr), 'must be an integer number')).toBe(true);

        const ovrStr = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            allowOverage: 'true',
        });
        expect(ovrStr.status()).toBe(400);
        expect(hasMessage(await messagesOf(ovrStr), 'allowOverage must be a boolean value')).toBe(
            true,
        );

        const pidNum = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: 123,
            monthlyCapCents: 5000,
        });
        expect(pidNum.status()).toBe(400);
        expect(hasMessage(await messagesOf(pidNum), 'pluginId must be a string')).toBe(true);
    });

    test('whitelist closure: an unknown property is 400 "property X should not exist"; an empty body 400s on the two REQUIRED fields (scope + monthlyCapCents)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'wl');

        const extra = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 5000,
            hacker: 'x',
        });
        expect(extra.status()).toBe(400);
        expect(hasMessage(await messagesOf(extra), 'property hacker should not exist')).toBe(true);

        const empty = await createBudget(request, token, workId, {});
        expect(empty.status()).toBe(400);
        const em = await messagesOf(empty);
        expect(hasMessage(em, 'scope must be one of: global, plugin')).toBe(true);
        expect(hasMessage(em, 'monthlyCapCents must be an integer number')).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP B — controller-thrown BUSINESS errors are a SINGLE STRING (not an array).
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: budgets create — scope↔pluginId gate + uniqueness are STRING errors, not DTO arrays', () => {
    test('the scope/pluginId consistency gate returns a single-string 400 (global-with-pluginId AND plugin-without-pluginId) — distinct from the DTO string[] shape', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'gate');

        const globalWithPid = await createBudget(request, token, workId, {
            scope: 'global',
            pluginId: 'openai',
            monthlyCapCents: 5000,
        });
        expect(globalWithPid.status()).toBe(400);
        const b1 = (await globalWithPid.json()) as ErrBody;
        expect(typeof b1.message, 'business error is a string, not string[]').toBe('string');
        expect(b1.message).toBe('pluginId must be omitted when scope = global');

        const pluginNoPid = await createBudget(request, token, workId, {
            scope: 'plugin',
            monthlyCapCents: 5000,
        });
        expect(pluginNoPid.status()).toBe(400);
        const b2 = (await pluginNoPid.json()) as ErrBody;
        expect(typeof b2.message).toBe('string');
        expect(b2.message).toBe('pluginId is required when scope = plugin');
    });

    test('uniqueness: a second GLOBAL cap AND a duplicate PLUGIN cap each 409 with a single-string "already exists … patch it instead" message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'uniq');

        await seedGlobal(request, token, workId);
        const dupGlobal = await createBudget(request, token, workId, {
            scope: 'global',
            monthlyCapCents: 9999,
        });
        expect(dupGlobal.status()).toBe(409);
        const g = (await dupGlobal.json()) as ErrBody;
        expect(typeof g.message).toBe('string');
        expect(hasMessage([g.message as string], 'already exists')).toBe(true);

        const pid = `dup-${stamp()}`;
        const first = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: pid,
            monthlyCapCents: 100,
        });
        expect(first.status()).toBe(201);
        const dupPlugin = await createBudget(request, token, workId, {
            scope: 'plugin',
            pluginId: pid,
            monthlyCapCents: 200,
        });
        expect(dupPlugin.status()).toBe(409);
        expect(
            hasMessage(
                [((await dupPlugin.json()) as ErrBody).message as string],
                'patch it instead',
            ),
        ).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP C — UpdateBudgetDto is a STRICT SUBSET; every update field re-validated.
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: budgets PATCH — strict-subset whitelist + per-field re-validation', () => {
    test('scope and pluginId are NOT in UpdateBudgetDto: a PATCH carrying either is a forbidNonWhitelisted 400 "property … should not exist", not a value/immutability error', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'patch-wl');
        const id = await seedGlobal(request, token, workId);

        const scopePatch = await patchBudget(request, token, workId, id, { scope: 'plugin' });
        expect(scopePatch.status()).toBe(400);
        expect(hasMessage(await messagesOf(scopePatch), 'property scope should not exist')).toBe(
            true,
        );

        const pidPatch = await patchBudget(request, token, workId, id, { pluginId: 'openai' });
        expect(pidPatch.status()).toBe(400);
        expect(hasMessage(await messagesOf(pidPatch), 'property pluginId should not exist')).toBe(
            true,
        );

        const bothPatch = await patchBudget(request, token, workId, id, {
            scope: 'plugin',
            pluginId: 'x',
            foo: 1,
        });
        expect(bothPatch.status()).toBe(400);
        // the row is untouched — a follow-up GET still lists the original global cap
        const list = await request.get(budgetsUrl(workId), { headers: authedHeaders(token) });
        const ids = ((await list.json()).budgets as Array<{ id: string; scope: string }>).map(
            (b) => `${b.id}:${b.scope}`,
        );
        expect(ids).toContain(`${id}:global`);
    });

    test('every UpdateBudgetDto field is independently re-validated on an EXISTING row: cap 0/float/over-ceiling, bad currency, non-bool overage, and an unknown field all 400', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'patch-val');
        const id = await seedGlobal(request, token, workId, 5000);

        const cases: Array<[Record<string, unknown>, string]> = [
            [{ monthlyCapCents: 0 }, 'must not be less than 1'],
            [{ monthlyCapCents: 12.5 }, 'must be an integer number'],
            [{ monthlyCapCents: CAP_MAX + 1 }, 'must not be greater than 100000000'],
            [{ currency: 'US$' }, 'currency must be an alphabetic currency code (e.g. USD)'],
            [{ allowOverage: 'nope' }, 'allowOverage must be a boolean value'],
            [{ mystery: true }, 'property mystery should not exist'],
        ];
        for (const [patch, expected] of cases) {
            const res = await patchBudget(request, token, workId, id, patch);
            expect(res.status(), `patch ${JSON.stringify(patch)}`).toBe(400);
            expect(
                hasMessage(await messagesOf(res), expected),
                `patch ${JSON.stringify(patch)} msg`,
            ).toBe(true);
        }
    });

    test('a valid partial PATCH (currency only) is a clean 200 write; an EMPTY body is an idempotent 200 no-op that leaves the row unchanged', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'patch-ok');
        const id = await seedGlobal(request, token, workId, 5000);

        const partial = await patchBudget(request, token, workId, id, { currency: 'eur' });
        expect(partial.status()).toBe(200);
        const afterPartial = (await partial.json()).budget;
        expect(afterPartial.currency).toBe('eur');
        expect(afterPartial.monthlyCapCents, 'cap untouched by a currency-only patch').toBe(5000);

        const noop = await patchBudget(request, token, workId, id, {});
        expect(noop.status()).toBe(200);
        const afterNoop = (await noop.json()).budget;
        expect(afterNoop.currency).toBe('eur');
        expect(afterNoop.monthlyCapCents).toBe(5000);
        expect(afterNoop.id).toBe(id);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP D — usage period / granularity / format grammar as a 3-endpoint matrix.
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: usage read grammar — period/granularity/format validation matrix', () => {
    test('the ?period grammar splits shape-errors ("Invalid period …") from range-errors ("Invalid month …"); "current" and an omitted period resolve the same window', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'period');

        const omitted = await request.get(summaryUrl(workId), { headers: authedHeaders(token) });
        expect(omitted.status()).toBe(200);
        const explicit = await request.get(`${summaryUrl(workId)}?period=current`, {
            headers: authedHeaders(token),
        });
        expect(explicit.status()).toBe(200);
        const a = await omitted.json();
        const b = await explicit.json();
        expect(b.periodStart).toBe(a.periodStart);
        expect(b.periodEnd).toBe(a.periodEnd);

        const valid = await request.get(`${summaryUrl(workId)}?period=2026-07`, {
            headers: authedHeaders(token),
        });
        expect(valid.status()).toBe(200);
        expect((await valid.json()).periodStart).toBe('2026-07-01T00:00:00.000Z');

        for (const shape of ['xxxx', '2026-7', '2026', '26-01']) {
            const res = await request.get(
                `${summaryUrl(workId)}?period=${encodeURIComponent(shape)}`,
                { headers: authedHeaders(token) },
            );
            expect(res.status(), `bad-shape ${shape}`).toBe(400);
            const m = (await res.json()) as ErrBody;
            expect(m.message).toBe(`Invalid period '${shape}'. Use 'current' or 'YYYY-MM'.`);
        }

        for (const range of ['2026-13', '2026-00']) {
            const res = await request.get(`${summaryUrl(workId)}?period=${range}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `bad-range ${range}`).toBe(400);
            expect(((await res.json()) as ErrBody).message).toBe(
                `Invalid month in period '${range}'.`,
            );
        }
    });

    test('summary, trend, AND export share ONE period parser: a valid YYYY-MM 200s, a bad-shape and a bad-range 400 identically on all three surfaces', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'period3');
        const h = authedHeaders(token);
        const surfaces = [summaryUrl(workId), trendUrl(workId), exportUrl(workId)];

        for (const url of surfaces) {
            const ok = await request.get(`${url}?period=2026-05`, { headers: h });
            expect(ok.status(), `valid period on ${url}`).toBe(200);

            const shape = await request.get(`${url}?period=nope`, { headers: h });
            expect(shape.status(), `bad-shape on ${url}`).toBe(400);
            expect(((await shape.json()) as ErrBody).message).toBe(
                "Invalid period 'nope'. Use 'current' or 'YYYY-MM'.",
            );

            const range = await request.get(`${url}?period=2026-99`, { headers: h });
            expect(range.status(), `bad-range on ${url}`).toBe(400);
            expect(((await range.json()) as ErrBody).message).toBe(
                "Invalid month in period '2026-99'.",
            );
        }
    });

    test('trend granularity is a hard gate (only "day") and export format is a hard gate (only "csv") — any other value is a single-string 400', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'gate2');
        const h = authedHeaders(token);

        const day = await request.get(`${trendUrl(workId)}?granularity=day`, { headers: h });
        expect(day.status()).toBe(200);
        expect((await day.json()).granularity).toBe('day');
        const hour = await request.get(`${trendUrl(workId)}?granularity=hour`, { headers: h });
        expect(hour.status()).toBe(400);
        expect(((await hour.json()) as ErrBody).message).toBe(
            "Unsupported granularity 'hour'. Only 'day' is supported in V1.",
        );

        const csv = await request.get(`${exportUrl(workId)}?format=csv`, { headers: h });
        expect(csv.status()).toBe(200);
        const pdf = await request.get(`${exportUrl(workId)}?format=pdf`, { headers: h });
        expect(pdf.status()).toBe(400);
        expect(((await pdf.json()) as ErrBody).message).toBe(
            "Unsupported format 'pdf'. Only 'csv' is supported in V1.",
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP E — usage NUMERIC NON-NEGATIVE zero-state + CSV header contract.
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: usage read side — numeric non-negative zero-state', () => {
    test('a fresh Work summary is a non-negative zero-state: totalSpendCents 0, perPlugin [] — globalBudget is null without a cap and a numeric percentUsed>=0 once a GLOBAL cap exists', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'zero');
        const h = authedHeaders(token);

        const before = await request.get(summaryUrl(workId), { headers: h });
        expect(before.status()).toBe(200);
        const s0 = await before.json();
        expect(s0.workId).toBe(workId);
        expect(typeof s0.totalSpendCents).toBe('number');
        expect(s0.totalSpendCents).toBeGreaterThanOrEqual(0);
        expect(s0.totalSpendCents).toBe(0);
        expect(Array.isArray(s0.perPlugin)).toBe(true);
        expect(s0.perPlugin.length).toBe(0);
        expect(s0.globalBudget, 'no cap → null').toBeNull();
        expect(s0.currency).toBe('usd');

        await seedGlobal(request, token, workId, 8000);
        const after = await request.get(summaryUrl(workId), { headers: h });
        const s1 = await after.json();
        expect(s1.globalBudget).not.toBeNull();
        expect(s1.globalBudget.monthlyCapCents).toBe(8000);
        expect(typeof s1.globalBudget.percentUsed).toBe('number');
        expect(s1.globalBudget.percentUsed).toBeGreaterThanOrEqual(0);
        expect(s1.globalBudget.percentUsed).toBe(0); // 0 spend against 8000 cap
    });

    test('trend zero-state is an array of buckets with day granularity; export streams a no-store text/csv with the fixed 8-column header and a period-scoped filename', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'trend-csv');
        const h = authedHeaders(token);

        const trend = await request.get(trendUrl(workId), { headers: h });
        expect(trend.status()).toBe(200);
        const t = await trend.json();
        expect(Array.isArray(t.buckets)).toBe(true);
        expect(t.granularity).toBe('day');
        expect(t.workId).toBe(workId);

        const csv = await request.get(`${exportUrl(workId)}?period=2026-07`, { headers: h });
        expect(csv.status()).toBe(200);
        expect(csv.headers()['content-type']).toContain('text/csv');
        expect(csv.headers()['cache-control']).toContain('no-store');
        expect(csv.headers()['content-disposition']).toContain(`usage-${workId}-2026-07.csv`);
        const text = await csv.text();
        expect(text.split('\n')[0]).toBe(
            'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId',
        );
    });

    test('account-wide zero-state is a non-negative self-keyed envelope: currentSpendCents 0, capCents null, percentUsed null, blocked false, userId === the token subject', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(u.access_token) });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.userId).toBe(u.user.id);
        expect(typeof body.currentSpendCents).toBe('number');
        expect(body.currentSpendCents).toBeGreaterThanOrEqual(0);
        expect(body.currentSpendCents).toBe(0);
        expect(body.capCents, 'fresh user has no account cap').toBeNull();
        expect(body.percentUsed, 'null percent when uncapped').toBeNull();
        expect(body.blocked).toBe(false);
        expect(typeof body.currency).toBe('string');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP F — admin/usage guard: guard-before-pipe + prefix asymmetry.
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: admin/usage guard — platform-admin gate precedes period validation', () => {
    test('a regular user is 403 "Platform admin access required"; anonymous is 401; the api/-prefixed path 404s (bare /admin/usage is the only route)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const authed = await request.get(ADMIN_USAGE, { headers: authedHeaders(u.access_token) });
        expect(authed.status()).toBe(403);
        const body = (await authed.json()) as ErrBody;
        expect(body.message).toBe('Platform admin access required');
        expect(typeof body.message).toBe('string');

        const anon = await request.get(ADMIN_USAGE);
        expect(anon.status()).toBe(401);

        const wrongPrefix = await request.get(`${API_BASE}/api/admin/usage`, {
            headers: authedHeaders(u.access_token),
        });
        expect(wrongPrefix.status(), 'api/ prefix is NOT a route for admin usage').toBe(404);
    });

    test('the platform-admin guard runs BEFORE the period pipe: a non-admin gets the SAME 403 for a valid, a bad-shape, and a bad-range period — the period contract never leaks past the gate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const h = authedHeaders(u.access_token);
        for (const period of ['current', '2026-07', 'garbage', '2026-13']) {
            const res = await request.get(`${ADMIN_USAGE}?period=${encodeURIComponent(period)}`, {
                headers: h,
            });
            expect(res.status(), `non-admin period=${period} stays 403 (not 400)`).toBe(403);
            expect(((await res.json()) as ErrBody).message).toBe('Platform admin access required');
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP G — consolidated AUTHZ + ID-RESOLUTION matrix (budgets + usage).
// ════════════════════════════════════════════════════════════════════════════
test.describe('flow: budgets/usage authz + id-resolution matrix', () => {
    test('budgets require auth on every verb: list, create, patch, and delete without a token are all 401', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'unauth');
        const id = await seedGlobal(request, token, workId);

        expect((await request.get(budgetsUrl(workId))).status()).toBe(401);
        expect(
            (
                await request.post(budgetsUrl(workId), {
                    data: { scope: 'global', monthlyCapCents: 1 },
                })
            ).status(),
        ).toBe(401);
        expect(
            (await request.patch(budgetUrl(workId, id), { data: { monthlyCapCents: 2 } })).status(),
        ).toBe(401);
        expect((await request.delete(budgetUrl(workId, id))).status()).toBe(401);
    });

    test('a non-member stranger is 403 (NOT 404) on the budget READ, and 403 on every WRITE (create/patch/delete) — this surface leaks existence to strangers by posture', async ({
        request,
    }) => {
        const owner = await freshUserWithWork(request, 'owner');
        const id = await seedGlobal(request, owner.token, owner.workId);
        const stranger = await registerUserViaAPI(request);
        const sh = authedHeaders(stranger.access_token);

        const list = await request.get(budgetsUrl(owner.workId), { headers: sh });
        expect(list.status(), 'non-member read is 403, not 404').toBe(403);
        expect(hasMessage(await messagesOf(list), 'does not have access')).toBe(true);

        const create = await request.post(budgetsUrl(owner.workId), {
            headers: sh,
            data: { scope: 'plugin', pluginId: 'x', monthlyCapCents: 100 },
        });
        expect(create.status()).toBe(403);
        expect(
            hasMessage(await messagesOf(create), 'must be the Work owner or have MANAGER role'),
        ).toBe(true);

        const patch = await request.patch(budgetUrl(owner.workId, id), {
            headers: sh,
            data: { monthlyCapCents: 200 },
        });
        expect(patch.status()).toBe(403);

        const del = await request.delete(budgetUrl(owner.workId, id), { headers: sh });
        expect(del.status()).toBe(403);
    });

    test('id resolution on budgets: an unknown-but-valid work uuid 404s, a MALFORMED work id 404s (no ParseUUIDPipe), and unknown/malformed budget ids 404 on PATCH and DELETE', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWithWork(request, 'ids');
        const realId = await seedGlobal(request, token, workId);
        const h = authedHeaders(token);

        const unknownWork = await request.get(budgetsUrl(NONEXISTENT_UUID), { headers: h });
        expect(unknownWork.status()).toBe(404);
        expect(hasMessage(await messagesOf(unknownWork), 'not found')).toBe(true);

        const malformedWork = await request.get(budgetsUrl(MALFORMED_ID), { headers: h });
        expect(malformedWork.status(), 'malformed work id is 404, not 400 — no ParseUUIDPipe').toBe(
            404,
        );

        const unknownBudgetPatch = await patchBudget(request, token, workId, NONEXISTENT_UUID, {
            monthlyCapCents: 1,
        });
        expect(unknownBudgetPatch.status()).toBe(404);

        const malformedBudgetPatch = await patchBudget(request, token, workId, MALFORMED_ID, {
            monthlyCapCents: 1,
        });
        expect(malformedBudgetPatch.status(), 'malformed budget id is 404, not 400').toBe(404);

        const unknownBudgetDelete = await request.delete(budgetUrl(workId, NONEXISTENT_UUID), {
            headers: h,
        });
        expect(unknownBudgetDelete.status()).toBe(404);

        // sanity: the real id still deletes cleanly (proves the 404s were id-specific, not a broken route)
        const okDelete = await request.delete(budgetUrl(workId, realId), { headers: h });
        expect(okDelete.status()).toBe(200);
        expect((await okDelete.json()).deletedId).toBe(realId);
    });

    test('all three usage surfaces enforce ONE authz contract: unauth 401, non-member 403, unknown work 404, malformed work 404 — uniformly on summary, trend, and export', async ({
        request,
    }) => {
        const owner = await freshUserWithWork(request, 'usage-authz');
        const stranger = await registerUserViaAPI(request);
        const sh = authedHeaders(stranger.access_token);
        const oh = authedHeaders(owner.token);

        const surfaces = [summaryUrl, trendUrl, exportUrl];
        for (const surface of surfaces) {
            expect((await request.get(surface(owner.workId))).status(), 'unauth').toBe(401);
            expect(
                (await request.get(surface(owner.workId), { headers: sh })).status(),
                'non-member 403',
            ).toBe(403);
            expect(
                (await request.get(surface(NONEXISTENT_UUID), { headers: oh })).status(),
                'unknown work 404',
            ).toBe(404);
            expect(
                (await request.get(surface(MALFORMED_ID), { headers: oh })).status(),
                'malformed work 404',
            ).toBe(404);
        }
    });

    test('account-wide is a GET-only, session-gated, strictly self-scoped read: anonymous 401, and two distinct tokens each return their OWN userId', async ({
        request,
    }) => {
        expect((await request.get(ACCOUNT_WIDE)).status()).toBe(401);

        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const ra = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(a.access_token) });
        const rb = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(b.access_token) });
        expect(ra.status()).toBe(200);
        expect(rb.status()).toBe(200);
        const ja = await ra.json();
        const jb = await rb.json();
        expect(ja.userId).toBe(a.user.id);
        expect(jb.userId).toBe(b.user.id);
        expect(ja.userId).not.toBe(jb.userId);

        // write verbs on the read endpoint are not routed
        const post = await request.post(ACCOUNT_WIDE, {
            headers: authedHeaders(a.access_token),
            data: {},
        });
        expect([404, 405]).toContain(post.status());
    });
});
