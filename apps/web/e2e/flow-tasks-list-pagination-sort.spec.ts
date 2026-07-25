/**
 * GET /api/tasks — list pagination, ordering & filter semantics, DEEP + ASSERTIVE.
 *
 * The sibling `tasks-pagination-filter.spec.ts` only smoke-checks a 2-window
 * split, a garbage limit, and three single-filter counts. THIS file pins the
 * real controller/repo contract end-to-end against a live stack, covering the
 * angles that one does NOT touch: the exact limit/offset CLAMP arithmetic, the
 * `meta.total`-is-the-full-filtered-count invariant, the updatedAt-DESC
 * ordering (incl. a recency bump + tie-tolerant monotonicity), full-scan
 * window coverage (disjoint ∪ complete), CSV multi-value status/priority
 * filters, filter validation 400s, scope (missionId) filtering, LIKE-wildcard
 * escaping in `?search`, JSON-token boundary matching in `?label`, unknown
 * params being ignored, and cross-user isolation.
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) BEFORE assertions were written:
 *
 *   Shape:  GET /api/tasks → 200 { data: Task[], meta: { total, limit, offset } }
 *           row carries { id, userId, slug, title, description, status, priority,
 *           labels, missionId, ideaId, workId, parentTaskId, createdAt, updatedAt, … }
 *   Order:  task.updatedAt DESC (equal-timestamp ties are second-granularity and
 *           order-stable per snapshot but NOT slug-ordered — asserted tie-tolerant).
 *   Default limit 50, offset 0.
 *   limit clamp = `limit ? Math.min(200, Math.max(1, parseInt(limit,10) || 50)) : 50`
 *           → limit=0 → 50 (falsy)   limit=9999 → 200   limit=-5 → 1
 *             limit="abc" → 50        limit="2.9" → 2 (parseInt truncates)
 *   offset clamp = `offset ? Math.max(0, parseInt(offset,10) || 0) : 0`
 *           → offset=-5 → 0   offset=0 → 0   offset past end → echoed, data [], total steady.
 *   meta.total = getCount() of the FULL filtered set (independent of the window).
 *   ?status / ?priority: single → scalar match; CSV `a,b` → IN(...) union;
 *           unknown value → 400 (`Invalid status/priority filter: X`);
 *           empty `?status=` → falsy → unfiltered; trailing-comma tolerated.
 *   ?missionId/?ideaId/?workId/?parentTaskId: ParseUUIDPipe → bad uuid → 400;
 *           valid-but-unknown uuid → empty page, 200 (never 404).
 *   ?search: LIKE substring over title|slug|description (sqlite LIKE is
 *           case-insensitive); `%` and `_` are escaped → treated literally.
 *   ?label: matches the serialized JSON token `"<label>"` → boundary-safe
 *           (`lbl3` does not match a task labelled only `lbl30`).
 *   Unknown params (`sort`, `cursor`, `q`) are ignored → 200, unfiltered.
 *   Auth: no bearer → 401. Cross-user: user B never sees user A's rows.
 *
 * Isolation discipline: every test registers a FRESH user via
 * registerUserViaAPI(), so that user's task set (and therefore `meta.total`)
 * is deterministic — no reliance on global shard counts. Fully API-orchestrated
 * (safe `flow-` prefix), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TaskRow {
    id: string;
    userId: string;
    slug: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    labels: string[] | null;
    missionId: string | null;
    ideaId: string | null;
    workId: string | null;
    parentTaskId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface ListResponse {
    data: TaskRow[];
    meta: { total: number; limit: number; offset: number };
}

type Headers = ReturnType<typeof authedHeaders>;

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function newUser(request: APIRequestContext): Promise<{ headers: Headers; userId: string }> {
    const u = await registerUserViaAPI(request);
    return { headers: authedHeaders(u.access_token), userId: u.user.id };
}

async function createTask(
    request: APIRequestContext,
    headers: Headers,
    body: Record<string, unknown>,
): Promise<TaskRow> {
    const res = await request.post(`${API_BASE}/api/tasks`, { headers, data: body });
    expect(res.status(), `create failed: ${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function list(
    request: APIRequestContext,
    headers: Headers,
    query = '',
): Promise<{ status: number; body: ListResponse }> {
    const res = await request.get(`${API_BASE}/api/tasks${query}`, { headers });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as ListResponse };
}

/** Seed `n` plain tasks for a fresh user; titles carry the run token so
 *  `?search` is scoped to just this user's rows even under shared LIKE. */
