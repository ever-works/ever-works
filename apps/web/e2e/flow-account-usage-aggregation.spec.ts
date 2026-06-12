import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-account-usage-aggregation — the AGGREGATION MECHANICS of the account-wide
 * usage rollup (`GET /api/me/usage/account-wide`, AccountUsageController →
 * `@ever-works/agent/budgets` `BudgetService.summarizeForUser(userId)`), driven
 * DEEPER than the Batch-3 contract spec: this file proves how the per-USER
 * aggregate RELATES to the per-OWNER spend surfaces it folds in — the shared
 * period engine across owner TYPES, invariance of the aggregate to owner
 * mutation / per-owner read activity, the percentUsed arithmetic ladder over a
 * RANGE of account caps, and the per-USER isolation of the CAP itself (not just
 * spend) under separately-populated portfolios.
 *
 * Every status code, casing, and number asserted below was PROBED against the
 * LIVE API at http://127.0.0.1:3100 before being written (2026-06-12).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — the account-wide endpoint + the per-owner budget reads are
 * ALREADY heavily covered; this file stays strictly on the GAPS:
 *
 *   - `flow-account-usage-contract.spec.ts` (Batch 3) pins, on the SAME endpoint:
 *       the fresh zero-state SHAPE + exact key set, JWT-subject keying, the
 *       Work+Mission+Idea PORTFOLIO fold staying at zero, the multi-owner fold,
 *       cross-USER SPEND isolation, idempotent read, the calendar-month window in
 *       ISOLATION, and the HTTP closure (anon/garbage 401, POST/PUT 404).
 *       → This file NEVER restates the zero-state key set, JWT keying, the
 *         spend-leak silo, or the GET-only/anon closure. It adds the RELATIONAL
 *         contracts: the aggregate's window CONVERGES with the per-owner reads at
 *         one instant, is INVARIANT to interleaved owner reads/mutations, the
 *         percentUsed LADDER over cap magnitudes, and cross-user CAP isolation.
 *   - `flow-budget-agent-spend.spec.ts` + `flow-subscriptions-budgets.spec.ts`
 *       pin the account-cap CRUD/echo (digit-string), ONE cap→0% case, the
 *       cap-0 hard-stop/soft-cap blocked gate, and the two-clock model.
 *       → This file does NOT re-assert the blocked gate or the digit-string echo.
 *         It pins percentUsed === 0 across a RANGE (1 / 100 / huge) of positive
 *         caps at 0 spend (the rounding/precision boundary nobody else sweeps).
 *   - `flow-mission-budget-contract.spec.ts`, `flow-work-proposals-deep.spec.ts`,
 *       `flow-agent-budget-enforcement.spec.ts` pin the per-OWNER (mission/idea)
 *       budget SHAPE + scoping (404/401/400) and mission↔idea / mission↔account
 *       window alignment.
 *       → This file does NOT re-assert per-owner shapes or their scoping. It uses
 *         them only to prove the THREE-WAY convergence (account ↔ mission ↔ idea
 *         in one read-set) and the cap non-inheritance THROUGH the live reads.
 *
 *   The contracts pinned HERE (no sibling covers them):
 *     1. THREE-WAY PERIOD CONVERGENCE. In one read-set, the account-wide
 *        aggregate, a Mission budget, and an Idea budget report BYTE-IDENTICAL
 *        periodStart/periodEnd — the aggregate folds owners onto the SAME
 *        calendar-month engine (whereas the per-Agent rollup slides on a
 *        rolling-30d clock). The aggregate window literally equals the owners'.
 *     2. AGGREGATE INVARIANCE. Reading per-owner budgets and ADDING owners
 *        (multiple Works, a Mission, an Idea) — interleaved with account-wide
 *        reads — never perturbs the aggregate's window, spend (0), or null cap.
 *        The aggregate is a pure function of userId, decoupled from per-owner
 *        read activity and owner count.
 *     3. MULTIPLE-WORKS FOLD. There is NO per-Work budget READ endpoint
 *        (`/api/me/works/:id/budget` → 404), so a user's Works fold their spend
 *        ONLY into the account-wide aggregate — which sums across N Works as a
 *        single per-user rollup that stays the zero-state in keyless CI.
 *     4. percentUsed LADDER. At 0 spend, EVERY positive account cap (the smallest
 *        cap=1, a mid cap=100, a huge cap=999_999_999) yields percentUsed === 0
 *        EXACTLY (no rounding artifact), while cap=0 yields null (divide-by-zero
 *        guard) and no cap yields null. capCents narrows the bigint to a NUMBER.
 *     5. CROSS-USER CAP ISOLATION. The account CAP is per-user siloed: arming
 *        user A's monthly cap leaves a separately-populated user B's aggregate
 *        uncapped (capCents null), and vice-versa — neither the cap nor the
 *        percentUsed/blocked it induces bleeds across the userId silo.
 *     6. PER-OWNER NON-INHERITANCE THROUGH LIVE READS. With the account cap armed
 *        AND a populated portfolio, the per-owner reads (mission + idea) stay
 *        uncapped (capCents null, percentUsed null) — the aggregate cap clamps
 *        ONLY the per-user view, never cascading down to the owners it folds.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, 2026-06-12):
 *   GET /api/me/usage/account-wide → 200 { userId, periodStart(ISO 1st-of-month),
 *     periodEnd(ISO 1st-of-next-month), currentSpendCents:0, capCents:number|null,
 *     currency:'usd', percentUsed:number|null, allowOverage, blocked }.
 *   Account window == per-owner window: account, GET /api/me/missions/:id/budget,
 *     and GET /api/me/work-proposals/:id/budget all returned periodStart
 *     '2026-06-01T00:00:00.000Z' / periodEnd '2026-07-01T00:00:00.000Z'.
 *   GET /api/me/works/:id/budget → 404 (no per-Work budget read endpoint).
 *   Cap set via PUT /api/me/work-agent/preferences {accountWideMonthlyCapCents}:
 *     '1'→capCents 1, percentUsed 0; '100'→100,0; '999999999'→999999999,0;
 *     '0'→0, percentUsed null; null→capCents null, percentUsed null.
 *   With account cap '20000' armed: account-wide capCents 20000 / percentUsed 0,
 *     but mission + idea budgets stay capCents null / percentUsed null.
 *   Creating 3 Works in a row left the aggregate byte-identical after each.
 *   Per-owner create routes: POST /api/works {name,slug,description,
 *     organization:false}→200 {work:{id}}; POST /api/me/missions
 *     {title,description,type:'one-shot'}→201 {id}; POST /api/me/work-proposals
 *     {description}→201 {id, source:'user-manual'}.
 *
 * Cross-spec isolation: every CAP mutation runs on a FRESH registerUserViaAPI()
 * user (this file's cap writes can never shadow a sibling's). Unique stamps come
 * from a per-test counter seeded off the test title, NOT a module-scope clock.
 * Assertions pin shape / convergence / self-scoping / zero-state, never a billed
 * number or a global count.
 */

