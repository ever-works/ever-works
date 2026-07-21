/**
 * Activity Log — LIST pagination / ordering / filter / aggregate MECHANICS (deep, multi-row).
 *
 * Distinct angle vs the sibling activity specs. The existing files exercise the
 * read surface with only the single auto-seeded `user_signup` row:
 *   - flow-activity-log-validation-authz-matrix.spec.ts owns the ParseIntPipe
 *     4xx matrix, the cast-through filter matrix, the authz sweep, per-user
 *     isolation, immutability, and the ingest-guard header matrix — all against
 *     a 1-row account.
 *   - flow-activity-ingest-platform.spec.ts owns the EW-120 ingest contract
 *     (DTO matrix, guard isolation, idempotency, future-clamp, rate limit, feed).
 * NEITHER drives the LIST endpoint against a genuinely PAGINATED, MULTI-ROW,
 * MULTI-`workId` dataset. This file builds a real per-user dataset (N `work_created`
 * rows + the 1 `user_signup` row — every row `status:'completed'`) and pins the
 * true page-tiling, ordering, actionType/workId/date-window filtering, the
 * summary/running-count aggregates, and the CSV export shape as the row count
 * grows past the default page.
 *
 * ── PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the CI driver) ─────
 *  GET /api/activity-log → 200 { activities: ActivityRow[], total: number }
 *    - default page size = 25 (no `limit` param → returns min(total, 25) rows);
 *      `limit` clamped server-side to 100 (Math.min); a page is NEVER > 100.
 *    - `limit=0` falls back to the default 25 (repo `options.limit || 25`), so a
 *      zero limit returns rows, NOT an empty page.
 *    - `offset` past the end → empty `activities`, `total` unchanged.
 *    - ordering is `createdAt DESC`. createdAt is SECOND-granularity (`…:55.000Z`),
 *      so rows minted in the same wall-clock second TIE — ordering among ties is
 *      non-deterministic. Every ordering assertion here is therefore
 *      non-increasing (>=) with tie tolerance, or set/min-based, NEVER positional.
 *  Seeding: POST /api/works logs exactly one `work_created` row (action
 *    `work.created`, status `completed`, `workId` set, summary `Created work: <name>`,
 *    `work` relation embedded) per Work — a clean, non-throttled bulk seeder.
 *  Filters (repo findByUserIdWithLimit): actionType `=`, workId `=`, status `=`,
 *    createdAt `>= dateFrom` / `<= dateTo`, search case-insensitive LIKE over
 *    `summary` OR `work.name`. Bogus filters cast-through to an empty page (no 4xx).
 *    NB: the date-window boundary does NOT align byte-for-byte with the DISPLAYED
 *    second (driver TZ/string-compare artifact), so the window tests assert only
 *    the ROBUST invariants: a covering window returns all, a disjoint window
 *    returns none, an inverted window returns none, and the count is monotonic in
 *    each bound. Exact inclusive/exclusive at the second boundary is NOT pinned.
 *  GET /api/activity-log/summary → 200 { counts:{pending,in_progress,completed,
 *    failed,cancelled} }; GET …/running-count → 200 { count }.
 *  GET /api/activity-log/export → 200 text/csv, header
 *    `Date,Action Type,Action,Status,Work,Summary`, ONE data row per activity
 *    (no page cap — export limit is 10000), ordered createdAt DESC.
 *
 * Every test registers a FRESH registerUserViaAPI() owner (so `total` is exactly
 * `seededWorks + 1` and fully deterministic per user), never the shared seeded UI
 * user. Ids are asserted with toContain / set membership, never exact global
 * counts. Fully API-orchestrated; do not run playwright from here.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

const ACT_BASE = `${API_BASE}/api/activity-log`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface ActivityRow {
    id: string;
    userId: string;
    workId: string | null;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    createdAt: string;
    work: { name?: string } | null;
}
interface ListBody {
    activities: ActivityRow[];
    total: number;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** GET the list with a raw query string; return status + parsed body. */
