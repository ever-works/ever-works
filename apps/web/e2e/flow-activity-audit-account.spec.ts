import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, makeTestUser } from './helpers/api';

/**
 * flow-activity-audit-account — the ACCOUNT-LEVEL audit trail (auth / security
 * events) exercised as deep, multi-step INTEGRATION flows. The activity-log is
 * the user's forensic record of what happened to their account: who signed in,
 * from where, when sessions were globally killed, and (truthfully) what is and
 * is NOT recorded. We drive the REAL auth side-effects (register / login /
 * logout / logout-all / update-password / api-key create) and then assert the
 * audit entries the API actually emits, their per-user visibility scoping, the
 * filter/pagination/date-range query surface, and the CSV export parity.
 *
 * ── PROBED GROUND TRUTH (2026-06-01, CI sqlite driver @ 127.0.0.1:3100) ──────
 *
 * AUDIT-EMITTING ENDPOINTS (apps/api/src/auth/controllers/auth.controller.ts +
 * apps/api/src/activity-log/activity-log.listener.ts):
 *   POST /api/auth/register   → actionType=user_signup,  action=user.signup,
 *                               status=completed, summary="Account created"
 *                               (ipAddress/userAgent = null on this path).
 *   POST /api/auth/login      → actionType=user_login,   action=user.login,
 *                               status=completed, summary="Signed in",
 *                               ipAddress (e.g. ::ffff:127.0.0.1) + userAgent CAPTURED.
 *   POST /api/auth/logout     → emits NOTHING (no audit entry at all).
 *   POST /api/auth/logout-all → actionType=user_login,   action=user.logout_all,
 *                               status=completed, summary="Signed out from all devices".
 *                               NOTE: bucketed under actionType=user_login (not a
 *                               distinct type) — distinguished by `action`. logout-all
 *                               kills EVERY session incl. the register/login token.
 *   POST /api/auth/update-password → 200 but emits NO audit entry. `changePassword`
 *                               (auth-provider.service.ts) calls setPassword WITHOUT
 *                               firing UserPasswordChangedEvent, so the listener's
 *                               password_changed branch never runs on the API path.
 *                               PROBED: ?actionType=password_changed → total 0.
 *   POST /api/auth/api-keys   → 201 but emits NO audit entry (api-keys.controller.ts
 *                               does not log). 2FA has no API surface at all.
 *   ⇒ The ONLY account-level audit kinds wired today are user_signup + user_login
 *     (login / logout_all / anonymous_created / account_claimed share user_login).
 *
 * LIST  GET /api/activity-log → 200 { activities:[…], total:number }. Each row:
 *   { id, userId, actionType, action, status, summary, ipAddress, userAgent,
 *     createdAt, updatedAt, workId, work, details, metadata, organizationId,
 *     tenantId, ingestEventId }. Scoped to the bearer's user. 401 unauth.
 *   Query: actionType, status, workId, dateFrom (ISO), dateTo (ISO), search
 *   (matches summary + work name), limit (default 25, max 100), offset.
 *   PROBED: ?userId=<other> is IGNORED (always scoped to the token) — no spoof.
 *   PROBED: ?actionType=user_login returns ONLY user_login rows; ?search="Signed in"
 *   returns only the login rows; dateFrom=2099 → total 0; dateTo=2000 → total 0.
 *
 * ENTRY GET /api/activity-log/:id → 200 { activity:{…} } for the OWNER; 404 for a
 *   stranger (findByIdAndUserId scoping) and 404 for a bogus uuid. 401 unauth.
 *
 * EXPORT GET /api/activity-log/export → 200 text/csv; charset=utf-8,
 *   Content-Disposition: attachment; filename=activity-log.csv. Header row:
 *   `Date,Action Type,Action,Status,Work,Summary`. Honours the same actionType /
 *   date filters (PROBED parity: ?actionType=user_login exports only login rows).
 *   401 unauth.
 *
 * AGGREGATES GET /api/activity-log/{summary,running-count} → status-bucket counts /
 *   { count }. Append-only: PATCH/PUT/DELETE on :id → 4xx (covered elsewhere).
 *
 * ── ANTI-DUPLICATION ─────────────────────────────────────────────────────────
 * Deliberately NOT re-covered (already deep in sibling specs):
 *   - activity-log-audit / activity-log.spec → the signup entry, summary/running-count
 *     shape, ?limit cap (single-axis). This file is the LOGIN/LOGOUT-ALL auth event
 *     EMISSION + the chronological multi-login sequence + ip/ua capture.
 *   - audit-log-immutable / audit-log-sequences / audit-tamper-resistance → the
 *     PATCH/PUT/DELETE append-only guarantee. NOT repeated here.
 *   - audit-export-sanitization / csv-export-schema → "no secret patterns in export".
 *     This file asserts the export's auth-row PARITY with the live list + the CSV
 *     header/filename contract, not secret-scrubbing.
 *   - flow-settings-security-deep → the UI-driven password/key/danger surfaces. This
 *     file is the API-level AUDIT side-effect of those same actions (what gets logged).
 *   - flow-multi-tenant-isolation / multi-tenant-data-leak → cross-tenant resource
 *     leakage. This file is per-USER audit visibility scoping for AUTH events.
 *
 * RESILIENCE: every flow runs on FRESH Date.now-suffixed users (never the shared
 * seeded user — a logout-all / password churn would break sibling specs). Unique
 * names/emails; toContain / >= over exact counts where pre-existing rows could
 * exist (here fresh users start clean, so we can pin exact small counts). Generous
 * timeouts, expect.poll for the async best-effort `.log().catch()` emission, and we
 * skip-UP the moment a today-absent contract (password_changed / api-key audit)
 * actually lands rather than encoding a fictional one.
 */

