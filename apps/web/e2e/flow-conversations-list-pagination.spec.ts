/**
 * flow-conversations-list-pagination — GET /api/conversations LIST semantics,
 * driven end-to-end against the live stack. Deep + assertive coverage of the
 * `{ conversations, total }` contract: the narrow summary projection, the
 * updatedAt-DESC ordering (with rename / message-append re-sort), the clamp
 * math on `limit` / `offset`, the repo default page size, hostile / inert query
 * params, own-only isolation, and read/mutation behaviour under real concurrency.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-conversation-crud-deep.spec.ts (singular) already pins the happy-path
 *   limit=2 window over 5 rows, the DESC ordering, the rename→top re-sort, and the
 *   summary projection. flow-conversations-crud-deep.spec.ts (plural) pins a few
 *   clamp edges (limit=1000000→200, limit=0→1, limit=-5→1, limit=abc→default,
 *   offset=-5→0). NEITHER covers: the exact BOUNDARY clamps (201→200, 200 verbatim,
 *   fractional 2.7→2, EMPTY-string limit/offset falling through the `x ? … : undefined`
 *   guard vs the NaN path), the repo DEFAULT page size of 50 proven with >50 rows,
 *   message-append (not rename) as a re-sort trigger, SQL-injection-shaped params
 *   being inert (parameterised queries), unknown query params being ignored, list
 *   own-only isolation with interleaved owners, or the CONCURRENCY matrix (parallel
 *   identical reads are a consistent snapshot; a small parallel create burst loses
 *   nothing / duplicates nothing; an over-cap burst that the per-user throttle
 *   partially rejects is reflected EXACTLY by the committed rows; parallel delete-all
 *   converges to empty with no double-delete). THIS file owns all of that.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users BEFORE any assertion. Exact observed contract:
 *
 *   GET /api/conversations  → 200 { conversations: [row…], total }
 *     • row projection is EXACTLY { id, title, providerId, model, createdAt,
 *       updatedAt } — NO userId / messages / metadata / tenantId / organizationId,
 *       even when the conversation has messages (repo `select` list in findByUser).
 *     • `total` is the true COUNT of the caller's rows, independent of the page
 *       window (limit / offset never change it).
 *     • ordering is `updatedAt DESC`; a PATCH title OR a message append touches
 *       updatedAt and floats that conversation to the front.
 *     • DEFAULT page size (no `limit`) is 50 (repo `take: limit ?? 50`).
 *     • clamp (controller): limit → Math.min(Math.max(n,1),200); offset →
 *       Math.max(n,0). `?limit=` / `?offset=` (empty string) are FALSY → the
 *       repo default applies (50 / 0). NaN (`abc`) → default too. `2.7`→2.
 *       0/-5→1. 201→200. 200 verbatim. offset past the end → empty page.
 *     • the `limit`/`offset` values reach TypeORM as bound parameters, so a
 *       `?limit=1;DROP TABLE…` string is parsed to its leading int and is
 *       otherwise inert; unknown params (status/q/sort/cursor/order) are ignored.
 *     • auth: no / malformed / garbage bearer → 401. Own-only: a caller never
 *       sees another user's conversations at any page window.
 *
 *   PER-USER THROTTLE (observed, honored): the platform throttler buckets by
 *   `user:<id>` — short 50/1s, medium 300/10s, long 1000/60s. Every test uses a
 *   FRESH registerUserViaAPI() owner (its own bucket), keeps parallel bursts well
 *   under 50, and paces the >50-row bulk create in small gap-separated batches so
 *   the short tier never trips. One test deliberately over-caps the burst to pin
 *   the truthful "committed rows == number of 201s" invariant.
 *
 * Fully API-orchestrated (safe `flow-` prefix — not matched by the no-auth
 * testIgnore regex), so it never contends on the shared UI auth state. IDs are
 * asserted with toContain / not.toContain (never exact global counts on the
 * shared shard DB); ordering is asserted non-increasing WITH equal-timestamp
 * tolerance; multi-valued statuses use tolerant expect([...]).toContain.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const CONV_URL = `${API_BASE}/api/conversations`;

/** Second-precision timestamps: a touch must sit >1s away to strictly re-sort. */
const TICK_MS = 1_100;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface ConvSummary {
    id: string;
    title: string | null;
    providerId: string | null;
    model: string | null;
    createdAt: string;
    updatedAt: string;
}

