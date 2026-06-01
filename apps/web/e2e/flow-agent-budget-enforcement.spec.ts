import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent budget enforcement — complex, multi-step, cross-feature INTEGRATION
 * flows for the THREE distinct budget surfaces of the Ever Works platform, with
 * a focus on the pieces the sibling `flow-subscriptions-budgets.spec.ts` and
 * `budgets.spec.ts` do NOT cover: the PER-AGENT rolling-window rollup, the
 * polymorphic PER-OWNER (Mission/Idea) summary, period-boundary "reset"
 * semantics, the over-budget `blocked` gate as the de-facto canSpend signal,
 * and the strict ISOLATION + INDEPENDENCE of all three layers.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING.
 * The three budget read surfaces have DELIBERATELY DIFFERENT shapes/windows:
 *
 *   1. PER-AGENT  (AgentsController @Controller('api/agents'), AuthSessionGuard)
 *      GET /api/agents/:id/budget
 *        -> 200 { currentSpendCents:number, capCents:null, periodStart(ISO),
 *                 periodEnd(ISO), currency:'USD' }
 *        • Window is a ROLLING 30 DAYS: periodStart = now-30d, periodEnd = now
 *          — NOT calendar-month aligned, and BOTH carry a time-of-day component
 *          (e.g. "2026-05-02T08:28:16.650Z"). capCents is ALWAYS null in v1
 *          (per-agent caps not yet wired). Spend is rolled up from
 *          PluginUsageEvent rows attributed via ownerType='agent'; in CI no
 *          plugin calls are billed so currentSpendCents is always 0.
 *        • currency is UPPER-CASE 'USD' here (contrast: the owner/account
 *          summaries below use lower-case 'usd').
 *        • There is NO percentUsed / allowOverage / blocked field on this shape.
 *        - bad uuid     -> 400 'Validation failed (uuid is expected)' (ParseUUIDPipe)
 *        - foreign uuid -> 404 (service.getOne ownership gate)
 *        - stranger     -> 404
 *        - no auth      -> 401
 *
 *   2. PER-OWNER  (MissionsController GET /api/me/missions/:id/budget,
 *                  WorkProposalsController GET /api/me/work-proposals/:id/budget)
 *      -> 200 OwnerBudgetSummary {
 *            ownerType:'mission'|'idea', ownerId, periodStart(ISO), periodEnd(ISO),
 *            currentSpendCents:number, capCents:number|null, currency:'usd',
 *            percentUsed:number|null, allowOverage:boolean, blocked:boolean }
 *        • Window is CALENDAR-MONTH UTC: periodStart = 1st-of-month 00:00:00Z,
 *          periodEnd = 1st-of-next-month 00:00:00Z (no time-of-day component).
 *        • capCents reflects the owner's GLOBAL budget row; there is NO REST
 *          endpoint to SET a Mission/Idea cap in this build (the budgets CRUD is
 *          Work-scoped only), so capCents is null + allowOverage true + blocked
 *          false for every Mission/Idea here. percentUsed is null when capCents
 *          is null (no divide-by-zero).
 *        - bad uuid     -> 400 (ParseUUIDPipe)
 *        - foreign uuid -> 404 (getForUser ownership gate)
 *        - stranger     -> 404
 *        - no auth      -> 401
 *
 *   3. ACCOUNT-WIDE  (AccountUsageController GET /api/me/usage/account-wide +
 *                     WorkAgentController PUT /api/me/work-agent/preferences)
 *      GET /api/me/usage/account-wide
 *        -> 200 UserBudgetSummary { userId, periodStart, periodEnd,
 *               currentSpendCents:number, capCents:number|null, currency:'usd',
 *               percentUsed:number|null, allowOverage:boolean, blocked:boolean }
 *        • Window is CALENDAR-MONTH UTC — the SAME engine as the per-owner
 *          summary (identical periodStart/periodEnd to a Mission/Idea read in
 *          the same period). The cap lives on Work-agent prefs as
 *          accountWideMonthlyCapCents (bigint).
 *        • OVER-BUDGET / canSpend CONTRACT (BudgetService.summarizeForUser):
 *            blocked === (capCents !== null && currentSpendCents >= capCents && !allowOverage)
 *            percentUsed === capCents>0 ? spend/cap*100 : null
 *          `blocked` is the canSpend gate — the BudgetGuardService raises
 *          BudgetExceededException at the facade entry when an equivalent
 *          evaluation is blocked. We assert the gate predicate (the only
 *          deterministic way without billed plugin calls in CI).
 *      PUT /api/me/work-agent/preferences { accountWideMonthlyCapCents?:digit-string|null,
 *                                           accountWideAllowOverage?:boolean }
 *        -> 200 full prefs echoed. On the PUT echo the cap comes back as a digit
 *           STRING; on GET /preferences it is narrowed to a NUMBER. We tolerate
 *           BOTH (String()/Number() at the boundary). non-digit cap -> 400
 *           (@Matches /^\d+$/, so '-5' and 'abc' both reject).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • NO plugin billing happens in CI → every currentSpendCents is 0. The
 *     over-budget / blocked contract is therefore driven DETERMINISTICALLY by
 *     setting the account-wide cap to 0 with overage off (spend 0 >= cap 0 &&
 *     !overage → blocked). This is the documented deterministic threshold cross.
 *   • There is no historical query on /me/usage/account-wide — a `?period=` is
 *     IGNORED (always the current month). The period-RESET behaviour is therefore
 *     proven on the per-Work usage summary, which DOES accept ?period=YYYY-MM and
 *     returns a distinct calendar-month window (the mechanism by which spend rolls
 *     over / resets at each month boundary).
 *   • CROSS-SPEC ISOLATION: every mutating flow runs on FRESH registerUserViaAPI()
 *     users (never the shared seeded user) so an account-wide cap set here can't
 *     shadow sibling specs. Assertions tolerate pre-existing rows; no exact global
 *     counts.
 */

