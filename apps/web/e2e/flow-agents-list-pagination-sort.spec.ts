/**
 * GET /api/agents — list pagination / sort / filter, DEEP + ASSERTIVE.
 *
 * The Agents list endpoint (`AgentsController.list`, agents/plan.md §4) is the
 * dashboard's primary read surface. There is already a shallow
 * `agents-list-filter.spec.ts` (4 smoke tests: archived-exclusion, one status
 * filter, one search, one paginate). This file deliberately covers the DISTINCT
 * pagination / ordering / clamp / edge angles that spec does not, pinning the
 * TRUE observed contract rather than smoke-asserting `< 500`.
 *
 * Response contract (verified live against http://127.0.0.1:3100, the sqlite
 * in-memory CI driver, before any assertion was written):
 *
 *   • Shape: `{ data: AgentDto[], meta: { total, limit, offset } }`. Bare object,
 *     NOT `{items,total}` and NOT a bare array. `data` rows are full AgentDto
 *     projections (id/userId/scope/status/name/slug/updatedAt/createdAt/…).
 *   • Defaults: no `?limit` → meta.limit === 50; no `?offset` → meta.offset === 0.
 *   • meta echoes the REQUESTED limit/offset verbatim — it is NOT re-derived from
 *     the page size and NOT clamped (out-of-range values are rejected upstream by
 *     the DTO, they never reach the echo). offset past the end still echoes the
 *     raw offset with an empty `data`.
 *   • `total` = the FULL filtered match count (COUNT before take/skip in
 *     `AgentRepository.findByUserIdScoped`), independent of limit/offset.
 *   • Ordering: `agent.updatedAt DESC`. There is NO `?sort` / `?order` param — the
 *     order is fixed. On sqlite `updatedAt` has SECOND resolution, so rows created
 *     in the same second TIE; ordering is asserted non-increasing WITH tolerance
 *     for equal-timestamp ties. Bumping a row (PATCH) advances its updatedAt and
 *     floats it to the front.
 *   • The list is user-scoped: `findByUserIdScoped(userId, …)` — a fresh user sees
 *     EXACTLY the agents they created (so per-user totals are deterministic and
 *     safe to assert exactly, even though the shard DB accumulates other users'
 *     rows). Archived agents are always excluded (`status != archived`), so
 *     `?status=archived` returns total 0 by construction.
 *   • Filters: `scope` (enum), `status` (enum), `missionId`/`ideaId`/`workId`
 *     (uuid), `search` (LIKE on name/slug/title, wildcards escaped → literal).
 *     Combined filters intersect (AND).
 *   • Validation (global ValidationPipe, whitelist + forbidNonWhitelisted ON):
 *       - limit ∈ [1,200] integer  → 0 / 201 / -1 / abc / 3.5 all 400; 1 & 200 ok
 *       - offset ≥ 0 integer       → -1 / abc 400; 0 & huge ok
 *       - scope/status bad enum    → 400
 *       - missionId/ideaId/workId non-uuid → 400
 *       - search > 80 chars        → 400
 *       - UNKNOWN query params (sort / order / page / foo) → 400 (forbidNonWhitelisted)
 *   • Auth: 401 without a bearer token.
 *
 * Isolation discipline: every test registers a FRESH user (registerUserViaAPI)
 * and asserts only against agents that user created — no cross-test contention,
 * no reliance on global counts. Fully API-orchestrated (safe `flow-` prefix).
 */
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface AgentRow {
    id: string;
    userId: string;
    scope: string;
    status: string;
    name: string;
    slug: string;
    updatedAt: string;
    createdAt: string;
    [k: string]: unknown;
}
interface ListBody {
    data: AgentRow[];
    meta: { total: number; limit: number; offset: number };
}

/** Create a tenant-scoped Agent (no parent row required). Returns its id. */
async function createAgent(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name },
    });
    expect(res.status(), `createAgent(${name}) body=${await res.text().catch(() => '')}`).toBe(201);
    const json = await res.json();
    expect(json.id, 'created agent id is a uuid').toMatch(UUID_RE);
    return json.id as string;
}

/** Create N tenant Agents with a shared unique token; returns their ids in creation order. */
async function createAgents(
    request: APIRequestContext,
    token: string,
    n: number,
    label: string,
): Promise<string[]> {
    const tag = stamp();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        ids.push(await createAgent(request, token, `${label} ${i} ${tag}`));
    }
    return ids;
}

