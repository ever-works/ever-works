import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Usage tracking — complex, multi-step, cross-feature INTEGRATION flows for the
 * PluginUsageEvent read surfaces (EW-602 + Phase 7). The sibling budget specs
 * (`flow-agent-budget-enforcement`, `flow-profile-budget-alerts`,
 * `budgets.spec.ts`, `account-usage.spec.ts`, `usage-quota.spec.ts`,
 * `usage-export-pii-isolation.spec.ts`) pin the budget CAP CRUD, the over-budget
 * `blocked` gate, the alert-threshold scaffolding, the account-wide envelope's
 * zero-spend shape, and the export PII-isolation. This file covers a DIFFERENT,
 * uncovered surface: the per-Work USAGE-TRACKING controller's attribution shape
 * (perPlugin breakdown), the CSV export CONTRACT (columns / filename / headers /
 * format validation), the daily-spend TREND buckets, the cross-user ADMIN
 * aggregation, the usage controller's DISTINCT authz semantics (403-non-member
 * vs 404-not-found, unlike the budget endpoints' 404-everywhere), and the
 * usage-vs-budget RECONCILIATION across the per-Work / account-wide / per-Agent
 * read paths.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   PER-WORK USAGE  (UsageController @Controller('api/works/:workId/usage'),
 *                    AuthSessionGuard; access via UsageController.assertReadAccess:
 *                    owner OR work-member → allow; non-member → 403; missing → 404)
 *
 *     GET /api/works/:workId/usage/summary[?period=current|YYYY-MM]
 *       -> 200 {
 *            workId, periodStart(ISO 1st-of-month 00:00:00.000Z),
 *            periodEnd(ISO 1st-of-NEXT-month), periodLabel("Month YYYY"),
 *            currency:'usd' (or the global budget's currency),
 *            totalSpendCents:number,
 *            perPlugin:[ { pluginId, capability, units:number, costCents:number } ],
 *            globalBudget:{ id, monthlyCapCents, allowOverage, currency, percentUsed } | null
 *          }
 *        • perPlugin is the ATTRIBUTION breakdown — one row per (pluginId,
 *          capability), summed units + costCents, ordered costCents DESC. In CI
 *          NO plugin call is billed so perPlugin is [] and totalSpendCents is 0.
 *        • percentUsed = monthlyCapCents>0 ? round(total/cap*100) : 0 — i.e.
 *          usage IS the numerator the budget cap divides; usage and budget
 *          reconcile on the SAME summary payload.
 *        - garbage / month-13 period -> 400 'Invalid period…' / 'Invalid month…'
 *        - non-member -> 403 'User does not have access to work <id>'
 *        - missing/malformed work id -> 404 'Work <id> not found' (NO ParseUUIDPipe)
 *        - no auth -> 401
 *
 *     GET /api/works/:workId/usage/export[?period=…&format=csv]
 *       -> 200 text/csv; charset=utf-8
 *          Cache-Control: no-store
 *          Content-Disposition: attachment; filename="usage-<workId>-<YYYY-MM>.csv"
 *          body = header line + one line per event (half-open period window):
 *            occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId
 *        • The filename's YYYY-MM tracks the period (?period=2026-03 -> …-2026-03.csv).
 *        - format!=csv -> 400 "Unsupported format '<x>'. Only 'csv' is supported in V1."
 *        - non-member -> 403 ; missing -> 404 ; no auth -> 401
 *
 *     GET /api/works/:workId/usage/trend[?period=…&granularity=day]
 *       -> 200 { workId, periodStart, periodEnd, granularity:'day',
 *                buckets:[ { day:'YYYY-MM-DD', costCents } ] }
 *        • buckets are JS-side daily rollups (driver-agnostic), ascending by day.
 *          In CI buckets is [] (no billed spend).
 *        - granularity!=day -> 400 "Unsupported granularity '<x>'. Only 'day'…"
 *        - non-member -> 403 ; missing -> 404 ; no auth -> 401
 *
 *   ADMIN USAGE  (AdminUsageController @Controller('admin/usage') — NOTE: NO 'api/'
 *                 prefix, so the route is /admin/usage; /api/admin/usage is 404.
 *                 @UseGuards(IsPlatformAdminGuard) — User.isPlatformAdmin === true)
 *
 *     GET /admin/usage[?period=current|YYYY-MM]
 *       -> 200 (admins only) {
 *            periodStart, periodEnd, periodLabel, totalSpendCents,
 *            rows:[ { userId, username, email, workId, workName, units, costCents } ]
 *          }  — one row per (user, work) with non-zero spend, costCents DESC.
 *        • The GUARD runs FIRST: a non-admin gets 403 even with a malformed
 *          ?period (the period DTO never gets a chance to 400).
 *        - non-admin (any normal authed user, incl. the seeded user) -> 403
 *          'Platform admin access required'
 *        - no auth -> 401
 *        - /api/admin/usage (wrong prefix) -> 404
 *
 *   ACCOUNT-WIDE  (AccountUsageController GET /api/me/usage/account-wide) and
 *   PER-AGENT     (AgentsController GET /api/agents/:id/budget) are the OTHER two
 *                 usage roll-ups; used here ONLY for cross-surface RECONCILIATION
 *                 (their own shapes are pinned by the sibling budget specs).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • NO LLM key + NO plugin billing in CI → every spend roll-up is 0, perPlugin
 *     is [] and trend buckets are []. We therefore pin the SHAPE + the ATTRIBUTION
 *     CONTRACT + the period/authz semantics, never a non-zero billed total. The
 *     zero-state is itself a meaningful reconciliation: per-Work total ==
 *     account-wide spend == per-Agent spend == 0 across the SAME period.
 *   • The usage controller's authz is DISTINCT from the budget endpoints: a
 *     non-member gets 403 (ForbiddenException) here, whereas the per-owner /
 *     per-agent budget endpoints return 404 to hide existence. We assert the 403
 *     specifically so a regression toward 404 (or vice-versa) is caught.
 *   • CROSS-SPEC ISOLATION: every flow uses a FRESH registerUserViaAPI() user
 *     (never the shared seeded user for mutations). The admin flow uses the
 *     seeded user ONLY as a READ-ONLY "established non-admin" probe (it never
 *     mutates anything) — proving the admin route stays locked even for the
 *     long-lived account. Assertions tolerate pre-existing rows; no exact global
 *     counts.
 *   • /admin/usage has NO 'api/' prefix (verified). Build it from the API_BASE
 *     origin directly, not via the api/ helpers.
 */

const FAKE_UUID = '99999999-9999-4999-8999-999999999999';
const ADMIN_USAGE = `${API_BASE}/admin/usage`;

interface PerPluginRow {
    pluginId: string;
    capability: string;
    units: number;
    costCents: number;
}

interface UsageSummary {
    workId: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    currency: string;
    totalSpendCents: number;
    perPlugin: PerPluginRow[];
    globalBudget: {
        id: string;
        monthlyCapCents: number;
        allowOverage: boolean;
        currency: string;
        percentUsed: number;
    } | null;
}

interface UsageTrend {
    workId: string;
    periodStart: string;
    periodEnd: string;
    granularity: string;
    buckets: { day: string; costCents: number }[];
}

async function getSummary(
    request: APIRequestContext,
    token: string,
    workId: string,
    qs = '',
): Promise<UsageSummary> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/usage/summary${qs}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `summary status body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Flow: per-Work usage summary — attribution shape (perPlugin breakdown) + period contract', () => {
    test('summary exposes a well-typed totalSpend + perPlugin attribution array; window is calendar-month and tracks ?period', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-attrib-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // ── Step 1: the default (current) summary — the FULL usage-tracking shape.
        //    totalSpendCents is the period roll-up; perPlugin is the per-capability
        //    attribution breakdown (empty in CI, but must be an ARRAY, never null).
        const cur = await getSummary(request, owner.access_token, work.id);
        expect(cur.workId).toBe(work.id);
        expect(typeof cur.totalSpendCents, 'totalSpendCents is numeric').toBe('number');
        expect(cur.totalSpendCents, 'no billed plugin calls in CI → zero spend').toBe(0);
        expect(Array.isArray(cur.perPlugin), 'perPlugin is the attribution array').toBe(true);
        expect(cur.perPlugin, 'zero billed events → empty attribution').toHaveLength(0);
        expect(cur.currency, 'default currency when no budget is usd').toBe('usd');
        // No cap created yet → globalBudget null (usage exists independently of a budget).
        expect(cur.globalBudget, 'usage tracking is decoupled from a budget cap').toBeNull();

        // ── Step 2: the window is a clean calendar-month UTC pair, and the label is
        //    a human "Month YYYY". periodEnd is the 1st of the NEXT month (half-open).
        expect(cur.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
        expect(cur.periodEnd).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
        expect(typeof cur.periodLabel).toBe('string');
        expect(cur.periodLabel.length).toBeGreaterThan(0);
        expect(
            Date.parse(cur.periodEnd),
            'periodEnd is strictly after periodStart',
        ).toBeGreaterThan(Date.parse(cur.periodStart));

        // ?period=current must resolve to the EXACT same window as the default.
        const explicit = await getSummary(request, owner.access_token, work.id, '?period=current');
        expect(explicit.periodStart).toBe(cur.periodStart);
        expect(explicit.periodEnd).toBe(cur.periodEnd);
        expect(explicit.periodLabel).toBe(cur.periodLabel);

        // ── Step 3: a PAST month is a DISTINCT attribution window (usage is bucketed
        //    per period — a March query never returns the current month's roll-up).
        const past = await getSummary(request, owner.access_token, work.id, '?period=2026-03');
        expect(past.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(past.periodEnd, 'past window rolls to the 1st of the next month').toBe(
            '2026-04-01T00:00:00.000Z',
        );
        expect(past.periodLabel).toContain('2026');
        expect(past.totalSpendCents, 'each period is its own attribution bucket').toBe(0);
        expect(past.perPlugin).toHaveLength(0);
        expect(past.periodStart).not.toBe(cur.periodStart);

        // ── Step 4: malformed periods are rejected (the read endpoint validates the
        //    period grammar rather than silently falling back to current).
        const garbage = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/summary?period=not-a-period`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(garbage.status(), "garbage period → 400 (not a silent 'current')").toBe(400);
        expect(JSON.stringify(await garbage.json())).toContain('Invalid period');

        const badMonth = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/summary?period=2026-13`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(badMonth.status(), 'month 13 → 400').toBe(400);
        expect(JSON.stringify(await badMonth.json())).toContain('Invalid month');
    });
});

test.describe('Flow: per-Work usage CSV export — column contract, period-scoped filename, no-store, format gate', () => {
    test('export streams a fixed 8-column CSV with a period-scoped attachment filename + no-store; only csv is accepted', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-export-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // ── Step 1: the default export is a CSV download. The CONTRACT the
        //    spreadsheet importer depends on: text/csv content-type, no-store cache
        //    control (usage data must never be cached by a shared proxy), and an
        //    attachment disposition with a per-Work / per-period filename.
        const res = await request.get(`${API_BASE}/api/works/${work.id}/usage/export`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), `export status body=${await res.text().catch(() => '')}`).toBe(200);
        expect(res.headers()['content-type']).toContain('text/csv');
        expect(res.headers()['cache-control'], 'usage export must not be cached').toContain(
            'no-store',
        );
        const disposition = res.headers()['content-disposition'] ?? '';
        expect(disposition).toContain('attachment');
        // filename="usage-<workId>-<YYYY-MM>.csv" — current month.
        const currentSlug = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
        expect(disposition).toContain(`usage-${work.id}-${currentSlug}.csv`);

        // ── Step 2: the header row is the FIXED 8-column schema. With zero billed
        //    events in CI the body is the header alone — that header is exactly the
        //    audit-grade column set downstream tooling parses positionally.
        const body = await res.text();
        const lines = body.split('\n').filter((l) => l.length > 0);
        expect(lines.length, 'header present even with no events').toBeGreaterThanOrEqual(1);
        expect(lines[0]).toBe(
            'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId',
        );
        // No data rows in CI (no billed usage), so exactly the header line.
        expect(lines).toHaveLength(1);

        // ── Step 3: the filename tracks the ?period — a March export names the
        //    March slug, proving the export is period-scoped (the half-open window
        //    that reconciles with the summary's totals for the same month).
        const marchRes = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/export?period=2026-03`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(marchRes.status()).toBe(200);
        expect(marchRes.headers()['content-disposition'] ?? '').toContain(
            `usage-${work.id}-2026-03.csv`,
        );

        // ── Step 4: the format gate. The only supported format is csv; json (or any
        //    other token) is rejected at the controller with the exact V1 message —
        //    so a client can never accidentally pull an unsupported/unsanitised shape.
        const json = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/export?format=json`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(json.status(), "format=json → 400 (only 'csv' in V1)").toBe(400);
        expect(JSON.stringify(await json.json())).toContain('Only');

        const explicitCsv = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/export?format=csv`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(explicitCsv.status(), 'explicit format=csv → 200').toBe(200);
        expect(explicitCsv.headers()['content-type']).toContain('text/csv');

        // ── Step 5: a bad period is rejected on the export path too (same grammar
        //    as the summary), so a malformed window can't produce an off-by-month CSV.
        const badPeriod = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/export?period=2026-13`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(badPeriod.status(), 'month-13 export → 400').toBe(400);
    });
});

test.describe('Flow: per-Work usage trend — daily-spend buckets, granularity gate, contiguous period windows', () => {
    test('trend returns ascending daily buckets for the period; only day granularity is supported; past windows are contiguous + distinct', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-trend-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // ── Step 1: the default trend — daily buckets across the current month. In CI
        //    there are no billed events so buckets is empty, but the envelope (workId,
        //    period window, granularity 'day', buckets array) is the contract the
        //    dashboard sparkline binds to.
        const res = await request.get(`${API_BASE}/api/works/${work.id}/usage/trend`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), `trend status body=${await res.text().catch(() => '')}`).toBe(200);
        const trend = (await res.json()) as UsageTrend;
        expect(trend.workId).toBe(work.id);
        expect(trend.granularity, 'V1 trend is daily').toBe('day');
        expect(Array.isArray(trend.buckets)).toBe(true);
        expect(trend.buckets, 'no billed spend → no buckets').toHaveLength(0);
        expect(trend.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
        expect(trend.periodEnd).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);

        // The trend window must agree with the summary window for the same period —
        // the two read surfaces share one period engine, so a chart and a total never
        // disagree about which month they describe.
        const summary = await getSummary(request, owner.access_token, work.id);
        expect(trend.periodStart, 'trend + summary share the period window').toBe(
            summary.periodStart,
        );
        expect(trend.periodEnd).toBe(summary.periodEnd);

        // ── Step 2: the granularity gate. 'day' is explicit-OK; anything else (hour /
        //    week) is rejected — the bucketing can't be silently widened/narrowed.
        const dayOk = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/trend?granularity=day`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(dayOk.status(), 'explicit granularity=day → 200').toBe(200);
        expect((await dayOk.json()).granularity).toBe('day');

        const hour = await request.get(
            `${API_BASE}/api/works/${work.id}/usage/trend?granularity=hour`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(hour.status(), "granularity=hour → 400 (only 'day' in V1)").toBe(400);
        expect(JSON.stringify(await hour.json())).toContain('day');

        // ── Step 3: a PAST month is a distinct, contiguous trend window — the
        //    periodEnd of March is exactly the periodStart of April (no gap/overlap
        //    between the daily-bucket windows that the spend "resets" across).
        const march = (await (
            await request.get(`${API_BASE}/api/works/${work.id}/usage/trend?period=2026-03`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as UsageTrend;
        expect(march.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(march.periodEnd).toBe('2026-04-01T00:00:00.000Z');
        expect(march.periodStart, 'past trend window is distinct from the current one').not.toBe(
            trend.periodStart,
        );
        const april = (await (
            await request.get(`${API_BASE}/api/works/${work.id}/usage/trend?period=2026-04`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as UsageTrend;
        expect(april.periodStart, 'April starts exactly where March ends (contiguous)').toBe(
            march.periodEnd,
        );

        // ── Step 4: a bad period is rejected on the trend path too.
        const bad = await request.get(`${API_BASE}/api/works/${work.id}/usage/trend?period=nope`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(bad.status(), 'garbage trend period → 400').toBe(400);
    });
});

test.describe('Flow: admin cross-user usage aggregation — platform-admin guard + envelope shape', () => {
    test('/admin/usage is platform-admin-gated (403 for any normal user incl. the seeded account), 401 unauth, 404 under the wrong prefix; the guard runs before period validation', async ({
        request,
    }) => {
        // ── Step 1: a brand-new (non-admin) user is FORBIDDEN from the cross-user
        //    aggregation — the admin usage view leaks every user's spend, so it must
        //    be locked behind User.isPlatformAdmin, not mere authentication.
        const normal = await registerUserViaAPI(request);
        const forbidden = await request.get(ADMIN_USAGE, {
            headers: authedHeaders(normal.access_token),
        });
        expect(forbidden.status(), 'non-admin → 403').toBe(403);
        expect(JSON.stringify(await forbidden.json())).toContain('Platform admin access required');

        // ── Step 2: the SEEDED (long-lived, established) account is ALSO a normal
        //    user — it is NOT a platform admin, so it is likewise 403. This proves the
        //    lock isn't bypassed for a pre-existing/privileged-looking account. We use
        //    the seeded creds READ-ONLY here (no mutation), so nothing leaks to siblings.
        const seeded = loadSeededTestUser();
        const seededLogin = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(seededLogin.status(), 'seeded login ok').toBe(200);
        const seededToken = (await seededLogin.json()).access_token as string;
        expect(seededToken).toBeTruthy();
        const seededAdmin = await request.get(ADMIN_USAGE, {
            headers: authedHeaders(seededToken),
        });
        expect(seededAdmin.status(), 'established non-admin account is still 403').toBe(403);

        // ── Step 3: the GUARD short-circuits BEFORE the period DTO. A non-admin who
        //    passes a malformed ?period still gets 403, NOT the 400 the period grammar
        //    would otherwise raise — confirming auth is evaluated first (no oracle that
        //    reveals validation behaviour to an unauthorized caller).
        const guardBeforeValidation = await request.get(`${ADMIN_USAGE}?period=2026-13`, {
            headers: authedHeaders(normal.access_token),
        });
        expect(
            guardBeforeValidation.status(),
            'admin guard runs before period validation → 403, not 400',
        ).toBe(403);

        // ── Step 4: unauthenticated access is 401 (the global session guard), and the
        //    route lives at /admin/usage with NO 'api/' prefix — the 'api/'-prefixed
        //    variant 404s. Pin both so a future prefix refactor is caught.
        expect((await request.get(ADMIN_USAGE)).status(), 'unauth admin usage → 401').toBe(401);
        const wrongPrefix = await request.get(`${API_BASE}/api/admin/usage`, {
            headers: authedHeaders(normal.access_token),
        });
        expect(wrongPrefix.status(), '/api/admin/usage (wrong prefix) → 404').toBe(404);
    });
});

test.describe('Flow: usage read-access matrix — owner allowed, non-member 403, missing 404, unauth 401 across all three surfaces', () => {
    test('the SAME 403/404/401 authz contract holds uniformly for summary, export AND trend; usage uses 403-non-member (NOT 404-hidden)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `usage-authz-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        const surfaces = ['summary', 'export', 'trend'] as const;

        for (const surface of surfaces) {
            const url = `${API_BASE}/api/works/${work.id}/usage/${surface}`;

            // Owner is allowed on every surface.
            const ownerRes = await request.get(url, { headers: authedHeaders(owner.access_token) });
            expect(ownerRes.status(), `owner can read ${surface}`).toBe(200);

            // ── A non-member gets 403 (ForbiddenException), NOT 404. This is the
            //    usage controller's DELIBERATE divergence from the per-owner/per-agent
            //    BUDGET endpoints (which 404 to hide existence): a Work's existence is
            //    not a secret, but its usage is access-controlled. Pin the 403 so a
            //    regression toward either 200 (leak) or 404 (semantic drift) is caught.
            const strangerRes = await request.get(url, {
                headers: authedHeaders(stranger.access_token),
            });
            expect(strangerRes.status(), `non-member ${surface} → 403, not 404`).toBe(403);
            expect(
                JSON.stringify(await strangerRes.json()),
                `${surface} 403 names the access failure`,
            ).toContain('does not have access');

            // ── A well-formed-but-missing work id is 404 'Work … not found' — the
            //    findById gate fires before the membership check, so a non-existent
            //    Work is reported as missing (not "forbidden"), keeping the two
            //    failure modes distinct and honest.
            const missingRes = await request.get(
                `${API_BASE}/api/works/${FAKE_UUID}/usage/${surface}`,
                { headers: authedHeaders(owner.access_token) },
            );
            expect(missingRes.status(), `missing work ${surface} → 404`).toBe(404);
            expect(JSON.stringify(await missingRes.json())).toContain('not found');

            // A malformed (non-uuid) id is ALSO 404 here — the usage controller has no
            // ParseUUIDPipe, so findById simply misses and 404s (no 400).
            const malformedRes = await request.get(
                `${API_BASE}/api/works/not-a-uuid/usage/${surface}`,
                { headers: authedHeaders(owner.access_token) },
            );
            expect(
                malformedRes.status(),
                `malformed work ${surface} → 404 (no ParseUUIDPipe)`,
            ).toBe(404);

            // ── Unauthenticated is 401 on every surface (global session guard).
            const unauthRes = await request.get(url);
            expect(unauthRes.status(), `unauth ${surface} → 401`).toBe(401);
        }
    });
});

test.describe('Flow: usage ↔ budget reconciliation — per-Work total drives percentUsed; account-wide aggregates; per-Agent stays attributed', () => {
    test('the SAME usage roll-up reconciles across per-Work summary, account-wide and per-Agent reads; a Work cap makes percentUsed a function of the tracked usage', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `usage-reconcile-${Date.now()}`,
        });
        const agent = await createAgentViaAPI(request, u.access_token, {
            scope: 'tenant',
            name: `usage-reconcile-agent-${Date.now()}`,
        });
        expect(work.id).toBeTruthy();
        expect(agent.id).toBeTruthy();

        // ── Step 1: the THREE usage read surfaces all report zero spend for this
        //    fresh user — and they RECONCILE: the per-Work total, the account-wide
        //    roll-up and the per-Agent roll-up describe the same (empty) ledger.
        const summary0 = await getSummary(request, u.access_token, work.id);
        expect(summary0.totalSpendCents).toBe(0);

        const accountRes = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: authedHeaders(u.access_token),
        });
        expect(accountRes.status()).toBe(200);
        const account = await accountRes.json();
        expect(account.userId).toBe(u.user.id);
        expect(account.currentSpendCents, 'account spend reconciles with the per-Work zero').toBe(
            0,
        );

        const agentBudgetRes = await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, {
            headers: authedHeaders(u.access_token),
        });
        expect(agentBudgetRes.status()).toBe(200);
        const agentBudget = await agentBudgetRes.json();
        expect(agentBudget.currentSpendCents, 'per-Agent spend reconciles to zero too').toBe(0);

        // The account-wide + per-Work summaries share the calendar-month window
        // (same engine), so their totals are directly comparable for the period.
        expect(account.periodStart, 'account + per-Work share the calendar-month window').toBe(
            summary0.periodStart,
        );
        expect(account.periodEnd).toBe(summary0.periodEnd);

        // ── Step 2: record a Work budget cap. Usage tracking is INDEPENDENT of the
        //    cap (the summary tracked spend before any cap existed) — adding a cap
        //    simply makes the SAME tracked usage divide into a percentUsed.
        const CAP = 1000; // $10.00
        const createCap = await request.post(`${API_BASE}/api/works/${work.id}/budgets`, {
            headers: authedHeaders(u.access_token),
            data: { scope: 'global', monthlyCapCents: CAP, allowOverage: false, currency: 'usd' },
        });
        expect(
            createCap.status(),
            `create cap body=${await createCap.text().catch(() => '')}`,
        ).toBe(201);

        // ── Step 3: the cap now surfaces on the SAME usage summary, and percentUsed
        //    is the reconciliation: round(totalSpendCents / cap * 100). With the
        //    tracked usage at 0, percentUsed is 0 — usage and budget agree on the
        //    one payload (no separate ledger to drift out of sync).
        const summary1 = await getSummary(request, u.access_token, work.id);
        expect(summary1.totalSpendCents, 'usage roll-up unchanged by adding a cap').toBe(0);
        expect(summary1.globalBudget, 'cap now joined onto the usage summary').not.toBeNull();
        expect(summary1.globalBudget?.monthlyCapCents).toBe(CAP);
        expect(
            summary1.globalBudget?.percentUsed,
            'percentUsed = round(usage/cap*100) = round(0/1000*100) = 0',
        ).toBe(0);
        // The summary currency now follows the budget's currency (usd).
        expect(summary1.currency).toBe('usd');

        // ── Step 4: ATTRIBUTION isolation. The Work-scoped usage roll-up and the
        //    per-Agent roll-up are SEPARATE attribution buckets keyed on different
        //    columns (workId vs agentId) — adding the Work cap did not retroactively
        //    create or move any per-Agent usage. Both remain at zero, independently.
        const agentBudgetAfter = await (
            await request.get(`${API_BASE}/api/agents/${agent.id}/budget`, {
                headers: authedHeaders(u.access_token),
            })
        ).json();
        expect(
            agentBudgetAfter.currentSpendCents,
            'per-Agent attribution is independent of the per-Work cap/usage',
        ).toBe(0);
        expect(
            agentBudgetAfter.capCents,
            'per-agent caps not wired → null (own bucket)',
        ).toBeNull();

        // ── Step 5: the export for the SAME period is the row-level ledger behind the
        //    summary total — with zero tracked usage it is the header alone, which
        //    reconciles with totalSpendCents=0 (no data rows means no spend to sum).
        const exportRes = await request.get(`${API_BASE}/api/works/${work.id}/usage/export`, {
            headers: authedHeaders(u.access_token),
        });
        expect(exportRes.status()).toBe(200);
        const exportLines = (await exportRes.text()).split('\n').filter((l) => l.length > 0);
        expect(
            exportLines,
            'export has the header but NO data rows, reconciling with total=0',
        ).toHaveLength(1);
    });
});