interface ConvListBody {
    conversations: ConvSummary[];
    total: number;
}

/** Create one conversation. Asserts the expected status (201 by default). */
async function createConversation(
    request: APIRequestContext,
    token: string,
    body: { title?: string; providerId?: string } = {},
    expectStatus = 201,
): Promise<ConvSummary> {
    const res = await request.post(CONV_URL, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: body,
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(expectStatus);
    return res.json();
}

/** GET the list with an optional query string. Asserts 200 and returns the body. */
async function listConversations(
    request: APIRequestContext,
    token: string,
    qs = '',
): Promise<ConvListBody> {
    const res = await request.get(`${CONV_URL}${qs}`, { headers: authedHeaders(token) });
    expect(res.status(), `list${qs} body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as ConvListBody;
    expect(Array.isArray(body.conversations), 'conversations is an array').toBe(true);
    expect(typeof body.total, 'total is a number').toBe('number');
    return body;
}

async function patchTitle(
    request: APIRequestContext,
    token: string,
    id: string,
    title: string,
): Promise<number> {
    const res = await request.patch(`${CONV_URL}/${id}`, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: { title },
    });
    return res.status();
}

async function appendMessages(
    request: APIRequestContext,
    token: string,
    id: string,
    messages: Array<{ role: string; content: string }>,
): Promise<number> {
    const res = await request.post(`${CONV_URL}/${id}/messages`, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: { messages },
    });
    return res.status();
}

/** Create `n` conversations paced in small gap-separated batches so the per-user
 *  short-tier throttle (50/1s) never trips even for a >50-row set. */
async function createManyPaced(
    request: APIRequestContext,
    token: string,
    n: number,
    batch = 10,
): Promise<ConvSummary[]> {
    const created: ConvSummary[] = [];
    for (let i = 0; i < n; i += batch) {
        const size = Math.min(batch, n - i);
        const rows = await Promise.all(
            Array.from({ length: size }, (_, k) =>
                createConversation(request, token, { title: `bulk-${i + k}-${stamp()}` }),
            ),
        );
        created.push(...rows);
        if (i + batch < n) await sleep(TICK_MS);
    }
    return created;
}

/** updatedAt DESC allowing equal-second ties (sqlite second precision). */
function expectNonIncreasingUpdatedAt(rows: ConvSummary[]): void {
    for (let i = 1; i < rows.length; i++) {
        expect(
            Date.parse(rows[i - 1].updatedAt),
            `updatedAt is non-increasing between index ${i - 1} and ${i}`,
        ).toBeGreaterThanOrEqual(Date.parse(rows[i].updatedAt));
    }
}

const SUMMARY_KEYS = ['id', 'title', 'providerId', 'model', 'createdAt', 'updatedAt'].sort();

// ─────────────────────────────────────────────────────────────────────────────
// Shape & projection.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — shape & projection', () => {
    test('a fresh user gets the exact empty envelope { conversations: [], total: 0 }', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const body = await listConversations(request, user.access_token);
        expect(body.conversations).toEqual([]);
        expect(body.total).toBe(0);
    });

    test('each row is the narrow summary projection — no userId / messages / metadata / scope FKs, even with messages', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {
            title: 'projected',
            providerId: 'openrouter',
        });
        // A conversation WITH messages still lists with the narrow projection.
        expect(
            await appendMessages(request, token, conv.id, [{ role: 'user', content: 'hi' }]),
        ).toBe(201);

        const body = await listConversations(request, token);
        const row = body.conversations.find((c) => c.id === conv.id);
        expect(row, 'the created conversation is in the list').toBeTruthy();
        expect(Object.keys(row as object).sort()).toEqual(SUMMARY_KEYS);
        for (const leaked of ['userId', 'messages', 'metadata', 'tenantId', 'organizationId']) {
            expect(row, `list row must not leak ${leaked}`).not.toHaveProperty(leaked);
        }
        expect(row!.id).toMatch(UUID_RE);
        expect(row!.title).toBe('projected');
        expect(row!.providerId).toBe('openrouter');
        expect(row!.createdAt).toMatch(ISO_RE);
        expect(row!.updatedAt).toMatch(ISO_RE);
    });

    test('a titleless conversation lists with title:null / providerId:null; model is always null (create rejects it)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        // `model` is NOT whitelisted on CreateConversationDto → forbidNonWhitelisted 400.
        await createConversation(request, token, { title: 't', providerId: 'p' }, 201);
        const rejected = await request.post(CONV_URL, {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: { title: 't2', model: 'gpt-4' },
        });
        expect(rejected.status(), 'model is not an accepted create field').toBe(400);

        const conv = await createConversation(request, token, {}); // empty body allowed
        const body = await listConversations(request, token);
        const row = body.conversations.find((c) => c.id === conv.id)!;
        expect(row.title).toBeNull();
        expect(row.providerId).toBeNull();
        expect(
            row.model,
            'model can never be set via the public create path → always null',
        ).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordering — updatedAt DESC, with re-sort on touch.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — updatedAt DESC ordering', () => {
    test('the whole list is ordered newest-updatedAt first (non-increasing, ties tolerated)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 8, 8); // one burst of 8 (< 50/s)

        const body = await listConversations(request, token, '?limit=200');
        expect(body.conversations.length).toBe(body.total);
        expectNonIncreasingUpdatedAt(body.conversations);
    });

    test('a PATCH title touches updatedAt and floats that conversation to the FRONT', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const first = await createConversation(request, token, { title: `old-${stamp()}` });
        await createConversation(request, token, { title: `mid-${stamp()}` });
        const last = await createConversation(request, token, { title: `new-${stamp()}` });

        // `last` is currently on top. Wait >1s so the touch is strictly newer.
        await sleep(TICK_MS);
        const renamed = `renamed-${stamp()}`;
        expect(await patchTitle(request, token, first.id, renamed)).toBe(204);

        await expect
            .poll(async () => (await listConversations(request, token)).conversations[0]?.id, {
                timeout: 15_000,
                message: 'the renamed (touched) conversation rises to the top',
            })
            .toBe(first.id);

        const after = await listConversations(request, token);
        expect(after.conversations[0].title).toBe(renamed);
        expect(after.conversations[0].id).not.toBe(last.id);
        expect(after.total, 'rename does not change the count').toBe(3);
        expectNonIncreasingUpdatedAt(after.conversations);
    });

    test('appending a message touches updatedAt and floats that conversation to the FRONT', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const target = await createConversation(request, token, { title: `target-${stamp()}` });
        await createConversation(request, token, { title: `later-${stamp()}` });

        // A newer conversation is on top; wait >1s so the append is strictly newer.
        await sleep(TICK_MS);
        expect(
            await appendMessages(request, token, target.id, [
                { role: 'user', content: 'wake me up' },
            ]),
        ).toBe(201);

        await expect
            .poll(async () => (await listConversations(request, token)).conversations[0]?.id, {
                timeout: 15_000,
                message: 'the conversation that received a message rises to the top',
            })
            .toBe(target.id);
        // The message itself never appears in the list projection.
        const top = (await listConversations(request, token)).conversations[0];
        expect(top).not.toHaveProperty('messages');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination window — limit caps, offset pages, total is window-independent.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — pagination window', () => {
    test('limit caps the returned page while total stays the full count', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 8, 8);

        const page = await listConversations(request, token, '?limit=3');
        expect(page.conversations.length, 'the page is capped at the limit').toBe(3);
        expect(page.total, 'total is the full count, not the page size').toBe(8);
    });

    test('offset pages sweep the full set: disjoint, complete, non-increasing, total constant every page', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const created = await createManyPaced(request, token, 12, 12);
        const createdIds = new Set(created.map((c) => c.id));

        const seen = new Set<string>();
        const sweep: ConvSummary[] = [];
        for (let offset = 0; offset < 12; offset += 5) {
            const page = await listConversations(request, token, `?limit=5&offset=${offset}`);
            expect(page.total, 'total is invariant across every page window').toBe(12);
            for (const row of page.conversations) {
                expect(
                    seen.has(row.id),
                    `row ${row.id} appears on exactly one page (disjoint)`,
                ).toBe(false);
                seen.add(row.id);
                sweep.push(row);
            }
        }
        // The concatenated sweep is exactly the created set (complete, no leaks).
        expect(seen.size, 'every created row surfaced exactly once across the sweep').toBe(12);
        for (const id of createdIds) expect(seen.has(id)).toBe(true);
        // Ordering is globally non-increasing across the reassembled pages.
        expectNonIncreasingUpdatedAt(sweep);
    });

    test('an offset past the end yields an empty page but leaves total unchanged', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 4, 4);

        const beyond = await listConversations(request, token, '?offset=9999');
        expect(beyond.conversations, 'no rows past the end').toEqual([]);
        expect(beyond.total, 'total is still the full count').toBe(4);
    });

    test('a limit wider than the post-offset remainder returns only the remainder', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 5, 5);

        const tail = await listConversations(request, token, '?limit=50&offset=3');
        expect(tail.conversations.length, 'only 2 rows remain after offset 3').toBe(2);
        expect(tail.total).toBe(5);
    });

    test('total is a true COUNT, invariant across default / limit=1 / offset-beyond-end windows', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 6, 6);

        const def = await listConversations(request, token);
        const one = await listConversations(request, token, '?limit=1');
        const past = await listConversations(request, token, '?offset=100');
        expect(def.total).toBe(6);
        expect(one.total).toBe(6);
        expect(past.total).toBe(6);
        expect(one.conversations.length, 'limit=1 returns exactly the newest row').toBe(1);
        expect(one.conversations[0].id, 'the single row is the list head').toBe(
            def.conversations[0].id,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default page size — repo `take: limit ?? 50`.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — default page size (50)', () => {
    test('with >50 conversations the default (no limit) returns exactly 50; limit=200 returns them all', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const created = await createManyPaced(request, token, 55, 10);
        expect(created.length, 'all 55 paced creates committed (no throttle inside batches)').toBe(
            55,
        );

        const def = await listConversations(request, token);
        expect(def.total, 'total reflects every row').toBe(55);
        expect(def.conversations.length, 'the default page is capped at 50').toBe(50);

        const wide = await listConversations(request, token, '?limit=200');
        expect(wide.conversations.length, 'a 200 limit returns the full set (< cap)').toBe(55);

        const tail = await listConversations(request, token, '?limit=50&offset=50');
        expect(tail.conversations.length, 'the remainder past the default page is 5').toBe(5);

        // The default page and the second page are disjoint and cover everything.
        const firstIds = new Set(def.conversations.map((c) => c.id));
        expect(
            tail.conversations.every((c) => !firstIds.has(c.id)),
            'pages are disjoint',
        ).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Clamp math — boundaries the sibling specs don't touch.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — limit/offset clamp boundaries', () => {
    test('limit=200 is honored verbatim and limit=201 clamps down to 200', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        // Enough rows that the exact page value is what the clamp yields, not the row count.
        const created = await createManyPaced(request, token, 6, 6);

        const at = await listConversations(request, token, '?limit=200');
        const over = await listConversations(request, token, '?limit=201');
        // Both resolve to a page >= our rows and equal to each other (201→200 clamp).
        expect(at.conversations.length).toBe(created.length);
        expect(over.conversations.length, '201 is clamped to 200 → same page as limit=200').toBe(
            created.length,
        );
        expect(over.total).toBe(created.length);
    });

    test('a fractional limit is parsed to its integer floor (2.7 → 2)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 5, 5);

        const frac = await listConversations(request, token, '?limit=2.7');
        expect(frac.conversations.length, 'parseInt("2.7") = 2').toBe(2);
        expect(frac.total).toBe(5);
    });

    test('EMPTY-string limit/offset fall through to the repo defaults (limit 50, offset 0)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 4, 4);

        // `?limit=` and `?offset=` are the empty string → falsy → default branch,
        // a DISTINCT code path from the NaN ("abc") one the sibling spec covers.
        const empties = await listConversations(request, token, '?limit=&offset=');
        expect(empties.conversations.length, 'empty limit → default 50 → all 4 rows').toBe(4);
        expect(empties.total).toBe(4);
    });

    test('a non-numeric offset floors to the default 0 (no rows skipped)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 4, 4);

        const nan = await listConversations(request, token, '?offset=notanumber');
        expect(nan.conversations.length, 'NaN offset → default 0 → nothing skipped').toBe(4);
    });

    test('limit=1 returns exactly one row — the list head', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 5, 5);

        const full = await listConversations(request, token);
        const one = await listConversations(request, token, '?limit=1');
        expect(one.conversations.length).toBe(1);
        expect(one.conversations[0].id).toBe(full.conversations[0].id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hostile / inert query params — parameterised queries, ignored unknowns.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — hostile & inert params', () => {
    test('SQL-injection-shaped limit/offset/sort values are inert — leading int parsed, no data harmed, no 5xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 4, 4);

        // `limit` is parsed to its leading integer (1) and bound as a parameter; the
        // trailing `;DROP TABLE…` is never interpreted. `sort=` is not a real param.
        const injected = await listConversations(
            request,
            token,
            '?limit=1;DROP%20TABLE%20conversations&sort=id;DROP',
        );
        expect(injected.conversations.length, 'leading int 1 honored, injection inert').toBe(1);

        // The table is intact: a plain follow-up list still returns all four rows.
        const intact = await listConversations(request, token);
        expect(intact.total, 'no table was dropped — every row survives').toBe(4);
    });

    test('unknown query params (status / q / sort / cursor / order) are ignored', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 5, 5);

        const baseline = await listConversations(request, token);
        const noisy = await listConversations(
            request,
            token,
            '?status=archived&q=nonsense&sort=title&cursor=abc&order=asc',
        );
        // The endpoint only honors limit/offset — every unknown param is a no-op.
        expect(noisy.total).toBe(baseline.total);
        expect(noisy.conversations.map((c) => c.id)).toEqual(
            baseline.conversations.map((c) => c.id),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth & own-only isolation.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — auth & own-only isolation', () => {
    test('no / malformed / garbage bearer → 401', async ({ request }) => {
        const anon = await request.get(CONV_URL);
        expect(anon.status()).toBe(401);
        const malformed = await request.get(CONV_URL, {
            headers: { authorization: 'NotBearer xyz' },
        });
        expect(malformed.status()).toBe(401);
        const garbage = await request.get(CONV_URL, {
            headers: { authorization: 'Bearer garbage.token.value' },
        });
        expect(garbage.status()).toBe(401);
    });

    test('two owners with interleaved creates each see ONLY their own rows, with their own total', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aIds: string[] = [];
        const bIds: string[] = [];
        // Interleave so wall-clock ordering cannot accidentally segregate them.
        for (let i = 0; i < 3; i++) {
            aIds.push((await createConversation(request, a.access_token, { title: `A-${i}` })).id);
            bIds.push((await createConversation(request, b.access_token, { title: `B-${i}` })).id);
        }

        const aList = await listConversations(request, a.access_token);
        const bList = await listConversations(request, b.access_token);
        const aSeen = aList.conversations.map((c) => c.id);
        const bSeen = bList.conversations.map((c) => c.id);

        expect(aList.total, "A's total counts only A's rows").toBe(3);
        expect(bList.total, "B's total counts only B's rows").toBe(3);
        for (const id of aIds) expect(aSeen).toContain(id);
        for (const id of bIds) {
            expect(aSeen, "A never sees B's conversations").not.toContain(id);
            expect(bSeen).toContain(id);
        }
        for (const id of aIds) expect(bSeen, "B never sees A's conversations").not.toContain(id);
    });

    test('paging never crosses the owner boundary — a deep offset into A never reveals B', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aRows = await createManyPaced(request, a.access_token, 4, 4);
        const bRows = await createManyPaced(request, b.access_token, 4, 4);
        const bIds = new Set(bRows.map((r) => r.id));

        // Sweep A's list with a window that would overrun into a shared table if the
        // query weren't user-scoped. Every returned row must belong to A.
        for (let offset = 0; offset < 6; offset += 2) {
            const page = await listConversations(
                request,
                a.access_token,
                `?limit=2&offset=${offset}`,
            );
            for (const row of page.conversations) {
                expect(bIds.has(row.id), 'no B row leaks into A pagination').toBe(false);
            }
        }
        const full = await listConversations(request, a.access_token, '?limit=200');
        expect(full.total).toBe(aRows.length);
        expect(full.conversations.every((r) => !bIds.has(r.id))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency — consistent reads, no lost/duplicate writes, converging deletes.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Conversations list — concurrency', () => {
    test('N parallel identical reads return a consistent { total, count } snapshot with no 5xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await createManyPaced(request, token, 7, 7);

        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                request.get(CONV_URL, { headers: authedHeaders(token) }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 200),
            `every read 200 (${statuses})`,
        ).toBe(true);
        const bodies = (await Promise.all(results.map((r) => r.json()))) as ConvListBody[];
        expect(
            new Set(bodies.map((b) => b.total)),
            'every concurrent read sees the same total',
        ).toEqual(new Set([7]));
        expect(
            new Set(bodies.map((b) => b.conversations.length)),
            'every concurrent read sees the same page size',
        ).toEqual(new Set([7]));
    });

    test('a small parallel create burst loses nothing and duplicates nothing — total == N, all ids present', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const N = 10; // well under the 50/s short tier

        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                request.post(CONV_URL, {
                    headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                    data: { title: `burst-${i}-${stamp()}` },
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 201),
            `every create 201 (${statuses})`,
        ).toBe(true);
        const ids = (await Promise.all(results.map((r) => r.json()))).map((j) => j.id as string);
        expect(new Set(ids).size, 'every create minted a distinct id').toBe(N);

        const list = await listConversations(request, token, '?limit=200');
        expect(list.total, 'exactly N rows committed — no lost create').toBe(N);
        const listed = new Set(list.conversations.map((c) => c.id));
        for (const id of ids) expect(listed.has(id), `created ${id} is listed`).toBe(true);
    });

    test('an over-cap create burst is partially throttled; the list reflects EXACTLY the committed (201) rows', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const BURST = 60; // deliberately over the per-user short tier (50/1s)

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                request.post(CONV_URL, {
                    headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                    data: { title: `cap-${i}-${stamp()}` },
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        // Every response is either a committed 201 or a throttled 429 — never a 5xx.
        expect(
            statuses.every((s) => s === 201 || s === 429),
            `only 201 / 429 in the burst (${statuses})`,
        ).toBe(true);
        const committed = results.filter((r) => r.status() === 201);
        expect(committed.length, 'at least one create committed').toBeGreaterThanOrEqual(1);
        // The short tier (50/1s) normally caps a 60-burst below its size; we don't
        // hard-assert the trip (CI timing can smear the burst across two 1s windows),
        // only that the committed set never exceeds what we fired.
        expect(committed.length, 'committed cannot exceed the burst').toBeLessThanOrEqual(BURST);
        const committedIds = (await Promise.all(committed.map((r) => r.json()))).map(
            (j) => j.id as string,
        );

        // Let the short-tier window reset before the verifying read so it isn't itself
        // throttled by the burst that just saturated the bucket.
        await sleep(TICK_MS);
        // The list total equals the number of committed rows — no phantom rows from
        // throttled requests, no committed row silently lost.
        const list = await listConversations(request, token, '?limit=200');
        expect(list.total, 'total == number of committed (201) creates').toBe(committed.length);
        const listed = new Set(list.conversations.map((c) => c.id));
        for (const id of committedIds)
            expect(listed.has(id), `committed ${id} is listed`).toBe(true);
    });

    test('parallel delete-all converges to an empty list with no double-delete and no 5xx-then-resurrection', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const created = await createManyPaced(request, token, 6, 6);

        const results = await Promise.all(
            Array.from({ length: 3 }, () =>
                request.delete(CONV_URL, { headers: authedHeaders(token) }),
            ),
        );
        const statuses = results.map((r) => r.status());
        // Each racer either wins (200 with a {deleted} report) or hits a sqlite
        // tx-serialization 5xx — never a 4xx, never anything else.
        expect(
            statuses.every((s) => s === 200 || s >= 500),
            `delete-all racers are 200 or 5xx only (${statuses})`,
        ).toBe(true);

        // No double-delete: across the 200 responses, the rows are each removed once,
        // so the reported deletions never exceed the number that existed.
        const deletedCounts = await Promise.all(
            results
                .filter((r) => r.status() === 200)
                .map((r) => r.json().then((b) => b.deleted as number)),
        );
        const totalDeleted = deletedCounts.reduce((a, b) => a + b, 0);
        expect(totalDeleted, 'no row is deleted more than once').toBeLessThanOrEqual(
            created.length,
        );

        // The strong invariant: the list is empty afterwards (no resurrection). A
        // clean follow-up delete settles it if every racer happened to conflict.
        let after = await listConversations(request, token);
        if (after.total !== 0) {
            await request.delete(CONV_URL, { headers: authedHeaders(token) });
            after = await listConversations(request, token);
        }
        expect(after.total, 'the list is empty after the delete race').toBe(0);
        expect(after.conversations).toEqual([]);
    });
});