/** GET /api/agents?<qs> raw response (caller asserts status). */
function listRaw(request: APIRequestContext, token: string | null, qs = ''): Promise<APIResponse> {
    return request.get(`${API_BASE}/api/agents${qs}`, {
        headers: token ? authedHeaders(token) : {},
    });
}

/** GET /api/agents?<qs>, asserting 200, returning the typed body. */
async function list(request: APIRequestContext, token: string, qs = ''): Promise<ListBody> {
    const res = await listRaw(request, token, qs);
    expect(res.status(), `GET /api/agents${qs} body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()) as ListBody;
}

async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    return registerUserViaAPI(request);
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('GET /api/agents — response shape & defaults', () => {
    test('empty list returns the {data:[],meta:{total:0,limit:50,offset:0}} envelope', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const body = await list(request, u.access_token);
        expect(Array.isArray(body.data), 'data is an array').toBe(true);
        expect(body.data).toEqual([]);
        // Default page window is pinned by the controller (limit ?? 50, offset ?? 0).
        expect(body.meta).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    test('meta is a flat {total,limit,offset} object — not {items,total} and not a bare array', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 2, 'Shape');
        const res = await listRaw(request, u.access_token);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('data');
        expect(body).toHaveProperty('meta');
        expect(Object.keys(body.meta).sort()).toEqual(['limit', 'offset', 'total']);
        expect(body).not.toHaveProperty('items');
        expect(body).not.toHaveProperty('total'); // total lives under meta, not top-level
    });

    test('each row is a full AgentDto projection with the expected key set + types', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const id = await createAgent(request, u.access_token, `Projection ${stamp()}`);
        const body = await list(request, u.access_token);
        const row = body.data.find((r) => r.id === id);
        expect(row, 'created agent is present').toBeTruthy();
        if (!row) return;
        // Identity + lifecycle columns present with correct primitive types.
        expect(row.id).toMatch(UUID_RE);
        expect(row.userId).toBe(u.user.id);
        expect(row.scope).toBe('tenant');
        expect(row.status).toBe('draft'); // freshly created agents start DRAFT
        expect(typeof row.name).toBe('string');
        expect(typeof row.slug).toBe('string');
        expect(row.updatedAt).toMatch(ISO_RE);
        expect(row.createdAt).toMatch(ISO_RE);
        // A handful of AgentDto fields that must always be projected.
        for (const key of [
            'missionId',
            'ideaId',
            'workId',
            'permissions',
            'idleBehavior',
            'errorCount',
            'pauseAfterFailures',
            'avatarMode',
            'hasInlineFiles',
        ]) {
            expect(row, `row carries ${key}`).toHaveProperty(key);
        }
    });

    test('total is the FULL match count and is independent of limit/offset', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 6, 'Total');
        const full = await list(request, u.access_token);
        expect(full.meta.total).toBe(6);
        // Slicing the page does not change the reported total.
        expect((await list(request, u.access_token, '?limit=2')).meta.total).toBe(6);
        expect((await list(request, u.access_token, '?limit=1&offset=4')).meta.total).toBe(6);
        expect((await list(request, u.access_token, '?offset=999')).meta.total).toBe(6);
    });

    test('meta echoes the REQUESTED limit/offset verbatim (never re-derived from page size)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 5, 'Echo');
        const page = await list(request, u.access_token, '?limit=2&offset=1');
        expect(page.meta.limit).toBe(2);
        expect(page.meta.offset).toBe(1);
        expect(page.data.length).toBe(2);
        // limit larger than the result set still echoes the requested limit,
        // and data is capped at the true match count (5), not the limit (7).
        const wide = await list(request, u.access_token, '?limit=7');
        expect(wide.meta.limit).toBe(7);
        expect(wide.data.length).toBe(5);
    });
});

test.describe('GET /api/agents — ordering & stability (updatedAt DESC)', () => {
    test('rows come back ordered by updatedAt DESC (non-increasing, ties tolerated)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 6, 'Order');
        const body = await list(request, u.access_token);
        expect(body.data.length).toBe(6);
        const ups = body.data.map((r) => r.updatedAt);
        // ISO-8601 strings sort lexically == chronologically; assert monotonic
        // non-increasing so equal-timestamp ties (same-second creation) pass.
        for (let i = 0; i + 1 < ups.length; i++) {
            expect(
                ups[i] >= ups[i + 1],
                `updatedAt non-increasing at ${i}: ${ups[i]} !>= ${ups[i + 1]}`,
            ).toBe(true);
        }
    });

    test('there is no ?sort / ?order param — the order is fixed (unknown sort params are rejected)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 3, 'NoSort');
        // The DTO has no sort/order field and forbidNonWhitelisted is on, so a
        // sort attempt is a 400 rather than silently re-ordering the feed.
        for (const qs of ['?sort=name', '?order=asc', '?sortBy=createdAt', '?orderBy=name']) {
            const res = await listRaw(request, u.access_token, qs);
            expect(res.status(), `unknown sort param ${qs} must 400`).toBe(400);
        }
    });

    test('bumping an agent (PATCH) advances updatedAt and floats it to the front', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const ids = await createAgents(request, u.access_token, 4, 'Bump');
        const oldest = ids[0];
        // Cross a whole-second boundary so the bumped row's updatedAt is strictly
        // greater than the others' (sqlite updatedAt is second-resolution).
        await new Promise((r) => setTimeout(r, 1100));
        const patch = await request.patch(`${API_BASE}/api/agents/${oldest}`, {
            headers: authedHeaders(u.access_token),
            data: { title: 'bumped' },
        });
        expect(patch.status()).toBe(200);
        const body = await list(request, u.access_token);
        expect(body.data[0].id, 'the freshly-bumped agent is now at the head').toBe(oldest);
        expect(body.data[0].title).toBe('bumped');
        // Its updatedAt dominates every other row's.
        const bumpedUp = body.data[0].updatedAt;
        for (const r of body.data.slice(1)) {
            expect(bumpedUp >= r.updatedAt).toBe(true);
        }
    });

    test('two identical concurrent list calls agree on total and head ordering', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 5, 'Concurrent');
        const [a, b, c] = await Promise.all([
            list(request, u.access_token),
            list(request, u.access_token),
            list(request, u.access_token),
        ]);
        expect(a.meta.total).toBe(5);
        expect(b.meta.total).toBe(5);
        expect(c.meta.total).toBe(5);
        // The ordered id vectors are identical across the parallel reads (a
        // single sqlite connection serializes them deterministically).
        const ids = (x: ListBody) => x.data.map((r) => r.id);
        expect(ids(b)).toEqual(ids(a));
        expect(ids(c)).toEqual(ids(a));
    });
});

test.describe('GET /api/agents — pagination windows & edges', () => {
    test('limit caps the page to exactly `limit` rows while total stays the full count', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 7, 'Cap');
        const page = await list(request, u.access_token, '?limit=3');
        expect(page.data.length).toBe(3);
        expect(page.meta.total).toBe(7);
        expect(page.meta.limit).toBe(3);
    });

    test('offset walks the window; a partial final page returns the remainder', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 7, 'Walk');
        expect((await list(request, u.access_token, '?limit=3&offset=0')).data.length).toBe(3);
        expect((await list(request, u.access_token, '?limit=3&offset=3')).data.length).toBe(3);
        // 7 rows, offset 6 → 1 remaining.
        expect((await list(request, u.access_token, '?limit=3&offset=6')).data.length).toBe(1);
    });

    test('paging through with a small limit covers the full set with no dup and no gap', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const created = await createAgents(request, u.access_token, 8, 'Cover');
        const createdSet = new Set(created);
        const seen: string[] = [];
        for (let offset = 0; offset < 20; offset += 3) {
            const page = await list(request, u.access_token, `?limit=3&offset=${offset}`);
            expect(page.meta.total).toBe(8);
            if (page.data.length === 0) break;
            for (const r of page.data) seen.push(r.id);
        }
        // Union of every page equals the created set exactly (no duplicate id,
        // no id missing, no foreign id leaked in).
        expect(seen.length).toBe(8);
        expect(new Set(seen).size).toBe(8);
        for (const id of created) {
            expect(seen, `created agent ${id} appears across the pages`).toContain(id);
        }
        expect(seen.every((id) => createdSet.has(id))).toBe(true);
    });

    test('offset past the end yields an empty page but preserves total and echoes the raw offset', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 3, 'PastEnd');
        const beyond = await list(request, u.access_token, '?offset=999');
        expect(beyond.data).toEqual([]);
        expect(beyond.meta.total).toBe(3);
        expect(beyond.meta.offset).toBe(999); // echoed verbatim, not clamped to 3
        expect(beyond.meta.limit).toBe(50);
    });

    test('a single full-width page returns every created row (limit >= total)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const created = await createAgents(request, u.access_token, 9, 'Full');
        const body = await list(request, u.access_token, '?limit=200');
        expect(body.data.length).toBe(9);
        const ids = body.data.map((r) => r.id);
        for (const id of created) expect(ids).toContain(id);
    });
});

test.describe('GET /api/agents — limit/offset validation (400)', () => {
    test('limit outside [1,200] or non-integer is rejected with 400', async ({ request }) => {
        const u = await freshUser(request);
        for (const qs of ['?limit=0', '?limit=201', '?limit=-1', '?limit=abc', '?limit=3.5']) {
            const res = await listRaw(request, u.access_token, qs);
            expect(res.status(), `limit edge ${qs} must 400`).toBe(400);
        }
    });

    test('the inclusive limit boundaries 1 and 200 are accepted with 200', async ({ request }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 2, 'Bound');
        const lo = await list(request, u.access_token, '?limit=1');
        expect(lo.data.length).toBe(1);
        expect(lo.meta.limit).toBe(1);
        const hi = await list(request, u.access_token, '?limit=200');
        expect(hi.meta.limit).toBe(200);
        expect(hi.data.length).toBe(2);
    });

    test('offset below 0 or non-integer is rejected with 400; 0 and huge offsets are accepted', async ({
        request,
    }) => {
        const u = await freshUser(request);
        for (const qs of ['?offset=-1', '?offset=abc', '?offset=1.5']) {
            const res = await listRaw(request, u.access_token, qs);
            expect(res.status(), `offset edge ${qs} must 400`).toBe(400);
        }
        expect((await listRaw(request, u.access_token, '?offset=0')).status()).toBe(200);
        expect((await listRaw(request, u.access_token, '?offset=1000000')).status()).toBe(200);
    });

    test('unknown query params are rejected with 400 (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        for (const qs of ['?foo=bar', '?page=2', '?cursor=abc', '?take=5', '?q=x']) {
            const res = await listRaw(request, u.access_token, qs);
            expect(res.status(), `unknown param ${qs} must 400`).toBe(400);
        }
    });
});

test.describe('GET /api/agents — filters', () => {
    test('?scope filters by scope; a bogus scope enum is 400 and a mismatched scope returns 0', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 3, 'Scope');
        const tenant = await list(request, u.access_token, '?scope=tenant');
        expect(tenant.meta.total).toBe(3);
        expect(tenant.data.every((r) => r.scope === 'tenant')).toBe(true);
        // All the created agents are tenant-scoped → mission scope matches nothing.
        expect((await list(request, u.access_token, '?scope=mission')).meta.total).toBe(0);
        // A value outside the AgentScope enum is a validation error.
        expect((await listRaw(request, u.access_token, '?scope=bogus')).status()).toBe(400);
    });

    test('?status partitions draft vs active after a real draft→active transition', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const ids = await createAgents(request, u.access_token, 3, 'Status');
        // resume() drives DRAFT → ACTIVE (USER_TRANSITIONS allows it).
        const resume = await request.post(`${API_BASE}/api/agents/${ids[0]}/resume`, {
            headers: authedHeaders(u.access_token),
        });
        expect(resume.status()).toBe(200);

        const active = await list(request, u.access_token, '?status=active');
        expect(active.meta.total).toBe(1);
        expect(active.data.every((r) => r.status === 'active')).toBe(true);
        expect(active.data.map((r) => r.id)).toContain(ids[0]);

        const draft = await list(request, u.access_token, '?status=draft');
        expect(draft.meta.total).toBe(2);
        expect(draft.data.every((r) => r.status === 'draft')).toBe(true);
        expect(draft.data.map((r) => r.id)).not.toContain(ids[0]);
    });

    test('a bogus status enum is 400', async ({ request }) => {
        const u = await freshUser(request);
        expect((await listRaw(request, u.access_token, '?status=bogus')).status()).toBe(400);
    });

    test('archived agents are excluded from the default list and ?status=archived is always empty', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const ids = await createAgents(request, u.access_token, 3, 'Archive');
        const del = await request.delete(`${API_BASE}/api/agents/${ids[0]}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(del.status()).toBe(200);

        const def = await list(request, u.access_token);
        expect(def.meta.total).toBe(2); // archived one dropped
        expect(def.data.map((r) => r.id)).not.toContain(ids[0]);

        // `archived` is a valid enum (200) but the repo filters `status != archived`
        // BEFORE applying the status filter → the intersection is always empty.
        const arch = await list(request, u.access_token, '?status=archived');
        expect(arch.meta.total).toBe(0);
        expect(arch.data).toEqual([]);
    });

    test('?search matches on the agent name and total reflects only the matches', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = `zqx${stamp().replace(/-/g, '')}`;
        await createAgent(request, u.access_token, `${token} alpha`);
        await createAgent(request, u.access_token, `${token} beta`);
        await createAgent(request, u.access_token, `unrelated ${stamp()}`);

        const hit = await list(request, u.access_token, `?search=${encodeURIComponent(token)}`);
        expect(hit.meta.total).toBe(2);
        expect(hit.data.length).toBe(2);
        expect(hit.data.every((r) => r.name.includes(token))).toBe(true);
    });

    test('?search escapes LIKE wildcards — a literal "%" matches nothing when no name contains it', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 3, 'NoPercent');
        // Unescaped, `%` would match every row; escaped, it is a literal char that
        // appears in none of the names → 0 matches (total untouched at 0).
        const res = await list(request, u.access_token, `?search=${encodeURIComponent('%')}`);
        expect(res.meta.total).toBe(0);
        expect(res.data).toEqual([]);
    });

    test('?search accepts an 80-char term but rejects 81 chars with 400', async ({ request }) => {
        const u = await freshUser(request);
        expect((await listRaw(request, u.access_token, `?search=${'a'.repeat(80)}`)).status()).toBe(
            200,
        );
        expect((await listRaw(request, u.access_token, `?search=${'a'.repeat(81)}`)).status()).toBe(
            400,
        );
    });

    test('a valid-but-absent parent uuid filter returns 0; a non-uuid parent filter is 400', async ({
        request,
    }) => {
        const u = await freshUser(request);
        await createAgents(request, u.access_token, 2, 'Parent');
        // Well-formed v4 uuids that reference no row of this user → empty, total 0.
        const ghost = 'b81a2c00-a0c0-4a20-aaa8-ef45fff2ddda';
        for (const key of ['missionId', 'ideaId', 'workId']) {
            const body = await list(request, u.access_token, `?${key}=${ghost}`);
            expect(body.meta.total, `${key}=<ghost> → 0`).toBe(0);
            expect(body.data).toEqual([]);
        }
        // Malformed uuids are validation errors.
        for (const key of ['missionId', 'ideaId', 'workId']) {
            const res = await listRaw(request, u.access_token, `?${key}=not-a-uuid`);
            expect(res.status(), `${key}=not-a-uuid → 400`).toBe(400);
        }
    });

    test('combined scope + status filters intersect (AND semantics)', async ({ request }) => {
        const u = await freshUser(request);
        const ids = await createAgents(request, u.access_token, 3, 'Combo');
        await request.post(`${API_BASE}/api/agents/${ids[0]}/resume`, {
            headers: authedHeaders(u.access_token),
        });
        // tenant AND active → exactly the one we activated.
        const hit = await list(request, u.access_token, '?scope=tenant&status=active');
        expect(hit.meta.total).toBe(1);
        expect(hit.data[0].id).toBe(ids[0]);
        // tenant AND active AND limit still echoes the window.
        expect(hit.meta.limit).toBe(50);
        // mission AND active → the scope predicate knocks it to empty.
        const miss = await list(request, u.access_token, '?scope=mission&status=active');
        expect(miss.meta.total).toBe(0);
        expect(miss.data).toEqual([]);
    });
});

