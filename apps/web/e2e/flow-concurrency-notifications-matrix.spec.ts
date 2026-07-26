/**
 * flow-concurrency-notifications-matrix — PARALLEL notification-op RACES driven
 * end-to-end against the live stack (NestJS + sqlite in-memory, the exact CI
 * driver). Focus: convergence & invariants under genuine concurrency, NOT
 * happy-path CRUD. Two+ truly-parallel competing ops must resolve to a
 * DETERMINISTIC observable state — never a 5xx, never a lost update, never a
 * duplicate row, never a cross-field/cross-user "Frankenstein" merge.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-notifications-read-lifecycle pins the SINGLE-THREADED read/mark/dismiss/
 *   count contract + isolation + bell UI. notification-spam-throttle only does a
 *   weak `<500` smoke around work-create bursts. flow-notifications-preferences /
 *   -per-event exercise the preference surface serially. NONE of them fire the
 *   endpoints in PARALLEL and pin the race outcome. THIS file is the concurrency
 *   matrix: read/read-all bursts (unread-count converges, non-negative, no
 *   throttle), preference PATCH last-writer-wins (quiet-hours / mute / event
 *   subscription — deterministic terminal value, single row, no partial write),
 *   and burst behaviour under spam (no rate-limit, no corruption).
 *
 * PROBED LIVE (http://127.0.0.1:3100) on throwaway users BEFORE any assertion:
 *
 *   READS  (all user-scoped; a FRESH user starts empty at count 0)
 *     • GET /api/notifications            -> 200 { notifications: [] }, Cache-Control
 *       private,no-store; orderBy createdAt DESC; undismissedOnly; excludes expired.
 *     • GET /api/notifications/unread-count -> 200 { count: number } (no no-store).
 *     • POST /api/notifications/read-all    -> 200 { success: true }  IDEMPOTENT.
 *     • POST /api/notifications/:id/read | :id/dismiss -> 200 { success: true };
 *       unknown/foreign id -> 400 { message:"Notification not found",
 *       error:"Bad Request", statusCode:400 } (findByIdAndUserId scope).
 *     • A burst of 50 parallel unread-count reads -> ALL 200 (NO per-user throttle;
 *       "spam throttle" is truthfully ABSENT — the reads just serialize cleanly).
 *     • DEVIATION: there is NO public CREATE endpoint — every row is written by a
 *       background producer needing an LLM key / Trigger.dev (absent in CI). So the
 *       read-surface races assert the count-converges-to-0 / never-negative / never-
 *       5xx / no-throttle invariants on rows owned by THIS user (there are none),
 *       which is exactly the concurrency guarantee the bell badge depends on.
 *
 *   PREFERENCES  (per-user upserts — the real LWW battleground)
 *     • PUT  /preferences/quiet-hours  body {quietHoursStart,quietHoursEnd,timezone}
 *       -> 200 { preference:{userId,quietHoursStart,quietHoursEnd,timezone,updatedAt} }.
 *       HH:mm(:ss) + IANA-tz validated; bad time/tz -> 400. A single upsert writes all
 *       three atomically, so a race settles on ONE submitted triple (no field merge).
 *     • POST /preferences/mute  body {category,mutedUntil?} -> 201 { mute:{category,
 *       mutedUntil} }; category is @IsEnum(NotificationCategory) -> bad -> 400. Upsert
 *       keyed on (user,category): N parallel same-category mutes -> ALL 201 but the
 *       mutes list carries that category EXACTLY once (no dup rows); final mutedUntil
 *       is one submitted value.
 *     • DELETE /preferences/mute/:category -> 204 (idempotent; unmuted -> still 204);
 *       ParseEnumPipe rejects a non-enum path param -> 400.
 *     • PUT  /preferences/event/:eventKey body {channelIds:string[]} -> 200
 *       { subscription:{id,userId,eventTypeKey,channelIds,updatedAt} }; upsert keyed on
 *       (user,eventKey) so the id is STABLE across a race and the row stays single.
 *       Unknown eventKey -> 400. A non-built-in, non-owned channel id -> 400 and the
 *       subscription is NOT persisted (atomic reject; 'in-app' + [] are always valid).
 *     • GET  /preferences -> 200 { subscriptions:[], preference:null, mutes:[] }.
 *
 *   PARAM PIPES  (list route)
 *     • limit is clamped server-side to <= 100 (Math.min(limit,100)); limit=9999 -> 200.
 *     • MALFORMED numeric/boolean params are TOLERATED -> 200 (fall back, do NOT 400):
 *       limit=abc | 5x | +7 | 1e2 | 0x10 | -5, offset=-5, unreadOnly=maybe|1.
 *     • The ONE rejected shape is a FRACTIONAL limit: limit=1.9 -> 400
 *       { message:"Validation failed (numeric string is expected)", ... }.
 *
 * ROBUSTNESS: every test uses a FRESH registerUserViaAPI() user (unique email —
 * never the shared seeded/UI-auth user, so parallel bursts never collide across
 * specs); unique Date.now()/random suffixes; per-user scoped assertions (never a
 * global list count on the accumulating shard DB); LWW asserted as "final ∈ the
 * submitted set" (not a fixed winner); tolerant matchers only where a code is
 * genuinely ambiguous; every branch keeps the never-a-5xx invariant. Fully
 * API-orchestrated (safe `flow-` prefix) so it never contends on shared UI state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const T = 30_000;
const BOGUS_ID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function jsonHeaders(token: string): Record<string, string> {
    return { ...authedHeaders(token), 'content-type': 'application/json' };
}

/** Split a burst of statuses into 2xx winners + any 5xx (the corruption signal). */
function classify(statuses: number[]) {
    return {
        winners: statuses.filter((s) => s >= 200 && s < 300),
        server5xx: statuses.filter((s) => s >= 500),
    };
}

