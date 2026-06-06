import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Subscription / platform-admin USAGE surface — complex, multi-step, cross-feature
 * INTEGRATION flows. The theme is the admin usage dashboard (cross-user × cross-Work
 * spend), the platform-admin gate (IsPlatformAdminGuard / User.isPlatformAdmin),
 * usage PERIOD filters, and usage EXPORT — exercised end-to-end against the LIVE API
 * and the real authenticated UI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   ADMIN USAGE  (AdminUsageController @Controller('admin/usage'), IsPlatformAdminGuard)
 *     NOTE: mounted at bare 'admin/usage' — NO `api/` prefix (unlike every sibling).
 *       GET /api/admin/usage                       -> 404  (api/-prefixed path is NOT a route)
 *       GET /admin/usage              (no auth)     -> 401  { message:'Unauthorized', statusCode:401 }
 *       GET /admin/usage              (non-admin)   -> 403  { message:'Platform admin access required',
 *                                                            error:'Forbidden', statusCode:403 }
 *     GUARD-BEFORE-PIPE ORDERING (verified): the IsPlatformAdminGuard runs BEFORE the
 *     @Query('period') validation. A non-admin hitting /admin/usage?period=garbage gets
 *     403 (NOT the 400 "Invalid period" a platform-admin would get) — the route never
 *     leaks its period-parsing contract to a non-admin. Same 403 for every period value.
 *     Response (for an admin) would be { periodStart, periodEnd, periodLabel,
 *       totalSpendCents, rows:[{ userId, username, email, workId, workName, units, costCents }] }
 *     but no e2e user is a platform admin, so the closure contract is pinned instead.
 *
 *   WORK USAGE  (UsageController @Controller('api/works/:workId/usage'), AuthSessionGuard)
 *     GET /api/works/:id/usage/summary[?period=current|YYYY-MM]
 *       -> 200 { workId, periodStart(ISO), periodEnd(ISO), periodLabel('Month YYYY'),
 *                currency:'usd', totalSpendCents:0, perPlugin:[], globalBudget:null }
 *       - period default == 'current'; an explicit 'current' === omitting it.
 *       - period=YYYY-MM   -> 200, half-open Date.UTC window [YYYY-MM-01, next-month-01)
 *       - period=garbage   -> 400 "Invalid period 'garbage'. Use 'current' or 'YYYY-MM'."
 *       - period=2026-13   -> 400 "Invalid month in period '2026-13'."
 *       - period=2026-00   -> 400 "Invalid month in period '2026-00'."
 *       - non-owner / non-member -> 403 "User does not have access to work <id>"
 *       - unknown workId   -> 404 "Work <id> not found"
 *     GET /api/works/:id/usage/trend[?granularity=day]
 *       -> 200 { workId, periodStart, periodEnd, granularity:'day', buckets:[] }
 *       - granularity=hour -> 400 "Unsupported granularity 'hour'. Only 'day' is supported in V1."
 *     GET /api/works/:id/usage/export[?period=…&format=csv]   (@Header Cache-Control:no-store)
 *       -> 200 text/csv; charset=utf-8 ;
 *          Content-Disposition: attachment; filename="usage-<workId>-<YYYY-MM>.csv"
 *            (the YYYY-MM slug ECHOES the resolved period window's start month)
 *          body begins with the header row:
 *            "occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId"
 *          (in CI no plugin calls are billed → exactly the header row, no data rows)
 *       - format=json (or anything != 'csv') -> 400 "Unsupported format 'json'. Only 'csv' is supported in V1."
 *       - non-owner export -> 403 (same access gate as summary)
 *
 *   ACCOUNT-WIDE  (AccountUsageController @Controller('api/me/usage'), AuthSessionGuard)
 *     GET /api/me/usage/account-wide
 *       -> 200 { userId, periodStart, periodEnd, currentSpendCents:0, capCents:null,
 *                currency:'usd', percentUsed:null, allowOverage:true, blocked:false }
 *       -> 401 (no auth)
 *     This is a per-USER rollup (your account only) — strictly NARROWER than the
 *     admin cross-user view. The two surfaces are independent: account-wide is open to
 *     every authed user; /admin/usage is platform-admin-only.
 *
 *   WEB UI  (apps/web .../admin/usage/page.tsx, route /admin/usage, localePrefix:'never')
 *     The page server-fetches adminUsageAPI.list() → on ANY failure it calls notFound().
 *     So a NON-admin (every e2e user) sees the Next.js not-found page — the route is
 *     invisible, never leaking "you lack admin" via a distinctive error. Anonymous hits
 *     307-redirect to /login (dashboard layout auth). i18n: dashboard.adminUsage.* —
 *     title 'Platform usage', columnWork label is 'Directory', empty 'No usage recorded…'.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • No e2e user is a platform admin (User.isPlatformAdmin defaults false; the flag is
 *     seeded via SEED_PLATFORM_ADMIN_EMAIL only). The admin 200 payload is therefore
 *     UNREACHABLE — we pin the genuine closure contract (404 api-prefix / 401 unauth /
 *     403 forbidden, guard-before-pipe) plus the UI not-found, never a fictional table.
 *   • Per-Work + account-wide usage is always ZERO in CI (no plugin calls are billed),
 *     so spend assertions pin the well-formed zero-state + the export header-only CSV.
 *   • CROSS-SPEC ISOLATION: every mutation/registration uses FRESH registerUserViaAPI()
 *     users with unique slugs (Date.now()). The SEEDED user (storageState) is used ONLY
 *     for the UI-driven not-found assertion and a read-only export it owns — never for
 *     plan/preference writes that sibling subscription specs depend on.
 *   • ANON context: a bare browser.newContext() inherits the storageState cookie, so the
 *     anonymous redirect flow uses newContext({ storageState:{cookies:[],origins:[]} }).
 *   • next-dev LOCAL vs CI route divergence on the not-found body → assert with .or().
 */

const CSV_HEADER = 'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId';

/** A YYYY-MM that is safely in the past (the export/summary window math is identical
 *  for any well-formed past month; using a fixed historical month keeps the slug stable). */
const PAST_PERIOD = '2025-01';

async function freshWork(
    request: APIRequestContext,
    prefix: string,
): Promise<{ token: string; userId: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const work = await createWorkViaAPI(request, u.access_token, {
        name: `${prefix} ${suffix}`,
        slug: `${prefix}-${suffix}`,
    });
    expect(work.id, 'created work must carry an id').toBeTruthy();
    return { token: u.access_token, userId: u.user.id, workId: work.id };
}

test.describe('Flow: platform-admin usage gating matrix (isPlatformAdmin)', () => {
    test('flow 1: the admin cross-user usage surface is a tightly-closed platform-admin route — the api/-prefixed path is not a route, unauth is 401, every authed non-admin is 403, and that 403 is stable across the full RBAC matrix', async ({
        request,
    }) => {
        // ── 1. The `api/`-prefixed path does NOT exist. Sibling usage controllers all
        //       carry `api/`, so a naive client guessing the path 404s — proving the
        //       admin controller is mounted at the bare 'admin/usage'.
        const apiPrefixed = await request.get(`${API_BASE}/api/admin/usage`);
        expect(apiPrefixed.status(), 'api/admin/usage must NOT resolve').toBe(404);

        // ── 2. The real route exists but requires authentication → 401 (the global
        //       AuthSessionGuard fires before the platform-admin guard for anon).
        const unauth = await request.get(`${API_BASE}/admin/usage`);
        expect(unauth.status(), 'admin usage requires auth').toBe(401);
        const unauthBody = await unauth.json();
        expect(unauthBody.statusCode).toBe(401);

        // ── 3. Three INDEPENDENT freshly-registered users each hit the route — every one
        //       is a non-admin, so all get an identical 403 with the platform-admin
        //       message. The 403 is user-invariant: there is no row, cap, or scope that
        //       can elevate a normal account to the cross-user view.
        for (let i = 0; i < 3; i++) {
            const u = await registerUserViaAPI(request);
            const res = await request.get(`${API_BASE}/admin/usage`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status(), `non-admin #${i} must be forbidden`).toBe(403);
            const body = await res.json();
            expect(body.statusCode).toBe(403);
            expect(body.error).toBe('Forbidden');
            expect(
                String(body.message).toLowerCase(),
                '403 message names the platform-admin requirement',
            ).toContain('platform admin');
        }

        // ── 4. The SEEDED storageState user — a long-lived, work-owning account — is ALSO
        //       a non-admin. Owning works / budgets never grants the platform-admin flag.
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.ok(), 'seeded user logs in').toBeTruthy();
        const { access_token } = await login.json();
        const seededRes = await request.get(`${API_BASE}/admin/usage`, {
            headers: authedHeaders(access_token),
        });
        expect(seededRes.status(), 'the seeded work-owner is still NOT a platform admin').toBe(403);
    });

    test("flow 2: the platform-admin guard runs BEFORE the period-validation pipe — a non-admin can never probe the admin route's period contract (every period value, valid or garbage, returns the same 403, not a 400)", async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        // A platform admin would see: 'current'/valid YYYY-MM → 200, garbage → 400
        // "Invalid period…", 2026-13 → 400 "Invalid month…". A NON-admin must see NONE
        // of that — the guard short-circuits with 403 before the pipe parses `period`.
        const periodInputs = [
            undefined, // default window
            'current',
            '2026-03', // valid past/explicit month
            'garbage', // would be 400 for an admin
            '2026-13', // would be 400 (invalid month) for an admin
            '2026-00', // would be 400 (invalid month) for an admin
            '99999-99', // wildly malformed
        ];

        for (const period of periodInputs) {
            const url =
                period === undefined
                    ? `${API_BASE}/admin/usage`
                    : `${API_BASE}/admin/usage?period=${encodeURIComponent(period)}`;
            const res = await request.get(url, { headers });
            expect(
                res.status(),
                `period=${String(period)} must 403 (guard before pipe), never 400/200`,
            ).toBe(403);
            const body = await res.json();
            // Crucially the body is the ADMIN-GATE message, NOT a period-validation error.
            expect(String(body.message).toLowerCase()).toContain('platform admin');
            expect(String(body.message).toLowerCase()).not.toContain('invalid period');
            expect(String(body.message).toLowerCase()).not.toContain('invalid month');
        }
    });
});

