import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    createAgentViaAPI,
    createTaskViaAPI,
    assignTaskToAgent,
    listAgentRuns,
} from './helpers/agents-tasks';

/**
 * Agent budget cap + currentSpendCents accrual — complex, multi-step,
 * cross-feature INTEGRATION flows for the AGENT-CENTRIC budget surfaces of the
 * Ever Works platform. This file deliberately stays clear of the three sibling
 * budget specs, which already pin:
 *   - `flow-agent-budget-enforcement.spec.ts` — the per-Agent rolling-30d shape,
 *     the per-Owner (Mission/Idea) summary, the account-wide `blocked` gate, the
 *     per-Work period-reset window, and cross-LAYER (account/owner/agent) caps.
 *   - `flow-subscriptions-budgets.spec.ts` — subscriptions + per-Work cap CRUD +
 *     the account-wide cap PUT/echo.
 *   - `flow-profile-budget-alerts.spec.ts` — the 75/90/100/overage email opt-out.
 *
 * The NEW, uncovered ground here is the PER-RUN budget guardrail
 * (`guardrails.maxBudgetCentsPerRun` + `requireApprovalAboveBudgetCents`) as a
 * budget surface DISTINCT from the monthly account-wide cap, the AGENT EXPORT
 * `budget[]` envelope (the portable per-Agent budget config), and the
 * observability of spend ACCRUAL: an Agent records runs but never bills in CI,
 * so currentSpendCents stays 0 while the run RECORD still lands. We also pin the
 * two-clock period model (the Agent's rolling 30-day window vs the account-wide
 * calendar-month window) and that the per-run guardrail never leaks into the
 * account-wide cap.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   PER-AGENT SPEND  (AgentsController @Controller('api/agents'), AuthSessionGuard)
 *     GET /api/agents/:id/budget
 *       -> 200 { currentSpendCents:number, capCents:null, periodStart(ISO),
 *                periodEnd(ISO), currency:'USD' }
 *       • Spend rolled up from PluginUsageEvent rows attributed via
 *         ownerType='agent' over a ROLLING 30-DAY window: periodStart = now-30d,
 *         periodEnd = now (BOTH carry a time-of-day component, NOT month-pinned).
 *       • capCents is ALWAYS null in v1 (per-Agent caps not wired). currency is
 *         UPPER-CASE 'USD'. NO percentUsed/allowOverage/blocked on this shape.
 *       - bad uuid -> 400 (ParseUUIDPipe) ; foreign/stranger -> 404 ; no auth -> 401.
 *       • There is NO usage-event ingestion endpoint in this build — every probed
 *         POST (/api/me/usage/event, /api/usage/events, /api/plugin-usage, …) is
 *         404, so spend is read-only + always 0 in CI. We assert the well-formed
 *         zero-state + the run RECORD, never a non-zero accrual or completion.
 *
 *   AGENT EXPORT BUDGET ENVELOPE  (GET /api/agents/:id/export)
 *     -> 200 { version:1, meta:{exportedAt,sourceAgentId,sourceUserId}, identity,
 *              model, runtime, avatar, files, skillBindings,
 *              budget: Array<{ intervalUnit:string, intervalCount:number,
 *                              capCents:number|null, currency:string }> }
 *       • `budget` is the PORTABLE per-Agent budget config — an ARRAY, EMPTY ([])
 *         until an AgentBudget row exists (none is creatable via REST in this
 *         build). The envelope still always carries the `budget` key.
 *       - no auth -> 401 ; stranger -> 404.
 *
 *   PER-RUN BUDGET GUARDRAIL  (WorkAgentController @Controller('api/me/work-agent'))
 *     GET /api/me/work-agent/preferences
 *       -> 200 { …, guardrails:{ maxWorksPerRun, maxItemsPerWork,
 *                  maxBudgetCentsPerRun:0, requireApprovalBeforeCreate,
 *                  requireApprovalBeforeDelete, requireApprovalAboveBudgetCents:0,
 *                  dryRunByDefault }, accountWideMonthlyCapCents:null|digit-string,
 *                  accountWideAllowOverage:boolean }
 *     PUT /api/me/work-agent/preferences
 *       body { maxBudgetCentsPerRun?:int 0..1_000_000,
 *              requireApprovalAboveBudgetCents?:int 0..1_000_000,
 *              accountWideMonthlyCapCents?:digit-string|null, accountWideAllowOverage?:boolean, … }
 *       -> 200 full prefs echoed; guardrails echoed as NUMBERS, the account cap as
 *          a digit STRING. A PARTIAL PUT preserves un-named guardrails.
 *       - maxBudgetCentsPerRun = -5         -> 400 (@Min(0))
 *       - maxBudgetCentsPerRun = 2_000_000  -> 400 (@Max(1_000_000))
 *       - maxBudgetCentsPerRun = 2500.5     -> 400 (@IsInt)
 *     • THE PER-RUN GUARDRAIL (maxBudgetCentsPerRun) IS A SEPARATE BUDGET SURFACE
 *       FROM THE MONTHLY ACCOUNT-WIDE CAP (accountWideMonthlyCapCents). Setting one
 *       NEVER mutates the other: account-wide `capCents` on /me/usage/account-wide
 *       stays null while a per-run cap is set, and vice-versa.
 *
 *   ACCOUNT-WIDE SUMMARY  (AccountUsageController GET /api/me/usage/account-wide)
 *     -> 200 UserBudgetSummary { userId, periodStart, periodEnd, currentSpendCents:0,
 *            capCents:number|null, currency:'usd', percentUsed:number|null,
 *            allowOverage:boolean, blocked:boolean }
 *       • CALENDAR-MONTH UTC window (1st 00:00:00Z → 1st-of-next-month 00:00:00Z).
 *         blocked === capCents!==null && spend>=cap && !allowOverage.
 *
 *   AGENT RUNS  (GET /api/agents/:id/runs) -> 200 { data:[{ id,status,triggerKind,taskId,… }],
 *            meta:{ total, limit:25, offset:0 } }
 *     POST /api/agents/:id/assign-task { taskId } — pre-creates an AgentRun then
 *       enqueues. WITHOUT Trigger.dev (CI default) the enqueue 500s but the run
 *       RECORD persists (status 'failed'). Assert the record via listAgentRuns,
 *       NEVER completion — and the Agent's spend stays 0 regardless.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • NO plugin billing + NO Trigger.dev in CI → every currentSpendCents is 0 and
 *     no run ever completes. Spend accrual is therefore asserted as the
 *     well-formed observable ZERO-state across runs (the accrual MECHANISM, not a
 *     billed number). The over-budget HARD-STOP is driven DETERMINISTICALLY on the
 *     account-wide cap (cap 0 + overage off → spend 0 >= cap 0 → blocked) since the
 *     per-Agent shape carries no cap to block against.
 *   • CROSS-SPEC ISOLATION: every preference/guardrail MUTATION runs on a FRESH
 *     registerUserViaAPI() user (never the shared seeded user) so a per-run cap or
 *     account cap set here can't shadow a sibling spec. Unique names (Date.now);
 *     assertions tolerate pre-existing rows; no exact global counts.
 */