async function seedPlain(
    request: APIRequestContext,
    n: number,
): Promise<{ headers: Headers; userId: string; created: TaskRow[] }> {
    const { headers, userId } = await newUser(request);
    const created: TaskRow[] = [];
    for (let i = 0; i < n; i++) {
        created.push(await createTask(request, headers, { title: `Seed-${RUN} row ${i}` }));
    }
    return { headers, userId, created };
}

const idsOf = (rows: TaskRow[]) => rows.map((r) => r.id);

// ── Shape & defaults ──────────────────────────────────────────────────────

test.describe('GET /api/tasks — shape & defaults', () => {
    test('fresh user with no tasks → empty data + zeroed default meta', async ({ request }) => {
        const { headers } = await newUser(request);
        const { status, body } = await list(request, headers);
        expect(status).toBe(200);
        expect(body.data).toEqual([]);
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test('default page pins the row projection + {data,meta} envelope', async ({ request }) => {
        const { headers, userId, created } = await seedPlain(request, 3);
        const { status, body } = await list(request, headers);
        expect(status).toBe(200);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.meta).toEqual({ total: 3, limit: 50, offset: 0 });
        const row = body.data[0];
        // Pinned key surface (not a snapshot — just the load-bearing fields).
        for (const k of [
            'id',
            'userId',
            'slug',
            'title',
            'status',
            'priority',
            'labels',
            'createdAt',
            'updatedAt',
        ]) {
            expect(row, `missing key ${k}`).toHaveProperty(k);
        }
        expect(row.id).toMatch(UUID_RE);
        expect(row.userId).toBe(userId);
        expect(row.slug).toMatch(/^T-\d+$/);
        expect(idsOf(body.data).sort()).toEqual(idsOf(created).sort());
    });

    test('meta.total is the full filtered count, independent of the page window', async ({
        request,
    }) => {
        const { headers } = await seedPlain(request, 7);
        const { body } = await list(request, headers, '?limit=2');
        expect(body.data.length).toBe(2); // window is capped …
        expect(body.meta).toMatchObject({ total: 7, limit: 2, offset: 0 }); // … total is not.
    });
});

// ── limit clamping ────────────────────────────────────────────────────────

test.describe('GET /api/tasks — limit clamp', () => {
    test('limit=0 is falsy → default 50 (returns everything)', async ({ request }) => {
        const { headers } = await seedPlain(request, 4);
        const { body } = await list(request, headers, '?limit=0');
        expect(body.meta.limit).toBe(50);
        expect(body.data.length).toBe(4);
    });

    test('limit above the 200 cap is clamped to 200', async ({ request }) => {
        const { headers } = await seedPlain(request, 3);
        const { body } = await list(request, headers, '?limit=9999');
        expect(body.meta.limit).toBe(200);
        expect(body.data.length).toBe(3);
        expect(body.meta.total).toBe(3);
    });

    test('negative limit is clamped up to 1', async ({ request }) => {
        const { headers } = await seedPlain(request, 4);
        const { body } = await list(request, headers, '?limit=-5');
        expect(body.meta.limit).toBe(1);
        expect(body.data.length).toBe(1);
        expect(body.meta.total).toBe(4); // total still reflects the full set
    });

    test('non-numeric limit falls back to default 50', async ({ request }) => {
        const { headers } = await seedPlain(request, 2);
        const { status, body } = await list(request, headers, '?limit=abc');
        expect(status).toBe(200);
        expect(body.meta.limit).toBe(50);
        expect(body.data.length).toBe(2);
    });

    test('fractional limit is parseInt-truncated (2.9 → 2)', async ({ request }) => {
        const { headers } = await seedPlain(request, 5);
        const { body } = await list(request, headers, '?limit=2.9');
        expect(body.meta.limit).toBe(2);
        expect(body.data.length).toBe(2);
    });
});

// ── offset clamping & window coverage ─────────────────────────────────────

test.describe('GET /api/tasks — offset & windows', () => {
    test('negative offset is clamped to 0', async ({ request }) => {
        const { headers } = await seedPlain(request, 3);
        const { body } = await list(request, headers, '?offset=-5');
        expect(body.meta.offset).toBe(0);
        expect(body.data.length).toBe(3);
    });

    test('offset past the end → empty page, offset echoed, total unchanged', async ({
        request,
    }) => {
        const { headers } = await seedPlain(request, 4);
        const { status, body } = await list(request, headers, '?offset=999');
        expect(status).toBe(200);
        expect(body.data).toEqual([]);
        expect(body.meta).toMatchObject({ total: 4, offset: 999 });
    });

    test('sequential windows are disjoint AND together cover the full set exactly', async ({
        request,
    }) => {
        const { headers, created } = await seedPlain(request, 7);
        const all = new Set(idsOf(created));
        const seen: string[] = [];
        for (let offset = 0; offset < 7; offset += 2) {
            const { body } = await list(request, headers, `?limit=2&offset=${offset}`);
            expect(body.meta).toMatchObject({ total: 7, limit: 2, offset });
            for (const r of body.data) seen.push(r.id);
        }
        // No id appears twice across windows …
        expect(new Set(seen).size).toBe(seen.length);
        // … and the union is exactly the seeded set (no drops, no strangers).
        expect(new Set(seen)).toEqual(all);
        expect(seen.length).toBe(7);
    });

    test('paging reproduces the same global order as a single full fetch', async ({ request }) => {
        const { headers } = await seedPlain(request, 6);
        const full = (await list(request, headers, '?limit=50')).body.data.map((r) => r.id);
        expect(full.length).toBe(6);
        const w1 = (await list(request, headers, '?limit=3&offset=0')).body.data.map((r) => r.id);
        const w2 = (await list(request, headers, '?limit=3&offset=3')).body.data.map((r) => r.id);
        // Windows are contiguous slices of the one stable snapshot ordering.
        expect(w1).toEqual(full.slice(0, 3));
        expect(w2).toEqual(full.slice(3, 6));
    });
});

// ── ordering (updatedAt DESC) ─────────────────────────────────────────────

test.describe('GET /api/tasks — ordering', () => {
    test('rows are ordered by updatedAt DESC (monotonic non-increasing, tie-tolerant)', async ({
        request,
    }) => {
        const { headers } = await seedPlain(request, 6);
        const { body } = await list(request, headers);
        const ts = body.data.map((r) => Date.parse(r.updatedAt));
        for (let i = 1; i < ts.length; i++) {
            // `>=` tolerates equal-second timestamps for rows created in the
            // same tick — the invariant is "never ascending".
            expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
        }
    });

    test('a freshly updated task bubbles to the front of the list', async ({ request }) => {
        const { headers, created } = await seedPlain(request, 3);
        // updatedAt is second-granularity — wait past the boundary so the
        // PATCH lands on a strictly later second than the original inserts.
        await new Promise((r) => setTimeout(r, 1100));
        const bump = created[0]; // the oldest by insertion
        const patch = await request.patch(`${API_BASE}/api/tasks/${bump.id}`, {
            headers,
            data: { title: `Bumped-${RUN}` },
        });
        expect(patch.status()).toBe(200);

        const { body } = await list(request, headers);
        expect(body.data[0].id).toBe(bump.id);
        const bumpedTs = Date.parse(body.data[0].updatedAt);
        for (const r of body.data.slice(1)) {
            expect(bumpedTs).toBeGreaterThanOrEqual(Date.parse(r.updatedAt));
        }
    });
});

// ── status filter ─────────────────────────────────────────────────────────

test.describe('GET /api/tasks — status filter', () => {
    async function seedStatuses(request: APIRequestContext) {
        const { headers } = await newUser(request);
        // 2 backlog, 1 todo, 1 in_progress, 1 done
        await createTask(request, headers, { title: `S-${RUN} a`, status: 'backlog' });
        await createTask(request, headers, { title: `S-${RUN} b`, status: 'backlog' });
        await createTask(request, headers, { title: `S-${RUN} c`, status: 'todo' });
        await createTask(request, headers, { title: `S-${RUN} d`, status: 'in_progress' });
        await createTask(request, headers, { title: `S-${RUN} e`, status: 'done' });
        return headers;
    }

    test('single ?status returns only that status', async ({ request }) => {
        const headers = await seedStatuses(request);
        const { body } = await list(request, headers, '?status=backlog');
        expect(body.meta.total).toBe(2);
        expect(body.data.every((r) => r.status === 'backlog')).toBe(true);
    });

    test('CSV ?status=a,b is an OR union of both', async ({ request }) => {
        const headers = await seedStatuses(request);
        const { body } = await list(request, headers, '?status=backlog,todo');
        expect(body.meta.total).toBe(3);
        expect(new Set(body.data.map((r) => r.status))).toEqual(new Set(['backlog', 'todo']));
    });

    test('unknown status value → 400', async ({ request }) => {
        const { headers } = await newUser(request);
        const res = await request.get(`${API_BASE}/api/tasks?status=nope`, { headers });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toContain('Invalid status filter');
    });

    test('trailing comma / blank segment in ?status is tolerated', async ({ request }) => {
        const headers = await seedStatuses(request);
        const { status, body } = await list(request, headers, '?status=backlog,');
        expect(status).toBe(200);
        expect(body.meta.total).toBe(2);
        expect(body.data.every((r) => r.status === 'backlog')).toBe(true);
    });

    test('empty ?status= is falsy → unfiltered', async ({ request }) => {
        const headers = await seedStatuses(request);
        const { status, body } = await list(request, headers, '?status=');
        expect(status).toBe(200);
        expect(body.meta.total).toBe(5);
    });
});

// ── priority filter ───────────────────────────────────────────────────────

test.describe('GET /api/tasks — priority filter', () => {
    async function seedPriorities(request: APIRequestContext) {
        const { headers } = await newUser(request);
        await createTask(request, headers, { title: `P-${RUN} a`, priority: 'p0' });
        await createTask(request, headers, { title: `P-${RUN} b`, priority: 'p1' });
        await createTask(request, headers, { title: `P-${RUN} c`, priority: 'p1' });
        await createTask(request, headers, { title: `P-${RUN} d`, priority: 'p3' });
        return headers;
    }

    test('single ?priority returns only that priority', async ({ request }) => {
        const headers = await seedPriorities(request);
        const { body } = await list(request, headers, '?priority=p1');
        expect(body.meta.total).toBe(2);
        expect(body.data.every((r) => r.priority === 'p1')).toBe(true);
    });

    test('CSV ?priority=a,b is an OR union', async ({ request }) => {
        const headers = await seedPriorities(request);
        const { body } = await list(request, headers, '?priority=p0,p3');
        expect(body.meta.total).toBe(2);
        expect(new Set(body.data.map((r) => r.priority))).toEqual(new Set(['p0', 'p3']));
    });

    test('unknown priority value → 400', async ({ request }) => {
        const { headers } = await newUser(request);
        const res = await request.get(`${API_BASE}/api/tasks?priority=urgent`, { headers });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toContain('Invalid priority filter');
    });

    test('status + priority combine with AND semantics', async ({ request }) => {
        const { headers } = await newUser(request);
        await createTask(request, headers, {
            title: `AP-${RUN} 1`,
            status: 'todo',
            priority: 'p1',
        });
        await createTask(request, headers, {
            title: `AP-${RUN} 2`,
            status: 'todo',
            priority: 'p3',
        });
        await createTask(request, headers, {
            title: `AP-${RUN} 3`,
            status: 'backlog',
            priority: 'p1',
        });
        const { body } = await list(request, headers, '?status=todo&priority=p1');
        expect(body.meta.total).toBe(1);
        expect(body.data[0].status).toBe('todo');
        expect(body.data[0].priority).toBe('p1');
    });
});

// ── scope (missionId) filter ──────────────────────────────────────────────

test.describe('GET /api/tasks — scope filter', () => {
    test('?missionId narrows to that scope; unscoped rows drop out', async ({ request }) => {
        const { headers } = await newUser(request);
        const mres = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Scope Mission ${RUN}`,
                description: 'scope mission for tasks list filter',
                type: 'one-shot',
            },
        });
        expect(mres.status(), `mission create: ${await mres.text().catch(() => '')}`).toBe(201);
        const missionId = (await mres.json()).id as string;
        expect(missionId).toMatch(UUID_RE);

        await createTask(request, headers, { title: `Scoped-${RUN}`, missionId });
        await createTask(request, headers, { title: `Unscoped-${RUN}` });

        const { body } = await list(request, headers, `?missionId=${missionId}`);
        expect(body.meta.total).toBe(1);
        expect(body.data[0].missionId).toBe(missionId);
        // and the full (unfiltered) list still has both
        expect((await list(request, headers)).body.meta.total).toBe(2);
    });

    test('malformed ?missionId (not a uuid) → 400', async ({ request }) => {
        const { headers } = await newUser(request);
        const res = await request.get(`${API_BASE}/api/tasks?missionId=not-a-uuid`, { headers });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toContain('uuid');
    });

    test('valid-but-unknown ?missionId → empty page, 200 (never 404)', async ({ request }) => {
        const { headers } = await seedPlain(request, 2);
        const { status, body } = await list(
            request,
            headers,
            '?missionId=11111111-1111-4111-8111-111111111111',
        );
        expect(status).toBe(200);
        expect(body.data).toEqual([]);
        expect(body.meta.total).toBe(0);
    });
});

// ── search & label ────────────────────────────────────────────────────────

test.describe('GET /api/tasks — search & label', () => {
    test('?search matches a title substring', async ({ request }) => {
        const { headers } = await newUser(request);
        await createTask(request, headers, { title: `Alpha ${RUN} unicorn` });
        await createTask(request, headers, { title: `Beta ${RUN} walrus` });
        const { body } = await list(request, headers, '?search=unicorn');
        expect(body.meta.total).toBe(1);
        expect(body.data[0].title).toContain('unicorn');
    });

    test('?search also matches slug and description', async ({ request }) => {
        const { headers } = await newUser(request);
        const t = await createTask(request, headers, {
            title: `Desc ${RUN}`,
            description: `payload-${RUN}-zebra`,
        });
        const bySlug = await list(request, headers, `?search=${encodeURIComponent(t.slug)}`);
        expect(bySlug.body.data.some((r) => r.id === t.id)).toBe(true);
        const byDesc = await list(request, headers, `?search=${encodeURIComponent('zebra')}`);
        expect(byDesc.body.meta.total).toBe(1);
        expect(byDesc.body.data[0].id).toBe(t.id);
    });

    test('LIKE wildcards in ?search are escaped (treated literally)', async ({ request }) => {
        const { headers } = await newUser(request);
        await createTask(request, headers, { title: `NoWild ${RUN} abc` });
        // A bare `%` would match everything if unescaped — here it matches the
        // literal char, of which there is none → 0.
        const pct = await list(request, headers, `?search=${encodeURIComponent('%')}`);
        expect(pct.body.meta.total).toBe(0);
        // `a_c` with an unescaped `_` would match "abc"; escaped it is literal → 0.
        const und = await list(request, headers, `?search=${encodeURIComponent('a_c')}`);
        expect(und.body.meta.total).toBe(0);
    });

    test('unknown query params (q, sort, cursor) are ignored → unfiltered 200', async ({
        request,
    }) => {
        const { headers } = await seedPlain(request, 3);
        const { status, body } = await list(
            request,
            headers,
            '?q=nomatch&sort=title;DROP&cursor=abc',
        );
        expect(status).toBe(200);
        expect(body.meta.total).toBe(3); // `q` did NOT filter — it is not the search param
        expect(body.data.length).toBe(3);
    });

    test('?label matches the exact JSON token — boundary-safe (lbl3 ≠ lbl30)', async ({
        request,
    }) => {
        const { headers } = await newUser(request);
        const three = await createTask(request, headers, { title: `L3 ${RUN}`, labels: ['lbl3'] });
        await createTask(request, headers, { title: `L30 ${RUN}`, labels: ['lbl30'] });
        const { body } = await list(request, headers, '?label=lbl3');
        expect(body.meta.total).toBe(1);
        expect(body.data[0].id).toBe(three.id);
        expect(body.data[0].labels).toContain('lbl3');
    });

    test('?label + shared tag returns every task carrying it', async ({ request }) => {
        const { headers } = await newUser(request);
        await createTask(request, headers, { title: `C1 ${RUN}`, labels: ['common', 'x'] });
        await createTask(request, headers, { title: `C2 ${RUN}`, labels: ['common', 'y'] });
        await createTask(request, headers, { title: `C3 ${RUN}`, labels: ['other'] });
        const { body } = await list(request, headers, '?label=common');
        expect(body.meta.total).toBe(2);
        expect(body.data.every((r) => (r.labels ?? []).includes('common'))).toBe(true);
    });

    test('filter + pagination compose: meta.total is the filtered count, window within it', async ({
        request,
    }) => {
        const { headers } = await newUser(request);
        for (let i = 0; i < 5; i++) {
            await createTask(request, headers, { title: `F-${RUN} ${i}`, status: 'backlog' });
        }
        await createTask(request, headers, { title: `F-${RUN} other`, status: 'done' });
        const { body } = await list(request, headers, '?status=backlog&limit=2&offset=0');
        expect(body.meta).toMatchObject({ total: 5, limit: 2, offset: 0 });
        expect(body.data.length).toBe(2);
        expect(body.data.every((r) => r.status === 'backlog')).toBe(true);
    });
});

// ── auth & isolation ──────────────────────────────────────────────────────

test.describe('GET /api/tasks — auth & isolation', () => {
    test('no bearer token → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/tasks`);
        expect(res.status()).toBe(401);
    });

    test('one user never sees another users tasks', async ({ request }) => {
        const { headers: a, created } = await seedPlain(request, 3);
        const { headers: b } = await newUser(request);

        const bList = await list(request, b);
        expect(bList.body.meta.total).toBe(0);
        expect(bList.body.data).toEqual([]);

        // B cannot surface A's rows even by searching A's run token.
        const bSearch = await list(request, b, `?search=${encodeURIComponent(RUN)}`);
        const aIds = new Set(idsOf(created));
        for (const r of bSearch.body.data) {
            expect(aIds.has(r.id)).toBe(false);
        }
        // A still sees its own three.
        expect((await list(request, a)).body.meta.total).toBe(3);
    });
});