const ACCOUNT_WIDE = `${API_BASE}/api/me/usage/account-wide`;
const PREFS = `${API_BASE}/api/me/work-agent/preferences`;
const FAKE_UUID = '99999999-9999-4999-8999-999999999999';

interface OwnerBudgetSummary {
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

interface AgentBudget {
	currentSpendCents: number;
	capCents: number | null;
	periodStart: string;
	periodEnd: string;
	currency: string;
}

async function createMission(
	request: APIRequestContext,
	token: string,
	description: string,
): Promise<string> {
	const res = await request.post(`${API_BASE}/api/me/missions`, {
		headers: authedHeaders(token),
		data: { description, type: 'one-shot' },
	});
	expect(res.status(), `create mission body=${await res.text().catch(() => '')}`).toBe(201);
	return (await res.json()).id as string;
}

async function createIdea(
	request: APIRequestContext,
	token: string,
	description: string,
): Promise<string> {
	const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
		headers: authedHeaders(token),
		data: { description },
	});
	expect(res.status(), `create idea body=${await res.text().catch(() => '')}`).toBe(201);
	return (await res.json()).id as string;
}

/** Set the account-wide cap (digit-string|null) + overage flag and return the parsed echo. */
async function setAccountCap(
	request: APIRequestContext,
	token: string,
	capCents: string | null,
	allowOverage: boolean,
) {
	const res = await request.put(PREFS, {
		headers: authedHeaders(token),
		data: { accountWideMonthlyCapCents: capCents, accountWideAllowOverage: allowOverage },
	});
	expect(res.status(), `set account cap body=${await res.text().catch(() => '')}`).toBe(200);
	return res.json();
}