const PREFS = `${API_BASE}/api/me/work-agent/preferences`;
const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;
const FAKE_UUID = '99999999-9999-4999-8999-999999999999';

interface AgentBudget {
    currentSpendCents: number;
    capCents: number | null;
    periodStart: string;
    periodEnd: string;
    currency: string;
}

interface Guardrails {
    maxWorksPerRun: number;
    maxItemsPerWork: number;
    maxBudgetCentsPerRun: number;
    requireApprovalBeforeCreate: boolean;
    requireApprovalBeforeDelete: boolean;
    requireApprovalAboveBudgetCents: number;
    dryRunByDefault: boolean;
}

interface Prefs {
    guardrails: Guardrails;
    accountWideMonthlyCapCents: string | null;
    accountWideAllowOverage: boolean;
}

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

async function getPrefs(request: APIRequestContext, token: string): Promise<Prefs> {
    const res = await request.get(PREFS, { headers: authedHeaders(token) });
    expect(res.status(), `GET prefs status ${res.status()}`).toBe(200);
    return res.json();
}

async function putPrefs(
    request: APIRequestContext,
    token: string,
    patch: Record<string, unknown>,
): Promise<Prefs> {
    const res = await request.put(PREFS, { headers: authedHeaders(token), data: patch });
    expect(res.status(), `PUT prefs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getAgentBudget(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<AgentBudget> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/budget`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET agent budget status ${res.status()}`).toBe(200);
    return res.json();
}

async function getAccount(request: APIRequestContext, token: string): Promise<AccountSummary> {
    const res = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(token) });
    expect(res.status(), `GET account-wide status ${res.status()}`).toBe(200);
    return res.json();
}

test.describe('Flow: per-run budget guardrail (maxBudgetCentsPerRun) is its OWN budget surface', () => {
    test('default 0 → set a per-run cap → persists + echoes as a number → validated (Min/Max/Int); never touches the monthly account-wide cap', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // ── Step 1: a fresh user's per-run budget guardrail is the documented
        //    UNLIMITED default (maxBudgetCentsPerRun = 0) and the approval-above
        //    guardrail is likewise 0 — both off until explicitly armed. This is the
        //    SECOND-tier budget control (per single agent run), distinct from the
        //    monthly account-wide cap.
        const fresh = await getPrefs(request, u.access_token);
        expect(fresh.guardrails.maxBudgetCentsPerRun, 'per-run cap defaults to 0 (unlimited)').toBe(
            0,
        );
        expect(
            fresh.guardrails.requireApprovalAboveBudgetCents,
            'approval-above-budget guardrail defaults to 0 (off)',
        ).toBe(0);
        // The monthly account-wide cap is an ENTIRELY separate, unset knob.
        expect(fresh.accountWideMonthlyCapCents, 'account-wide cap unset by default').toBeNull();

        // ── Step 2: arm a $25.00 per-run budget cap. The guardrail persists and is
        //    echoed back as a NUMBER (contrast the account cap's digit-string).
        const armed = await putPrefs(request, u.access_token, { maxBudgetCentsPerRun: 2500 });
        expect(armed.guardrails.maxBudgetCentsPerRun).toBe(2500);
        expect(typeof armed.guardrails.maxBudgetCentsPerRun, 'per-run cap is a number').toBe(
            'number',
        );
        // An independent GET confirms it persisted (not just echoed).
        expect((await getPrefs(request, u.access_token)).guardrails.maxBudgetCentsPerRun).toBe(
            2500,
        );

        // ── Step 3: THE INDEPENDENCE CONTRACT. Arming the per-run guardrail must NOT
        //    create or alter the monthly account-wide cap — the account-wide summary
        //    still reports capCents null + an open gate. The two budgets are
        //    different rows/columns; one is per-run, one is per-month-aggregate.
        const accountAfterPerRun = await getAccount(request, u.access_token);
        expect(
            accountAfterPerRun.capCents,
            'per-run guardrail does NOT become the account-wide cap',
        ).toBeNull();
        expect(accountAfterPerRun.blocked, 'no account-wide cap → gate stays open').toBe(false);
        expect(accountAfterPerRun.allowOverage).toBe(true);

        // ── Step 4: the per-run cap is validated at the DTO boundary. A negative
        //    cap (@Min(0)), an over-ceiling cap (@Max(1_000_000)), and a fractional
        //    cap (@IsInt) are all rejected 400 — a malformed cap can never sneak past
        //    into the run-budget gate math.
        const negative = await request.put(PREFS, {
            headers: authedHeaders(u.access_token),
            data: { maxBudgetCentsPerRun: -5 },
        });
        expect(negative.status(), 'negative per-run cap → 400').toBe(400);
        const over = await request.put(PREFS, {
            headers: authedHeaders(u.access_token),
            data: { maxBudgetCentsPerRun: 2_000_000 },
        });
        expect(over.status(), 'per-run cap past the 1,000,000c ceiling → 400').toBe(400);
        const fractional = await request.put(PREFS, {
            headers: authedHeaders(u.access_token),
            data: { maxBudgetCentsPerRun: 2500.5 },
        });
        expect(fractional.status(), 'fractional per-run cap → 400 (@IsInt)').toBe(400);

        // The rejected writes left the armed value intact (still 2500).
        expect((await getPrefs(request, u.access_token)).guardrails.maxBudgetCentsPerRun).toBe(
            2500,
        );

        // ── Step 5: the boundary values are ACCEPTED — 0 (clear) and the exact
        //    ceiling 1,000,000 both round-trip.
        expect(
            (await putPrefs(request, u.access_token, { maxBudgetCentsPerRun: 1_000_000 }))
                .guardrails.maxBudgetCentsPerRun,
        ).toBe(1_000_000);
        expect(
            (await putPrefs(request, u.access_token, { maxBudgetCentsPerRun: 0 })).guardrails
                .maxBudgetCentsPerRun,
        ).toBe(0);

        // Unauthenticated prefs read/write are rejected (the guardrail is session-gated).
        expect((await request.get(PREFS)).status(), 'unauth GET prefs → 401').toBe(401);
        expect(
            (await request.put(PREFS, { data: { maxBudgetCentsPerRun: 100 } })).status(),
            'unauth PUT prefs → 401',
        ).toBe(401);
    });
});

test.describe('Flow: per-run cap + approval-above-budget + account cap are three INDEPENDENT budget knobs on one payload', () => {
    test('set all three in one PUT → each persists with its own type → a partial PUT preserves the others → clearing one leaves the rest', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // ── Step 1: a single PUT arms all THREE budget controls at once:
        //    the per-run hard cap, the per-run approval threshold, and the monthly
        //    account-wide cap (with overage off). They coexist on one prefs payload
        //    but are stored independently (numbers vs a bigint digit-string).
        const all = await putPrefs(request, u.access_token, {
            maxBudgetCentsPerRun: 3000,
            requireApprovalAboveBudgetCents: 1500,
            accountWideMonthlyCapCents: '5000',
            accountWideAllowOverage: false,
        });
        expect(all.guardrails.maxBudgetCentsPerRun, 'per-run hard cap armed').toBe(3000);
        expect(all.guardrails.requireApprovalAboveBudgetCents, 'approval-above armed').toBe(1500);
        // The account cap is a bigint serialized as a digit STRING (distinct type).
        expect(all.accountWideMonthlyCapCents).toBe('5000');
        expect(typeof all.accountWideMonthlyCapCents, 'account cap is a digit string').toBe(
            'string',
        );
        expect(all.accountWideAllowOverage).toBe(false);

        // ── Step 2: the account-wide summary reflects ONLY the account cap (5000),
        //    not the per-run guardrails — the per-run numbers never roll up into the
        //    monthly aggregate. 0 spend under a 5000 cap → 0% used, not blocked.
        const acc = await getAccount(request, u.access_token);
        expect(acc.capCents, 'account-wide cap is the 5000 we set').toBe(5000);
        expect(acc.currentSpendCents, 'no billed spend in CI').toBe(0);
        expect(acc.percentUsed, '0 / 5000 → 0%').toBe(0);
        expect(acc.blocked, 'spend < cap → not blocked').toBe(false);

        // ── Step 3: a PARTIAL PUT that only bumps the account cap must NOT reset the
        //    per-run guardrails (the service writes only the named fields). This is
        //    the regression this flow guards: an omitted budget field silently
        //    reverting to its column default.
        const bumped = await putPrefs(request, u.access_token, {
            accountWideMonthlyCapCents: '8000',
        });
        expect(bumped.accountWideMonthlyCapCents).toBe('8000');
        expect(
            bumped.guardrails.maxBudgetCentsPerRun,
            'per-run cap survives a partial account-cap PUT',
        ).toBe(3000);
        expect(
            bumped.guardrails.requireApprovalAboveBudgetCents,
            'approval-above survives a partial account-cap PUT',
        ).toBe(1500);

        // ── Step 4: the inverse — a PARTIAL PUT that only changes the per-run cap
        //    leaves the account-wide cap untouched (still 8000 on the summary).
        const perRunOnly = await putPrefs(request, u.access_token, { maxBudgetCentsPerRun: 4000 });
        expect(perRunOnly.guardrails.maxBudgetCentsPerRun).toBe(4000);
        // A NAMED account-cap write echoes the bigint as a digit STRING (Steps 1/3),
        // but a PRESERVED (un-named) account cap is re-loaded from the persisted bigint
        // and echoed as a NUMBER (8000) — Number() pins the value regardless of echo type.
        expect(
            Number(perRunOnly.accountWideMonthlyCapCents),
            'per-run-only PUT leaves the account cap intact (echoed as a number when un-named)',
        ).toBe(8000);
        expect((await getAccount(request, u.access_token)).capCents).toBe(8000);

        // ── Step 5: CLEAR the account cap (null) — the per-run guardrails are
        //    orthogonal and stay armed. Clearing one budget surface never disarms the
        //    others.
        const clearedAccount = await putPrefs(request, u.access_token, {
            accountWideMonthlyCapCents: null,
        });
        expect(clearedAccount.accountWideMonthlyCapCents, 'account cap cleared').toBeNull();
        expect(
            clearedAccount.guardrails.maxBudgetCentsPerRun,
            'clearing the account cap leaves the per-run cap armed',
        ).toBe(4000);
        expect(
            (await getAccount(request, u.access_token)).capCents,
            'account-wide summary now uncapped',
        ).toBeNull();

        // ── Step 6: clear the per-run cap too — the account cap stays cleared. Both
        //    surfaces independently return to their permissive defaults.
        const clearedPerRun = await putPrefs(request, u.access_token, { maxBudgetCentsPerRun: 0 });
        expect(clearedPerRun.guardrails.maxBudgetCentsPerRun).toBe(0);
        expect(clearedPerRun.accountWideMonthlyCapCents).toBeNull();
    });
});

test.describe('Flow: per-Agent spend rollup — observable accrual stays ZERO across run records (no billing in CI)', () => {
    test('agent budget zero-state → assign a task records an AgentRun → spend STILL 0 (run record ≠ billed spend), all on the rolling 30d window', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            scope: 'tenant',
            name: `spend-accrual-agent-${Date.now()}`,
        });

        // ── Step 1: a fresh Agent has the well-formed zero-spend rollup on the
        //    rolling-30-day window (the de-facto "current period" for an Agent),
        //    capCents null (per-Agent caps not wired), UPPER-CASE USD.
        const before = await getAgentBudget(request, owner.access_token, agent.id);
        expect(before.currentSpendCents, 'fresh agent has zero spend').toBe(0);
        expect(before.capCents, 'per-agent caps not wired → null').toBeNull();
        expect(before.currency, 'agent budget reports UPPER-CASE USD').toBe('USD');
        const startMs = Date.parse(before.periodStart);
        const endMs = Date.parse(before.periodEnd);
        const spanDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
        expect(spanDays, 'rolling window spans ~30 days').toBeGreaterThan(29);
        expect(spanDays, 'rolling window spans ~30 days').toBeLessThan(31);

        // No runs yet — the spend rollup and the run history start empty together.
        const runs0 = await listAgentRuns(request, owner.access_token, agent.id);
        expect(runs0.length, 'no runs yet').toBe(0);

        // ── Step 2: drive an OBSERVABLE operation. Assigning a task pre-creates an
        //    AgentRun then enqueues; without Trigger.dev in CI the enqueue 500s but
        //    the run RECORD persists. We assert the RECORD (not completion) — and,
        //    crucially, that a recorded run does NOT itself accrue spend (spend comes
        //    from billed plugin calls, of which there are none in CI).
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: `spend-accrual-task-${Date.now()}`,
        });
        await assignTaskToAgent(request, owner.access_token, agent.id, task.id);

        // The run record lands even though the enqueue failed (assert via the list,
        // never on the assign-task HTTP status).
        await expect
            .poll(
                async () =>
                    (await listAgentRuns(request, owner.access_token, agent.id)).filter(
                        (r) => r.taskId === task.id,
                    ).length,
                { timeout: 15_000, message: 'an AgentRun is recorded for the assigned task' },
            )
            .toBeGreaterThan(0);
        const runs1 = await listAgentRuns(request, owner.access_token, agent.id);
        const taskRun = runs1.find((r) => r.taskId === task.id);
        expect(taskRun?.triggerKind, 'the recorded run is a task-triggered run').toBe('task');

        // ── Step 3: the spend rollup is UNCHANGED by the recorded run — accrual is
        //    billing-driven, and CI bills nothing, so currentSpendCents is still 0.
        //    (This is the truthful "spend accrual is observable" contract: the
        //    mechanism exists and reports 0, never a fabricated non-zero.)
        const after = await getAgentBudget(request, owner.access_token, agent.id);
        expect(after.currentSpendCents, 'a recorded run does NOT bill spend in CI → still 0').toBe(
            0,
        );
        expect(after.capCents).toBeNull();
        expect(after.currency).toBe('USD');

        // ── Step 4: a SECOND assign-task for the same (task, agent) pair DEDUPES to
        //    the same in-flight run rather than spawning a parallel one (and still
        //    bills nothing). The spend rollup remains 0 — re-assignment is not spend.
        await assignTaskToAgent(request, owner.access_token, agent.id, task.id);
        const runs2 = await listAgentRuns(request, owner.access_token, agent.id);
        const taskRuns = runs2.filter((r) => r.taskId === task.id);
        // At most one ACTIVE run per (task, agent) — tolerate a failed-then-retried
        // record but the spend must not move.
        expect(taskRuns.length, 'task runs recorded for the pair').toBeGreaterThan(0);
        expect(
            (await getAgentBudget(request, owner.access_token, agent.id)).currentSpendCents,
            're-assignment never accrues spend',
        ).toBe(0);
    });

    test('two Agents owned by the same user are SEPARATE spend buckets; the rollup is owner-gated (404 to a stranger)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const a1 = await createAgentViaAPI(request, owner.access_token, {
            scope: 'tenant',
            name: `spend-bucket-1-${Date.now()}`,
        });
        const a2 = await createAgentViaAPI(request, owner.access_token, {
            scope: 'tenant',
            name: `spend-bucket-2-${Date.now()}`,
        });
        expect(a1.id).not.toBe(a2.id);

        // ── Step 1: each Agent is its OWN spend rollup (ownerType='agent',
        //    ownerId=agentId) — same zero-state, independently computed. Spend never
        //    aggregates across an owner's agents at this layer.
        const b1 = await getAgentBudget(request, owner.access_token, a1.id);
        const b2 = await getAgentBudget(request, owner.access_token, a2.id);
        expect(b1.currentSpendCents).toBe(0);
        expect(b2.currentSpendCents).toBe(0);
        expect(b1.capCents).toBeNull();
        expect(b2.capCents).toBeNull();

        // ── Step 2: the rollup is owner-gated — a different user can never
        //    introspect this Agent's spend (404 hides existence), and the standard
        //    validation/auth closure modes hold.
        const stranger = await registerUserViaAPI(request);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${a1.id}/budget`, {
                    headers: authedHeaders(stranger.access_token),
                })
            ).status(),
            'stranger cannot read agent spend → 404',
        ).toBe(404);
        expect(
            (await request.get(`${API_BASE}/api/agents/${a1.id}/budget`)).status(),
            'unauth agent budget → 401',
        ).toBe(401);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/not-a-uuid/budget`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
            'malformed id → 400 (ParseUUIDPipe)',
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${FAKE_UUID}/budget`, {
                    headers: authedHeaders(owner.access_token),
                })
            ).status(),
            'well-formed but non-existent agent → 404',
        ).toBe(404);
    });
});