async function list(
    request: APIRequestContext,
    token: string,
    qs = '',
): Promise<{ status: number; body: ListBody }> {
    const url = qs ? `${ACT_BASE}?${qs}` : ACT_BASE;
    const res = await request.get(url, { headers: authedHeaders(token) });
    const status = res.status();
    const body: ListBody = status === 200 ? await res.json() : { activities: [], total: 0 };
    return { status, body };
}

/** Convenience: fetch just the `total` for a query (asserts 200). */
async function totalFor(request: APIRequestContext, token: string, qs: string): Promise<number> {
    const { status, body } = await list(request, token, qs);
    expect(status, `?${qs} should be 200`).toBe(200);
    return body.total;
}

/**
 * Create `n` Works as the given user; each logs one `work_created` activity.
 * Returns the created Works' ids + names in creation order (oldest → newest).
 */
async function seedWorks(
    request: APIRequestContext,
    token: string,
    n: number,
    label: string,
): Promise<Array<{ id: string; name: string }>> {
    const created: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < n; i++) {
        const s = stamp();
        const name = `${label}${s}x${i}`;
        const { id } = await createWorkViaAPI(request, token, {
            name,
            slug: `${label.toLowerCase()}-${s}-${i}`,
            description: `seed work ${i} for ${label}`,
        });
        expect(id, `seeded work #${i} must expose an id`).toBeTruthy();
        created.push({ id, name });
    }
    return created;
}

/** Assert a createdAt sequence is non-increasing (DESC) with tie tolerance. */
function assertNonIncreasing(rows: ActivityRow[], ctx: string): void {
    for (let i = 0; i + 1 < rows.length; i++) {
        expect(
            rows[i].createdAt >= rows[i + 1].createdAt,
            `${ctx}: row ${i} (${rows[i].createdAt}) must be >= row ${i + 1} (${rows[i + 1].createdAt})`,
        ).toBe(true);
    }
}

