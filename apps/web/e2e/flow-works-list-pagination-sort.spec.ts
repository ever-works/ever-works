/**
 * GET /api/works — list pagination / ordering / filter contract, DEEP + ASSERTIVE.
 *
 * `GET /api/works` is the dashboard's primary Work-list surface. The existing
 * pagination specs (`api-pagination-param-edges`, `pagination`,
 * `pagination-cursor-stability`, `api-sort-and-filter-tolerance`) are shallow
 * "tolerated / best-effort" smoke checks that `test.skip` on any non-200. This
 * file is their assertive counterpart: it seeds a KNOWN dataset for a FRESH
 * owner and pins the EXACT response shape, default window, ordering, and every
 * pagination / filter edge the controller + repo actually implement.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. Ground truth pinned here:
 *
 *   • Envelope is `{ status:'success', works:[…], total, limit, offset }` —
 *     the list key is `works` (NOT `data` / `items`), and there is no `meta`
 *     / `page` / `nextCursor` wrapper.
 *   • Defaults: limit = 20, offset = 0. `total` is the full accessible count,
 *     INDEPENDENT of limit/offset (own COUNT query).
 *   • Ordering: `work.updatedAt DESC` with NO secondary tie-breaker. Row
 *     timestamps are SECOND-granularity, so rapidly-created rows tie and their
 *     relative order is unstable — assertions use monotonic-non-increasing
 *     (ties allowed) + set-based page-union invariants, never a pinned slug
 *     order for same-second rows.
 *   • limit coercion (controller `parsedLimit && !isNaN(parsedLimit)` guard →
 *     service default 20, repo `if (limit) take(limit)`):
 *       - limit=0 / non-numeric  → falls back to default 20 (echoed limit=20)
 *       - limit=5                → caps to 5 (echoed 5)
 *       - limit=100000           → NO upper clamp; echoed 100000; returns all
 *       - limit=-5               → truthy-negative → `take(-5)` = no cap; all
 *       - limit=3.0              → Number('3.0')===3 → accepted as 3
 *       - limit=2.9 (non-int)    → TypeORM/sqlite reject → normalized 400
 *                                  `{status:'error',message:'SqliteError: datatype mismatch'}`
 *   • offset coercion (`if (offset) skip(offset)`):
 *       - offset=0 / non-numeric → default 0
 *       - offset=1000 (past end) → empty page, `total` unchanged
 *       - offset=-5              → sqlite treats negative OFFSET as 0; all rows
 *       - offset=2.5 (non-int)   → normalized 400 datatype mismatch
 *   • search: trimmed + sliced to 100 chars, case-insensitive CONTAINS over
 *     name OR description OR slug. Whitespace-only search is a no-op (all rows).
 *   • `sort`, `status`, `q` are NOT read by the handler → silently ignored
 *     (default order, no filtering, no 5xx). `q` is NOT an alias for `search`.
 *   • Own-rows-only: a second user never sees / can never search another
 *     owner's Works. Unauthenticated → 401.
 *
 * Isolation discipline: read-only tests share ONE freshly-registered owner
 * seeded in `beforeAll` (per Playwright worker) with a deterministic 12-Work
 * dataset, so `total` is exact (12) and never contends with the accumulating
 * shard DB. Isolation / time-gap tests each register their own owner. Fully
 * API-orchestrated (safe `flow-` prefix), no UI contention.
 */
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SeededWork {
    id: string;
    slug: string;
    name: string;
    description: string;
}

async function createWork(
    request: APIRequestContext,
    token: string,
    w: { slug: string; name: string; description: string },
): Promise<SeededWork> {
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: { slug: w.slug, name: w.name, description: w.description, organization: false },
    });
    expect(res.status(), `seed create ${w.slug} → ${await res.text().catch(() => '')}`).toBe(200);
    const json = await res.json();
    return { id: json.work.id, slug: json.work.slug, name: w.name, description: w.description };
}