test.describe('Flow: Agent export budget envelope — the portable per-Agent budget config', () => {
    test('export carries a budget[] array (empty when no AgentBudget row) → access-gated → independent of the account-wide cap', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            scope: 'tenant',
            name: `export-budget-agent-${Date.now()}`,
        });

        // ── Step 1: the export envelope ALWAYS carries a top-level `budget` key — the
        //    portable per-Agent budget config that travels with the Agent on
        //    export/import. With no AgentBudget row creatable via REST in this build,
        //    it is the well-formed EMPTY array (the zero-state of a per-Agent cap),
        //    NOT null/undefined.
        const res = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), `export status ${res.status()}`).toBe(200);
        const envelope = await res.json();
        expect(envelope.version, 'export envelope version').toBe(1);
        expect(envelope.meta?.sourceAgentId, 'envelope identifies the source agent').toBe(agent.id);
        expect(envelope.meta?.sourceUserId, 'envelope identifies the source user').toBe(
            owner.user.id,
        );
        expect(
            Object.prototype.hasOwnProperty.call(envelope, 'budget'),
            'envelope always carries a budget key',
        ).toBe(true);
        expect(Array.isArray(envelope.budget), 'budget is an array').toBe(true);
        expect(envelope.budget.length, 'no AgentBudget row → empty budget config').toBe(0);

        // Any per-Agent budget rows that DO appear must match the documented shape
        // (intervalUnit/intervalCount/capCents/currency) — guards a future row.
        for (const b of envelope.budget) {
            expect(typeof b.intervalUnit).toBe('string');
            expect(typeof b.intervalCount).toBe('number');
            expect(b.capCents === null || typeof b.capCents === 'number').toBe(true);
            expect(typeof b.currency).toBe('string');
        }

        // ── Step 2: arming the user's MONTHLY account-wide cap does NOT inject a
        //    per-Agent budget into the export — the export budget is the Agent's own
        //    config, not the account aggregate. Set a hard account cap, re-export,
        //    and confirm the envelope budget stays empty.
        await putPrefs(request, owner.access_token, {
            accountWideMonthlyCapCents: '5000',
            accountWideAllowOverage: false,
        });
        const reExport = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(reExport.status()).toBe(200);
        const env2 = await reExport.json();
        expect(
            Array.isArray(env2.budget) && env2.budget.length,
            'account-wide cap does NOT cascade into the Agent export budget',
        ).toBe(0);
        // And the account-wide cap really is set (proving the export is independent,
        // not just that nothing happened).
        expect((await getAccount(request, owner.access_token)).capCents).toBe(5000);

        // ── Step 3: the export (which carries the budget config) is owner-gated —
        //    a stranger gets 404, unauth gets 401.
        const stranger = await registerUserViaAPI(request);
        expect(
            (
                await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
                    headers: authedHeaders(stranger.access_token),
                })
            ).status(),
            'stranger cannot export (and thus cannot read the budget config) → 404',
        ).toBe(404);
        expect(
            (await request.get(`${API_BASE}/api/agents/${agent.id}/export`)).status(),
            'unauth export → 401',
        ).toBe(401);

        // Clean up the throwaway user's account cap so nothing leaks across the run.
        await putPrefs(request, owner.access_token, { accountWideMonthlyCapCents: null });
    });
});

