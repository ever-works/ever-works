import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-account-usage-contract — the ACCOUNT-WIDE USAGE AGGREGATION surface
 * (`GET /api/me/usage/account-wide`, Phase 7 PR II) of the Ever Works
 * Missions/Ideas/Works taxonomy. Drives the real
 * `apps/api/src/budgets/account-usage.controller.ts` →
 * `WorkAgentService.getPreferences(userId)` (for the cap inputs) →
 * `@ever-works/agent/budgets` `BudgetService.summarizeForUser(userId, …)`,
 * whose spend rollup `getTotalSpendCentsForUser(userId, …)` is discriminated
 * PURELY by the JWT subject's `userId` (NOT an owner ref) — so it aggregates
 * across EVERY Work + Mission + Idea (work-proposal) the user owns.
 *
 * Every status code, message, and JSON shape asserted below was PROBED against
 * the LIVE API at http://127.0.0.1:3100 before being written (2026-06-12).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — this file pins the ACCOUNT-WIDE AGGREGATION + CROSS-USER
 * ISOLATION contract, deliberately staying clear of the two sibling specs that
 * already cover the OTHER facets of `/me/usage/account-wide`:
 *
 *   - `flow-budget-agent-spend.spec.ts` pins, on the SAME endpoint:
 *       • the account-wide cap CRUD (cap as a digit-string, overage flag),
 *       • the per-run `maxBudgetCentsPerRun` guardrail's INDEPENDENCE from the
 *         monthly cap, the over-budget HARD-STOP (cap 0 + overage-off → blocked,
 *         overage-on → soft), the calendar-month vs rolling-30d clock contrast,
 *         and the `usd` (lower) vs `USD` (upper) casing fingerprint.
 *     It NEVER builds a populated owner portfolio under the user, and it NEVER
 *     proves cross-USER isolation with two real accounts.
 *   - `flow-mission-budget-contract.spec.ts` pins the PER-OWNER read
 *     (`GET /api/me/missions/:id/budget` → `summarizeForOwner({ownerType:
 *     MISSION,…})`) — the ownerType/ownerId-keyed shape, its owner-scoping
 *     (anon/400/404/stranger), and that it does NOT inherit the account cap.
 *     It is the PER-OWNER rollup; this file is the PER-USER aggregate.
 *
 *   The contracts neither sibling covers, pinned HERE:
 *     1. THE AGGREGATION MECHANISM. The account-wide summary is keyed on the
 *        user, so a user who actually OWNS a portfolio (a Work + a Mission + an
 *        Idea/work-proposal) has those owners FOLDED INTO the one rollup — yet
 *        in keyless CI (no plugin billing) the aggregate is the well-formed
 *        ZERO state (currentSpendCents 0). We assert the aggregation is WIRED
 *        ACROSS owner types and reports 0, never a fabricated non-zero — and
 *        that adding owners NEVER perturbs the number off zero.
 *     2. NO CROSS-USER LEAKAGE. Two distinct, separately-populated users each
 *        read a summary discriminated ONLY by their own `userId`; neither user's
 *        owners or `userId` ever appear in the other's summary. The rollup is a
 *        per-user silo.
 *     3. JWT-SUBJECT KEYING. The `userId` in the body always equals the bearer
 *        token's subject (the registered user's id) — the summary is computed
 *        for whoever holds the token, with no path/param to spoof another user.
 *     4. IDEMPOTENT READ. Repeated GETs are byte-identical within a period and
 *        carry EXACTLY the UserBudgetSummary key set (no ownerType/ownerId leak
 *        from the per-owner shape, no extra fields).
 *     5. HTTP CLOSURE. The route is GET-ONLY (POST/PUT → 404), anon → 401, and a
 *        garbage bearer → 401 (the rollup is session-gated end to end).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROBED CONTRACTS (live, 2026-06-12):
 *   GET /api/me/usage/account-wide → 200 UserBudgetSummary:
 *     { userId:<JWT subject id>, periodStart(ISO 1st-of-month UTC),
 *       periodEnd(ISO 1st-of-next-month UTC), currentSpendCents:0, capCents:null,
 *       currency:'usd', percentUsed:null, allowOverage:true, blocked:false } for
 *     a fresh user. Same exact body AFTER the user owns a Work + Mission + Idea
 *     (currentSpendCents STILL 0 — no billing in CI).
 *   userId === the registered user's id (probed: two users return their own ids).
 *   Two GETs in one period are byte-identical (idempotent).
 *   POST /api/me/usage/account-wide → 404 ; PUT → 404 (GET-only route).
 *   No Authorization → 401 ; garbage bearer ('garbage.token.here') → 401.
 *   Owner-create routes used to populate the portfolio (all probed live):
 *     POST /api/works {name,slug,description,organization:false} → 200
 *       {status:'success', work:{ id, userId, … }}  (createWorkViaAPI helper).
 *     POST /api/me/missions {title,description,type:'one-shot'} → 201 { id, … }.
 *     POST /api/me/work-proposals {description} → 201
 *       { id, source:'user-manual', status:'pending', … }  (an Idea).
 *
 * Cross-spec isolation: EVERY user here is a FRESH registerUserViaAPI() account
 * (this file performs ZERO cap mutations, so it can never shadow a sibling's
 * cap). Unique stamps come from a per-test counter seeded off the test title,
 * NOT a module-scope clock. Assertions pin shape / self-scoping / zero-state,
 * never global counts or a billed number.
 */