test.describe('Flow: per-Agent budget — rolling-30d window shape + isolation across agents', () => {
	test('two agents each report an INDEPENDENT rolling-30-day zero-spend rollup; gate is owner-only', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);

		// ── Two agents owned by the same user — the budget rollup must be keyed
		//    per-agent (ownerType='agent', ownerId=agentId), not shared.
		const a1 = await createAgentViaAPI(request, owner.access_token, {
			scope: 'tenant',
			name: `budget-agent-1-${Date.now()}`,
		});
		const a2 = await createAgentViaAPI(request, owner.access_token, {
			scope: 'tenant',
			name: `budget-agent-2-${Date.now()}`,
		});
		expect(a1.id).not.toBe(a2.id);

		// ── Step 1: the per-agent budget shape is the AGENT-specific one — a
		//    rolling-30-day window, UPPER-CASE currency, capCents always null,
		//    and NO percentUsed/allowOverage/blocked fields.
		const b1 = await request.get(`${API_BASE}/api/agents/${a1.id}/budget`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(b1.status()).toBe(200);
		const ab1 = (await b1.json()) as AgentBudget;
		expect(ab1.currentSpendCents, 'no billed plugin calls in CI → zero spend').toBe(0);
		expect(ab1.capCents, 'per-agent caps not wired in v1 → null').toBeNull();
		expect(ab1.currency, 'per-agent budget reports UPPER-CASE USD').toBe('USD');
		expect(typeof ab1.periodStart).toBe('string');
		expect(typeof ab1.periodEnd).toBe('string');
		// The agent shape deliberately omits the owner/account fields.
		expect(ab1).not.toHaveProperty('percentUsed');
		expect(ab1).not.toHaveProperty('blocked');
		expect(ab1).not.toHaveProperty('allowOverage');

		// ── Step 2: the window is ROLLING 30 DAYS — periodEnd ≈ now and
		//    periodStart ≈ now-30d (≈ 2_592_000_000 ms span), and BOTH carry a
		//    time-of-day component (i.e. NOT calendar-month aligned, which would
		//    pin both to 00:00:00.000Z). This is the structural contrast with the
		//    owner/account calendar-month summaries asserted in later flows.
		const startMs = Date.parse(ab1.periodStart);
		const endMs = Date.parse(ab1.periodEnd);
		expect(Number.isFinite(startMs) && Number.isFinite(endMs)).toBe(true);
		const spanDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
		expect(spanDays, 'rolling window spans ~30 days').toBeGreaterThan(29);
		expect(spanDays, 'rolling window spans ~30 days').toBeLessThan(31);
		expect(
			endMs,
			'periodEnd is ~now (rolling), not a future month boundary',
		).toBeLessThanOrEqual(Date.now() + 60_000);
		// At least one boundary must NOT be a clean midnight, distinguishing the
		// rolling window from the calendar-month engine.
		const bothMidnight =
			ab1.periodStart.endsWith('T00:00:00.000Z') && ab1.periodEnd.endsWith('T00:00:00.000Z');
		expect(bothMidnight, 'rolling window is not calendar-month-aligned').toBe(false);

		// ── Step 3: the SECOND agent is its own bucket — same well-formed
		//    zero-state, independently computed (isolation per agent).
		const b2 = await request.get(`${API_BASE}/api/agents/${a2.id}/budget`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(b2.status()).toBe(200);
		const ab2 = (await b2.json()) as AgentBudget;
		expect(ab2.currentSpendCents).toBe(0);
		expect(ab2.capCents).toBeNull();
		expect(ab2.currency).toBe('USD');

		// ── Step 4: cross-user isolation — a DIFFERENT user can never read this
		//    agent's spend (404, not 403 — the existence is hidden), and the
		//    standard unauth/validation closure modes hold.
		const stranger = await registerUserViaAPI(request);
		const strangerRead = await request.get(`${API_BASE}/api/agents/${a1.id}/budget`, {
			headers: authedHeaders(stranger.access_token),
		});
		expect(strangerRead.status(), 'stranger cannot introspect agent spend').toBe(404);

		const badUuid = await request.get(`${API_BASE}/api/agents/not-a-uuid/budget`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(badUuid.status(), 'malformed id → ParseUUIDPipe 400').toBe(400);

		const foreign = await request.get(`${API_BASE}/api/agents/${FAKE_UUID}/budget`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(foreign.status(), 'well-formed but non-existent agent → 404').toBe(404);

		const noAuth = await request.get(`${API_BASE}/api/agents/${a1.id}/budget`);
		expect(noAuth.status(), 'unauth → 401').toBe(401);
	});
});

test.describe('Flow: per-Owner (Mission/Idea) budget summary — OwnerBudgetSummary shape + isolation', () => {
	test('Mission + Idea each expose a calendar-month OwnerBudgetSummary; ownership-gated and per-owner independent', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);

		const missionId = await createMission(request, owner.access_token, 'budget owner mission A');
		const ideaId = await createIdea(
			request,
			owner.access_token,
			'budget owner idea A for per-owner summary',
		);

		// ── Step 1: the Mission budget is an OwnerBudgetSummary — ownerType
		//    'mission', the FULL field set (currentSpendCents/capCents/currency/
		//    percentUsed/allowOverage/blocked), lower-case 'usd', and the no-cap
		//    null-state (no REST way to set a Mission cap in this build).
		const m = await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(m.status()).toBe(200);
		const ms = (await m.json()) as OwnerBudgetSummary;
		expect(ms.ownerType).toBe('mission');
		expect(ms.ownerId).toBe(missionId);
		expect(ms.currentSpendCents).toBe(0);
		expect(ms.capCents, 'no Mission cap setter in this build → null').toBeNull();
		expect(ms.currency).toBe('usd');
		expect(ms.percentUsed, 'capCents null → percentUsed null').toBeNull();
		expect(ms.allowOverage, 'no cap → permissive default').toBe(true);
		expect(ms.blocked, 'no cap → never blocked').toBe(false);

		// ── Step 2: the Idea budget mirrors the SAME OwnerBudgetSummary shape but
		//    with ownerType 'idea' — the polymorphic owner discriminator changes,
		//    the contract does not.
		const i = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(i.status()).toBe(200);
		const is = (await i.json()) as OwnerBudgetSummary;
		expect(is.ownerType).toBe('idea');
		expect(is.ownerId).toBe(ideaId);
		expect(is.currentSpendCents).toBe(0);
		expect(is.capCents).toBeNull();
		expect(is.currency).toBe('usd');
		expect(is.blocked).toBe(false);

		// ── Step 3: the Mission and Idea windows are CALENDAR-MONTH aligned (both
		//    boundaries at 00:00:00.000Z) and IDENTICAL to each other — the shared
		//    period engine, in contrast to the rolling per-agent window above.
		expect(ms.periodStart).toMatch(/T00:00:00\.000Z$/);
		expect(ms.periodEnd).toMatch(/T00:00:00\.000Z$/);
		expect(ms.periodStart, 'Mission + Idea share the same period window').toBe(is.periodStart);
		expect(ms.periodEnd).toBe(is.periodEnd);

		// ── Step 4: ownership isolation — a stranger gets a 404 (the gate runs
		//    getForUser FIRST so foreign per-owner spend isn't introspectable),
		//    plus the malformed/foreign/unauth closure modes for both endpoints.
		const stranger = await registerUserViaAPI(request);
		expect(
			(
				await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`, {
					headers: authedHeaders(stranger.access_token),
				})
			).status(),
			'stranger Mission budget → 404',
		).toBe(404);
		expect(
			(
				await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`, {
					headers: authedHeaders(stranger.access_token),
				})
			).status(),
			'stranger Idea budget → 404',
		).toBe(404);

		expect(
			(
				await request.get(`${API_BASE}/api/me/missions/not-a-uuid/budget`, {
					headers: authedHeaders(owner.access_token),
				})
			).status(),
			'malformed Mission id → 400',
		).toBe(400);
		expect(
			(
				await request.get(`${API_BASE}/api/me/missions/${FAKE_UUID}/budget`, {
					headers: authedHeaders(owner.access_token),
				})
			).status(),
			'foreign Mission uuid → 404',
		).toBe(404);

		expect(
			(await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`)).status(),
			'unauth Mission budget → 401',
		).toBe(401);
		expect(
			(await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`)).status(),
			'unauth Idea budget → 401',
		).toBe(401);
	});

	test('two Missions owned by the same user are SEPARATE budget buckets (per-owner isolation, same ownerType)', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const m1 = await createMission(request, owner.access_token, 'isolation mission one');
		const m2 = await createMission(request, owner.access_token, 'isolation mission two');
		expect(m1).not.toBe(m2);

		const s1 = (await (
			await request.get(`${API_BASE}/api/me/missions/${m1}/budget`, {
				headers: authedHeaders(owner.access_token),
			})
		).json()) as OwnerBudgetSummary;
		const s2 = (await (
			await request.get(`${API_BASE}/api/me/missions/${m2}/budget`, {
				headers: authedHeaders(owner.access_token),
			})
		).json()) as OwnerBudgetSummary;

		// Same user, same ownerType, but the ownerId discriminator differs — each
		// Mission is its own spend rollup, never aggregated together.
		expect(s1.ownerId).toBe(m1);
		expect(s2.ownerId).toBe(m2);
		expect(s1.ownerId).not.toBe(s2.ownerId);
		expect(s1.currentSpendCents).toBe(0);
		expect(s2.currentSpendCents).toBe(0);
		// They DO share the same period window (one calendar month for everyone).
		expect(s1.periodStart).toBe(s2.periodStart);
		expect(s1.periodEnd).toBe(s2.periodEnd);
	});
});