const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;
const PREFS = `${API_BASE}/api/me/work-agent/preferences`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH_START_RE = /^\d{4}-\d{2}-01T00:00:00\.000Z$/;

interface AccountSummary {
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

interface OwnerBudget {
    ownerType: string;
    ownerId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
}

/** Per-test monotonic stamp — built from the test title, NOT a module clock. */
function stamper(title: string): () => string {
    let n = 0;
    const base = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    return () => `${base}-${n++}`;
}

async function getAccount(request: APIRequestContext, token: string): Promise<AccountSummary> {
    const res = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
    expect(res.status(), `account-wide GET body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Set (or clear, with null) the account-wide monthly cap via the prefs surface. */
async function setAccountCap(
    request: APIRequestContext,
    token: string,
    capCents: string | null,
    allowOverage = true,
): Promise<void> {
    const res = await request.put(PREFS, {
        headers: authedHeaders(token),
        data: { accountWideMonthlyCapCents: capCents, accountWideAllowOverage: allowOverage },
    });
    expect(res.status(), `set account cap body=${await res.text().catch(() => '')}`).toBe(200);
}

async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: {
            title,
            description: `${title} — an owner folded into the account-wide spend aggregate`,
            type: 'one-shot',
        },
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const id = (await res.json()).id as string;
    expect(id).toMatch(UUID_RE);
    return id;
}

async function createIdea(
    request: APIRequestContext,
    token: string,
    label: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description: `${label} — a directory of tools folded into the account aggregate` },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    const id = (await res.json()).id as string;
    expect(id).toMatch(UUID_RE);
    return id;
}

async function getMissionBudget(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<OwnerBudget> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `mission budget body=${await res.text()}`).toBe(200);
    return res.json();
}

async function getIdeaBudget(
    request: APIRequestContext,
    token: string,
    ideaId: string,
): Promise<OwnerBudget> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `idea budget body=${await res.text()}`).toBe(200);
    return res.json();
}

test.describe('flow: account-wide usage AGGREGATION mechanics (GET /api/me/usage/account-wide)', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 1 — THE AGGREGATE FOLDS OWNERS ONTO ONE PERIOD ENGINE. The
    // account-wide rollup, a Mission budget, and an Idea budget — read in one
    // set — share BYTE-IDENTICAL period boundaries: the aggregate's window IS the
    // owners' window (the calendar-month engine), proving it sums the same-period
    // owner spend rather than running its own clock.
    // ──────────────────────────────────────────────────────────────────
    test('the account-wide window CONVERGES byte-identically with a Mission AND an Idea budget read in the same set (one calendar-month engine)', async ({
        request,
    }) => {
        const s = stamper('three-way-convergence');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const missionId = await createMission(request, token, `Converge Mission ${s()}`);
        const ideaId = await createIdea(request, token, `Converge idea ${s()}`);

        // Read all three surfaces (per-user aggregate + two per-owner rollups).
        const account = await getAccount(request, token);
        const mission = await getMissionBudget(request, token, missionId);
        const idea = await getIdeaBudget(request, token, ideaId);

        // The aggregate boundaries are clean first-of-month UTC midnights.
        expect(account.periodStart).toMatch(MONTH_START_RE);
        expect(account.periodEnd).toMatch(MONTH_START_RE);

        // The aggregate window EQUALS both owner windows, byte-for-byte. This is the
        // structural proof that the per-user aggregate folds owners onto the SAME
        // calendar-month window (contrast the per-Agent rolling-30d window pinned by
        // flow-budget-agent-spend.spec.ts — that one would NOT match here).
        expect(account.periodStart, 'account start == mission start').toBe(mission.periodStart);
        expect(account.periodStart, 'account start == idea start').toBe(idea.periodStart);
        expect(account.periodEnd, 'account end == mission end').toBe(mission.periodEnd);
        expect(account.periodEnd, 'account end == idea end').toBe(idea.periodEnd);

        // Owner discriminators differ (mission vs idea) but the window is shared —
        // the convergence is across owner TYPES, not a coincidence of one owner.
        expect(mission.ownerType).toBe('mission');
        expect(idea.ownerType).toBe('idea');

        // Currency casing is consistent across the per-user + per-owner UserBudgetSummary
        // family: lower-case 'usd' on all three (the per-Agent rollup uses UPPER 'USD').
        expect(account.currency).toBe('usd');
        expect(mission.currency).toBe('usd');
        expect(idea.currency).toBe('usd');

        // The window is exactly one calendar month forward (28..31 days).
        const spanDays =
            (Date.parse(account.periodEnd) - Date.parse(account.periodStart)) /
            (24 * 60 * 60 * 1000);
        expect(spanDays).toBeGreaterThanOrEqual(28);
        expect(spanDays).toBeLessThanOrEqual(31);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 2 — THE AGGREGATE IS INVARIANT TO OWNER ACTIVITY. Adding owners
    // (multiple Works, a Mission, an Idea) and reading their per-owner budgets —
    // interleaved with account-wide reads — never moves the aggregate off its
    // window / zero spend / null cap. The aggregate is a pure function of userId.
    // ──────────────────────────────────────────────────────────────────
    test('interleaving owner CREATES and per-owner budget READS never perturbs the account-wide aggregate (window, 0 spend, null cap all invariant)', async ({
        request,
    }) => {
        const s = stamper('aggregate-invariance');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Baseline aggregate (empty portfolio).
        const base = await getAccount(request, token);
        expect(base.userId).toBe(user.user.id);
        expect(base.currentSpendCents).toBe(0);
        expect(base.capCents).toBeNull();

        // Add a Mission, READ its budget, then re-read the aggregate — unchanged.
        const missionId = await createMission(request, token, `Invariance Mission ${s()}`);
        const mBudget = await getMissionBudget(request, token, missionId);
        expect(mBudget.ownerId).toBe(missionId);
        const afterMission = await getAccount(request, token);
        expect(afterMission).toEqual(base);

        // Add an Idea, READ its budget, re-read the aggregate — still unchanged.
        const ideaId = await createIdea(request, token, `Invariance idea ${s()}`);
        const iBudget = await getIdeaBudget(request, token, ideaId);
        expect(iBudget.ownerId).toBe(ideaId);
        const afterIdea = await getAccount(request, token);
        expect(afterIdea).toEqual(base);

        // Add a couple of Works (re-reading the aggregate each time) — the per-user
        // aggregate is decoupled from owner COUNT and from per-owner read activity.
        const w1 = await createWorkViaAPI(request, token, {
            name: `Invariance Work A ${s()}`,
            slug: `inv-work-a-${s()}`.toLowerCase(),
            description: 'A work folded into the account aggregate',
        });
        expect(w1.id, 'work A created').not.toBe('');
        expect(await getAccount(request, token)).toEqual(base);

        const w2 = await createWorkViaAPI(request, token, {
            name: `Invariance Work B ${s()}`,
            slug: `inv-work-b-${s()}`.toLowerCase(),
            description: 'Another work folded into the same aggregate',
        });
        expect(w2.id, 'work B created').not.toBe('');
        const final = await getAccount(request, token);
        expect(final, 'the aggregate is invariant to the whole owner build-up').toEqual(base);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 3 — MULTIPLE WORKS FOLD INTO THE AGGREGATE, WHICH IS THEIR ONLY
    // SPEND READ. There is no per-Work budget endpoint, so a user's Works fold
    // their spend ONLY into the account-wide rollup. We pin BOTH the absence of a
    // per-Work read AND that N Works produce ONE aggregate (the per-user SUM).
    // ──────────────────────────────────────────────────────────────────
    test('there is NO per-Work budget read endpoint → Works fold their spend ONLY into the single account-wide aggregate (sums across N Works)', async ({
        request,
    }) => {
        const s = stamper('multi-work-fold');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const before = await getAccount(request, token);
        expect(before.currentSpendCents).toBe(0);

        // Create three Works under the one user.
        const works: string[] = [];
        for (const tag of ['x', 'y', 'z']) {
            const w = await createWorkViaAPI(request, token, {
                name: `Fold Work ${tag} ${s()}`,
                slug: `fold-work-${tag}-${s()}`.toLowerCase(),
                description: `Work ${tag} whose spend folds only into the account aggregate`,
            });
            expect(w.id, `work ${tag} created`).not.toBe('');
            works.push(w.id);
        }
        expect(new Set(works).size, 'three distinct works').toBe(3);

        // There is NO per-Work budget READ surface — the per-owner budget endpoints
        // exist for missions/ideas, but NOT for works. A Work's spend is observable
        // ONLY through the account-wide aggregate that folds it in.
        const perWork = await request.get(`${API_BASE}/api/me/works/${works[0]}/budget`, {
            headers: authedHeaders(token),
        });
        expect(perWork.status(), 'no per-Work budget read endpoint → 404').toBe(404);

        // The aggregate is the SINGLE per-user SUM across all three Works — still the
        // zero-state in keyless CI (no billing), window unchanged. N Works → ONE rollup.
        const after = await getAccount(request, token);
        expect(after.userId).toBe(user.user.id);
        expect(after.currentSpendCents, 'three Works fold into one aggregate, still 0').toBe(0);
        expect(after.periodStart).toBe(before.periodStart);
        expect(after.periodEnd).toBe(before.periodEnd);
        // It carries no per-owner discriminator — it is strictly the per-USER view.
        expect(after).not.toHaveProperty('ownerType');
        expect(after).not.toHaveProperty('ownerId');
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 4 — THE percentUsed ARITHMETIC LADDER. At 0 spend, EVERY positive
    // account cap (the smallest cap=1, a mid cap=100, a huge cap) yields
    // percentUsed === 0 EXACTLY (no rounding artifact); cap=0 yields null (the
    // divide-by-zero guard); no cap yields null. capCents narrows to a NUMBER.
    // ──────────────────────────────────────────────────────────────────
    test('percentUsed is EXACTLY 0 across a magnitude ladder of positive caps (1, 100, 999_999_999) at 0 spend; cap 0 and no-cap are null', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // No cap → percentUsed null (nothing to divide by).
        const uncapped = await getAccount(request, token);
        expect(uncapped.capCents).toBeNull();
        expect(uncapped.percentUsed, 'no cap → percentUsed null').toBeNull();

        // The ladder of positive caps — at 0 spend each is EXACTLY 0% (the precision
        // boundary: a naive 0/1*100 rounding bug or a cap-coercion bug would show as
        // a non-zero/NaN here; the smallest positive cap=1 and a huge cap both hold).
        for (const cap of ['1', '100', '999999999'] as const) {
            await setAccountCap(request, token, cap, /* allowOverage */ false);
            const s = await getAccount(request, token);
            expect(s.capCents, `cap '${cap}' narrows to a NUMBER on the summary`).toBe(Number(cap));
            expect(typeof s.capCents, 'capCents is a number, not the digit-string').toBe('number');
            expect(s.currentSpendCents, 'no billed spend in CI').toBe(0);
            expect(s.percentUsed, `0 spend under cap ${cap} → EXACTLY 0%`).toBe(0);
            // 0 spend < positive cap → not blocked even with overage off (the cap is
            // not yet reached; only cap 0 hits the >= threshold).
            expect(s.blocked, `0 < ${cap} → not blocked`).toBe(false);
        }

        // cap 0 → percentUsed null (the service guards division by capCents>0), even
        // though it's a "positive-shaped" boundary. This is the one cap value where
        // percentUsed is null DESPITE a non-null cap.
        await setAccountCap(request, token, '0', /* allowOverage */ true);
        const zeroCap = await getAccount(request, token);
        expect(zeroCap.capCents).toBe(0);
        expect(zeroCap.percentUsed, 'cap 0 → percentUsed null (no divide-by-zero)').toBeNull();

        // Clearing the cap returns percentUsed to null and the cap to null.
        await setAccountCap(request, token, null);
        const cleared = await getAccount(request, token);
        expect(cleared.capCents).toBeNull();
        expect(cleared.percentUsed).toBeNull();
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 5 — CROSS-USER CAP ISOLATION. The account CAP (not just spend) is a
    // per-user silo: arming user A's monthly cap leaves a separately-populated
    // user B's aggregate uncapped, and the percentUsed/blocked the cap induces on
    // A never appears on B. Distinct from the contract spec's cross-user SPEND silo.
    // ──────────────────────────────────────────────────────────────────
    test('arming user A account cap leaves a separately-populated user B uncapped — the cap, percentUsed and blocked are all per-user siloed', async ({
        request,
    }) => {
        const s = stamper('cross-user-cap-silo');
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        expect(a.user.id).not.toBe(b.user.id);

        // Populate BOTH users with different portfolios so a leak would be observable.
        await createMission(request, a.access_token, `Cap silo A mission ${s()}`);
        await createWorkViaAPI(request, b.access_token, {
            name: `Cap silo B Work ${s()}`,
            slug: `cap-silo-b-work-${s()}`.toLowerCase(),
            description: "User B's work — B must stay uncapped when A arms a cap",
        });
        await createIdea(request, b.access_token, `Cap silo B idea ${s()}`);

        // Arm a HARD cap on A only (cap 0 + overage off → A's gate blocks).
        await setAccountCap(request, a.access_token, '0', /* allowOverage */ false);

        const sA = await getAccount(request, a.access_token);
        const sB = await getAccount(request, b.access_token);

        // A's cap landed and A's gate is blocked (cap 0, overage off, spend 0 >= 0).
        expect(sA.userId).toBe(a.user.id);
        expect(sA.capCents, "A's cap is the 0 we armed").toBe(0);
        expect(sA.allowOverage).toBe(false);
        expect(sA.blocked, "A's gate is blocked by its own cap").toBe(true);

        // B is a DIFFERENT silo — B never inherits A's cap / blocked / overage flip.
        expect(sB.userId).toBe(b.user.id);
        expect(sB.capCents, "B is uncapped — A's cap does not bleed into B").toBeNull();
        expect(sB.percentUsed, 'B has no cap → percentUsed null').toBeNull();
        expect(
            sB.allowOverage,
            "B keeps its permissive default — A's overage-off didn't bleed",
        ).toBe(true);
        expect(sB.blocked, "A's hard stop never blocks B").toBe(false);

        // The inverse: arm a DIFFERENT cap on B; A's 0-cap is untouched (each silo
        // stores its own row).
        await setAccountCap(request, b.access_token, '5000', /* allowOverage */ false);
        const sB2 = await getAccount(request, b.access_token);
        const sA2 = await getAccount(request, a.access_token);
        expect(sB2.capCents, "B now carries ITS cap (5000), not A's 0").toBe(5000);
        expect(sB2.percentUsed, '0 / 5000 → 0%').toBe(0);
        expect(sA2.capCents, "A's 0-cap survives B's write").toBe(0);
        expect(sA2.blocked, 'A still blocked by its own cap').toBe(true);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 6 — THE AGGREGATE CAP CLAMPS ONLY THE PER-USER VIEW. With the account
    // cap armed AND a populated portfolio, the per-owner reads (mission + idea)
    // stay uncapped — the aggregate cap never cascades DOWN to the owners it folds
    // in. The clamp is one-directional: aggregate-only.
    // ──────────────────────────────────────────────────────────────────
    test('with the account cap armed, the per-owner Mission and Idea budgets it folds in stay uncapped (cap clamps the aggregate, not its owners)', async ({
        request,
    }) => {
        const s = stamper('cap-non-inheritance');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const missionId = await createMission(request, token, `Clamp Mission ${s()}`);
        const ideaId = await createIdea(request, token, `Clamp idea ${s()}`);

        // Baseline: both owner reads are uncapped, and so is the aggregate.
        expect((await getMissionBudget(request, token, missionId)).capCents).toBeNull();
        expect((await getIdeaBudget(request, token, ideaId)).capCents).toBeNull();
        expect((await getAccount(request, token)).capCents).toBeNull();

        // Arm a mid-range account cap (overage off so percentUsed math is exercised).
        await setAccountCap(request, token, '20000', /* allowOverage */ false);

        // The AGGREGATE reflects the cap (clamped per-user view) …
        const account = await getAccount(request, token);
        expect(account.capCents, 'aggregate is clamped to the 20000 cap').toBe(20000);
        expect(account.percentUsed, '0 / 20000 → 0%').toBe(0);
        expect(account.allowOverage).toBe(false);

        // … but the per-owner budgets it folds in are UNTOUCHED — capCents null,
        // percentUsed null, overage permissive. The cap clamps the per-USER rollup
        // only; it never cascades down onto the Mission/Idea owner rows.
        const mission = await getMissionBudget(request, token, missionId);
        expect(mission.capCents, 'mission does NOT inherit the account cap').toBeNull();
        expect(mission.percentUsed, 'mission stays percentUsed null').toBeNull();
        expect(mission.allowOverage, 'mission keeps its own permissive overage').toBe(true);
        expect(mission.blocked, 'mission not blocked by the account cap').toBe(false);

        const idea = await getIdeaBudget(request, token, ideaId);
        expect(idea.capCents, 'idea does NOT inherit the account cap').toBeNull();
        expect(idea.percentUsed, 'idea stays percentUsed null').toBeNull();
        expect(idea.allowOverage).toBe(true);
        expect(idea.blocked).toBe(false);

        // And the owner windows still converge with the (now-capped) aggregate —
        // clamping the cap didn't shift the shared period engine.
        expect(mission.periodStart).toBe(account.periodStart);
        expect(idea.periodEnd).toBe(account.periodEnd);
    });

    // ------------------------------------------------------------------
    // GROUP 7 - A REJECTED CAP WRITE IS INERT AT THE AGGREGATE. The cap mutation
    // surface validates the bigint-as-digit-string (a negative string, a
    // non-numeric string, and a raw NUMBER all 400); a rejected write leaves the
    // aggregate's previously-armed cap exactly intact - no partial corruption of
    // the per-user rollup.
    // ------------------------------------------------------------------
    test('a malformed account-cap write (400) never corrupts the aggregate - the previously-armed cap survives every rejected PUT', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Arm a valid cap so there is a known-good state to defend.
        await setAccountCap(request, token, '5000', /* allowOverage */ false);
        const armed = await getAccount(request, token);
        expect(armed.capCents, 'baseline armed cap is 5000').toBe(5000);

        // Each malformed cap write is rejected at the DTO boundary with 400. The cap
        // must be a NON-NEGATIVE DIGIT STRING; a negative string, a non-numeric
        // string, and a raw number (not a string) are all invalid.
        for (const bad of [
            { accountWideMonthlyCapCents: '-5' },
            { accountWideMonthlyCapCents: 'abc' },
            { accountWideMonthlyCapCents: 5000 },
        ]) {
            const res = await request.put(PREFS, { headers: authedHeaders(token), data: bad });
            expect(res.status(), `malformed cap ${JSON.stringify(bad)} -> 400`).toBe(400);
        }

        // After all three rejected writes the aggregate is byte-identical to the
        // armed baseline - a 400 leaves the per-user rollup untouched (no half-applied
        // cap, no reset to default).
        const afterBad = await getAccount(request, token);
        expect(afterBad, 'rejected cap writes are inert at the aggregate').toEqual(armed);
    });

    // ------------------------------------------------------------------
    // GROUP 8 - CAP ROUND-TRIP RESTORES THE EXACT PRIOR AGGREGATE. Arming then
    // CLEARING the account cap returns the aggregate to its original uncapped
    // numbers - the cap is the only mutated field, and the rollup is otherwise a
    // stable pure read keyed on userId.
    // ------------------------------------------------------------------
    test('arming then clearing the account cap restores the aggregate to its original uncapped state (cap is the only moving part)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Original uncapped aggregate (the permissive default: cap null, overage true).
        const original = await getAccount(request, token);
        expect(original.capCents).toBeNull();
        expect(original.percentUsed).toBeNull();
        expect(original.allowOverage).toBe(true);

        // Arm a cap WITHOUT changing overage (keep the default true) so the ONLY
        // field that moves is the cap/percentUsed pair - then clear it back to null.
        await setAccountCap(request, token, '12345', /* allowOverage */ true);
        const capped = await getAccount(request, token);
        expect(capped.capCents).toBe(12345);
        expect(capped.percentUsed, '0 / 12345 -> 0%').toBe(0);
        expect(capped.allowOverage, 'overage preserved through the cap arm').toBe(true);

        await setAccountCap(request, token, null, /* allowOverage */ true);
        const restored = await getAccount(request, token);

        // The aggregate is byte-identical to the original - the cap round-trip left no
        // residue, and the window/userId/spend never moved (pure read keyed on userId).
        expect(restored, 'cap round-trip restores the exact original aggregate').toEqual(original);
    });
});