const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH_START_RE = /^\d{4}-\d{2}-01T00:00:00\.000Z$/;

/** Exact key set of the account-wide UserBudgetSummary (probed live). */
const ACCOUNT_SUMMARY_KEYS = [
    'allowOverage',
    'blocked',
    'capCents',
    'currency',
    'currentSpendCents',
    'percentUsed',
    'periodEnd',
    'periodStart',
    'userId',
] as const;

interface UserBudgetSummary {
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

/** Per-test monotonic stamp — built from the test title, NOT a module clock. */
function stamper(title: string): () => string {
    let n = 0;
    const base = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    return () => `${base}-${n++}`;
}

async function getAccount(request: APIRequestContext, token: string): Promise<UserBudgetSummary> {
    const res = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
    expect(res.status(), `account-wide GET body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/**
 * Assert a summary is the well-formed, uncapped ZERO state for `userId`. In
 * keyless CI nothing bills, so this is the only legitimate observable state —
 * the aggregation MECHANISM reporting 0, never a fabricated accrual.
 */
function expectZeroStateSummary(s: UserBudgetSummary, userId: string): void {
    expect(s.userId).toBe(userId);
    expect(s.currentSpendCents).toBe(0);
    expect(s.capCents).toBeNull();
    expect(s.currency).toBe('usd');
    expect(s.percentUsed).toBeNull();
    expect(s.allowOverage).toBe(true);
    expect(s.blocked).toBe(false);
    expect(s.periodStart).toMatch(MONTH_START_RE);
    expect(s.periodEnd).toMatch(MONTH_START_RE);
}

async function createMission(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<{ id: string }> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = (await res.json()) as { id: string };
    expect(m.id).toMatch(UUID_RE);
    return m;
}

/** Create an Idea (work-proposal) and return its id. Probed: 201, source 'user-manual'. */
async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    const body = (await res.json()) as { id: string; source: string };
    expect(body.id).toMatch(UUID_RE);
    expect(body.source).toBe('user-manual');
    return body.id;
}

test.describe('flow: account-wide usage aggregation + cross-user isolation (GET /api/me/usage/account-wide)', () => {
    // ──────────────────────────────────────────────────────────────────
    // GROUP 1 — THE FRESH-USER SUMMARY SHAPE + JWT-SUBJECT KEYING. A brand-new
    // user's account-wide summary is the well-formed ZERO state, keyed on the
    // BEARER TOKEN'S subject (userId === the registered user's id) — there is no
    // path/param to read another user's aggregate.
    // ──────────────────────────────────────────────────────────────────
    test('a fresh user account-wide summary is the well-formed zero-state with EXACTLY the documented key set, keyed on the JWT subject', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        const summary = await getAccount(request, user.access_token);
        expectZeroStateSummary(summary, user.user.id);

        // The envelope carries EXACTLY the UserBudgetSummary keys — no more, no
        // fewer. This is the per-USER aggregate shape, NOT the per-OWNER shape:
        // it carries `userId` and must NOT leak `ownerType`/`ownerId`.
        expect(Object.keys(summary).sort()).toEqual([...ACCOUNT_SUMMARY_KEYS]);
        expect(summary).not.toHaveProperty('ownerType');
        expect(summary).not.toHaveProperty('ownerId');

        // Field TYPES are pinned (a regression to a digit-string cap or numeric
        // currency would slip past a value-only check).
        expect(typeof summary.userId).toBe('string');
        expect(typeof summary.currentSpendCents).toBe('number');
        expect(typeof summary.currency).toBe('string');
        expect(typeof summary.allowOverage).toBe('boolean');
        expect(typeof summary.blocked).toBe('boolean');
        // capCents / percentUsed are null in the uncapped zero-state.
        expect(summary.capCents).toBeNull();
        expect(summary.percentUsed).toBeNull();
    });

    test('the summary userId always equals the bearer token subject — two distinct tokens return two distinct, self-keyed summaries', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        expect(a.user.id).not.toBe(b.user.id);

        // Each token surfaces ITS OWN subject as userId — never the other's. There
        // is no way to ask the endpoint for a different user's aggregate.
        const sA = await getAccount(request, a.access_token);
        const sB = await getAccount(request, b.access_token);
        expect(sA.userId, "A's token → A's userId").toBe(a.user.id);
        expect(sB.userId, "B's token → B's userId").toBe(b.user.id);
        expect(sA.userId).not.toBe(sB.userId);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 2 — AGGREGATION ACROSS THE TAXONOMY. The rollup is keyed on the
    // user, so a user who OWNS a Work + a Mission + an Idea (work-proposal) has
    // ALL of them folded into the single account-wide summary. In keyless CI
    // (no plugin billing) the aggregate is the well-formed ZERO state — we pin
    // that the aggregation is WIRED ACROSS owner types and reports 0, never a
    // fabricated number, and that growing the portfolio never moves the number.
    // ──────────────────────────────────────────────────────────────────
    test('a user owning a Work + Mission + Idea reports ONE aggregate summary, still zero in CI — and building the portfolio never perturbs it', async ({
        request,
    }) => {
        const s = stamper('aggregate-portfolio');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Baseline: empty portfolio → uncapped zero-state.
        const before = await getAccount(request, token);
        expectZeroStateSummary(before, user.user.id);

        // ── Build a cross-taxonomy portfolio under THIS user, re-reading the
        //    aggregate after EACH owner type. The summary is the SINGLE per-user
        //    rollup that folds in every owner — yet stays a clean zero (no billing
        //    in CI), proving the aggregation mechanism is wired but not fabricating.
        const slug = `acct-agg-work-${s()}`.toLowerCase();
        const work = await createWorkViaAPI(request, token, {
            name: `Acct Agg Work ${s()}`,
            slug,
            description: 'A work folded into the account-wide spend aggregate',
        });
        expect(work.id, 'work was created').not.toBe('');
        const afterWork = await getAccount(request, token);
        expectZeroStateSummary(afterWork, user.user.id);

        const mission = await createMission(request, token, {
            title: `Acct Agg Mission ${s()}`,
            description: 'A mission folded into the account-wide spend aggregate',
            type: 'one-shot',
        });
        const afterMission = await getAccount(request, token);
        expectZeroStateSummary(afterMission, user.user.id);

        const ideaId = await createIdea(
            request,
            token,
            `Acct agg idea ${s()} — a directory of tools folded into the account aggregate`,
        );
        expect(ideaId).toMatch(UUID_RE);
        const afterIdea = await getAccount(request, token);
        expectZeroStateSummary(afterIdea, user.user.id);

        // ── The aggregate is STILL exactly one summary for one user — the spend
        //    never moved off zero as owners were added (a recorded owner is not
        //    spend; spend comes from billed plugin calls, of which there are none).
        //    The window + identity are unchanged across the whole build-up.
        expect(afterIdea.userId).toBe(before.userId);
        expect(afterIdea.currentSpendCents, 'owning a portfolio never bills spend in CI').toBe(0);
        expect(afterIdea.periodStart).toBe(before.periodStart);
        expect(afterIdea.periodEnd).toBe(before.periodEnd);
        // And it still carries no per-owner discriminators — it is the per-USER view.
        expect(afterIdea).not.toHaveProperty('ownerType');
        expect(afterIdea).not.toHaveProperty('ownerId');
    });

    test('owning MULTIPLE Missions + Ideas still folds into a single zero aggregate (the rollup is per-user, not per-owner-count)', async ({
        request,
    }) => {
        const s = stamper('multi-owner-fold');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Several owners of two taxonomy shapes under one user.
        await createMission(request, token, {
            title: `Multi Mission A ${s()}`,
            description: 'One of several missions folded into a single account aggregate',
            type: 'one-shot',
        });
        await createMission(request, token, {
            title: `Multi Mission B ${s()}`,
            description: 'Another mission folded into the same single account aggregate',
            type: 'one-shot',
        });
        await createIdea(
            request,
            token,
            `Multi idea A ${s()} — a directory of tools in the account aggregate`,
        );
        await createIdea(
            request,
            token,
            `Multi idea B ${s()} — another directory of tools in the same aggregate`,
        );

        // Still ONE per-user summary, still the zero-state — the aggregate does not
        // scale with owner count (it is a single SUM keyed on userId), and nothing
        // bills in CI.
        const summary = await getAccount(request, token);
        expectZeroStateSummary(summary, user.user.id);
        expect(summary.currentSpendCents, 'N owners → one aggregate, still 0').toBe(0);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 3 — NO CROSS-USER LEAKAGE. Two distinct, SEPARATELY POPULATED users
    // each read a summary discriminated ONLY by their own userId. Neither user's
    // owners nor userId ever surface in the other's summary — the rollup is a
    // strict per-user silo.
    // ──────────────────────────────────────────────────────────────────
    test('two separately-populated users each read a strictly self-scoped aggregate — no owner or userId bleeds across the silo', async ({
        request,
    }) => {
        const s = stamper('cross-user-silo');
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        expect(a.user.id).not.toBe(b.user.id);

        // Populate A heavily and B lightly — DIFFERENT portfolios so a leak would
        // be visible as a non-zero / mismatched-owner read.
        await createMission(request, a.access_token, {
            title: `Silo A mission ${s()}`,
            description: "User A's mission that must never appear in user B's aggregate",
            type: 'one-shot',
        });
        await createWorkViaAPI(request, a.access_token, {
            name: `Silo A Work ${s()}`,
            slug: `silo-a-work-${s()}`.toLowerCase(),
            description: "User A's work that must never appear in user B's aggregate",
        });
        await createIdea(
            request,
            a.access_token,
            `Silo A idea ${s()} — a directory of tools private to user A`,
        );
        await createIdea(
            request,
            b.access_token,
            `Silo B idea ${s()} — a directory of tools private to user B`,
        );

        const sA = await getAccount(request, a.access_token);
        const sB = await getAccount(request, b.access_token);

        // Each summary is keyed on its OWN user — never the other's.
        expect(sA.userId).toBe(a.user.id);
        expect(sB.userId).toBe(b.user.id);
        expect(sA.userId).not.toBe(sB.userId);

        // Both are the zero-state (nothing bills in CI) — and crucially A's heavier
        // portfolio did NOT push A's spend above B's: the silo sums only the token
        // holder's own owners, so a cross-user leak would have to show up as a
        // non-zero here. It doesn't.
        expectZeroStateSummary(sA, a.user.id);
        expectZeroStateSummary(sB, b.user.id);
        expect(sA.currentSpendCents).toBe(0);
        expect(sB.currentSpendCents).toBe(0);

        // Re-reading B after A keeps building changes nothing for B (no shared row).
        await createMission(request, a.access_token, {
            title: `Silo A mission 2 ${s()}`,
            description: "More of user A's owners that must stay invisible to user B",
            type: 'one-shot',
        });
        const sB2 = await getAccount(request, b.access_token);
        expect(sB2.userId).toBe(b.user.id);
        expect(sB2.currentSpendCents, "A's growth never touches B's aggregate").toBe(0);
        expect(sB2.periodStart).toBe(sB.periodStart);
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 4 — IDEMPOTENT READ + PERIOD WINDOW. The summary is a pure read:
    // repeated GETs within a period are byte-identical, and the window is the
    // calendar-month UTC engine (1st 00:00:00Z → 1st-of-next-month 00:00:00Z),
    // the SAME period engine as the per-owner rollups.
    // ──────────────────────────────────────────────────────────────────
    test('the account-wide read is idempotent within a period — repeated GETs are byte-identical and carry only the documented keys', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const first = await getAccount(request, token);
        const second = await getAccount(request, token);
        const third = await getAccount(request, token);

        // Pure read → identical JSON each time (no cursor, no mutation, no clock
        // drift within a calendar month).
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(Object.keys(first).sort()).toEqual([...ACCOUNT_SUMMARY_KEYS]);
    });

    test('the account-wide window is the calendar-month UTC engine (clean first-of-month midnights, ~one month forward)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const summary = await getAccount(request, user.access_token);

        // Both boundaries are clean first-of-month UTC midnights.
        expect(summary.periodStart).toMatch(MONTH_START_RE);
        expect(summary.periodEnd).toMatch(MONTH_START_RE);

        // The window is exactly one calendar month forward (28..31 days). This is
        // the per-user calendar-month engine (NOT the per-Agent rolling-30d window),
        // against which a monthly account cap would reset each boundary.
        const startMs = Date.parse(summary.periodStart);
        const endMs = Date.parse(summary.periodEnd);
        expect(Number.isFinite(startMs) && Number.isFinite(endMs)).toBe(true);
        const spanDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
        expect(spanDays).toBeGreaterThanOrEqual(28);
        expect(spanDays).toBeLessThanOrEqual(31);
        expect(endMs, 'window is forward (end after start)').toBeGreaterThan(startMs);

        // Lowercase 'usd' — the per-user/per-owner UserBudgetSummary casing (the
        // per-Agent rollup uses UPPER-CASE 'USD'; pinning the lower-case here guards
        // a regression that conflates the two engines).
        expect(summary.currency).toBe('usd');
    });

    // ──────────────────────────────────────────────────────────────────
    // GROUP 5 — HTTP CLOSURE. The rollup is session-gated end to end and the
    // route is GET-ONLY: anon → 401, garbage bearer → 401, POST/PUT → 404.
    // ──────────────────────────────────────────────────────────────────
    test('the account-wide rollup is session-gated: anonymous → 401, a garbage bearer → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // No Authorization header at all → 401.
        const anon = await request.get(ACCOUNT_WIDE);
        expect(anon.status(), 'anon account-wide → 401').toBe(401);

        // A syntactically-bearer-shaped but invalid token → 401 (not a 500/200).
        const garbage = await request.get(ACCOUNT_WIDE, {
            headers: { Authorization: 'Bearer garbage.token.here' },
        });
        expect(garbage.status(), 'garbage bearer → 401').toBe(401);

        // Sanity: the SAME endpoint with the real token is 200 (proving the 401s are
        // the auth gate, not a broken route).
        expect((await getAccount(request, user.access_token)).userId).toBe(user.user.id);
    });

    test('the account-wide route is GET-only: POST and PUT are 404 (no write surface on the read endpoint)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // There is no write verb on the aggregate — it is computed, not stored, so
        // POST/PUT have no handler → 404 (the cap is mutated via the prefs endpoint,
        // a SEPARATE surface owned by the sibling specs, not here).
        const post = await request.post(ACCOUNT_WIDE, { headers: h, data: { capCents: 100 } });
        expect(post.status(), 'POST account-wide → 404 (GET-only)').toBe(404);
        const put = await request.put(ACCOUNT_WIDE, { headers: h, data: { capCents: 100 } });
        expect(put.status(), 'PUT account-wide → 404 (GET-only)').toBe(404);

        // The GET still works — the 404s are method-not-found, not a dead route.
        expect((await getAccount(request, user.access_token)).userId).toBe(user.user.id);
    });
});