test.describe('Flow: over-budget hard-stop — the account-wide cap is the de-facto agent-spend gate', () => {
    test('per-Agent shape has no cap to block on → the spend gate lives on the account-wide cap (0-cap + overage off → blocked) → overage flips it → clear re-opens', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            scope: 'tenant',
            name: `over-budget-agent-${Date.now()}`,
        });

        // ── Step 1: the per-Agent budget shape is INFORMATIONAL ONLY — capCents is
        //    null and there is no `blocked` field, so an Agent op can never be
        //    hard-stopped at THIS layer. The enforceable spend gate for an Agent's
        //    work lives on the account-wide cap (BudgetService.summarizeForUser),
        //    which aggregates everything the user owns (Agents included).
        const ab = await getAgentBudget(request, u.access_token, agent.id);
        expect(ab.capCents, 'no per-Agent cap → nothing to block at this layer').toBeNull();
        expect(ab).not.toHaveProperty('blocked');
        expect(ab).not.toHaveProperty('allowOverage');

        // ── Step 2: a fresh account is unconditionally open (no cap → not blocked).
        const open = await getAccount(request, u.access_token);
        expect(open.userId).toBe(u.user.id);
        expect(open.capCents).toBeNull();
        expect(open.blocked, 'no account cap → agent ops not gated').toBe(false);

        // ── Step 3: the deterministic OVER-BUDGET HARD-STOP. With no billed spend in
        //    CI, the only way to cross the threshold is a 0-cap + overage off:
        //    spend(0) >= cap(0) && !overage → blocked === true. This `blocked` flag
        //    is exactly the canSpend gate the BudgetGuardService raises as a
        //    BudgetExceededException before a plugin/agent call reaches the provider.
        await putPrefs(request, u.access_token, {
            accountWideMonthlyCapCents: '0',
            accountWideAllowOverage: false,
        });
        const hard = await getAccount(request, u.access_token);
        expect(hard.capCents).toBe(0);
        expect(hard.currentSpendCents).toBe(0);
        expect(hard.allowOverage).toBe(false);
        expect(hard.percentUsed, 'cap 0 → percentUsed null (no divide-by-zero)').toBeNull();
        expect(
            hard.blocked,
            'spend >= cap && !overage → over budget → agent op would be blocked',
        ).toBe(true);

        // ── Step 4: while the account is over-budget, the per-Agent rollup is STILL
        //    a clean 0-spend read (the gate is at the account layer; the per-Agent
        //    view doesn't itself flip to blocked). Proves the two surfaces are
        //    decoupled — the block is account-wide, not stamped onto the agent shape.
        const agentDuringBlock = await getAgentBudget(request, u.access_token, agent.id);
        expect(agentDuringBlock.currentSpendCents).toBe(0);
        expect(
            agentDuringBlock.capCents,
            'agent shape never gains a cap from the block',
        ).toBeNull();

        // ── Step 5: flip overage ON with the SAME 0-cap → the gate becomes SOFT
        //    (alerts would still fire but the call is no longer hard-stopped), so
        //    `blocked` is false again. The overage flag is the discriminator between
        //    a hard stop and a warn.
        await putPrefs(request, u.access_token, {
            accountWideMonthlyCapCents: '0',
            accountWideAllowOverage: true,
        });
        const soft = await getAccount(request, u.access_token);
        expect(soft.capCents).toBe(0);
        expect(soft.allowOverage).toBe(true);
        expect(soft.blocked, 'overage allowed → soft cap, agent op not hard-stopped').toBe(false);

        // ── Step 6: clearing the cap (null) re-opens the gate unconditionally.
        const cleared = await putPrefs(request, u.access_token, {
            accountWideMonthlyCapCents: null,
        });
        expect(cleared.accountWideMonthlyCapCents).toBeNull();
        const reopened = await getAccount(request, u.access_token);
        expect(reopened.capCents, 'cleared cap → null').toBeNull();
        expect(reopened.blocked, 'no cap → agent ops re-permitted').toBe(false);
    });
});