test.describe('Flow: usage period filters & windowing (the admin route shares this parser)', () => {
    test('flow 3: the per-Work usage period parser is a strict, half-open Date.UTC window — current==omitted, YYYY-MM maps to [month-01, next-01), and malformed/out-of-range periods 400 with the exact same contract the admin route enforces behind its guard', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request, 'period-work');
        const headers = authedHeaders(token);
        const summary = (period?: string) =>
            request.get(
                `${API_BASE}/api/works/${workId}/usage/summary${
                    period ? `?period=${encodeURIComponent(period)}` : ''
                }`,
                { headers },
            );

        // ── 1. Omitting period === explicit 'current'. Both produce the SAME window.
        const defRes = await summary();
        const curRes = await summary('current');
        expect(defRes.status()).toBe(200);
        expect(curRes.status()).toBe(200);
        const def = await defRes.json();
        const cur = await curRes.json();
        expect(def.periodStart).toBe(cur.periodStart);
        expect(def.periodEnd).toBe(cur.periodEnd);
        // The current window is exactly one calendar month wide, half-open, UTC-aligned.
        expect(def.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
        expect(def.periodEnd).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
        expect(new Date(def.periodEnd).getTime()).toBeGreaterThan(
            new Date(def.periodStart).getTime(),
        );
        expect(typeof def.periodLabel).toBe('string'); // e.g. "June 2026"
        expect(def.currency).toBe('usd');
        expect(def.totalSpendCents).toBe(0);
        expect(def.perPlugin).toEqual([]);

        // ── 2. A specific YYYY-MM maps to the documented half-open Date.UTC window.
        const marRes = await summary('2026-03');
        expect(marRes.status()).toBe(200);
        const mar = await marRes.json();
        expect(mar.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(mar.periodEnd).toBe('2026-04-01T00:00:00.000Z');
        expect(mar.periodLabel).toBe('March 2026');

        // ── 3. December rolls the year boundary to next-Jan (the same arithmetic the
        //       admin controller's resolvePeriodWindow uses).
        const decRes = await summary('2026-12');
        expect(decRes.status()).toBe(200);
        const dec = await decRes.json();
        expect(dec.periodStart).toBe('2026-12-01T00:00:00.000Z');
        expect(dec.periodEnd).toBe('2027-01-01T00:00:00.000Z');

        // ── 4. Malformed + out-of-range periods 400 with the documented messages.
        const garbage = await summary('garbage');
        expect(garbage.status()).toBe(400);
        expect(String((await garbage.json()).message)).toContain("Invalid period 'garbage'");

        const month13 = await summary('2026-13');
        expect(month13.status()).toBe(400);
        expect(String((await month13.json()).message)).toContain(
            "Invalid month in period '2026-13'",
        );

        const month00 = await summary('2026-00');
        expect(month00.status()).toBe(400);
        expect(String((await month00.json()).message)).toContain(
            "Invalid month in period '2026-00'",
        );

        // ── 5. The trend surface shares the same window + adds a granularity gate.
        const trend = await request.get(
            `${API_BASE}/api/works/${workId}/usage/trend?period=2026-03`,
            {
                headers,
            },
        );
        expect(trend.status()).toBe(200);
        const tBody = await trend.json();
        expect(tBody.granularity).toBe('day');
        expect(tBody.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(Array.isArray(tBody.buckets)).toBe(true);
        const badGran = await request.get(
            `${API_BASE}/api/works/${workId}/usage/trend?granularity=hour`,
            { headers },
        );
        expect(badGran.status()).toBe(400);
        expect(String((await badGran.json()).message)).toContain("Unsupported granularity 'hour'");
    });
});

test.describe('Flow: usage export (CSV) — contract, period slug & format gating', () => {
    test('flow 4: a usage export is a well-formed, no-store CSV download whose filename slug ECHOES the resolved period window, whose only supported format is csv, and whose header row is the stable schema contract', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request, 'export-work');
        const headers = authedHeaders(token);

        // ── 1. Default (current) period export — header-only CSV in CI (no billed calls).
        const cur = await request.get(`${API_BASE}/api/works/${workId}/usage/export`, { headers });
        expect(cur.status()).toBe(200);
        expect(cur.headers()['content-type']).toContain('text/csv');
        expect(cur.headers()['content-type']).toContain('charset=utf-8');
        // Sensitive financial export must never be cached by intermediaries.
        expect(cur.headers()['cache-control']).toContain('no-store');
        const curDisp = cur.headers()['content-disposition'] ?? '';
        expect(curDisp).toContain('attachment');
        // filename slug = usage-<workId>-<currentMonth YYYY-MM>.csv
        const curSlug = /filename="usage-([^"]+)\.csv"/.exec(curDisp)?.[1] ?? '';
        expect(curSlug.startsWith(workId), 'filename embeds the workId').toBe(true);
        expect(curSlug).toMatch(new RegExp(`^${workId}-\\d{4}-\\d{2}$`));
        const curBody = await cur.text();
        expect(curBody.split('\n')[0], 'first line is the exact schema header').toBe(CSV_HEADER);

        // ── 2. A PAST period export — the filename slug must echo that exact month,
        //       proving the slug is derived from the resolved window, not "today".
        const past = await request.get(
            `${API_BASE}/api/works/${workId}/usage/export?period=${PAST_PERIOD}`,
            { headers },
        );
        expect(past.status()).toBe(200);
        const pastDisp = past.headers()['content-disposition'] ?? '';
        expect(pastDisp, `slug must echo period ${PAST_PERIOD}`).toContain(
            `usage-${workId}-${PAST_PERIOD}.csv`,
        );
        expect((await past.text()).split('\n')[0]).toBe(CSV_HEADER);

        // ── 3. format=csv is the explicit happy path; ANY other format 400s with the
        //       documented single-format message (json / xlsx / xml all rejected).
        const csvExplicit = await request.get(
            `${API_BASE}/api/works/${workId}/usage/export?format=csv`,
            { headers },
        );
        expect(csvExplicit.status()).toBe(200);

        for (const bad of ['json', 'xlsx', 'xml', 'pdf']) {
            const res = await request.get(
                `${API_BASE}/api/works/${workId}/usage/export?format=${bad}`,
                { headers },
            );
            expect(res.status(), `format=${bad} must be rejected`).toBe(400);
            expect(String((await res.json()).message)).toContain(`Unsupported format '${bad}'`);
        }

        // ── 4. A garbage PERIOD on the export path is validated by the SAME parser as
        //       summary → 400, never a malformed download.
        const badPeriod = await request.get(
            `${API_BASE}/api/works/${workId}/usage/export?period=nope`,
            { headers },
        );
        expect(badPeriod.status()).toBe(400);
        expect(String((await badPeriod.json()).message)).toContain("Invalid period 'nope'");
    });
});

