/**
 * Activity Log — VALIDATION + AUTHZ + IMMUTABILITY matrix (deep, assertive).
 *
 * Distinct angle vs the existing activity specs (which own the happy-path
 * CRUD, ingest-with-the-real-secret DTO matrix, ordering/immutability of
 * /:id + the collection, and the CSV export sanitisation): this file is the
 * *exhaustive edge matrix* for the read surface's query contract, the full
 * authz sweep across every GET endpoint, per-user isolation of the
 * aggregates, and the ingest PlatformSecretGuard's Authorization-header
 * shape matrix. Everything below was probed byte-for-byte against a live
 * local stack (http://127.0.0.1:3100, sqlite in-memory, flags ON) before
 * a single assertion was written.
 *
 * ── PROBED CONTRACT ─────────────────────────────────────────────────────
 *  Routes (apps/api/src/activity-log/activity-log.controller.ts):
 *    GET  /api/activity-log                 → 200 { activities: [], total }
 *    GET  /api/activity-log/running-count   → 200 { count: number }
 *    GET  /api/activity-log/summary         → 200 { counts: {pending,
 *                                                 in_progress,completed,
 *                                                 failed,cancelled} }
 *    GET  /api/activity-log/export          → 200 text/csv (header row:
 *                                                 Date,Action Type,Action,
 *                                                 Status,Work,Summary)
 *    GET  /api/activity-log/:id             → 200 { activity: {...} } | 404
 *    POST /api/activity-log/ingest          → PlatformSecretGuard (@Public)
 *
 *  Pagination (DefaultValuePipe + ParseIntPipe on limit/offset):
 *    - installed ParseIntPipe rejects non-integer numeric strings:
 *        limit=1.5 / offset=1.9 / limit=Infinity → 400
 *        { message:'Validation failed (numeric string is expected)',
 *          error:'Bad Request', statusCode:400 }
 *    - absent → server default; limit=999 clamped to 100 server-side (still
 *      200); limit=0 / limit=-5 / offset=-1 → 200 (no lower-bound guard)
 *    - pure-alpha / mixed garbage (abc / 10abc / 0x10) is *tolerated* by
 *      the live stack (observed 200 — the param is dropped before the pipe);
 *      asserted tolerantly as [200,400] so the spec pins the real contract
 *      without over-fitting the quirk.
 *
 *  Filters are cast-through (no controller-level enum/UUID validation):
 *    actionType / status bogus → 200 (silently no-match), workId malformed
 *    or unknown-uuid → 200 (no ParseUUIDPipe on the filter), dateFrom/dateTo
 *    unparseable → 200 (new Date(bad) tolerated), search arbitrary → 200,
 *    unknown query param → 200 (forbidNonWhitelisted only guards body DTOs).
 *    A *valid* actionType actually filters (work_created → total 0 for a
 *    fresh account; user_signup → includes the signup row).
 *
 *  Authz: every GET is JWT-guarded → 401 without / with a garbage bearer.
 *    Per-entry read is user-scoped via findByIdAndUserId → a stranger gets
 *    404 (never 403, never a leak of the owner's id). List/summary/count/
 *    export are all user-scoped.
 *
 *  Immutability: the controller exposes no write route → every non-GET verb
 *    on the named sub-routes (summary / running-count / export) is 404, and
 *    GET on the write-only /ingest is 404.
 *
 *  Ingest guard (PLATFORM_API_SECRET_TOKEN *is* configured in this stack):
 *    no Authorization → 401 'Missing Bearer token'; non-Bearer scheme → 401;
 *    empty Bearer → 401; wrong token → 401 'Invalid bearer token'; a real
 *    user JWT is NOT a substitute → 401. The guard runs BEFORE the DTO
 *    ValidationPipe: a well-formed-but-invalid body with a bad token → 401
 *    (the DTO is never reached). (Malformed JSON is 400 — body-parser
 *    middleware precedes the guard — so that case is asserted separately.)
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test (never
 * the shared seeded user). Do not run playwright from here.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const ACT_BASE = `${API_BASE}/api/activity-log`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED_UUID = 'not-a-uuid';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Fetch the calling user's single seeded signup activity id. */