test.describe('Flow: budget reset on period boundary — calendar-month windows on per-Work usage', () => {
	test('current vs past vs future month each return a DISTINCT period window with its own zero-spend rollup', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const work = await createWorkViaAPI(request, owner.access_token, {
			name: `budget-period-${Date.now()}`,
		});
		expect(work.id).toBeTruthy();

		const summary = (qs: string) =>
			request.get(`${API_BASE}/api/works/${work.id}/usage/summary${qs}`, {
				headers: authedHeaders(owner.access_token),
			});

		// ── Step 1: the default (current) window — calendar-month UTC, with the
		//    periodLabel "Month YYYY".
		const cur = await summary('');
		expect(cur.status()).toBe(200);
		const c = await cur.json();
		expect(c.workId).toBe(work.id);
		expect(c.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
		expect(c.periodEnd).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
		expect(typeof c.periodLabel).toBe('string');
		expect(c.totalSpendCents).toBe(0);
		// ?period=current must resolve to the exact same window as the default.
		const curExplicit = await summary('?period=current');
		expect(curExplicit.status()).toBe(200);
		const ce = await curExplicit.json();
		expect(ce.periodStart).toBe(c.periodStart);
		expect(ce.periodEnd).toBe(c.periodEnd);

		// ── Step 2: a PAST month resolves to a DIFFERENT window — the proof that
		//    spend is scoped per-period and "resets" at each month boundary: a
		//    cap/usage in March is a separate bucket from June, and querying March
		//    never returns June's rollup. (Both are zero in CI, but the WINDOW is
		//    what proves the reset mechanism.)
		const past = await summary('?period=2026-03');
		expect(past.status()).toBe(200);
		const p = await past.json();
		expect(p.periodStart).toBe('2026-03-01T00:00:00.000Z');
		expect(p.periodEnd, 'past window rolls to the first of the NEXT month').toBe(
			'2026-04-01T00:00:00.000Z',
		);
		expect(p.periodLabel).toContain('2026');
		expect(p.totalSpendCents, 'each period is its own bucket').toBe(0);
		// The past window is genuinely distinct from the current one.
		expect(p.periodStart).not.toBe(c.periodStart);

		// ── Step 3: a FUTURE month is likewise its own forward window — the engine
		//    computes boundaries arithmetically, not by clamping to "now".
		const future = await summary('?period=2026-12');
		expect(future.status()).toBe(200);
		const f = await future.json();
		expect(f.periodStart).toBe('2026-12-01T00:00:00.000Z');
		expect(f.periodEnd, 'December rolls into the next YEAR').toBe('2027-01-01T00:00:00.000Z');

		// ── Step 4: a contiguous span — the periodEnd of one month is exactly the
		//    periodStart of the next (no gap / no overlap between reset windows).
		const apr = await summary('?period=2026-04');
		expect(apr.status()).toBe(200);
		expect((await apr.json()).periodStart).toBe(p.periodEnd);

		// ── Step 5: malformed periods are rejected (the read endpoint validates
		//    the period grammar rather than silently falling back to current).
		const garbage = await summary('?period=not-a-period');
		expect(garbage.status(), "garbage period → 400 (not a silent 'current')").toBe(400);
		const badMonth = await summary('?period=2026-13');
		expect(badMonth.status(), 'month 13 → 400').toBe(400);
	});
});