test.describe('GET /api/agents — isolation & auth', () => {
    test('the list is user-scoped: one user never sees another user’s agents', async ({
        request,
    }) => {
        const a = await freshUser(request);
        const b = await freshUser(request);
        const aIds = await createAgents(request, a.access_token, 3, 'Owner A');
        const bIds = await createAgents(request, b.access_token, 2, 'Owner B');

        const aList = await list(request, a.access_token);
        expect(aList.meta.total).toBe(3);
        const aSeen = aList.data.map((r) => r.id);
        for (const id of aIds) expect(aSeen).toContain(id);
        for (const id of bIds) expect(aSeen).not.toContain(id);
        // Every row is stamped with the caller's userId.
        expect(aList.data.every((r) => r.userId === a.user.id)).toBe(true);

        const bList = await list(request, b.access_token);
        expect(bList.meta.total).toBe(2);
        const bSeen = bList.data.map((r) => r.id);
        for (const id of bIds) expect(bSeen).toContain(id);
        for (const id of aIds) expect(bSeen).not.toContain(id);
    });

    test('an unauthenticated list request is rejected with 401', async ({ request }) => {
        const res = await listRaw(request, null);
        expect(res.status()).toBe(401);
    });

    test('a garbage bearer token is rejected with 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/agents`, {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(res.status()).toBe(401);
    });
});