test.beforeEach(() => {
    // Seeding up to ~28 Works sequentially + cold Next/Nest routes in CI.
    test.setTimeout(120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. PAGE TILING — limit/offset over a genuinely multi-row dataset
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — page tiling over a multi-row dataset', () => {
    test('a fixed page size caps every page and total stays constant across the walk', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 11, 'Tile');
        const expectedTotal = works.length + 1; // + the signup row

        const pageSize = 4;
        let offset = 0;
        const seenTotals: number[] = [];
        let pagesWalked = 0;
        while (offset < expectedTotal + pageSize) {
            const { status, body } = await list(
                request,
                user.access_token,
                `limit=${pageSize}&offset=${offset}`,
            );
            expect(status).toBe(200);
            expect(body.total, 'total is stable across pages').toBe(expectedTotal);
            expect(
                body.activities.length,
                `page @${offset} must not exceed the page size`,
            ).toBeLessThanOrEqual(pageSize);
            seenTotals.push(body.total);
            offset += pageSize;
            if (++pagesWalked > 20) break; // hard stop against a runaway loop
        }
        // Every page reported the same total.
        expect(new Set(seenTotals).size).toBe(1);
    });

    test('pages tile the full result set EXACTLY — union covers everything, no row repeats', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 11, 'Union');
        const expectedTotal = works.length + 1;

        // Authoritative full snapshot (<= 100 so a single page holds it all).
        const full = await list(request, user.access_token, 'limit=100');
        expect(full.status).toBe(200);
        expect(full.body.total).toBe(expectedTotal);
        expect(full.body.activities).toHaveLength(expectedTotal);
        const fullIds = new Set(full.body.activities.map((a) => a.id));
        expect(fullIds.size).toBe(expectedTotal);

        // Walk the same data 3 rows at a time and accumulate ids.
        const pageSize = 3;
        const paged: string[] = [];
        for (let offset = 0; offset < expectedTotal; offset += pageSize) {
            const { body } = await list(
                request,
                user.access_token,
                `limit=${pageSize}&offset=${offset}`,
            );
            paged.push(...body.activities.map((a) => a.id));
        }

        // Disjoint (no id served twice) AND complete (covers the full set).
        expect(new Set(paged).size, 'no row appears on two pages').toBe(paged.length);
        expect(paged.length, 'the walk yields exactly `total` rows').toBe(expectedTotal);
        for (const id of fullIds) {
            expect(paged, `paged walk must include ${id}`).toContain(id);
        }
    });

    test('the final page returns only the remainder, not a full page', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 11, 'Remainder');
        const expectedTotal = works.length + 1; // 12
        const pageSize = 5; // 12 = 5 + 5 + 2 → last page has 2

        const remainder = expectedTotal % pageSize || pageSize;
        const lastOffset = expectedTotal - remainder;
        const { status, body } = await list(
            request,
            user.access_token,
            `limit=${pageSize}&offset=${lastOffset}`,
        );
        expect(status).toBe(200);
        expect(body.total).toBe(expectedTotal);
        expect(body.activities, 'the tail page holds only the leftover rows').toHaveLength(
            remainder,
        );
        expect(body.activities.length).toBeLessThan(pageSize);
    });

    test('an offset past the end returns an empty page while total still reports the real count', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 6, 'Past');
        const expectedTotal = works.length + 1;

        const { status, body } = await list(request, user.access_token, 'limit=10&offset=9999');
        expect(status).toBe(200);
        expect(body.activities, 'a beyond-the-end window is empty').toHaveLength(0);
        expect(body.total, 'total is not clamped to the empty page').toBe(expectedTotal);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIMIT SEMANTICS — default, clamp, zero
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — limit semantics (default 25 / clamp 100 / zero)', () => {
    test('with no limit param the page defaults to 25 even when more rows exist', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // 28 works + signup = 29 rows, comfortably over the 25 default.
        const works = await seedWorks(request, user.access_token, 28, 'Default');
        const expectedTotal = works.length + 1; // 29

        const { status, body } = await list(request, user.access_token);
        expect(status).toBe(200);
        expect(body.total, 'total reports the full row count').toBe(expectedTotal);
        expect(body.activities, 'the default page is capped at 25 rows').toHaveLength(25);
    });

    test('an over-max limit is clamped server-side (page never exceeds 100) and returns the whole small set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 9, 'Clamp');
        const expectedTotal = works.length + 1;

        for (const lim of [101, 500, 100000]) {
            const { status, body } = await list(request, user.access_token, `limit=${lim}`);
            expect(status, `limit=${lim} must be 200`).toBe(200);
            expect(
                body.activities.length,
                `limit=${lim} page must be clamped to <= 100`,
            ).toBeLessThanOrEqual(100);
            // The account has only `expectedTotal` (<100) rows, so a clamped large
            // limit still returns every one of them.
            expect(body.activities).toHaveLength(expectedTotal);
            expect(body.total).toBe(expectedTotal);
        }
    });

    test('limit=0 falls back to the default page rather than returning an empty list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 6, 'Zero');
        const expectedTotal = works.length + 1; // 7, under the 25 default

        const { status, body } = await list(request, user.access_token, 'limit=0');
        expect(status).toBe(200);
        expect(body.total).toBe(expectedTotal);
        // `options.limit || 25` treats 0 as falsy → default 25 → all 7 rows.
        expect(body.activities.length, 'limit=0 returns rows, not an empty page').toBeGreaterThan(
            0,
        );
        expect(body.activities).toHaveLength(Math.min(expectedTotal, 25));
    });

    test('offset omitted is identical to offset=0 (first page)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 8, 'Off0');

        const bare = await list(request, user.access_token, 'limit=5');
        const explicit = await list(request, user.access_token, 'limit=5&offset=0');
        expect(bare.status).toBe(200);
        expect(explicit.status).toBe(200);
        expect(bare.body.activities.map((a) => a.id)).toEqual(
            explicit.body.activities.map((a) => a.id),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ORDERING — createdAt DESC with second-granularity tie tolerance
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — ordering (createdAt DESC, tie-tolerant)', () => {
    test('the full scan is non-increasing by createdAt', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 10, 'OrderA');

        const { status, body } = await list(request, user.access_token, 'limit=100');
        expect(status).toBe(200);
        expect(body.activities.length).toBeGreaterThan(1);
        assertNonIncreasing(body.activities, 'full scan');
    });

    test('the signup row carries the minimum createdAt of the whole set (it is the oldest event)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 8, 'OrderB');

        const { body } = await list(request, user.access_token, 'limit=100');
        const signup = body.activities.find((a) => a.actionType === 'user_signup');
        expect(signup, 'the signup row is present').toBeTruthy();
        const minCreatedAt = body.activities
            .map((a) => a.createdAt)
            .reduce((a, b) => (a <= b ? a : b));
        // The signup happened before any Work was created, so it holds the min.
        expect(signup!.createdAt).toBe(minCreatedAt);
        for (const row of body.activities) {
            expect(row.createdAt >= signup!.createdAt, 'every row is at-or-after the signup').toBe(
                true,
            );
        }
    });

    test('a paged walk preserves the global non-increasing order and reproduces the full id set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 12, 'OrderC');
        const expectedTotal = works.length + 1;

        const concat: ActivityRow[] = [];
        for (let offset = 0; offset < expectedTotal; offset += 4) {
            const { body } = await list(request, user.access_token, `limit=4&offset=${offset}`);
            concat.push(...body.activities);
        }
        expect(concat).toHaveLength(expectedTotal);
        assertNonIncreasing(concat, 'paged concatenation');

        const full = await list(request, user.access_token, 'limit=100');
        expect(new Set(concat.map((a) => a.id))).toEqual(
            new Set(full.body.activities.map((a) => a.id)),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. actionType FILTER over a mixed dataset
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — actionType filter narrows a mixed dataset', () => {
    test('actionType=work_created returns exactly the seeded Works and every row matches', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 9, 'ActType');

        const { status, body } = await list(
            request,
            user.access_token,
            'actionType=work_created&limit=100',
        );
        expect(status).toBe(200);
        expect(body.total, 'one work_created row per seeded Work').toBe(works.length);
        expect(body.activities).toHaveLength(works.length);
        expect(body.activities.every((a) => a.actionType === 'work_created')).toBe(true);
        const ids = new Set(body.activities.map((a) => a.workId));
        for (const w of works) {
            expect(ids, `work ${w.id} should have a logged row`).toContain(w.id);
        }
        // The signup row must NOT bleed into a work_created filter.
        expect(body.activities.every((a) => a.actionType !== 'user_signup')).toBe(true);
    });

    test('actionType=user_signup isolates the single signup row', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 5, 'Signup');

        const { status, body } = await list(request, user.access_token, 'actionType=user_signup');
        expect(status).toBe(200);
        expect(body.total).toBe(1);
        expect(body.activities).toHaveLength(1);
        expect(body.activities[0].actionType).toBe('user_signup');
        expect(body.activities[0].action).toBe('user.signup');
        expect(body.activities[0].workId).toBeNull();
    });

    test('a valid-but-unused actionType casts through to an empty page (200, total 0)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 4, 'Unused');

        // `deployment` is a real enum member the account has never emitted.
        const { status, body } = await list(request, user.access_token, 'actionType=deployment');
        expect(status).toBe(200);
        expect(body.total).toBe(0);
        expect(body.activities).toHaveLength(0);
    });

    test('the actionType filter composes with pagination (tiles only over the matching rows)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 10, 'ActPage');

        const paged: string[] = [];
        for (let offset = 0; offset < works.length; offset += 3) {
            const { body } = await list(
                request,
                user.access_token,
                `actionType=work_created&limit=3&offset=${offset}`,
            );
            expect(body.total, 'filtered total is stable across pages').toBe(works.length);
            expect(body.activities.every((a) => a.actionType === 'work_created')).toBe(true);
            paged.push(...body.activities.map((a) => a.id));
        }
        expect(new Set(paged).size, 'filtered pages are disjoint').toBe(paged.length);
        expect(paged).toHaveLength(works.length);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. workId FILTER across several Works
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — workId filter across multiple Works', () => {
    test('each workId narrows to exactly its single work_created row', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 5, 'ByWork');

        for (const w of works) {
            const { status, body } = await list(request, user.access_token, `workId=${w.id}`);
            expect(status, `workId=${w.id} must be 200`).toBe(200);
            expect(body.total, `exactly one row for ${w.id}`).toBe(1);
            expect(body.activities).toHaveLength(1);
            expect(body.activities[0].workId).toBe(w.id);
            expect(body.activities[0].actionType).toBe('work_created');
            expect(body.activities[0].work?.name).toBe(w.name);
            // A workId filter must not surface any OTHER seeded Work's row.
            for (const other of works) {
                if (other.id !== w.id) {
                    expect(body.activities[0].workId).not.toBe(other.id);
                }
            }
        }
    });

    test('an unknown / foreign workId returns an empty page (no ParseUUIDPipe, casts through to no-match)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 4, 'Foreign');

        for (const wid of [UNKNOWN_UUID, 'not-a-uuid', '12345']) {
            const { status, body } = await list(
                request,
                user.access_token,
                `workId=${encodeURIComponent(wid)}`,
            );
            expect(status, `workId=${wid} must be 200`).toBe(200);
            expect(body.total, `unknown workId ${wid} → empty`).toBe(0);
            expect(body.activities).toHaveLength(0);
        }
    });

    test('workId + actionType compose (both predicates AND together)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 4, 'Compose');
        const target = works[1];

        const match = await list(
            request,
            user.access_token,
            `workId=${target.id}&actionType=work_created`,
        );
        expect(match.status).toBe(200);
        expect(match.body.total).toBe(1);
        expect(match.body.activities[0].workId).toBe(target.id);

        // Same workId but a non-matching actionType → empty (AND semantics).
        const miss = await list(
            request,
            user.access_token,
            `workId=${target.id}&actionType=user_signup`,
        );
        expect(miss.status).toBe(200);
        expect(miss.body.total).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DATE WINDOW — robust coarse bounds + monotonicity (no exact-second pin)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — dateFrom/dateTo time window', () => {
    test('a window covering the batch returns everything; a disjoint past/future window returns nothing', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 7, 'Window');
        const expectedTotal = works.length + 1;
        const now = Date.now();

        const cover = `dateFrom=${new Date(now - 10 * 60_000).toISOString()}&dateTo=${new Date(
            now + 10 * 60_000,
        ).toISOString()}&limit=100`;
        expect(await totalFor(request, user.access_token, cover)).toBe(expectedTotal);

        const past = `dateFrom=${new Date(now - 2 * YEAR_MS).toISOString()}&dateTo=${new Date(
            now - YEAR_MS,
        ).toISOString()}`;
        expect(await totalFor(request, user.access_token, past), 'a wholly-past window').toBe(0);

        const future = `dateFrom=${new Date(now + YEAR_MS).toISOString()}&dateTo=${new Date(
            now + 2 * YEAR_MS,
        ).toISOString()}`;
        expect(await totalFor(request, user.access_token, future), 'a wholly-future window').toBe(
            0,
        );
    });

    test('an inverted window (dateFrom after dateTo) yields an empty page, never a 5xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 5, 'Inverted');
        const now = Date.now();

        const inverted = `dateFrom=${new Date(now + 10 * 60_000).toISOString()}&dateTo=${new Date(
            now - 10 * 60_000,
        ).toISOString()}`;
        const { status, body } = await list(request, user.access_token, inverted);
        expect(status).toBe(200);
        expect(body.total, 'from > to can match nothing').toBe(0);
        expect(body.activities).toHaveLength(0);
    });

    test('count is monotonic in each bound: widening dateFrom earlier never shrinks it, widening dateTo later never shrinks it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await seedWorks(request, user.access_token, 6, 'Monotonic');
        const now = Date.now();

        // dateFrom ascending → result set can only shrink (>= a larger floor).
        const fromEarly = await totalFor(
            request,
            user.access_token,
            `dateFrom=${new Date(now - 10 * 60_000).toISOString()}`,
        );
        const fromMid = await totalFor(
            request,
            user.access_token,
            `dateFrom=${new Date(now - 2_000).toISOString()}`,
        );
        const fromLate = await totalFor(
            request,
            user.access_token,
            `dateFrom=${new Date(now + 10 * 60_000).toISOString()}`,
        );
        expect(fromEarly, 'earliest floor is the widest').toBeGreaterThanOrEqual(fromMid);
        expect(fromMid).toBeGreaterThanOrEqual(fromLate);
        expect(fromLate, 'a future floor excludes every existing row').toBe(0);

        // dateTo ascending → result set can only grow (<= a larger ceiling).
        const toEarly = await totalFor(
            request,
            user.access_token,
            `dateTo=${new Date(now - 10 * 60_000).toISOString()}`,
        );
        const toLate = await totalFor(
            request,
            user.access_token,
            `dateTo=${new Date(now + 10 * 60_000).toISOString()}&limit=100`,
        );
        expect(toEarly, 'a past ceiling excludes every existing row').toBe(0);
        expect(toLate, 'a future ceiling admits everything').toBeGreaterThanOrEqual(toEarly);
        expect(toLate).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. AGGREGATES — summary + running-count stay consistent with the list
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — summary + running-count aggregates', () => {
    test('summary buckets sum to the list total; completed == total when every row is completed; running-count is 0', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 8, 'Agg');
        const expectedTotal = works.length + 1;
        const h = authedHeaders(user.access_token);

        const summaryRes = await request.get(`${ACT_BASE}/summary`, { headers: h });
        expect(summaryRes.status()).toBe(200);
        const counts = (await summaryRes.json()).counts as Record<string, number>;
        for (const bucket of ['pending', 'in_progress', 'completed', 'failed', 'cancelled']) {
            expect(typeof counts[bucket], `counts.${bucket} is a number`).toBe('number');
        }
        const sum = Object.values(counts).reduce((a, b) => a + b, 0);
        expect(sum, 'the five status buckets partition the whole set').toBe(expectedTotal);
        // Every seeded row (work_created + signup) is `completed`.
        expect(counts.completed).toBe(expectedTotal);
        expect(counts.pending).toBe(0);
        expect(counts.in_progress).toBe(0);
        expect(counts.failed).toBe(0);
        expect(counts.cancelled).toBe(0);

        const runRes = await request.get(`${ACT_BASE}/running-count`, { headers: h });
        expect(runRes.status()).toBe(200);
        expect((await runRes.json()).count, 'nothing is in-progress').toBe(0);
    });

    test('aggregates track the dataset as it grows (completed count follows new Works)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const readCompleted = async (): Promise<number> => {
            const res = await request.get(`${ACT_BASE}/summary`, { headers: h });
            expect(res.status()).toBe(200);
            return (await res.json()).counts.completed as number;
        };

        // Fresh account: only the signup row.
        expect(await readCompleted()).toBe(1);

        await seedWorks(request, user.access_token, 3, 'Grow1');
        expect(await readCompleted(), 'after +3 Works').toBe(4);

        await seedWorks(request, user.access_token, 4, 'Grow2');
        const completed = await readCompleted();
        expect(completed, 'after +4 more Works').toBe(8);

        // And the list total agrees with the aggregate.
        expect(await totalFor(request, user.access_token, 'limit=100')).toBe(completed);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. CSV EXPORT — shape, ordering, and no page cap
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log export — shape follows the full (unpaginated) list', () => {
    test('export emits one data row per activity — no 25-row page cap — ordered createdAt DESC', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // 28 Works + signup = 29 rows, well over the default page of 25.
        const works = await seedWorks(request, user.access_token, 28, 'Export');
        const expectedTotal = works.length + 1;
        const h = authedHeaders(user.access_token);

        // The default LIST page is capped at 25 for the same account…
        const page = await list(request, user.access_token);
        expect(page.body.activities).toHaveLength(25);
        expect(page.body.total).toBe(expectedTotal);

        // …but the export carries ALL of them.
        const exp = await request.get(`${ACT_BASE}/export`, { headers: h });
        expect(exp.status()).toBe(200);
        expect(exp.headers()['content-type']).toContain('text/csv');
        const lines = (await exp.text()).split('\n').filter((l) => l.length > 0);
        expect(lines[0]).toBe('Date,Action Type,Action,Status,Work,Summary');
        const dataLines = lines.slice(1);
        expect(dataLines, 'one CSV data row per activity, no page cap').toHaveLength(expectedTotal);

        // The Date column (first field, full ISO) is ordered newest-first.
        const dates = dataLines.map((l) => l.split(',')[0]);
        for (let i = 0; i + 1 < dates.length; i++) {
            expect(dates[i] >= dates[i + 1], `export row ${i} must be >= row ${i + 1}`).toBe(true);
        }
        // Every data row is a completed activity for this account.
        expect(dataLines.every((l) => l.includes('completed'))).toBe(true);
    });

    test('the export is caller-scoped — a stranger sees only their own signup, never the owner rows', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const ownerWorks = await seedWorks(request, owner.access_token, 5, 'Owner');
        const stranger = await registerUserViaAPI(request);

        const exp = await request.get(`${ACT_BASE}/export`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(exp.status()).toBe(200);
        const csv = await exp.text();
        const dataLines = csv.split('\n').filter((l) => l.length > 0 && !l.startsWith('Date,'));
        // The stranger has only their own signup row.
        expect(dataLines, 'stranger export = 1 signup row').toHaveLength(1);
        expect(csv).toContain('user_signup');
        for (const w of ownerWorks) {
            expect(csv, `must not leak owner Work ${w.name}`).not.toContain(w.name);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. SEARCH — case-insensitive contains over summary / work name
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Activity log list — search narrows a multi-row dataset', () => {
    test('a summary-token search matches every Work row and excludes the signup', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 7, 'Search');

        // Every work_created summary is `Created work: <name>`; the signup summary
        // is `Account created` — so `Created work` matches the Works only.
        const worksOnly = await list(
            request,
            user.access_token,
            `search=${encodeURIComponent('Created work')}&limit=100`,
        );
        expect(worksOnly.status).toBe(200);
        expect(worksOnly.body.total).toBe(works.length);
        expect(worksOnly.body.activities.every((a) => a.actionType === 'work_created')).toBe(true);

        // The signup summary is reachable by its own distinctive token.
        const signupOnly = await list(
            request,
            user.access_token,
            `search=${encodeURIComponent('Account')}`,
        );
        expect(signupOnly.body.total).toBe(1);
        expect(signupOnly.body.activities[0].actionType).toBe('user_signup');
    });

    test('search is case-insensitive and an unmatched term yields an empty page', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 6, 'Case');

        const upper = await totalFor(
            request,
            user.access_token,
            `search=${encodeURIComponent('Created work')}`,
        );
        const lower = await totalFor(
            request,
            user.access_token,
            `search=${encodeURIComponent('created work')}`,
        );
        expect(upper, 'both casings hit the same rows').toBe(works.length);
        expect(lower).toBe(upper);

        const none = await list(
            request,
            user.access_token,
            `search=${encodeURIComponent('zzz-no-such-token-' + stamp())}`,
        );
        expect(none.status).toBe(200);
        expect(none.body.total).toBe(0);
        expect(none.body.activities).toHaveLength(0);
    });

    test('search composes with pagination and never exceeds the requested page size', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const works = await seedWorks(request, user.access_token, 8, 'SearchPage');

        const first = await list(
            request,
            user.access_token,
            `search=${encodeURIComponent('Created work')}&limit=3&offset=0`,
        );
        expect(first.status).toBe(200);
        expect(first.body.total, 'search total counts all matches, not just the page').toBe(
            works.length,
        );
        expect(first.body.activities.length).toBeLessThanOrEqual(3);
        expect(first.body.activities.every((a) => a.actionType === 'work_created')).toBe(true);
        expect(first.body.activities.every((a) => UUID_RE.test(a.id))).toBe(true);
    });
});