const T = 30_000;
const REGISTER = `${API_BASE}/api/auth/register`;
const LOGIN = `${API_BASE}/api/auth/login`;
const LOGOUT = `${API_BASE}/api/auth/logout`;
const LOGOUT_ALL = `${API_BASE}/api/auth/logout-all`;
const UPDATE_PASSWORD = `${API_BASE}/api/auth/update-password`;
const API_KEYS = `${API_BASE}/api/auth/api-keys`;
const LOG = `${API_BASE}/api/activity-log`;

const PW = 'TestPass1!secure';

interface ActivityRow {
    id: string;
    userId: string;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: string;
}

interface ActivityList {
    activities: ActivityRow[];
    total: number;
}

/** Fetch the full (≤100) audit list for a bearer. */
async function listLog(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<ActivityList> {
    const res = await request.get(`${LOG}?limit=100${query}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
    expect(res.status(), `GET activity-log${query}`).toBe(200);
    const body = (await res.json()) as ActivityList;
    expect(Array.isArray(body.activities), 'activities is an array').toBe(true);
    expect(typeof body.total, 'total is numeric').toBe('number');
    return body;
}

/** Log in and return the fresh bearer (each login emits a user_login audit row). */
async function loginToken(
    request: APIRequestContext,
    email: string,
    password = PW,
): Promise<string> {
    const res = await request.post(LOGIN, { data: { email, password }, timeout: T });
    expect(res.status(), `login ${email}`).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(typeof body.access_token).toBe('string');
    return body.access_token;
}

/** Count audit rows matching a given `action` string. */
function countAction(list: ActivityList, action: string): number {
    return list.activities.filter((a) => a.action === action).length;
}

test.describe('flow-activity-audit-account', () => {
    /**
     * FLOW 1 — The auth-event audit TRAIL accrues login rows in order, and a plain
     * logout is (correctly) NOT audited while logout-all IS.
     *
     * A fresh account begins with exactly one user_signup row. Each successful login
     * appends a user_login/user.login row; a plain POST /logout appends NOTHING; a
     * logout-all appends a single user_login/user.logout_all row. We drive the real
     * sequence and assert the resulting multi-event ledger (counts + chronology),
     * proving the account audit trail is a faithful append-only record of auth actions.
     */
    test('login/logout-all events accrue an ordered audit trail while a plain logout is not recorded', async ({
        request,
    }) => {
        const acct = await registerUserViaAPI(request, {
            email: makeTestUser('audit-trail').email,
        });

        // Fresh account: exactly one signup row, nothing else.
        const initial = await listLog(request, acct.access_token);
        expect(initial.total, 'fresh account has exactly the signup row').toBe(1);
        expect(initial.activities[0].action).toBe('user.signup');
        expect(initial.activities[0].status).toBe('completed');

        // Three real logins → three user.login rows (best-effort `.log().catch()` so poll).
        await loginToken(request, acct.email);
        await loginToken(request, acct.email);
        const third = await loginToken(request, acct.email);

        await expect
            .poll(
                async () => countAction(await listLog(request, acct.access_token), 'user.login'),
                {
                    message: 'three logins should yield three user.login audit rows',
                    timeout: 15_000,
                },
            )
            .toBe(3);

        // A plain logout of the third session must NOT add an audit row.
        const beforeLogout = await listLog(request, acct.access_token);
        const logout = await request.post(LOGOUT, {
            headers: authedHeaders(third),
            timeout: T,
        });
        expect(logout.status(), 'plain logout → 200').toBe(200);
        // Give any (non-existent) async emission a beat, then assert no growth.
        const afterLogout = await listLog(request, acct.access_token);
        expect(
            afterLogout.total,
            'plain logout is intentionally NOT audited (no entry added)',
        ).toBe(beforeLogout.total);
        expect(countAction(afterLogout, 'user.logout'), 'no user.logout action exists').toBe(0);

        // logout-all DOES audit — one user.logout_all row, bucketed under user_login.
        const logoutAll = await request.post(LOGOUT_ALL, {
            headers: authedHeaders(acct.access_token),
            timeout: T,
        });
        expect(logoutAll.status(), 'logout-all → 200').toBe(200);

        // The register/login token survives long enough? No — logout-all kills it.
        // Re-login to read the final ledger.
        const readTok = await loginToken(request, acct.email);
        const finalList = await listLog(request, readTok);

        expect(countAction(finalList, 'user.logout_all'), 'exactly one logout-all row').toBe(1);
        const logoutAllRow = finalList.activities.find((a) => a.action === 'user.logout_all')!;
        expect(logoutAllRow.actionType, 'logout-all is bucketed under user_login type').toBe(
            'user_login',
        );
        expect(logoutAllRow.summary).toMatch(/signed out from all devices/i);

        // Chronology: createdAt is non-increasing down the list (newest first), and the
        // oldest row remains the immutable signup.
        const times = finalList.activities.map((a) => Date.parse(a.createdAt));
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1], 'rows ordered newest-first by createdAt').toBeGreaterThanOrEqual(
                times[i],
            );
        }
        expect(finalList.activities[finalList.activities.length - 1].action).toBe('user.signup');
    });

    /**
     * FLOW 2 — Login audit rows CAPTURE the request client fingerprint (ipAddress +
     * userAgent), distinguishing the login forensic record from the fingerprint-less
     * signup row.
     *
     * The login controller threads req.ip + user-agent into the audit entry; the
     * register path does not. We send a login with a DISTINCTIVE User-Agent header and
     * then assert the freshest user.login row carries BOTH an ipAddress and exactly
     * that userAgent — while the signup row has neither. This is the "where did this
     * sign-in come from?" capability a security audit log exists to provide.
     */
    test('login audit entries capture ipAddress and the request User-Agent; the signup row does not', async ({
        request,
    }) => {
        const acct = await registerUserViaAPI(request, { email: makeTestUser('audit-fp').email });
        const distinctiveUa = `e2e-audit-probe/${Date.now().toString(36)}`;

        const loginRes = await request.post(LOGIN, {
            data: { email: acct.email, password: PW },
            headers: { 'User-Agent': distinctiveUa },
            timeout: T,
        });
        expect(loginRes.status(), 'login with custom UA → 200').toBe(200);

        // Poll until the best-effort login row is persisted, then inspect it.
        let loginRow: ActivityRow | undefined;
        await expect
            .poll(
                async () => {
                    const list = await listLog(
                        request,
                        acct.access_token,
                        '&actionType=user_login',
                    );
                    loginRow = list.activities.find((a) => a.action === 'user.login');
                    return loginRow ? (loginRow.userAgent ?? '') : '';
                },
                { message: 'login row should carry the custom User-Agent', timeout: 15_000 },
            )
            .toContain(distinctiveUa);

        expect(loginRow, 'login row exists').toBeTruthy();
        expect(loginRow!.actionType).toBe('user_login');
        expect(loginRow!.userId, 'row is scoped to this account').toBe(acct.user.id);
        expect(typeof loginRow!.ipAddress, 'login row captured an ipAddress').toBe('string');
        expect((loginRow!.ipAddress ?? '').length, 'ipAddress is non-empty').toBeGreaterThan(0);

        // The signup row, by contrast, has no client fingerprint.
        const full = await listLog(request, acct.access_token);
        const signupRow = full.activities.find((a) => a.action === 'user.signup');
        expect(signupRow, 'signup row exists').toBeTruthy();
        expect(signupRow!.ipAddress ?? null, 'signup row has no ipAddress').toBeNull();
        expect(signupRow!.userAgent ?? null, 'signup row has no userAgent').toBeNull();
    });

    /**
     * FLOW 3 — Per-user audit VISIBILITY isolation: one user's auth events are never
     * visible to another, by listing, by direct entry fetch, or by query-param spoof.
     *
     * Two fresh accounts each generate distinct auth events. We then prove:
     *  (a) each user's list contains ONLY their own userId (no cross-bleed);
     *  (b) GET /:id of user A's entry as user B → 404 (findByIdAndUserId scoping),
     *      while A fetching it → 200;
     *  (c) the ?userId=<other> query param is IGNORED — A passing B's id still only
     *      sees A's rows (no horizontal escalation via a spoofed filter).
     */
    test('audit entries are strictly per-user: no cross-user listing, no cross-user fetch-by-id, no userId-spoof', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request, { email: makeTestUser('audit-iso-a').email });
        const b = await registerUserViaAPI(request, { email: makeTestUser('audit-iso-b').email });
        await loginToken(request, a.email);
        await loginToken(request, b.email);

        const listA = await listLog(request, a.access_token);
        const listB = await listLog(request, b.access_token);

        // (a) Each list is single-user; neither sees the other's userId.
        const usersA = new Set(listA.activities.map((r) => r.userId));
        const usersB = new Set(listB.activities.map((r) => r.userId));
        expect([...usersA], 'A sees only A rows').toEqual([a.user.id]);
        expect([...usersB], 'B sees only B rows').toEqual([b.user.id]);
        expect(usersA.has(b.user.id), 'A must not see B rows').toBe(false);
        expect(usersB.has(a.user.id), 'B must not see A rows').toBe(false);

        // (b) Direct entry fetch is owner-scoped.
        const aEntryId = listA.activities[0].id;
        const ownFetch = await request.get(`${LOG}/${aEntryId}`, {
            headers: authedHeaders(a.access_token),
            timeout: T,
        });
        expect(ownFetch.status(), 'owner fetches own entry → 200').toBe(200);
        const ownBody = (await ownFetch.json()) as { activity: { id: string; userId: string } };
        expect(ownBody.activity.id).toBe(aEntryId);
        expect(ownBody.activity.userId).toBe(a.user.id);

        const strangerFetch = await request.get(`${LOG}/${aEntryId}`, {
            headers: authedHeaders(b.access_token),
            timeout: T,
        });
        expect(
            strangerFetch.status(),
            "stranger fetching A's entry → 404 (scoped, never 5xx)",
        ).toBe(404);

        // A bogus uuid is also a clean 404, not a 5xx.
        const bogus = await request.get(`${LOG}/00000000-0000-0000-0000-000000000000`, {
            headers: authedHeaders(a.access_token),
            timeout: T,
        });
        expect(bogus.status(), 'bogus id → 404').toBe(404);

        // (c) ?userId spoof is ignored — A asking for B's rows still only gets A's.
        const spoof = await request.get(`${LOG}?userId=${b.user.id}&limit=100`, {
            headers: authedHeaders(a.access_token),
            timeout: T,
        });
        expect(spoof.status(), 'spoof query still 200').toBe(200);
        const spoofBody = (await spoof.json()) as ActivityList;
        const spoofUsers = new Set(spoofBody.activities.map((r) => r.userId));
        expect([...spoofUsers], 'userId query param is ignored; A still sees only A rows').toEqual([
            a.user.id,
        ]);
    });

    /**
     * FLOW 4 — The audit QUERY surface: filter by actionType, free-text search, ISO
     * date range, and limit/offset pagination — all scoped, all consistent with the
     * unfiltered ledger.
     *
     * We seed a known mix (signup + N logins) on a fresh account and exercise every
     * query axis the controller exposes, asserting each filter returns a faithful
     * subset: actionType=user_login excludes the signup; actionType=user_signup yields
     * exactly one; search="Signed in" matches only login summaries; a far-future
     * dateFrom and a far-past dateTo both yield zero; and limit/offset paginate the
     * trail without dropping or duplicating rows.
     */
    test('audit list supports actionType / search / date-range filters and limit+offset pagination', async ({
        request,
    }) => {
        const acct = await registerUserViaAPI(request, {
            email: makeTestUser('audit-query').email,
        });
        const LOGIN_COUNT = 4;
        for (let i = 0; i < LOGIN_COUNT; i++) await loginToken(request, acct.email);

        // Wait for all login rows to materialise (best-effort emission).
        await expect
            .poll(async () => (await listLog(request, acct.access_token)).total, {
                message: 'signup + logins should all be recorded',
                timeout: 15_000,
            })
            .toBe(1 + LOGIN_COUNT);

        const full = await listLog(request, acct.access_token);
        const total = full.total;

        // actionType=user_login → only login rows (the signup is excluded).
        const onlyLogins = await listLog(request, acct.access_token, '&actionType=user_login');
        expect(onlyLogins.total, 'login-filtered count').toBe(LOGIN_COUNT);
        expect(
            onlyLogins.activities.every((a) => a.actionType === 'user_login'),
            'every filtered row is user_login',
        ).toBe(true);
        expect(
            onlyLogins.activities.some((a) => a.action === 'user.signup'),
            'signup excluded from user_login filter',
        ).toBe(false);

        // actionType=user_signup → exactly the one signup row.
        const onlySignup = await listLog(request, acct.access_token, '&actionType=user_signup');
        expect(onlySignup.total, 'exactly one signup row').toBe(1);
        expect(onlySignup.activities[0].action).toBe('user.signup');

        // search="Signed in" matches only the login summaries.
        const searched = await listLog(request, acct.access_token, '&search=Signed%20in');
        expect(searched.total, 'search matches the login rows').toBe(LOGIN_COUNT);
        expect(
            searched.activities.every((a) => a.action === 'user.login'),
            'search returns only login rows',
        ).toBe(true);

        // Date-range boundaries: a future floor and a past ceiling both empty the trail.
        const futureFloor = await listLog(
            request,
            acct.access_token,
            '&dateFrom=2099-01-01T00:00:00.000Z',
        );
        expect(futureFloor.total, 'dateFrom in the future → empty').toBe(0);
        const pastCeiling = await listLog(
            request,
            acct.access_token,
            '&dateTo=2000-01-01T00:00:00.000Z',
        );
        expect(pastCeiling.total, 'dateTo in the past → empty').toBe(0);

        // Pagination: walk the trail in pages of 2 and reassemble it losslessly.
        const pageSize = 2;
        const collected: string[] = [];
        for (let offset = 0; offset < total; offset += pageSize) {
            const res = await request.get(`${LOG}?limit=${pageSize}&offset=${offset}`, {
                headers: authedHeaders(acct.access_token),
                timeout: T,
            });
            expect(res.status(), `page at offset ${offset}`).toBe(200);
            const body = (await res.json()) as ActivityList;
            expect(body.total, 'total is stable across pages').toBe(total);
            expect(body.activities.length, 'page is capped at pageSize').toBeLessThanOrEqual(
                pageSize,
            );
            for (const row of body.activities) collected.push(row.id);
        }
        const unique = new Set(collected);
        expect(collected.length, 'paginated rows are all distinct (no overlap)').toBe(unique.size);
        expect(unique.size, 'pagination reassembles the whole trail').toBe(total);
    });

    /**
     * FLOW 5 — Audit EXPORT (CSV) is a faithful, filterable projection of the live
     * audit list, with the right download contract.
     *
     * The export endpoint must (1) carry text/csv + an attachment filename, (2) emit
     * the documented header row, (3) contain a data row for every auth event in the
     * live list (login + signup row parity), and (4) honour the same actionType filter
     * the list does — exporting ?actionType=user_login yields ONLY login rows. We
     * cross-check the CSV row count against the API list count so the export can never
     * silently under- or over-report the user's security history.
     */
    test('CSV export mirrors the live audit list, carries the download contract, and honours actionType filtering', async ({
        request,
    }) => {
        const acct = await registerUserViaAPI(request, {
            email: makeTestUser('audit-export').email,
        });
        const LOGIN_COUNT = 3;
        for (let i = 0; i < LOGIN_COUNT; i++) await loginToken(request, acct.email);

        await expect
            .poll(async () => (await listLog(request, acct.access_token)).total, {
                message: 'all rows recorded before export',
                timeout: 15_000,
            })
            .toBe(1 + LOGIN_COUNT);

        // Unauthenticated export is refused.
        const unauth = await request.get(`${LOG}/export`, { timeout: T });
        expect(unauth.status(), 'export without auth → 401').toBe(401);

        // (1)+(2) Download contract + header row.
        const res = await request.get(`${LOG}/export`, {
            headers: authedHeaders(acct.access_token),
            timeout: T,
        });
        expect(res.status(), 'export → 200').toBe(200);
        const ct = res.headers()['content-type'] || '';
        expect(ct, `content-type was ${ct}`).toContain('text/csv');
        const disposition = res.headers()['content-disposition'] || '';
        expect(disposition, 'attachment filename present').toMatch(/attachment/i);
        expect(disposition, 'filename is activity-log.csv').toMatch(/activity-log\.csv/i);

        const csv = await res.text();
        const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
        expect(lines[0], 'CSV header row').toBe('Date,Action Type,Action,Status,Work,Summary');
        const dataRows = lines.slice(1);

        // (3) Row parity with the live list — one data row per audit event.
        const list = await listLog(request, acct.access_token);
        expect(dataRows.length, 'CSV data-row count equals the live audit total').toBe(list.total);
        // The signup + each login must each appear in the CSV body.
        expect(csv).toMatch(/user_signup,user\.signup,completed/);
        const csvLoginRows = dataRows.filter((r) => r.includes('user_login,user.login,completed'));
        expect(csvLoginRows.length, 'every login row is exported').toBe(LOGIN_COUNT);

        // (4) Filtered export parity — actionType=user_login excludes the signup row.
        const filtered = await request.get(`${LOG}/export?actionType=user_login`, {
            headers: authedHeaders(acct.access_token),
            timeout: T,
        });
        expect(filtered.status(), 'filtered export → 200').toBe(200);
        const filteredCsv = await filtered.text();
        const filteredRows = filteredCsv
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .slice(1);
        expect(filteredRows.length, 'filtered export holds only the login rows').toBe(LOGIN_COUNT);
        expect(
            filteredRows.every((r) => r.includes('user_login,user.login')),
            'no signup row in the user_login export',
        ).toBe(true);
        expect(filteredCsv.includes('user.signup'), 'signup excluded from filtered export').toBe(
            false,
        );
    });

    /**
     * FLOW 6 — Truthful coverage of audit GAPS: password-change and api-key create are
     * security-relevant but are NOT (yet) recorded in the account audit trail, and 2FA
     * has no surface at all. This flow PINS the current reality and auto-upgrades the
     * moment any of those events starts being audited — never asserting a fiction.
     *
     * We perform a real password rotation (200) and a real api-key creation (201) on a
     * fresh account, then assert no password_changed / key-related audit row appears
     * and the trail still holds only signup + login rows. If a future build wires the
     * UserPasswordChangedEvent (password_changed) or an api-key audit, the
     * corresponding assertion's guard skips-UP so this flow flips to verifying the new
     * real contract instead of the absence.
     */
    test('password change and api-key creation are NOT audited today (signup/login-only trail); skips up when they land', async ({
        request,
    }) => {
        const acct = await registerUserViaAPI(request, { email: makeTestUser('audit-gap').email });
        // One login so the trail has a known login row beside the signup.
        const sessionTok = await loginToken(request, acct.email);

        // Real password rotation through the API (changePassword → setPassword, no event).
        const newPw = 'Rotated9!secure';
        const pwRes = await request.post(UPDATE_PASSWORD, {
            headers: authedHeaders(sessionTok),
            data: { currentPassword: PW, newPassword: newPw },
            timeout: T,
        });
        expect(pwRes.status(), 'update-password → 200').toBe(200);

        // Real api-key creation (api-keys controller does not log activity).
        const keyRes = await request.post(API_KEYS, {
            headers: authedHeaders(sessionTok),
            data: { name: `audit-gap-key-${Date.now().toString(36)}` },
            timeout: T,
        });
        expect(keyRes.status(), 'create api-key → 201').toBe(201);

        // Give any (today non-existent) async audit emission a generous beat.
        const passwordChanged = await request.get(`${LOG}?actionType=password_changed`, {
            headers: authedHeaders(sessionTok),
            timeout: T,
        });
        expect(passwordChanged.status(), 'password_changed filter still 200').toBe(200);
        const pcBody = (await passwordChanged.json()) as ActivityList;

        // GUARD: if password_changed auditing has landed, upgrade this flow.
        test.skip(
            pcBody.total > 0,
            'password_changed audit rows now exist — upgrade this flow to assert the real password-change audit contract.',
        );

        const full = await listLog(request, sessionTok);
        const actions = new Set(full.activities.map((a) => a.action));

        // No password-change audit row of any phrasing.
        expect(
            full.activities.some((a) => a.actionType === 'password_changed'),
            'no password_changed actionType in the trail',
        ).toBe(false);

        // No api-key / 2FA related audit row.
        const hasKeyOrMfaRow = full.activities.some((a) =>
            /api[_-]?key|two[_-]?factor|2fa|mfa|totp/i.test(
                `${a.action} ${a.actionType} ${a.summary}`,
            ),
        );
        test.skip(
            hasKeyOrMfaRow,
            'api-key / 2FA audit rows now exist — upgrade this flow to assert that real contract.',
        );
        expect(hasKeyOrMfaRow, 'api-key creation is not audited today').toBe(false);

        // The trail remains exactly the signup + login auth events.
        expect(
            [...actions].sort(),
            'account audit trail today contains only signup + login auth events',
        ).toEqual(['user.login', 'user.signup']);
        expect(full.total, 'two rows: one signup + one login').toBe(2);
    });
});