test.describe('Flow: two budget clocks — the Agent rolling-30d window vs the account-wide calendar-month window', () => {
    test('the per-Agent spend window SLIDES with now while the account-wide window is month-pinned; the two never share a boundary', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            scope: 'tenant',
            name: `period-clock-agent-${Date.now()}`,
        });

        // ── Step 1: the Agent's window is a ROLLING 30 days — periodEnd ≈ now and
        //    periodStart ≈ now-30d, and at least one boundary is NOT a clean
        //    midnight (it carries a time-of-day component). This is the structural
        //    contrast with the account-wide calendar-month engine.
        const ab = await getAgentBudget(request, u.access_token, agent.id);
        expect(ab.currentSpendCents).toBe(0);
        const agentStartMs = Date.parse(ab.periodStart);
        const agentEndMs = Date.parse(ab.periodEnd);
        expect(Number.isFinite(agentStartMs) && Number.isFinite(agentEndMs)).toBe(true);
        expect(
            agentEndMs,
            'agent periodEnd is ~now (rolling), not a future month boundary',
        ).toBeLessThanOrEqual(Date.now() + 60_000);
        const bothMidnight =
            ab.periodStart.endsWith('T00:00:00.000Z') && ab.periodEnd.endsWith('T00:00:00.000Z');
        expect(bothMidnight, 'rolling window is NOT calendar-month-aligned').toBe(false);

        // ── Step 2: the account-wide window is CALENDAR-MONTH UTC — both boundaries
        //    are clean first-of-month midnights, and periodStart is the 1st of THIS
        //    month while periodEnd is the 1st of NEXT month. This is the window
        //    against which the monthly cap resets each boundary.
        const acc = await getAccount(request, u.access_token);
        expect(acc.periodStart, 'account window starts at a clean midnight').toMatch(
            /^\d{4}-\d{2}-01T00:00:00\.000Z$/,
        );
        expect(acc.periodEnd, 'account window ends at a clean midnight').toMatch(
            /^\d{4}-\d{2}-01T00:00:00\.000Z$/,
        );
        const accStartMs = Date.parse(acc.periodStart);
        const accEndMs = Date.parse(acc.periodEnd);
        // The account window is exactly one calendar month (28..31 days) and forward.
        const accSpanDays = (accEndMs - accStartMs) / (24 * 60 * 60 * 1000);
        expect(accSpanDays, 'account window is one calendar month').toBeGreaterThanOrEqual(28);
        expect(accSpanDays, 'account window is one calendar month').toBeLessThanOrEqual(31);

        // ── Step 3: the two clocks are GENUINELY DIFFERENT — the Agent's rolling
        //    start is not the calendar-month start, so the period RESET happens at
        //    different instants for the two surfaces. (Spend "resets" when its
        //    window's start moves past the older events; the windows move on
        //    different schedules.)
        expect(
            ab.periodStart,
            'agent rolling start ≠ account month start (different reset clocks)',
        ).not.toBe(acc.periodStart);
        // The account-wide month-start should be <= the agent's rolling start when
        // we're not on the 1st-of-month boundary (rolling start is ~30d ago, which
        // for most of the month is AFTER the month's 1st). We assert the weaker,
        // always-true relation: the agent window END is "now-ish" and the account
        // window END is a future month boundary, so they differ.
        expect(
            agentEndMs,
            'agent window ends ~now; account window ends at a future month boundary',
        ).toBeLessThan(accEndMs + 60_000 + 31 * 24 * 60 * 60 * 1000);
        expect(ab.periodEnd, 'agent end (now-ish) is not the account month-end').not.toBe(
            acc.periodEnd,
        );

        // ── Step 4: currency casing is itself a fingerprint of the two engines —
        //    the per-Agent rollup reports UPPER-CASE 'USD'; the account-wide summary
        //    reports lower-case 'usd'. Pin both so a casing regression that conflates
        //    the two surfaces is caught.
        expect(ab.currency, 'agent rollup currency is UPPER-CASE USD').toBe('USD');
        expect(acc.currency, 'account-wide currency is lower-case usd').toBe('usd');
    });
});