test.describe('Flow: cross-user usage isolation (admin-gated vs owner-scoped)', () => {
    test("flow 5: cross-user usage is impossible without the platform-admin flag — Bob cannot read OR export Alice's per-Work usage (403), the admin aggregate that WOULD surface it is 403 for both, and each user's account-wide rollup is strictly self-scoped", async ({
        request,
    }) => {
        // Alice owns a work; Bob is an unrelated, non-member account.
        const alice = await freshWork(request, 'iso-alice');
        const bob = await registerUserViaAPI(request);
        const bobHeaders = authedHeaders(bob.access_token);

        // ── 1. Bob cannot read Alice's per-Work usage summary (owner/member gate → 403).
        const bobSummary = await request.get(
            `${API_BASE}/api/works/${alice.workId}/usage/summary`,
            { headers: bobHeaders },
        );
        expect(bobSummary.status(), 'non-member summary is forbidden').toBe(403);
        expect(String((await bobSummary.json()).message)).toContain('does not have access');

        // ── 2. Bob cannot EXPORT Alice's usage either — same access gate on the CSV path.
        const bobExport = await request.get(`${API_BASE}/api/works/${alice.workId}/usage/export`, {
            headers: bobHeaders,
        });
        expect(bobExport.status(), 'non-member export is forbidden').toBe(403);
        // And it does NOT leak a CSV body to the unauthorized caller.
        expect(bobExport.headers()['content-type'] ?? '').not.toContain('text/csv');

        // ── 3. Bob cannot read Alice's trend either.
        const bobTrend = await request.get(`${API_BASE}/api/works/${alice.workId}/usage/trend`, {
            headers: bobHeaders,
        });
        expect(bobTrend.status()).toBe(403);

        // ── 4. The ONE surface that would aggregate Alice+Bob spend together is the
        //       admin route — and it is 403 for BOTH of them (neither is a platform admin).
        const aliceAdmin = await request.get(`${API_BASE}/admin/usage`, {
            headers: authedHeaders(alice.token),
        });
        const bobAdmin = await request.get(`${API_BASE}/admin/usage`, { headers: bobHeaders });
        expect(aliceAdmin.status()).toBe(403);
        expect(bobAdmin.status()).toBe(403);

        // ── 5. Each user's account-wide rollup is strictly SELF-scoped: the returned
        //       userId is always the caller's own id, never the other party's.
        const aliceAcct = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: authedHeaders(alice.token),
        });
        const bobAcct = await request.get(`${API_BASE}/api/me/usage/account-wide`, {
            headers: bobHeaders,
        });
        expect(aliceAcct.status()).toBe(200);
        expect(bobAcct.status()).toBe(200);
        const aBody = await aliceAcct.json();
        const bBody = await bobAcct.json();
        expect(aBody.userId).toBe(alice.userId);
        expect(bBody.userId).toBe(bob.user.id);
        expect(aBody.userId).not.toBe(bBody.userId);
        // Self-scoped rollups are the documented zero/no-cap state for fresh accounts.
        expect(aBody.currentSpendCents).toBe(0);
        expect(bBody.currentSpendCents).toBe(0);
        expect(aBody.capCents).toBeNull();
        expect(aBody.blocked).toBe(false);

        // ── 6. Reading usage for an entirely unknown work is a 404 (not a 403) — the
        //       access check is reached only after the work is found to exist.
        const ghost = await request.get(
            `${API_BASE}/api/works/00000000-0000-0000-0000-000000000000/usage/summary`,
            { headers: authedHeaders(alice.token) },
        );
        expect(ghost.status()).toBe(404);
        expect(String((await ghost.json()).message).toLowerCase()).toContain('not found');
    });
});