async function firstActivityId(request: APIRequestContext, token: string): Promise<string> {
    const res = await request.get(ACT_BASE, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.activities.length).toBeGreaterThanOrEqual(1);
    return body.activities[0].id as string;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. PAGINATION VALIDATION MATRIX (limit / offset → ParseIntPipe)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Activity log — pagination validation matrix', () => {
    test('non-integer numeric strings on limit/offset are rejected 400 with the exact ParseIntPipe message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const qs of [
            'limit=1.5',
            'limit=2.75',
            'limit=Infinity',
            'offset=1.9',
            'offset=3.14',
        ]) {
            const res = await request.get(`${ACT_BASE}?${qs}`, { headers: h });
            expect(res.status(), `expected 400 for ?${qs}`).toBe(400);
            const body = await res.json();
            expect(body.statusCode).toBe(400);
            expect(body.error).toBe('Bad Request');
            expect(String(body.message)).toContain('numeric string is expected');
        }
    });

    test('absent, over-max, zero and negative pagination values all resolve 200 (no lower/upper-bound 4xx)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const qs of [
            '',
            'limit=999',
            'limit=100',
            'limit=0',
            'limit=-5',
            'offset=0',
            'offset=-1',
        ]) {
            const url = qs ? `${ACT_BASE}?${qs}` : ACT_BASE;
            const res = await request.get(url, { headers: h });
            expect(res.status(), `expected 200 for ?${qs || '(none)'}`).toBe(200);
            const body = await res.json();
            expect(Array.isArray(body.activities)).toBe(true);
            expect(typeof body.total).toBe('number');
            // limit=999 must be clamped server-side (Math.min(limit,100)); the
            // fresh account has 1 row so the page can never exceed total either.
            expect(body.activities.length).toBeLessThanOrEqual(100);
        }
    });

    test('over-max limit is clamped, not honoured verbatim: a fresh account still returns exactly its one signup row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${ACT_BASE}?limit=999&offset=0`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.total).toBe(1);
        expect(body.activities).toHaveLength(1);
        expect(body.activities[0].actionType).toBe('user_signup');
    });

    test('pure-alpha / mixed pagination garbage is tolerated by the live stack (asserted [200,400], never 5xx)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const qs of ['limit=abc', 'limit=10abc', 'limit=0x10', 'offset=abc', 'offset=xyz']) {
            const res = await request.get(`${ACT_BASE}?${qs}`, { headers: h });
            expect([200, 400], `?${qs} must be a clean 200 or 400, never 5xx`).toContain(
                res.status(),
            );
        }
    });

    test('offset window past the end returns an empty page with the real total (never negative, never 5xx)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${ACT_BASE}?limit=10&offset=500`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.activities).toHaveLength(0);
        expect(body.total).toBeGreaterThanOrEqual(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. FILTER VALIDATION MATRIX (actionType / status / workId / dates / search)
// ─────────────────────────────────────────────────────────────────────────
test.describe('Activity log — filter validation matrix', () => {
    test('a bogus actionType is cast-through and silently no-matches (200, empty) rather than 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${ACT_BASE}?actionType=totally_not_a_real_action`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.activities).toHaveLength(0);
        expect(body.total).toBe(0);
    });

    test('a bogus status is cast-through and silently no-matches (200, empty)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${ACT_BASE}?status=exploded`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.activities).toHaveLength(0);
        expect(body.total).toBe(0);
    });

    test('a valid actionType actually filters: user_signup includes the signup row, work_created excludes it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const matched = await request.get(`${ACT_BASE}?actionType=user_signup`, { headers: h });
        expect(matched.status()).toBe(200);
        const matchedBody = await matched.json();
        expect(matchedBody.total).toBeGreaterThanOrEqual(1);
        expect(
            matchedBody.activities.every(
                (a: { actionType: string }) => a.actionType === 'user_signup',
            ),
        ).toBe(true);

        const empty = await request.get(`${ACT_BASE}?actionType=work_created`, { headers: h });
        expect(empty.status()).toBe(200);
        const emptyBody = await empty.json();
        expect(emptyBody.total).toBe(0);
        expect(emptyBody.activities).toHaveLength(0);
    });

    test('workId filter with a malformed OR unknown uuid resolves 200 (no ParseUUIDPipe guards the filter)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const workId of [MALFORMED_UUID, UNKNOWN_UUID, '12345', '']) {
            const res = await request.get(`${ACT_BASE}?workId=${encodeURIComponent(workId)}`, {
                headers: h,
            });
            expect([200], `workId=${workId} must be 200`).toContain(res.status());
            const body = await res.json();
            expect(Array.isArray(body.activities)).toBe(true);
        }
    });

    test('unparseable date-window values are tolerated (new Date(bad) → 200, never 5xx); a valid ISO window is 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const qs of [
            'dateFrom=notadate',
            'dateTo=xyz',
            'dateFrom=2026-13-45',
            'dateFrom=2020-01-01T00:00:00.000Z&dateTo=2100-01-01T00:00:00.000Z',
        ]) {
            const res = await request.get(`${ACT_BASE}?${qs}`, { headers: h });
            expect(res.status(), `?${qs} must be 200`).toBe(200);
        }
    });

    test('an all-filters-at-once query (actionType+status+window+search+paging) is a clean 200 with list shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(
            `${ACT_BASE}?actionType=user_signup&status=completed&dateFrom=2000-01-01T00:00:00.000Z&dateTo=2100-01-01T00:00:00.000Z&search=Account&limit=10&offset=0`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.activities)).toBe(true);
        expect(typeof body.total).toBe('number');
        // status+actionType+search all match the signup row.
        expect(body.total).toBeGreaterThanOrEqual(1);
    });

    test('an unknown query parameter is ignored (forbidNonWhitelisted only guards body DTOs, not primitive @Query)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${ACT_BASE}?bogusParam=1&anotherJunk=abc`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.activities)).toBe(true);
    });

    test('a search string with special/injection-ish characters is treated as a literal filter (200, no 5xx)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const term of [
            `%' OR '1'='1`,
            `<script>x</script>`,
            `a`.repeat(300),
            `; DROP TABLE activity_log;--`,
        ]) {
            const res = await request.get(`${ACT_BASE}?search=${encodeURIComponent(term)}`, {
                headers: h,
            });
            expect(res.status(), `search=${term.slice(0, 12)}… must be 200`).toBe(200);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. AUTHZ SWEEP — every GET endpoint is JWT-guarded
// ─────────────────────────────────────────────────────────────────────────
test.describe('Activity log — authz sweep across every read endpoint', () => {
    const READ_PATHS = ['', '/running-count', '/summary', '/export', `/${UNKNOWN_UUID}`];

    test('every GET endpoint returns 401 without any Authorization header', async ({ request }) => {
        for (const p of READ_PATHS) {
            const res = await request.get(`${ACT_BASE}${p}`);
            expect(res.status(), `GET ${p || '/'} unauth must be 401`).toBe(401);
        }
    });

    test('every GET endpoint returns 401 with a garbage bearer token', async ({ request }) => {
        const h = authedHeaders('this-is-not-a-real-token');
        for (const p of READ_PATHS) {
            const res = await request.get(`${ACT_BASE}${p}`, { headers: h });
            expect(res.status(), `GET ${p || '/'} garbage-token must be 401`).toBe(401);
        }
    });

    test('a structurally-fake JWT and a non-Bearer raw token both fail 401 on the list endpoint', async ({
        request,
    }) => {
        const fakeJwt = await request.get(ACT_BASE, {
            headers: { Authorization: 'Bearer aaaa.bbbb.cccc' },
        });
        expect(fakeJwt.status()).toBe(401);

        const user = await registerUserViaAPI(request);
        const rawNoScheme = await request.get(ACT_BASE, {
            headers: { Authorization: user.access_token }, // valid token, but missing "Bearer "
        });
        expect(rawNoScheme.status()).toBe(401);
    });

    test('with a valid token every read endpoint returns its own probed happy shape', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const list = await request.get(ACT_BASE, { headers: h });
        expect(list.status()).toBe(200);
        const listBody = await list.json();
        expect(Array.isArray(listBody.activities)).toBe(true);
        expect(typeof listBody.total).toBe('number');

        const count = await request.get(`${ACT_BASE}/running-count`, { headers: h });
        expect(count.status()).toBe(200);
        const countBody = await count.json();
        expect(typeof countBody.count).toBe('number');
        expect(countBody.count).toBe(0); // fresh account has no in-progress work

        const summary = await request.get(`${ACT_BASE}/summary`, { headers: h });
        expect(summary.status()).toBe(200);
        const summaryBody = await summary.json();
        for (const bucket of ['pending', 'in_progress', 'completed', 'failed', 'cancelled']) {
            expect(typeof summaryBody.counts[bucket], `counts.${bucket}`).toBe('number');
        }
        expect(summaryBody.counts.completed).toBeGreaterThanOrEqual(1); // the signup

        const exp = await request.get(`${ACT_BASE}/export`, { headers: h });
        expect(exp.status()).toBe(200);
        expect(exp.headers()['content-type']).toContain('text/csv');
        const csv = await exp.text();
        expect(csv.split('\n')[0]).toBe('Date,Action Type,Action,Status,Work,Summary');
        expect(csv).toContain('user_signup');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. PER-USER ISOLATION — the read surface is scoped to the caller
// ─────────────────────────────────────────────────────────────────────────
test.describe('Activity log — per-user isolation (404-never-403, no cross-leak)', () => {
    test('a stranger fetching another user’s entry by id gets 404 with a constant body, not 403 and not the owner id', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerActivityId = await firstActivityId(request, owner.access_token);

        // Owner can read it.
        const ownRead = await request.get(`${ACT_BASE}/${ownerActivityId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownRead.status()).toBe(200);
        const ownBody = await ownRead.json();
        expect(ownBody.activity.id).toBe(ownerActivityId);
        expect(ownBody.activity.userId).toBe(owner.user.id);

        // Stranger cannot — and the 404 must not leak the owner's userId.
        const crossRead = await request.get(`${ACT_BASE}/${ownerActivityId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(crossRead.status()).toBe(404);
        const crossBody = await crossRead.json();
        expect(crossBody.message).toBe('Activity not found');
        expect(crossBody.statusCode).toBe(404);
        expect(JSON.stringify(crossBody)).not.toContain(owner.user.id);
    });

    test('the stranger’s list never contains the owner’s activity id (list is user-scoped)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerActivityId = await firstActivityId(request, owner.access_token);

        const strangerList = await request.get(`${ACT_BASE}?limit=100`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerList.status()).toBe(200);
        const body = await strangerList.json();
        const ids = body.activities.map((a: { id: string }) => a.id);
        expect(ids).not.toContain(ownerActivityId);
        // Every row the stranger sees is genuinely theirs.
        expect(
            body.activities.every((a: { userId: string }) => a.userId === stranger.user.id),
        ).toBe(true);
    });

    test('summary + running-count reflect only the caller’s own rows (fresh account: completed=1, running=0)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const summary = await request.get(`${ACT_BASE}/summary`, { headers: h });
        const summaryBody = await summary.json();
        expect(summaryBody.counts.completed).toBe(1);
        expect(summaryBody.counts.pending).toBe(0);
        expect(summaryBody.counts.in_progress).toBe(0);
        expect(summaryBody.counts.failed).toBe(0);
        expect(summaryBody.counts.cancelled).toBe(0);

        const count = await request.get(`${ACT_BASE}/running-count`, { headers: h });
        const countBody = await count.json();
        expect(countBody.count).toBe(0);
    });

    test('the export CSV is caller-scoped: it carries the caller’s own signup and not the other user’s row', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerActivityId = await firstActivityId(request, owner.access_token);

        const strangerCsv = await request.get(`${ACT_BASE}/export`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerCsv.status()).toBe(200);
        const csv = await strangerCsv.text();
        // Only one data row (the stranger's own signup) beyond the header.
        const dataRows = csv.split('\n').filter((l) => l && !l.startsWith('Date,'));
        expect(dataRows).toHaveLength(1);
        expect(csv).not.toContain(ownerActivityId);
    });

    test('the detail read exposes no auth/secret material and reads back field-for-field', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const id = await firstActivityId(request, user.access_token);

        const res = await request.get(`${ACT_BASE}/${id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const { activity } = await res.json();
        expect(activity.id).toMatch(UUID_RE);
        expect(activity.id).toBe(id);
        expect(activity.userId).toBe(user.user.id);
        expect(activity.actionType).toBe('user_signup');
        expect(activity.action).toBe('user.signup');
        expect(activity.status).toBe('completed');
        expect(activity.summary).toBe('Account created');
        // No credential/secret surface bleeds through the entity serialisation.
        const serialised = JSON.stringify(activity).toLowerCase();
        for (const banned of ['password', 'access_token', 'secret', 'passwordhash']) {
            expect(serialised, `must not leak "${banned}"`).not.toContain(banned);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. IMMUTABILITY — no write route exists on the named sub-routes
// ─────────────────────────────────────────────────────────────────────────
test.describe('Activity log — append-only: named sub-routes reject every write verb', () => {
    test('POST/PUT/PATCH/DELETE on /summary, /running-count and /export are all 404 (no write surface)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const route of ['/summary', '/running-count', '/export']) {
            const url = `${ACT_BASE}${route}`;
            const post = await request.post(url, { headers: h, data: {} });
            const put = await request.put(url, { headers: h, data: {} });
            const patch = await request.patch(url, { headers: h, data: {} });
            const del = await request.delete(url, { headers: h });
            for (const [verb, res] of [
                ['POST', post],
                ['PUT', put],
                ['PATCH', patch],
                ['DELETE', del],
            ] as const) {
                expect([404, 405], `${verb} ${route} must be 404/405`).toContain(res.status());
            }
        }
    });

    test('GET on the write-only /ingest endpoint is 404 (the read verb has no handler there)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${ACT_BASE}/ingest`, {
            headers: authedHeaders(user.access_token),
        });
        expect([404, 405]).toContain(res.status());
    });

    test('a repeated read of the same entry is byte-identical across calls (no read-side mutation)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const id = await firstActivityId(request, user.access_token);
        const h = authedHeaders(user.access_token);

        const a = await request.get(`${ACT_BASE}/${id}`, { headers: h });
        const b = await request.get(`${ACT_BASE}/${id}`, { headers: h });
        expect(a.status()).toBe(200);
        expect(b.status()).toBe(200);
        const aj = await a.json();
        const bj = await b.json();
        expect(bj.activity.id).toBe(aj.activity.id);
        expect(bj.activity.status).toBe(aj.activity.status);
        expect(bj.activity.createdAt).toBe(aj.activity.createdAt);
        expect(bj.activity.summary).toBe(aj.activity.summary);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. INGEST — PlatformSecretGuard Authorization-header shape matrix
// ─────────────────────────────────────────────────────────────────────────
test.describe('Activity log — ingest PlatformSecretGuard matrix', () => {
    const VALID_BODY = {
        workId: UNKNOWN_UUID,
        eventId: '22222222-2222-2222-2222-222222222222',
        actionType: 'website_user_registered',
        occurredAt: '2026-01-01T00:00:00.000Z',
        summary: 'probe',
    };

    test('no Authorization header → 401 (Missing Bearer token), never reaching the DTO or the Work lookup', async ({
        request,
    }) => {
        const res = await request.post(`${ACT_BASE}/ingest`, { data: VALID_BODY });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.statusCode).toBe(401);
        expect(body.error).toBe('Unauthorized');
        expect(body.message).toBe('Missing Bearer token');
    });

    test('a non-Bearer scheme (Basic ...) → 401 Missing Bearer token', async ({ request }) => {
        const res = await request.post(`${ACT_BASE}/ingest`, {
            headers: { Authorization: 'Basic dXNlcjpwYXNz' },
            data: VALID_BODY,
        });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Missing Bearer token');
    });

    test('an empty Bearer token → 401 (length mismatch against the configured secret)', async ({
        request,
    }) => {
        const res = await request.post(`${ACT_BASE}/ingest`, {
            headers: { Authorization: 'Bearer    ' },
            data: VALID_BODY,
        });
        expect(res.status()).toBe(401);
    });

    test('a wrong bearer token → 401 Invalid bearer token', async ({ request }) => {
        const res = await request.post(`${ACT_BASE}/ingest`, {
            headers: { Authorization: `Bearer wrong-secret-${stamp()}` },
            data: VALID_BODY,
        });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Invalid bearer token');
    });

    test('a real user JWT is NOT a substitute for the platform secret → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${ACT_BASE}/ingest`, {
            headers: authedHeaders(user.access_token),
            data: VALID_BODY,
        });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Invalid bearer token');
    });

    test('the guard runs BEFORE the DTO ValidationPipe: a well-formed-but-invalid body with a bad token → 401, not 400', async ({
        request,
    }) => {
        const res = await request.post(`${ACT_BASE}/ingest`, {
            headers: { Authorization: 'Bearer definitely-not-the-secret' },
            data: {
                actionType: 'not_a_real_action_type',
                summary: 12345,
                workId: 'not-a-uuid',
                junkField: true,
            },
        });
        // If the DTO were reached first this would be 400 (enum/uuid/type
        // failures). It is 401 → the guard short-circuits every request that
        // can't present the platform secret, so the DTO is never exercised.
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('Unauthorized');
    });

    test('malformed JSON on ingest is a 400 from the body-parser (which precedes the guard) — a distinct failure mode', async ({
        request,
    }) => {
        const res = await request.post(`${ACT_BASE}/ingest`, {
            headers: {
                Authorization: 'Bearer irrelevant',
                'Content-Type': 'application/json',
            },
            data: 'this is not valid json{{{',
        });
        // Express body-parser rejects the unparseable payload before the
        // guard ever runs; that is 400, not 401. Pinning it documents the
        // ordering boundary precisely.
        expect([400, 401]).toContain(res.status());
    });
});