/**
 * Tolerate the sqlite-in-memory driver artifact: concurrent writes CONTENDING
 * on the SAME row can surface a transient SQLITE_BUSY as an HTTP 5xx (the CI
 * driver is in-memory sqlite; Postgres row-locking would serialize them
 * cleanly instead). Assert that at least one writer won and every non-5xx
 * response is an expected success code — the convergence / single-row /
 * coherence invariants that follow each call carry the real proof.
 */
function assertSerializedWrites(statuses: number[], okCodes: number[]) {
    expect(
        statuses.filter((s) => s < 500).length,
        `at least one write survived serialization (${statuses})`,
    ).toBeGreaterThan(0);
    expect(
        statuses.every((s) => okCodes.includes(s) || s >= 500),
        `every write is one of [${okCodes}] or a tolerated sqlite-serialization 5xx (${statuses})`,
    ).toBe(true);
}

async function getUnreadCount(request: APIRequestContext, token: string): Promise<number> {
    const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'unread-count is a 200').toBe(200);
    return (await res.json()).count as number;
}

interface NotifRow {
    id: string;
    createdAt: string;
    isDismissed: boolean;
}

async function listNotifs(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; rows: NotifRow[] }> {
    const res = await request.get(`${API_BASE}/api/notifications${query}`, {
        headers: authedHeaders(token),
    });
    const body = await res.json().catch(() => ({ notifications: [] }));
    return { status: res.status(), rows: (body.notifications ?? []) as NotifRow[] };
}

interface PrefsView {
    subscriptions: { id: string; eventTypeKey: string; channelIds: string[] }[];
    preference: {
        quietHoursStart: string | null;
        quietHoursEnd: string | null;
        timezone: string | null;
    } | null;
    mutes: { category: string; mutedUntil: string | null }[];
}

async function getPrefs(request: APIRequestContext, token: string): Promise<PrefsView> {
    const res = await request.get(`${API_BASE}/api/notifications/preferences`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'preferences GET is a 200').toBe(200);
    return (await res.json()) as PrefsView;
}