test.describe('Flow: budget vs canSpend — account-wide over-budget gate (blocked) interaction', () => {
	test('cap set → under-cap allows (not blocked) → 0-cap hard-stop blocks → overage flips it to soft → clear re-opens', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);

		const readAccount = async () => {
			const res = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(u.access_token) });
			expect(res.status()).toBe(200);
			return res.json() as Promise<OwnerBudgetSummary & { userId: string }>;
		};

		// ── Step 1: a fresh account has no cap → canSpend is unconditionally open
		//    (blocked false, percentUsed null).
		const fresh = await readAccount();
		expect(fresh.userId).toBe(u.user.id);
		expect(fresh.capCents).toBeNull();
		expect(fresh.percentUsed).toBeNull();
		expect(fresh.allowOverage).toBe(true);
		expect(fresh.blocked, 'no cap → canSpend (not blocked)').toBe(false);

		// ── Step 2: set a generous positive cap with overage OFF. Spend(0) is well
		//    under cap → still allowed, and percentUsed is the 0% roll-up (cap>0).
		const echoUnder = await setAccountCap(request, u.access_token, '5000', false);
		// PUT echoes the cap as a digit-STRING; tolerate string-or-number.
		expect(String(echoUnder.accountWideMonthlyCapCents)).toBe('5000');
		expect(echoUnder.accountWideAllowOverage).toBe(false);
		const under = await readAccount();
		expect(under.capCents, 'cap narrowed to a number on the usage summary').toBe(5000);
		expect(under.currentSpendCents).toBe(0);
		expect(under.percentUsed, '0 spend / 5000 cap → 0%').toBe(0);
		expect(under.blocked, 'spend < cap → canSpend').toBe(false);

		// GET /preferences narrows the cap to a NUMBER (vs the PUT echo's string) —
		// assert tolerantly so a future serialization tweak doesn't flake the spec.
		const prefs = await request.get(PREFS, { headers: authedHeaders(u.access_token) });
		expect(prefs.status()).toBe(200);
		const prefsBody = await prefs.json();
		expect(Number(prefsBody.accountWideMonthlyCapCents)).toBe(5000);
		// The HARD budget gate (account cap) is distinct from the SOFT per-run
		// guardrail — confirm the prefs payload carries the guardrail block too,
		// proving the two budget controls coexist independently.
		expect(typeof prefsBody.guardrails).toBe('object');
		expect(prefsBody.guardrails).toHaveProperty('maxBudgetCentsPerRun');

		// ── Step 3: the deterministic over-budget HARD-STOP. With no billed plugin
		//    calls in CI, the only way to cross the threshold is a 0-cap + overage
		//    off: spend(0) >= cap(0) && !overage → blocked === true. This `blocked`
		//    flag is exactly the canSpend gate the BudgetGuardService enforces
		//    (BudgetExceededException at the facade) — here we pin the predicate.
		await setAccountCap(request, u.access_token, '0', false);
		const hard = await readAccount();
		expect(hard.capCents).toBe(0);
		expect(hard.currentSpendCents).toBe(0);
		expect(hard.allowOverage).toBe(false);
		expect(hard.percentUsed, 'cap 0 → percentUsed null (no divide-by-zero)').toBeNull();
		expect(hard.blocked, 'spend >= cap && !overage → over budget / canSpend=false').toBe(true);

		// ── Step 4: flip overage ON with the SAME 0-cap → the gate becomes SOFT:
		//    alerts would still fire but the call is no longer hard-stopped, so
		//    `blocked` is false again. This is the budget-vs-permission interaction:
		//    the overage flag is what turns a hit cap from a hard stop into a warn.
		await setAccountCap(request, u.access_token, '0', true);
		const soft = await readAccount();
		expect(soft.capCents).toBe(0);
		expect(soft.allowOverage).toBe(true);
		expect(soft.blocked, 'overage allowed → soft cap, canSpend stays true').toBe(false);

		// ── Step 5: a non-digit cap is rejected at the DTO (@Matches /^\d+$/), so a
		//    negative or alphabetic cap can never sneak past into the gate math.
		const negative = await request.put(PREFS, {
			headers: authedHeaders(u.access_token),
			data: { accountWideMonthlyCapCents: '-5' },
		});
		expect(negative.status(), 'negative cap rejected by /^\\d+$/').toBe(400);
		const alpha = await request.put(PREFS, {
			headers: authedHeaders(u.access_token),
			data: { accountWideMonthlyCapCents: 'lots' },
		});
		expect(alpha.status(), 'alphabetic cap rejected').toBe(400);

		// ── Step 6: clearing the cap (null) returns the account to the open gate.
		const cleared = await setAccountCap(request, u.access_token, null, true);
		expect(cleared.accountWideMonthlyCapCents).toBeNull();
		const open = await readAccount();
		expect(open.capCents, 'cleared cap → null').toBeNull();
		expect(open.blocked, 'no cap → canSpend re-opened').toBe(false);

		// Unauth account-wide read is rejected.
		expect((await request.get(ACCOUNT_WIDE)).status()).toBe(401);
	});

	test('a large bigint cap survives the round-trip and keeps the gate open at zero spend', async ({
		request,
	}) => {
		// The cap is stored as a bigint so power-user caps survive; verify a value
		// past 32-bit int range round-trips and the gate math (spend < cap →
		// canSpend) still holds with percentUsed ~0.
		const u = await registerUserViaAPI(request);
		const echo = await setAccountCap(request, u.access_token, '999999999999', false);
		expect(String(echo.accountWideMonthlyCapCents)).toBe('999999999999');

		const res = await request.get(ACCOUNT_WIDE, { headers: authedHeaders(u.access_token) });
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.capCents, 'huge bigint cap narrowed to a finite number').toBe(999999999999);
		expect(body.currentSpendCents).toBe(0);
		expect(body.percentUsed, '0 / huge cap → 0%').toBe(0);
		expect(body.blocked, 'far under a huge cap → canSpend').toBe(false);
	});
});