async function listWorks(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<APIResponse> {
    return request.get(`${API_BASE}/api/works${query}`, { headers: authedHeaders(token) });
}

/** Fetch a list page and return the parsed body + the raw response. */
async function listJson(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{
    status: number;
    body: {
        status: string;
        works: Array<Record<string, unknown>>;
        total: number;
        limit: number;
        offset: number;
    };
}> {
    const res = await listWorks(request, token, query);
    expect(res.status(), `GET /api/works${query}`).toBe(200);
    return { status: res.status(), body: await res.json() };
}

const slugsOf = (works: Array<Record<string, unknown>>): string[] =>
    works.map((w) => String(w.slug));

// ── Shared read-only dataset ────────────────────────────────────────────────
const SEED_COUNT = 12;
// Index (1-based) of the seeded Work carrying a description-only search token.
const DESC_TOKEN_IDX = 4;

let reader: RegisteredUser;
let RUN = '';
let seeded: SeededWork[] = [];
let seededSlugs: Set<string>;
let descToken = '';

test.beforeAll(async ({ request }) => {
    reader = await registerUserViaAPI(request);
    RUN = stamp();
    descToken = `beacon${RUN.replace(/-/g, '')}zed`;
    seeded = [];
    for (let i = 1; i <= SEED_COUNT; i += 1) {
        const nn = String(i).padStart(2, '0');
        const description =
            i === DESC_TOKEN_IDX
                ? `list probe ${descToken} descriptor`
                : `list pagination probe row ${nn}`;
        seeded.push(
            await createWork(request, reader.access_token, {
                slug: `pg-${RUN}-${nn}`,
                name: `PGList ${RUN} node ${nn}`,
                description,
            }),
        );
    }
    seededSlugs = new Set(seeded.map((w) => w.slug));
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — envelope & defaults', () => {
    test('default list returns the exact {status,works,total,limit,offset} envelope', async ({
        request,
    }) => {
        const { body } = await listJson(request, reader.access_token);
        expect(Object.keys(body).sort()).toEqual(['limit', 'offset', 'status', 'total', 'works']);
        expect(body.status).toBe('success');
        expect(Array.isArray(body.works)).toBe(true);
        // The list key is `works` — assert the common alternative wrappers are absent.
        expect((body as Record<string, unknown>).data).toBeUndefined();
        expect((body as Record<string, unknown>).items).toBeUndefined();
        expect((body as Record<string, unknown>).meta).toBeUndefined();
        expect((body as Record<string, unknown>).nextCursor).toBeUndefined();
    });

    test('defaults are limit=20 / offset=0 and total is the exact seeded count', async ({
        request,
    }) => {
        const { body } = await listJson(request, reader.access_token);
        expect(body.limit).toBe(20);
        expect(body.offset).toBe(0);
        expect(body.total).toBe(SEED_COUNT);
        // Seeded set fits under the default page → every seeded row is present.
        expect(body.works.length).toBe(SEED_COUNT);
        for (const s of seededSlugs) {
            expect(slugsOf(body.works)).toContain(s);
        }
    });

    test('each row carries the owner projection (userId, userRole OWNER, org false, timestamps)', async ({
        request,
    }) => {
        const { body } = await listJson(request, reader.access_token);
        const row = body.works.find((w) => w.slug === seeded[0].slug)!;
        expect(row, 'seeded row present').toBeTruthy();
        expect(String(row.id)).toMatch(UUID_RE);
        expect(row.userId).toBe(reader.user.id);
        expect(row.userRole).toBe('owner');
        expect(row.organization).toBe(false);
        expect(typeof row.name).toBe('string');
        expect(typeof row.createdAt).toBe('string');
        expect(typeof row.updatedAt).toBe('string');
        expect(Number.isNaN(Date.parse(String(row.updatedAt)))).toBe(false);
    });

    test('total is independent of the pagination window', async ({ request }) => {
        const wide = await listJson(request, reader.access_token, '?limit=100');
        const narrow = await listJson(request, reader.access_token, '?limit=2&offset=5');
        expect(wide.body.total).toBe(SEED_COUNT);
        expect(narrow.body.total).toBe(SEED_COUNT);
        // …but the returned page size tracks the window.
        expect(wide.body.works.length).toBe(SEED_COUNT);
        expect(narrow.body.works.length).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — ordering (updatedAt DESC)', () => {
    test('full list is monotonically non-increasing by updatedAt (equal-second ties allowed)', async ({
        request,
    }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=100');
        const times = body.works.map((w) => Date.parse(String(w.updatedAt)));
        for (let i = 1; i < times.length; i += 1) {
            // DESC ⇒ each element is <= its predecessor. Ties (equal seconds) are
            // legal because there is no secondary sort key.
            expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
        }
    });

    test('a newer write batch sorts entirely ahead of an older batch across a second boundary', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const run = stamp();
        const older: string[] = [];
        for (let i = 1; i <= 3; i += 1) {
            const w = await createWork(request, owner.access_token, {
                slug: `ord-${run}-old${i}`,
                name: `Ord ${run} old ${i}`,
                description: `older ${i}`,
            });
            older.push(w.slug);
        }
        // Cross a whole-second boundary so the two batches get distinct
        // updatedAt seconds and the DESC order between batches is deterministic.
        await new Promise((r) => setTimeout(r, 1200));
        const newer: string[] = [];
        for (let i = 1; i <= 3; i += 1) {
            const w = await createWork(request, owner.access_token, {
                slug: `ord-${run}-new${i}`,
                name: `Ord ${run} new ${i}`,
                description: `newer ${i}`,
            });
            newer.push(w.slug);
        }
        const { body } = await listJson(request, owner.access_token, '?limit=100');
        const order = slugsOf(body.works);
        const maxNewIdx = Math.max(...newer.map((s) => order.indexOf(s)));
        const minOldIdx = Math.min(...older.map((s) => order.indexOf(s)));
        // Every newer row appears before every older row.
        expect(maxNewIdx).toBeGreaterThanOrEqual(0);
        expect(minOldIdx).toBeGreaterThanOrEqual(0);
        expect(maxNewIdx).toBeLessThan(minOldIdx);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — limit semantics', () => {
    test('limit=5 caps the page to 5 and echoes limit=5; total unchanged', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=5');
        expect(body.limit).toBe(5);
        expect(body.offset).toBe(0);
        expect(body.works.length).toBe(5);
        expect(body.total).toBe(SEED_COUNT);
    });

    test('limit=0 is coerced to the default 20', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=0');
        expect(body.limit).toBe(20);
        expect(body.works.length).toBe(SEED_COUNT); // 12 < 20 ⇒ all
    });

    test('limit far above total is NOT clamped (echoes 100000, returns all rows)', async ({
        request,
    }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=100000');
        expect(body.limit).toBe(100000);
        expect(body.works.length).toBe(SEED_COUNT);
        expect(body.total).toBe(SEED_COUNT);
    });

    test('negative limit disables the cap and echoes the raw value', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=-5');
        expect(body.limit).toBe(-5);
        // take(-5) = no LIMIT in sqlite ⇒ all rows come back.
        expect(body.works.length).toBe(SEED_COUNT);
    });

    test('non-numeric limit falls back to the default 20', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=abc');
        expect(body.limit).toBe(20);
        expect(body.works.length).toBe(SEED_COUNT);
    });

    test('integer-valued float limit (3.0) is accepted as 3', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=3.0');
        expect(body.limit).toBe(3);
        expect(body.works.length).toBe(3);
    });

    test('non-integer limit (2.9) is a normalized 400, never a 5xx', async ({ request }) => {
        const res = await listWorks(request, reader.access_token, '?limit=2.9');
        expect([400, 422]).toContain(res.status());
        expect(res.status()).toBeLessThan(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(String(body.message)).toContain('datatype mismatch');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — offset semantics', () => {
    test('offset advances the window; page0 and page1 are disjoint', async ({ request }) => {
        const p0 = await listJson(request, reader.access_token, '?limit=4&offset=0');
        const p1 = await listJson(request, reader.access_token, '?limit=4&offset=4');
        expect(p0.body.offset).toBe(0);
        expect(p1.body.offset).toBe(4);
        expect(p0.body.works.length).toBe(4);
        expect(p1.body.works.length).toBe(4);
        const s0 = new Set(slugsOf(p0.body.works));
        for (const s of slugsOf(p1.body.works)) {
            expect(s0.has(s)).toBe(false);
        }
    });

    test('offset past the end returns an empty page with total unchanged', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?offset=1000');
        expect(body.offset).toBe(1000);
        expect(body.works.length).toBe(0);
        expect(body.total).toBe(SEED_COUNT);
    });

    test('negative offset is tolerated (treated as 0) and never 5xx', async ({ request }) => {
        const res = await listWorks(request, reader.access_token, '?offset=-5');
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.offset).toBe(-5);
        // sqlite clamps a negative OFFSET to 0 ⇒ the window starts at the top.
        expect(body.works.length).toBe(Math.min(SEED_COUNT, 20));
        expect(body.total).toBe(SEED_COUNT);
    });

    test('non-numeric offset falls back to 0', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?offset=abc');
        expect(body.offset).toBe(0);
        expect(body.works.length).toBe(SEED_COUNT);
    });

    test('non-integer offset (2.5) is a normalized 400, never a 5xx', async ({ request }) => {
        const res = await listWorks(request, reader.access_token, '?offset=2.5');
        expect([400, 422]).toContain(res.status());
        expect(res.status()).toBeLessThan(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(String(body.message)).toContain('datatype mismatch');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — pagination integrity', () => {
    test('paging limit=5 over the whole set covers every row exactly once', async ({ request }) => {
        const collected: string[] = [];
        const pageSizes: number[] = [];
        for (let offset = 0; offset < SEED_COUNT + 5; offset += 5) {
            const { body } = await listJson(
                request,
                reader.access_token,
                `?limit=5&offset=${offset}`,
            );
            expect(body.total).toBe(SEED_COUNT);
            pageSizes.push(body.works.length);
            collected.push(...slugsOf(body.works));
            if (body.works.length === 0) break;
        }
        // Union is complete and duplicate-free.
        const unique = new Set(collected);
        expect(unique.size).toBe(collected.length); // no row repeated across pages
        for (const s of seededSlugs) {
            expect(unique.has(s)).toBe(true);
        }
        // Only the seeded rows are present (fresh owner).
        expect(unique.size).toBe(SEED_COUNT);
        // 12 rows over pages of 5 ⇒ 5,5,2,(0).
        expect(pageSizes.slice(0, 3)).toEqual([5, 5, 2]);
    });

    test('identical paged requests return a stable page composition', async ({ request }) => {
        const a = await listJson(request, reader.access_token, '?limit=5&offset=0');
        const b = await listJson(request, reader.access_token, '?limit=5&offset=0');
        expect(a.body.works.length).toBe(5);
        // Static data ⇒ the same 5 rows compose the page (set-stable; tie order
        // between equal-second rows is not contractually pinned).
        expect(new Set(slugsOf(a.body.works))).toEqual(new Set(slugsOf(b.body.works)));
    });

    test('a boundary window (limit=3 offset=10) returns only the trailing rows', async ({
        request,
    }) => {
        const { body } = await listJson(request, reader.access_token, '?limit=3&offset=10');
        expect(body.limit).toBe(3);
        expect(body.offset).toBe(10);
        // 12 total, offset 10 ⇒ 2 rows remain even though limit asks for 3.
        expect(body.works.length).toBe(2);
        expect(body.total).toBe(SEED_COUNT);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — search filter', () => {
    test('search by the shared run token matches all seeded rows, case-insensitively', async ({
        request,
    }) => {
        const lower = await listJson(request, reader.access_token, `?search=${RUN}`);
        expect(lower.body.total).toBe(SEED_COUNT);
        expect(lower.body.works.length).toBe(SEED_COUNT);
        const upper = await listJson(request, reader.access_token, `?search=${RUN.toUpperCase()}`);
        // Case-insensitive CONTAINS ⇒ same match set.
        expect(upper.body.total).toBe(SEED_COUNT);
    });

    test('search by a full unique slug narrows to exactly that row', async ({ request }) => {
        const target = seeded[6];
        const { body } = await listJson(request, reader.access_token, `?search=${target.slug}`);
        expect(body.total).toBe(1);
        expect(body.works.length).toBe(1);
        expect(body.works[0].slug).toBe(target.slug);
    });

    test('search matches a description-only token (not just name/slug)', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, `?search=${descToken}`);
        expect(body.total).toBe(1);
        expect(body.works[0].slug).toBe(seeded[DESC_TOKEN_IDX - 1].slug);
    });

    test('search with no match returns an empty page and total 0', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, `?search=nomatch-${RUN}-zzz`);
        expect(body.total).toBe(0);
        expect(body.works.length).toBe(0);
    });

    test('whitespace-only search is a no-op (returns all rows)', async ({ request }) => {
        const { body } = await listJson(request, reader.access_token, '?search=%20%20%20');
        expect(body.total).toBe(SEED_COUNT);
        expect(body.works.length).toBe(SEED_COUNT);
    });

    test('an over-long search string is truncated, not 5xx', async ({ request }) => {
        const long = 'z'.repeat(300);
        const res = await listWorks(request, reader.access_token, `?search=${long}`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        // 300 'z' sliced to 100 'z' ⇒ still no seeded match.
        expect(body.total).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('GET /api/works — ignored params, isolation & auth', () => {
    test('unknown params (sort/status) are ignored — default order, no filtering, no 5xx', async ({
        request,
    }) => {
        const sorted = await listJson(request, reader.access_token, '?sort=name');
        const statused = await listJson(request, reader.access_token, '?status=archived');
        expect(sorted.body.total).toBe(SEED_COUNT);
        expect(sorted.body.works.length).toBe(SEED_COUNT);
        expect(statused.body.total).toBe(SEED_COUNT);
        expect(statused.body.works.length).toBe(SEED_COUNT);
    });

    test('a SQL-injection-style sort value is inert (ignored, no 5xx, no data loss)', async ({
        request,
    }) => {
        const evil = encodeURIComponent('name); DROP TABLE works; --');
        const res = await listWorks(request, reader.access_token, `?sort=${evil}`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.total).toBe(SEED_COUNT);
        // Table intact: a follow-up default list still returns the seeded rows.
        const after = await listJson(request, reader.access_token);
        expect(after.body.total).toBe(SEED_COUNT);
    });

    test('`q` is NOT an alias for `search` — q is ignored, search filters', async ({ request }) => {
        const target = seeded[2].slug;
        const viaQ = await listJson(request, reader.access_token, `?q=${target}`);
        const viaSearch = await listJson(request, reader.access_token, `?search=${target}`);
        // q ignored ⇒ full set; search ⇒ exactly one.
        expect(viaQ.body.total).toBe(SEED_COUNT);
        expect(viaQ.body.works.length).toBe(SEED_COUNT);
        expect(viaSearch.body.total).toBe(1);
    });

    test('own-rows-only: a second owner sees only their own Works', async ({ request }) => {
        const other = await registerUserViaAPI(request);
        const run = stamp();
        const mine: string[] = [];
        for (let i = 1; i <= 3; i += 1) {
            const w = await createWork(request, other.access_token, {
                slug: `iso-${run}-${i}`,
                name: `Iso ${run} ${i}`,
                description: `iso ${i}`,
            });
            mine.push(w.slug);
        }
        const { body } = await listJson(request, other.access_token, '?limit=100');
        expect(body.total).toBe(3);
        expect(new Set(slugsOf(body.works))).toEqual(new Set(mine));
        // None of the shared reader's seeded rows leak in.
        for (const s of seededSlugs) {
            expect(slugsOf(body.works)).not.toContain(s);
        }
        for (const w of body.works) {
            expect(w.userId).toBe(other.user.id);
        }
    });

    test("cross-user search never leaks another owner's rows", async ({ request }) => {
        const other = await registerUserViaAPI(request);
        // `other` searches for a token unique to the shared reader's dataset.
        const { body } = await listJson(request, other.access_token, `?search=${RUN}`);
        expect(body.total).toBe(0);
        expect(body.works.length).toBe(0);
    });

    test('unauthenticated list request is rejected with 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/works`);
        expect(res.status()).toBe(401);
    });
});