test.describe('Flow: admin usage dashboard UI gating (non-admin → not-found)', () => {
    test('flow 6: the /admin/usage dashboard page is INVISIBLE to non-admins and anonymous visitors — the seeded (non-admin) user renders the not-found page rather than the cross-user table, and an anonymous visitor is bounced to /login — proving the UI never leaks the admin surface', async ({
        page,
        browser,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';

        // ── 1. The SEEDED user is authenticated (storageState) but is NOT a platform
        //       admin → the server component's adminUsageAPI.list() throws (403) and the
        //       page calls notFound(). We must NOT see the cross-user table chrome.
        await page.goto(`${origin}/admin/usage`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});

        // The admin table headers / title must never render for a non-admin. (Both the
        // 'Platform usage' title and the 'Directory'/'User' column labels are absent.)
        await expect(
            page.getByRole('heading', { name: /platform usage/i }),
            'admin title must not render for a non-admin',
        ).toHaveCount(0);
        await expect(
            page.getByRole('columnheader', { name: /^Directory$/ }),
            'admin table must not render for a non-admin',
        ).toHaveCount(0);

        // Instead the not-found surface is shown. next-dev renders different not-found
        // bodies LOCAL vs CI, so accept either the framework 404 copy or a generic
        // "not found" marker — branch on whichever resolves.
        const notFound = page
            .getByText(/page (could not be|not) found/i)
            .or(page.getByText(/^404$/))
            .or(page.getByRole('heading', { name: /not found/i }))
            .first();
        await expect(notFound, 'non-admin sees the not-found page').toBeVisible({ timeout: 20000 });

        // ── 2. An ANONYMOUS visitor (a fresh context with NO inherited storageState
        //       cookie) is bounced by the dashboard auth layer toward /login — the
        //       admin route never even attempts to render its (forbidden) data.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonPage = await anon.newPage();
        try {
            await anonPage.goto(`${origin}/admin/usage`, { waitUntil: 'domcontentloaded' });
            await anonPage.waitForLoadState('networkidle').catch(() => {});
            // Either the URL lands on /login (the 307 target) OR a login affordance is on
            // screen — both prove the admin surface is gated for anonymous users. We also
            // confirm the admin table is still absent.
            const onLogin = /\/login(\b|\/|\?|$)/.test(anonPage.url());
            const loginAffordance = anonPage
                .getByRole('button', { name: /sign in|log in|continue/i })
                .or(anonPage.getByRole('textbox', { name: /email/i }))
                .or(anonPage.getByText(/page (could not be|not) found/i))
                .first();
            if (!onLogin) {
                await expect(
                    loginAffordance,
                    'anonymous visitor is gated (login or not-found), never the admin table',
                ).toBeVisible({ timeout: 20000 });
            }
            await expect(
                anonPage.getByRole('heading', { name: /platform usage/i }),
                'anon must never see the admin usage title',
            ).toHaveCount(0);
        } finally {
            await anon.close();
        }
    });
});