test.describe('Flow: cross-layer budget independence — account cap does NOT cascade to owner/agent budgets', () => {
	test('setting an account-wide cap leaves per-Mission, per-Idea AND per-Agent budgets untouched (three isolated layers)', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);

		// Build one owner of each non-Work kind plus an Agent, all owned by `u`.
		const missionId = await createMission(request, u.access_token, 'cross-layer mission');
		const ideaId = await createIdea(request, u.access_token, 'cross-layer idea for independence');
		const agent = await createAgentViaAPI(request, u.access_token, {
			scope: 'tenant',
			name: `cross-layer-agent-${Date.now()}`,
		});

		// ── Step 1: snapshot the per-owner + per-agent budgets BEFORE any cap.
		const missionBefore = (await (
			await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`, {
				headers: authedHeaders(u.access_token),
			})
		).json()) as OwnerBudgetSummary;
		const ideaBefore = (await (
			await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`, {
				headers: authedHeaders(u.access_token),
			})
		).json()) as OwnerBudgetSummary;
		const agentBefore = (await (
			await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, {
				headers: authedHeaders(u.access_token),
			})
		).json()) as AgentBudget;
		expect(missionBefore.capCents).toBeNull();
		expect(ideaBefore.capCents).toBeNull();
		expect(agentBefore.capCents).toBeNull();

		// ── Step 2: set a tight, HARD account-wide cap (would block at the account
		//    layer). The account layer aggregates across everything the user owns,
		//    but the per-owner / per-agent caps are SEPARATE rows / columns.
		await setAccountCap(request, u.access_token, '0', false);
		const account = (await (
			await request.get(ACCOUNT_WIDE, { headers: authedHeaders(u.access_token) })
		).json()) as OwnerBudgetSummary;
		expect(account.capCents, 'account-wide cap is now 0').toBe(0);
		expect(account.blocked, 'account layer is blocked by the 0-cap').toBe(true);

		// ── Step 3: the per-owner + per-agent budgets are UNCHANGED — the
		//    account-wide cap does NOT cascade down. capCents stays null and the
		//    owner summaries stay un-blocked: budget isolation across the three
		//    layers (account / owner / agent) is real, not inherited.
		const missionAfter = (await (
			await request.get(`${API_BASE}/api/me/missions/${missionId}/budget`, {
				headers: authedHeaders(u.access_token),
			})
		).json()) as OwnerBudgetSummary;
		const ideaAfter = (await (
			await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`, {
				headers: authedHeaders(u.access_token),
			})
		).json()) as OwnerBudgetSummary;
		const agentAfter = (await (
			await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, {
				headers: authedHeaders(u.access_token),
			})
		).json()) as AgentBudget;

		expect(missionAfter.capCents, 'Mission cap not affected by account cap').toBeNull();
		expect(missionAfter.blocked, 'Mission not blocked by the account-wide cap').toBe(false);
		expect(ideaAfter.capCents, 'Idea cap not affected by account cap').toBeNull();
		expect(ideaAfter.blocked).toBe(false);
		expect(agentAfter.capCents, 'Agent cap not affected by account cap').toBeNull();

		// ── Step 4: the SHARED-vs-DISTINCT period engine. The account, Mission and
		//    Idea summaries all use the SAME calendar-month window; the Agent
		//    budget uses its own ROLLING window — so its periodStart differs.
		expect(account.periodStart, 'account + Mission share the calendar-month window').toBe(
			missionAfter.periodStart,
		);
		expect(missionAfter.periodStart, 'Mission + Idea share the calendar-month window').toBe(
			ideaAfter.periodStart,
		);
		expect(account.periodEnd).toBe(ideaAfter.periodEnd);
		expect(account.periodStart).toMatch(/T00:00:00\.000Z$/);
		expect(
			agentAfter.periodStart,
			'agent rolling window does NOT align with the calendar-month start',
		).not.toBe(account.periodStart);

		// Clean up the throwaway user's hard cap so nothing leaks across the run.
		await setAccountCap(request, u.access_token, null, true);
	});
});