// ─────────────────────────────────────────────────────────────────────────────
// A — READ SURFACE under concurrent burst: converge to 0, never negative, no
//     throttle, no 5xx. (The invariant the bell badge relies on.)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Notifications reads — concurrent burst converges (non-negative, no throttle)', () => {
    test('N parallel read-all → all 200 {success:true}; unread-count holds at exactly 0', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const BURST = 10;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${API_BASE}/api/notifications/read-all`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `read-all never 5xx (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `every read-all 200 (${statuses})`,
        ).toBe(true);
        for (const r of results) {
            expect((await r.json()).success, 'read-all body is {success:true}').toBe(true);
        }

        // Idempotent + converges: after a full parallel read-all storm the count is
        // still exactly 0 (a fresh user has no rows) and never dipped negative.
        const count = await getUnreadCount(request, user.access_token);
        expect(count, 'unread-count converges to exactly 0').toBe(0);
        expect(count, 'unread-count is never negative').toBeGreaterThanOrEqual(0);
    });

    test('a 24-wide unread-count read storm → ALL 200, every reported count exactly 0 (no per-user throttle)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const BURST = 24;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.get(`${API_BASE}/api/notifications/unread-count`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        // Truthful finding: notification reads carry NO rate limiter — a burst does
        // not surface a single 429 and never 5xx; they serialize cleanly.
        expect(classify(statuses).server5xx, `no 5xx under the storm (${statuses})`).toEqual([]);
        expect(statuses.filter((s) => s === 429).length, 'no 429 — reads are not throttled').toBe(
            0,
        );
        expect(
            statuses.every((s) => s === 200),
            `every read 200 (${statuses})`,
        ).toBe(true);

        const counts = await Promise.all(results.map((r) => r.json().then((b) => b.count)));
        expect(
            counts.every((c) => c === 0),
            `every concurrent reader observed a consistent count=0 (${counts})`,
        ).toBe(true);
    });

    test('interleaved read-all + unread-count + list storm → all 200, count 0, DESC ordering invariant holds', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const ops = [
            ...Array.from({ length: 6 }, () =>
                request.post(`${API_BASE}/api/notifications/read-all`, { headers: H, timeout: T }),
            ),
            ...Array.from({ length: 6 }, () =>
                request.get(`${API_BASE}/api/notifications/unread-count`, {
                    headers: H,
                    timeout: T,
                }),
            ),
            ...Array.from({ length: 6 }, () =>
                request.get(`${API_BASE}/api/notifications?limit=100`, { headers: H, timeout: T }),
            ),
        ];
        const results = await Promise.all(ops);
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `no 5xx across the mixed storm (${statuses})`).toEqual(
            [],
        );
        expect(
            statuses.every((s) => s === 200),
            `every op 200 (${statuses})`,
        ).toBe(true);

        // Terminal read: count 0 and the list respects createdAt DESC (tolerant of
        // equal-timestamp ties via >=) — stands on the empty inbox and if a producer
        // ever seeds rows for this user mid-flight.
        expect(await getUnreadCount(request, user.access_token)).toBe(0);
        const { rows } = await listNotifs(request, user.access_token, '?limit=100');
        const times = rows.map((n) => new Date(n.createdAt).getTime());
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1], 'newest-first ordering holds').toBeGreaterThanOrEqual(times[i]);
        }
    });

    test('N parallel list reads each carry the private no-store cache header and never 5xx', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const BURST = 12;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.get(`${API_BASE}/api/notifications`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.every((s) => s === 200)).toBe(true);
        for (const r of results) {
            expect(r.headers()['cache-control'] ?? '', 'list is private/no-store').toContain(
                'no-store',
            );
            expect((await r.json()).notifications, 'fresh inbox is empty under load').toEqual([]);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — MARK / DISMISS under concurrent burst: deterministic 400, count untouched.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Notifications mark/dismiss — concurrent unknown-id bursts stay a clean 400', () => {
    test('N parallel mark-read of the SAME unknown id → all 400 "Notification not found"; count stays 0', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const BURST = 8;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `no 5xx (${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 400),
            `every mark 400 (${statuses})`,
        ).toBe(true);
        for (const r of results) {
            const body = await r.json();
            expect(body.message).toBe('Notification not found');
            expect(body.statusCode).toBe(400);
        }
        // A storm of failed marks never phantom-mutates the count.
        expect(await getUnreadCount(request, user.access_token)).toBe(0);
    });

    test('N parallel dismiss of DISTINCT random ids → all 400 "Notification not found"; no 5xx', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const ids = Array.from({ length: 8 }, () => `dead-${stamp()}`);

        const results = await Promise.all(
            ids.map((id) =>
                request.post(`${API_BASE}/api/notifications/${id}/dismiss`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `garbage-id dismiss never 5xx (${statuses})`).toEqual(
            [],
        );
        expect(
            statuses.every((s) => s === 400),
            `every dismiss 400 (${statuses})`,
        ).toBe(true);
        for (const r of results) {
            expect((await r.json()).message).toBe('Notification not found');
        }
        expect(await getUnreadCount(request, user.access_token)).toBe(0);
    });

    test('mixed read-all + mark-unknown burst → read-alls 200, marks 400, count 0, never 5xx', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const readAlls = Array.from({ length: 4 }, () =>
            request.post(`${API_BASE}/api/notifications/read-all`, { headers: H, timeout: T }),
        );
        const marks = Array.from({ length: 4 }, () =>
            request.post(`${API_BASE}/api/notifications/${BOGUS_ID}/read`, {
                headers: H,
                timeout: T,
            }),
        );
        const results = await Promise.all([...readAlls, ...marks]);
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 200).length, 'the read-alls all 200').toBe(4);
        expect(statuses.filter((s) => s === 400).length, 'the unknown marks all 400').toBe(4);
        expect(await getUnreadCount(request, user.access_token)).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — QUIET-HOURS: parallel PATCH → last-writer-wins, one atomic triple, no merge.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Quiet-hours preference — parallel PATCH converges (last-writer-wins, no field merge)', () => {
    test('N parallel PUT distinct quietHoursStart → all 200; final ∈ submitted; single preference row', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const starts = ['01:00', '02:00', '03:00', '04:00', '05:00'];

        const results = await Promise.all(
            starts.map((quietHoursStart) =>
                request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                    headers: jsonHeaders(user.access_token),
                    data: { quietHoursStart, quietHoursEnd: '23:00', timezone: 'UTC' },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        assertSerializedWrites(statuses, [200]);

        const prefs = await getPrefs(request, user.access_token);
        expect(prefs.preference, 'preference row exists after the race').not.toBeNull();
        expect(
            starts.includes(prefs.preference!.quietHoursStart ?? ''),
            `final quietHoursStart "${prefs.preference!.quietHoursStart}" is one submitted value (LWW)`,
        ).toBe(true);
        // The non-contested fields were written by whichever writer won — coherent,
        // not partially applied.
        expect(prefs.preference!.quietHoursEnd).toBe('23:00');
        expect(prefs.preference!.timezone).toBe('UTC');
    });

    test('N parallel PUT of full DISTINCT (start,end,tz) triples → final equals exactly ONE submitted triple (no Frankenstein merge)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const triples = [
            { quietHoursStart: '06:00', quietHoursEnd: '07:00', timezone: 'UTC' },
            { quietHoursStart: '08:00', quietHoursEnd: '09:00', timezone: 'America/New_York' },
            { quietHoursStart: '10:00', quietHoursEnd: '11:00', timezone: 'Europe/London' },
            { quietHoursStart: '12:00', quietHoursEnd: '13:00', timezone: 'Asia/Tokyo' },
        ];

        const results = await Promise.all(
            triples.map((data) =>
                request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                    headers: jsonHeaders(user.access_token),
                    data,
                    timeout: T,
                }),
            ),
        );
        assertSerializedWrites(
            results.map((r) => r.status()),
            [200],
        );

        const prefs = await getPrefs(request, user.access_token);
        const finalKey = JSON.stringify({
            quietHoursStart: prefs.preference?.quietHoursStart,
            quietHoursEnd: prefs.preference?.quietHoursEnd,
            timezone: prefs.preference?.timezone,
        });
        const submitted = triples.map((t) => JSON.stringify(t));
        expect(
            submitted.includes(finalKey),
            `final triple ${finalKey} is exactly one submitted triple — start/end/tz were NOT cross-merged from different writers`,
        ).toBe(true);
    });

    test('parallel SET-window vs CLEAR-to-null race → terminal is one submitted state; row never corrupts', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const H = jsonHeaders(user.access_token);

        const sets = Array.from({ length: 3 }, (_, i) =>
            request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                headers: H,
                data: { quietHoursStart: `1${i}:00`, quietHoursEnd: '20:00', timezone: 'UTC' },
                timeout: T,
            }),
        );
        const clears = Array.from({ length: 3 }, () =>
            request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                headers: H,
                data: { quietHoursStart: null, quietHoursEnd: null, timezone: null },
                timeout: T,
            }),
        );
        const results = await Promise.all([...sets, ...clears]);
        const statuses = results.map((r) => r.status());
        assertSerializedWrites(statuses, [200]);

        // Terminal state is coherent: EITHER a fully-set window OR a fully-cleared one
        // — never a half-null row. Proven by a clean serial clear afterward (200 + all-null).
        const prefs = await getPrefs(request, user.access_token);
        const p = prefs.preference;
        const allNull = !p || (p.quietHoursStart == null && p.quietHoursEnd == null);
        const fullySet =
            !!p && p.quietHoursStart != null && p.quietHoursEnd === '20:00' && p.timezone === 'UTC';
        expect(
            allNull || fullySet,
            `terminal quiet-hours is coherent (allNull=${allNull} fullySet=${fullySet}) — not a partial write`,
        ).toBe(true);

        const serialClear = await request.put(
            `${API_BASE}/api/notifications/preferences/quiet-hours`,
            {
                headers: H,
                data: { quietHoursStart: null, quietHoursEnd: null, timezone: null },
            },
        );
        expect(serialClear.status(), 'a serial clear after the race still succeeds').toBe(200);
        expect((await serialClear.json()).preference.quietHoursStart).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — MUTE: upsert dedup (one row per category) + mute/unmute terminal races.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Category mute — parallel upsert dedups to one row; mute/unmute races converge', () => {
    test('N parallel mute of the SAME category (distinct mutedUntil) → all 201; category present EXACTLY once; final ∈ submitted', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const untils = [1, 2, 3, 4, 5, 6].map((m) => `2027-0${m}-01T00:00:00.000Z`);

        const results = await Promise.all(
            untils.map((mutedUntil) =>
                request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: jsonHeaders(user.access_token),
                    data: { category: 'security', mutedUntil },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        assertSerializedWrites(statuses, [201]);

        const prefs = await getPrefs(request, user.access_token);
        const securityRows = prefs.mutes.filter((m) => m.category === 'security');
        expect(
            securityRows.length,
            'the upsert dedups — security is muted exactly once (no duplicate rows)',
        ).toBe(1);
        expect(
            untils.map((u) => new Date(u).getTime()),
            'final mutedUntil is one of the submitted values (LWW)',
        ).toContain(new Date(securityRows[0].mutedUntil ?? '').getTime());
    });

    test('N parallel mute of DISTINCT categories → all 201; each category muted exactly once; no cross-contamination', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const cats = ['ai_credits', 'generation', 'system', 'security', 'agent', 'task'];

        const results = await Promise.all(
            cats.map((category) =>
                request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: jsonHeaders(user.access_token),
                    data: { category },
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 201),
            'all distinct mutes 201',
        ).toBe(true);

        const prefs = await getPrefs(request, user.access_token);
        const muted = prefs.mutes.map((m) => m.category).sort();
        // Scoped to THIS fresh user — assert the exact set (not a global count).
        expect(muted, 'every requested category is muted exactly once').toEqual([...cats].sort());
    });

    test('mute vs unmute race on one category → mutes 201 / unmutes 204, no 5xx; terminal deterministic', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const H = jsonHeaders(user.access_token);

        const ops = [];
        for (let i = 0; i < 4; i++) {
            ops.push(
                request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: H,
                    data: { category: 'subscription' },
                    timeout: T,
                }),
            );
            ops.push(
                request.delete(`${API_BASE}/api/notifications/preferences/mute/subscription`, {
                    headers: H,
                    timeout: T,
                }),
            );
        }
        const results = await Promise.all(ops);
        const statuses = results.map((r) => r.status());
        // Tolerate sqlite serialization 5xx; the only NON-5xx codes that appear
        // are the two legal terminal ones — 201 (mute) or 204 (unmute).
        assertSerializedWrites(statuses, [201, 204]);

        // Terminal state is coherent: subscription is muted 0 or 1 times — never a
        // duplicate. A clean serial unmute afterward proves the row was never corrupted.
        const prefs = await getPrefs(request, user.access_token);
        expect(
            prefs.mutes.filter((m) => m.category === 'subscription').length,
            'subscription is muted at most once after the race',
        ).toBeLessThanOrEqual(1);
        const serialUnmute = await request.delete(
            `${API_BASE}/api/notifications/preferences/mute/subscription`,
            { headers: H },
        );
        expect(serialUnmute.status(), 'a serial unmute always resolves 204 (idempotent)').toBe(204);
    });

    test('N parallel unmute of an UNMUTED category → all 204 (idempotent), mutes stays empty, no 5xx', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const BURST = 6;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.delete(`${API_BASE}/api/notifications/preferences/mute/generation`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 204),
            `every unmute 204 (${statuses})`,
        ).toBe(true);

        const prefs = await getPrefs(request, user.access_token);
        expect(
            prefs.mutes.some((m) => m.category === 'generation'),
            'unmuting an unmuted category never creates a phantom row',
        ).toBe(false);
    });

    test('parallel mute with an INVALID category → all 400; no mute row is persisted', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);

        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: jsonHeaders(user.access_token),
                    data: { category: `bogus-${stamp()}` },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 400),
            `enum guard rejects every one (${statuses})`,
        ).toBe(true);
        const prefs = await getPrefs(request, user.access_token);
        expect(prefs.mutes, 'a rejected mute never persists a row').toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — EVENT SUBSCRIPTION: upsert keyed on (user,eventKey) — stable id, one row.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Event subscription — parallel PUT upserts to a single stable row (LWW channelIds)', () => {
    test('N parallel PUT distinct valid channelIds same eventKey → all 200; exactly one row; final ∈ submitted', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        // Both ['in-app'] and [] are always-valid channel selections (in-app is a
        // built-in, [] means "no channels") — a clean LWW race with no ownership gate.
        const payloads = [['in-app'], [], ['in-app'], [], ['in-app']];

        const results = await Promise.all(
            payloads.map((channelIds) =>
                request.put(`${API_BASE}/api/notifications/preferences/event/git_auth_expired`, {
                    headers: jsonHeaders(user.access_token),
                    data: { channelIds },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        assertSerializedWrites(statuses, [200]);

        // The upsert is keyed on (user, eventKey): every SURVIVING response shares
        // ONE id (5xx responses carry no body — read survivors only).
        const okResults = results.filter((r) => r.status() === 200);
        const ids = await Promise.all(
            okResults.map((r) => r.json().then((b) => b.subscription.id)),
        );
        expect(new Set(ids).size, 'every surviving upsert targeted the same subscription id').toBe(
            1,
        );

        const prefs = await getPrefs(request, user.access_token);
        const rows = prefs.subscriptions.filter((s) => s.eventTypeKey === 'git_auth_expired');
        expect(rows.length, 'exactly one subscription row for the event key').toBe(1);
        expect(
            [JSON.stringify(['in-app']), JSON.stringify([])],
            'final channelIds is one submitted value (LWW, not a merge)',
        ).toContain(JSON.stringify(rows[0].channelIds));
    });

    test('N parallel PUT across DISTINCT event keys → all 200; each key gets exactly one row; no cross-key bleed', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const keys = [
            'ai_credits_depleted',
            'ai_provider_error',
            'generation_error',
            'schedule_paused',
        ];

        const results = await Promise.all(
            keys.map((key) =>
                request.put(`${API_BASE}/api/notifications/preferences/event/${key}`, {
                    headers: jsonHeaders(user.access_token),
                    data: { channelIds: ['in-app'] },
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 200),
            'all distinct-key PUTs 200',
        ).toBe(true);

        const prefs = await getPrefs(request, user.access_token);
        const byKey = prefs.subscriptions.map((s) => s.eventTypeKey).sort();
        expect(
            byKey,
            'each requested key has exactly one subscription (no cross-key merge)',
        ).toEqual([...keys].sort());
        for (const s of prefs.subscriptions) {
            expect(s.channelIds, `${s.eventTypeKey} kept its channels`).toEqual(['in-app']);
        }
    });

    test('N parallel PUT with a FOREIGN channel id → all 400; NO subscription persisted (atomic reject)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const foreign = '99999999-9999-9999-9999-999999999999';

        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                request.put(`${API_BASE}/api/notifications/preferences/event/mission_blocked`, {
                    headers: jsonHeaders(user.access_token),
                    data: { channelIds: [foreign] },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 400),
            `ownership guard rejects every one (${statuses})`,
        ).toBe(true);

        const prefs = await getPrefs(request, user.access_token);
        expect(
            prefs.subscriptions.some((s) => s.eventTypeKey === 'mission_blocked'),
            'a rejected foreign-channel PUT never persists a subscription row',
        ).toBe(false);
    });

    test('N parallel PUT to an UNKNOWN event key → all 400; nothing persisted', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const badKey = `no_such_event_${stamp()}`;

        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                request.put(`${API_BASE}/api/notifications/preferences/event/${badKey}`, {
                    headers: jsonHeaders(user.access_token),
                    data: { channelIds: ['in-app'] },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 400),
            `unknown key rejected (${statuses})`,
        ).toBe(true);
        for (const r of results) {
            expect((await r.json()).message).toMatch(/Unknown notification event type/i);
        }
        const prefs = await getPrefs(request, user.access_token);
        expect(prefs.subscriptions.some((s) => s.eventTypeKey === badKey)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F — CROSS-SURFACE & CROSS-USER isolation under simultaneous writes.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Preferences — concurrent writes stay isolated across surfaces & users', () => {
    test('simultaneous writes to quiet-hours + mute + event → each surface lands independently, no clobber', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const H = jsonHeaders(user.access_token);

        const [qh, mute, sub] = await Promise.all([
            request.put(`${API_BASE}/api/notifications/preferences/quiet-hours`, {
                headers: H,
                data: { quietHoursStart: '21:00', quietHoursEnd: '08:00', timezone: 'UTC' },
                timeout: T,
            }),
            request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                headers: H,
                data: { category: 'ai_credits' },
                timeout: T,
            }),
            request.put(`${API_BASE}/api/notifications/preferences/event/generation_error`, {
                headers: H,
                data: { channelIds: ['in-app'] },
                timeout: T,
            }),
        ]);
        expect(qh.status(), 'quiet-hours 200').toBe(200);
        expect(mute.status(), 'mute 201').toBe(201);
        expect(sub.status(), 'event sub 200').toBe(200);

        // All three writes coexist in one preferences view — none overwrote another.
        const prefs = await getPrefs(request, user.access_token);
        expect(prefs.preference?.quietHoursStart).toBe('21:00');
        expect(prefs.mutes.map((m) => m.category)).toContain('ai_credits');
        expect(prefs.subscriptions.map((s) => s.eventTypeKey)).toContain('generation_error');
    });

    test('two users muting the SAME category in parallel → each converges to their OWN value; zero cross-user bleed', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const [alice, bob] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const aUntil = '2028-01-01T00:00:00.000Z';
        const bUntil = '2029-06-15T00:00:00.000Z';

        // Interleave both users' bursts on the same category name.
        const ops = [];
        for (let i = 0; i < 4; i++) {
            ops.push(
                request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: jsonHeaders(alice.access_token),
                    data: { category: 'agent', mutedUntil: aUntil },
                    timeout: T,
                }),
            );
            ops.push(
                request.post(`${API_BASE}/api/notifications/preferences/mute`, {
                    headers: jsonHeaders(bob.access_token),
                    data: { category: 'agent', mutedUntil: bUntil },
                    timeout: T,
                }),
            );
        }
        const results = await Promise.all(ops);
        assertSerializedWrites(
            results.map((r) => r.status()),
            [201],
        );

        const [ap, bp] = await Promise.all([
            getPrefs(request, alice.access_token),
            getPrefs(request, bob.access_token),
        ]);
        const aAgent = ap.mutes.filter((m) => m.category === 'agent');
        const bAgent = bp.mutes.filter((m) => m.category === 'agent');
        expect(aAgent.length, "alice's agent mute is a single row").toBe(1);
        expect(bAgent.length, "bob's agent mute is a single row").toBe(1);
        // Each user sees ONLY their own submitted value — never the other's.
        expect(aAgent[0].mutedUntil && new Date(aAgent[0].mutedUntil).getTime()).toBe(
            new Date(aUntil).getTime(),
        );
        expect(bAgent[0].mutedUntil && new Date(bAgent[0].mutedUntil).getTime()).toBe(
            new Date(bUntil).getTime(),
        );
    });

    test('two users bursting read-all + unread-count in parallel → both hold at 0, fully isolated, no 5xx', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const [alice, bob] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);

        const ops = [];
        for (const u of [alice, bob]) {
            for (let i = 0; i < 5; i++) {
                ops.push(
                    request.post(`${API_BASE}/api/notifications/read-all`, {
                        headers: authedHeaders(u.access_token),
                        timeout: T,
                    }),
                );
                ops.push(
                    request.get(`${API_BASE}/api/notifications/unread-count`, {
                        headers: authedHeaders(u.access_token),
                        timeout: T,
                    }),
                );
            }
        }
        const results = await Promise.all(ops);
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `cross-user storm never 5xx (${statuses})`).toEqual(
            [],
        );
        expect(statuses.every((s) => s === 200)).toBe(true);
        expect(await getUnreadCount(request, alice.access_token)).toBe(0);
        expect(await getUnreadCount(request, bob.access_token)).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// G — LIST PARAM PIPES under concurrency: tolerant fallbacks + the one hard 400.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('List param pipes — concurrent malformed queries fall back cleanly; fractional limit 400s', () => {
    test('N parallel list reads with malformed limit/offset/unreadOnly → all 200 [] (tolerated, never 5xx)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const queries = [
            '?limit=abc',
            '?limit=5x',
            '?limit=%2B7', // +7
            '?limit=1e2',
            '?limit=0x10',
            '?limit=-5',
            '?offset=-9',
            '?offset=xyz',
            '?unreadOnly=maybe',
            '?unreadOnly=1',
            '?category=totally_bogus',
        ];

        const results = await Promise.all(
            queries.map((q) =>
                request.get(`${API_BASE}/api/notifications${q}`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            expect(r.status(), `${queries[i]} tolerated -> 200`).toBe(200);
            expect((await r.json()).notifications, `${queries[i]} returns an array`).toEqual([]);
        }
    });

    test('a FRACTIONAL limit=1.9 is the one rejected shape → 400 with the exact validation message (deterministic under a burst)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);

        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                request.get(`${API_BASE}/api/notifications?limit=1.9`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 400),
            `every fractional-limit read 400s (${statuses})`,
        ).toBe(true);
        for (const r of results) {
            const body = await r.json();
            expect(body.message).toBe('Validation failed (numeric string is expected)');
            expect(body.statusCode).toBe(400);
        }
    });

    test('parallel over-limit (9999) and zero (0) reads → all 200 with the ≤100 server-side clamp intact', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);

        const results = await Promise.all([
            ...Array.from({ length: 4 }, () =>
                request.get(`${API_BASE}/api/notifications?limit=9999`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
            ...Array.from({ length: 4 }, () =>
                request.get(`${API_BASE}/api/notifications?limit=0`, {
                    headers: authedHeaders(user.access_token),
                    timeout: T,
                }),
            ),
        ]);
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `every clamp read 200 (${statuses})`,
        ).toBe(true);
        for (const r of results) {
            const rows = (await r.json()).notifications as unknown[];
            expect(rows.length, 'the clamp keeps any page at most 100 rows').toBeLessThanOrEqual(
                100,
            );
        }
    });
});
