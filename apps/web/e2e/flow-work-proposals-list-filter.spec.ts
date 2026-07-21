import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
    type RegisteredUser,
} from './helpers/api';

/**
 * Work-Proposals (Ideas) — the LIST / FILTER / ORDER / PAGINATE read-model of
 * `GET /api/me/work-proposals`. This file owns the runtime BEHAVIOUR of the list
 * projection: the generatedAt-DESC ordering contract (status-agnostic, tie-
 * tolerant), the limit/offset windowing algebra, the `?statuses=` UNION semantics
 * (repeated params union — comma does NOT), the env-adaptive `?search=` ILIKE
 * execution, ORDER-BY injection hardening, and own-only scoping under every one
 * of those axes.
 *
 * Every status code, ordering rule, and env-adaptive branch asserted below was
 * probed against the LIVE API at http://127.0.0.1:3100 (sqlite in-memory,
 * REQUIRE_EMAIL_VERIFICATION=false, no AI provider / no Trigger.dev, keyless)
 * BEFORE this file was written.
 *
 * Taxonomy: a Mission produces Ideas; an Idea becomes a Work. An Idea is a
 * WorkProposal under `/api/me/work-proposals`.
 *
 * ── NON-DUPLICATION (deliberately DISJOINT from the sibling Idea specs) ──────
 *   - work-proposals.spec.ts                       — shallow 401 + empty-list +
 *     unknown-uuid smoke pins. THIS file drives the FULL list read-model.
 *   - flow-work-proposals-deep.spec.ts             — the POSITIVE create→read→
 *     status→prefs→budget→attachments→build round-trip; it pins ordering only
 *     for TWO same-instant rows (insertion tie) and pagination only as
 *     limit=1/offset=1 on 2 rows, plus the limit=0/102 & offset=-1 REJECTS.
 *     THIS file NEVER re-asserts those: it pins the DISTINCT-second DESC
 *     contract across a 5–7 row spaced set, the multi-page TILING algebra
 *     (disjoint + covering + order-preserving), offset-without-limit, offset
 *     past-end, limit>count, and huge-offset/limit=101 acceptance.
 *   - flow-work-proposals-validation-authz-matrix.spec.ts — the DTO validation
 *     lattice (statuses enum bogus/empty/uppercase/each-valid/repeated-SAME;
 *     limit/offset numeric TYPE; search maxLength 500/501; unknown-param
 *     whitelist; default-pending + 2-value union CONTAINMENT; statuses+limit
 *     compose; 401; default-list per-user). THIS file pins the ORTHOGONAL
 *     runtime behaviour those leave open: comma-statuses REJECTION (vs the
 *     repeated-param UNION), a 3-bucket union asserted by EXACT SET + STATUS-
 *     AGNOSTIC DESC ORDER + windowing, the search TRIM-to-no-op 200 path and
 *     the search SEMANTICS branch, ORDER-BY injection via ?sort/?order/?orderBy,
 *     and own-only isolation under a status BUCKET / under PAGINATION / under a
 *     search no-op (matrix only isolates the default pending list).
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────────
 *  GET /api/me/work-proposals → 200, a BARE ARRAY (no {data,meta} envelope).
 *    · ORDER: generatedAt DESC (newest-first), and the order is STATUS-AGNOSTIC
 *      — a dismissed/accepted row sorts purely by its generatedAt, not by bucket.
 *      generatedAt has SECOND precision → same-second rows tie (order among ties
 *      is insertion/rowid, so assertions are tie-tolerant / non-increasing).
 *    · PAGINATE: ?limit=3&offset={0,3,6} tiles a 7-row set into 3/3/1 with no
 *      overlap and no gaps, order preserved; ?offset past the end → [] (200);
 *      ?offset without ?limit skips N and returns the ordered remainder;
 *      ?limit greater than the row count returns all rows; ?offset=1000000 → []
 *      (200); ?limit=101 (the Max) → 200.
 *    · ?statuses UNION: ?statuses=a&statuses=b&statuses=c (REPEATED) unions the
 *      three buckets (200); a COMMA-joined ?statuses=a,b → 400 (the whole "a,b"
 *      string is a single invalid enum member — comma is NOT a union operator
 *      here); one bogus among repeated valid values → 400.
 *    · ?search: a whitespace-only / empty ?search trims to undefined in the
 *      controller → the ILIKE branch never runs → 200 with the UNFILTERED own
 *      set. A non-empty ?search builds a Postgres ILIKE the sqlite CI stack
 *      can't execute → env-adaptive [200 (pg) | 500 (sqlite)]; NEVER a 4xx once
 *      it passed maxLength validation.
 *    · HARDENING: ?sort / ?order / ?orderBy / ?direction (ORDER-BY injection
 *      vectors) are rejected 400 "property <x> should not exist" — no attacker-
 *      controlled ORDER BY ever reaches the query builder.
 *    · SCOPE: the list is WHERE userId = caller under EVERY axis — a stranger's
 *      rows never surface in your default list, your status buckets, your pages,
 *      or your search results.
 *
 * Cross-spec isolation: EVERY test runs on FRESH registerUserViaAPI() users, so
 * a user's own list total is deterministic (a fresh user owns exactly the rows
 * the test creates). Cross-user leak checks use toContain/not.toContain. Unique
 * suffixes come from a per-call stamp(), never a module-scope clock.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEA_DESC_MIN = 'A curated directory of resources'; // ≥10 chars filler

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * generatedAt has SECOND precision on this stack; a gap > 1s guarantees the two
 * rows land on distinct seconds (so their DESC order is deterministic, not a tie).
 */
const DISTINCT_SECOND_GAP_MS = 1100;

interface IdeaRow {
    id: string;
    title: string;
    description: string;
    status: string;
    acceptedWorkId: string | null;
    generatedAt: string;
}

async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<IdeaRow> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `create idea body=${await res.text()}`).toBe(201);
    const idea = (await res.json()) as IdeaRow;
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    return idea;
}

/**
 * Create N pending Ideas with a > 1s gap between each so every row lands on a
 * DISTINCT second — the returned ids are in creation order (oldest → newest),
 * so the newest-first list is exactly `[...ids].reverse()`.
 */
async function createSpacedIdeas(
    request: APIRequestContext,
    token: string,
    n: number,
    tag: string,
): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const idea = await createIdea(request, token, `${IDEA_DESC_MIN} ${tag}-${i}-${stamp()}`);
        ids.push(idea.id);
        if (i < n - 1) await sleep(DISTINCT_SECOND_GAP_MS);
    }
    return ids;
}

/** Create N Ideas back-to-back (no gap) — timestamps may TIE. Order in ids is creation order. */
async function createFastIdeas(
    request: APIRequestContext,
    token: string,
    n: number,
    tag: string,
): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const idea = await createIdea(request, token, `${IDEA_DESC_MIN} ${tag}-${i}-${stamp()}`);
        ids.push(idea.id);
    }
    return ids;
}

async function listRes(request: APIRequestContext, token: string, qs = '') {
    return request.get(`${API_BASE}/api/me/work-proposals${qs}`, {
        headers: authedHeaders(token),
    });
}

async function listRows(request: APIRequestContext, token: string, qs = ''): Promise<IdeaRow[]> {
    const res = await listRes(request, token, qs);
    expect(res.status(), `list ${qs} body=${await res.text()}`).toBe(200);
    const rows = (await res.json()) as IdeaRow[];
    expect(Array.isArray(rows), `list ${qs} is an array`).toBe(true);
    return rows;
}

/** Assert generatedAt is non-increasing down the array (DESC order; equal ties allowed). */
function assertNonIncreasing(rows: IdeaRow[]): void {
    for (let i = 0; i + 1 < rows.length; i++) {
        const cur = Date.parse(rows[i].generatedAt);
        const nxt = Date.parse(rows[i + 1].generatedAt);
        expect(Number.isFinite(cur) && Number.isFinite(nxt), `parseable generatedAt at ${i}`).toBe(
            true,
        );
        expect(
            cur,
            `row ${i} (${rows[i].generatedAt}) >= row ${i + 1} (${rows[i + 1].generatedAt})`,
        ).toBeGreaterThanOrEqual(nxt);
    }
}

/** Dismiss a pending Idea (204). */
async function dismiss(request: APIRequestContext, token: string, id: string): Promise<void> {
    const res = await request.patch(`${API_BASE}/api/me/work-proposals/${id}/dismiss`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `dismiss ${id}`).toBe(204);
}

/** Accept a pending Idea against a freshly-created Work → transition to ACCEPTED (200). */
async function acceptAgainstNewWork(
    request: APIRequestContext,
    user: RegisteredUser,
    id: string,
    tag: string,
): Promise<void> {
    const work = await createWorkViaAPI(request, user.access_token, { name: `LF Work ${tag}` });
    expect(work.id, 'work id present').toMatch(UUID_RE);
    const res = await request.post(`${API_BASE}/api/me/work-proposals/${id}/accept`, {
        headers: authedHeaders(user.access_token),
        data: { workId: work.id },
    });
    expect(res.status(), `accept ${id} body=${await res.text()}`).toBe(200);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Ordering — generatedAt DESC (newest-first), status-agnostic, tie-tolerant
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — generatedAt DESC ordering', () => {
    test('the default list is newest-first (generatedAt DESC) across a distinctly-timed set', async ({
        request,
    }) => {
        test.slow();
        const user = await registerUserViaAPI(request);
        // Five Ideas created oldest → newest on five DISTINCT seconds.
        const created = await createSpacedIdeas(request, user.access_token, 5, `order-${stamp()}`);

        const rows = await listRows(request, user.access_token, '');
        // A fresh user owns exactly these five rows — the list is their exact
        // reverse (newest created appears first).
        expect(rows.map((r) => r.id)).toEqual([...created].reverse());
        assertNonIncreasing(rows);
        // The single most-recently-created Idea is at the head of the list.
        expect(rows[0].id).toBe(created[created.length - 1]);
    });

    test('same-second creations all appear and never break the non-increasing envelope (tie-tolerant)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // Four Ideas created back-to-back — several likely share a second and TIE.
        const created = await createFastIdeas(request, user.access_token, 4, `tie-${stamp()}`);

        const rows = await listRows(request, user.access_token, '');
        // Every created row is present exactly once regardless of tie ordering.
        expect(new Set(rows.map((r) => r.id))).toEqual(new Set(created));
        expect(rows).toHaveLength(created.length);
        // Ties are allowed: the sequence is non-increasing, never ascending.
        assertNonIncreasing(rows);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Pagination — the limit/offset windowing algebra
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — limit/offset windowing', () => {
    test('?limit=3 tiles offset 0/3/6 into disjoint, covering, order-preserving pages', async ({
        request,
    }) => {
        test.slow();
        const user = await registerUserViaAPI(request);
        const created = await createSpacedIdeas(request, user.access_token, 7, `tile-${stamp()}`);
        const newestFirst = [...created].reverse();

        const p0 = await listRows(request, user.access_token, '?limit=3&offset=0');
        const p3 = await listRows(request, user.access_token, '?limit=3&offset=3');
        const p6 = await listRows(request, user.access_token, '?limit=3&offset=6');
        expect(p0).toHaveLength(3);
        expect(p3).toHaveLength(3);
        expect(p6).toHaveLength(1); // 7 rows → 3 + 3 + 1

        const concat = [...p0, ...p3, ...p6];
        // Covering + disjoint: the three pages reconstruct the full set with no
        // overlap (7 ids, all distinct, exactly the created set).
        expect(concat).toHaveLength(7);
        expect(new Set(concat.map((r) => r.id))).toEqual(new Set(created));
        // Order-preserving: concatenated pages equal the single global DESC order.
        expect(concat.map((r) => r.id)).toEqual(newestFirst);
        assertNonIncreasing(concat);
    });

    test('walking the list one row at a time with ?limit=1 reproduces the global DESC order', async ({
        request,
    }) => {
        test.slow();
        const user = await registerUserViaAPI(request);
        const created = await createSpacedIdeas(request, user.access_token, 4, `walk-${stamp()}`);
        const newestFirst = [...created].reverse();

        const walked: string[] = [];
        for (let offset = 0; offset < created.length; offset++) {
            const page = await listRows(request, user.access_token, `?limit=1&offset=${offset}`);
            expect(page, `page at offset ${offset}`).toHaveLength(1);
            walked.push(page[0].id);
        }
        // Offset-walking a limit=1 window yields exactly the global newest-first order.
        expect(walked).toEqual(newestFirst);
    });

    test('?offset without ?limit skips N rows and returns the ordered remainder (the tail)', async ({
        request,
    }) => {
        test.slow();
        const user = await registerUserViaAPI(request);
        const created = await createSpacedIdeas(request, user.access_token, 4, `tail-${stamp()}`);
        const newestFirst = [...created].reverse(); // [c3, c2, c1, c0]

        const tail = await listRows(request, user.access_token, '?offset=2');
        // Skip the two newest → the two oldest, still in DESC order.
        expect(tail.map((r) => r.id)).toEqual(newestFirst.slice(2));
        assertNonIncreasing(tail);
    });

    test('an ?offset past the end yields an empty page (200) while the full list is intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const created = await createFastIdeas(request, user.access_token, 3, `past-${stamp()}`);

        const beyond = await listRes(request, user.access_token, '?offset=99');
        expect(beyond.status()).toBe(200);
        expect(await beyond.json()).toEqual([]);

        // Offsetting past the end does not consume or drop rows — the unpaged list
        // still returns the full owned set.
        const full = await listRows(request, user.access_token, '');
        expect(new Set(full.map((r) => r.id))).toEqual(new Set(created));
        expect(full).toHaveLength(3);
    });

    test('a ?limit greater than the row count returns all rows (no error, no padding)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const created = await createFastIdeas(request, user.access_token, 3, `over-${stamp()}`);

        const rows = await listRows(request, user.access_token, '?limit=50');
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((r) => r.id))).toEqual(new Set(created));
    });

    test('a very large ?offset (1000000) and the ?limit ceiling (101) are both accepted 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await createFastIdeas(request, user.access_token, 2, `bounds-${stamp()}`);

        const huge = await listRes(request, user.access_token, '?offset=1000000');
        expect(huge.status()).toBe(200);
        expect(await huge.json()).toEqual([]);

        // 101 is the inclusive Max on the limit — accepted, and returns the owned rows.
        const maxLimit = await listRows(request, user.access_token, '?limit=101');
        expect(maxLimit.length).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. ?statuses — the UNION semantics (repeated params union; comma does NOT)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — ?statuses union semantics', () => {
    test('a COMMA-joined ?statuses=pending,dismissed is rejected 400 (comma is not a union operator)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // The whole "pending,dismissed" string is treated as one enum member and
        // fails @IsEnum — union must be expressed with REPEATED params, not comma.
        for (const qs of ['?statuses=pending,dismissed', '?statuses=pending%2Cdismissed']) {
            const res = await listRes(request, user.access_token, qs);
            expect(res.status(), `comma ${qs}`).toBe(400);
            expect(msgOf(await res.json()), `comma ${qs} msg`).toMatch(
                /each value in statuses must be one of/i,
            );
        }
    });

    test('REPEATED ?statuses params union three buckets — exact set, all three statuses, DESC across buckets', async ({
        request,
    }) => {
        test.slow();
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const tag = stamp();

        // Three Ideas on distinct seconds; leave one PENDING, dismiss one, accept one.
        const [pendingId, dismissId, acceptId] = await createSpacedIdeas(request, token, 3, tag);
        await dismiss(request, token, dismissId);
        await acceptAgainstNewWork(request, user, acceptId, tag);

        const union = await listRows(
            request,
            token,
            '?statuses=pending&statuses=dismissed&statuses=accepted',
        );
        // Exact set — a fresh user owns exactly these three across the three buckets.
        expect(new Set(union.map((r) => r.id))).toEqual(new Set([pendingId, dismissId, acceptId]));
        expect(union.map((r) => r.status).sort()).toEqual(['accepted', 'dismissed', 'pending']);
        // Ordering is STATUS-AGNOSTIC: the union is sorted purely by generatedAt
        // DESC, so the oldest-created row (whatever its bucket) sorts last.
        assertNonIncreasing(union);
        expect(union[0].id).toBe(acceptId); // acceptId was created last (newest)
        expect(union[union.length - 1].id).toBe(pendingId); // pendingId was created first (oldest)
    });

    test('one bogus value among repeated valid ?statuses fails the whole query 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await listRes(
            request,
            user.access_token,
            '?statuses=pending&statuses=bogus&statuses=accepted',
        );
        // @IsEnum({ each: true }) validates EVERY element — a single invalid member
        // rejects the request; there is no partial/lenient union.
        expect(res.status()).toBe(400);
        expect(msgOf(await res.json())).toMatch(/each value in statuses must be one of/i);
    });

    test('a multi-status union composes with limit/offset — the window caps the newest of the union', async ({
        request,
    }) => {
        test.slow();
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const tag = stamp();

        const [pendingId, dismissId, acceptId] = await createSpacedIdeas(request, token, 3, tag);
        await dismiss(request, token, dismissId);
        await acceptAgainstNewWork(request, user, acceptId, tag);
        const q = '?statuses=pending&statuses=dismissed&statuses=accepted';

        // limit caps the union to its newest N.
        const first = await listRows(request, token, `${q}&limit=2`);
        expect(first).toHaveLength(2);
        expect(first.map((r) => r.id)).toEqual([acceptId, dismissId]); // newest two of the union
        // offset pages the union past the newest ones.
        const rest = await listRows(request, token, `${q}&limit=2&offset=2`);
        expect(rest).toHaveLength(1);
        expect(rest[0].id).toBe(pendingId); // the oldest of the union
        // No overlap across the two pages.
        expect(first.map((r) => r.id)).not.toContain(pendingId);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. ?search — trim-to-no-op 200 path + env-adaptive ILIKE execution
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — ?search execution', () => {
    test('a whitespace-only / empty ?search trims to a no-op → 200 with the UNFILTERED own set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const created = await createFastIdeas(request, user.access_token, 3, `noop-${stamp()}`);

        // The controller does `search?.trim() || undefined`, so a blank search
        // never builds an ILIKE — it can NEVER hit the sqlite ILIKE 500 and always
        // returns the full unfiltered list.
        for (const qs of ['?search=', '?search=%20%20%20', '?search=%09%09']) {
            const res = await listRes(request, user.access_token, qs);
            expect(res.status(), `blank search ${qs}`).toBe(200);
            const rows = (await res.json()) as IdeaRow[];
            expect(new Set(rows.map((r) => r.id)), `blank search ${qs} set`).toEqual(
                new Set(created),
            );
        }
    });

    test('a real ?search term is env-adaptive [200 | 500] and, when it executes, filters by title/description', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        // A unique alnum token embedded in ONE Idea's description (→ its title too).
        const term = `zqx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const match = await createIdea(request, token, `${IDEA_DESC_MIN} ${term} matching row`);
        const other = await createIdea(request, token, `${IDEA_DESC_MIN} unrelated ${stamp()}`);

        const res = await listRes(request, token, `?search=${term}`);
        // Postgres runs the ILIKE (200); the sqlite CI driver cannot (500). Never a
        // 4xx — the input already passed @MaxLength(500) validation.
        expect([200, 500]).toContain(res.status());
        if (res.status() === 200) {
            const rows = (await res.json()) as IdeaRow[];
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(match.id);
            expect(ids).not.toContain(other.id);
            // A term nothing matches → an empty result (still 200).
            const none = await listRes(request, token, `?search=nomatch${term}`);
            if (none.status() === 200) {
                expect(await none.json()).toEqual([]);
            }
        }
    });

    test('degenerate LIKE-wildcard searches (%, _, %%) are env-adaptive and never a 4xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await createFastIdeas(request, user.access_token, 2, `wild-${stamp()}`);

        // Raw LIKE metacharacters are still valid INPUT (they only affect the SQL
        // pattern) — validation passes, so the only outcomes are 200 (pg) or 500
        // (sqlite ILIKE), never a client error.
        for (const qs of ['?search=%25', '?search=_', '?search=%25%25']) {
            const res = await listRes(request, user.access_token, qs);
            expect([200, 500], `wildcard ${qs}`).toContain(res.status());
        }
    });

    test('?search composes with ?statuses — still env-adaptive [200 | 500], never a 4xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await createFastIdeas(request, user.access_token, 2, `combo-${stamp()}`);

        const res = await listRes(
            request,
            user.access_token,
            '?statuses=pending&search=somethingHere',
        );
        // Both fields validate cleanly; the ILIKE execution is what varies by driver.
        expect([200, 500]).toContain(res.status());
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. ORDER-BY injection hardening — unknown sort/order params are rejected
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — ORDER-BY injection hardening', () => {
    test('client-supplied sort/order/orderBy/direction params are rejected 400 "should not exist"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // The ordering is server-fixed (generatedAt DESC). The DTO whitelists no
        // sort/order field, so every injection vector — including a value carrying
        // a SQL fragment — is rejected by forbidNonWhitelisted BEFORE any query.
        const vectors = [
            '?sort=generatedAt',
            '?order=asc',
            '?orderBy=title',
            '?direction=DESC',
            '?sort=title;DROP TABLE work_proposals',
            '?orderBy=(SELECT 1)',
        ];
        for (const qs of vectors) {
            const res = await listRes(request, user.access_token, qs);
            expect(res.status(), `injection ${qs}`).toBe(400);
            expect(msgOf(await res.json()), `injection ${qs} msg`).toMatch(/should not exist/i);
        }
    });

    test('an unknown param mixed with a fully-valid query still 400s (whitelist is not bypassable)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // A valid ?statuses + ?limit alongside one stray property still trips the
        // whitelist — a good field cannot smuggle an unknown one through.
        const res = await listRes(
            request,
            user.access_token,
            '?statuses=pending&limit=5&cursor=abc',
        );
        expect(res.status()).toBe(400);
        expect(msgOf(await res.json())).toMatch(/property cursor should not exist/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Own-only scoping — isolation holds under every list axis
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — own-only scoping under every axis', () => {
    test('isolation under a status BUCKET — a stranger’s dismissed Idea never appears in your dismissed bucket', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const aDismissed = (
            await createIdea(request, a.access_token, `${IDEA_DESC_MIN} a-${stamp()}`)
        ).id;
        await dismiss(request, a.access_token, aDismissed);
        const bDismissed = (
            await createIdea(request, b.access_token, `${IDEA_DESC_MIN} b-${stamp()}`)
        ).id;
        await dismiss(request, b.access_token, bDismissed);

        // Each owner's dismissed bucket is exactly their own row.
        const aBucket = await listRows(request, a.access_token, '?statuses=dismissed');
        expect(aBucket.map((r) => r.id)).toContain(aDismissed);
        expect(aBucket.map((r) => r.id)).not.toContain(bDismissed);

        const bBucket = await listRows(request, b.access_token, '?statuses=dismissed');
        expect(bBucket.map((r) => r.id)).toContain(bDismissed);
        expect(bBucket.map((r) => r.id)).not.toContain(aDismissed);
    });

    test('isolation under PAGINATION — paging your list never surfaces another user’s rows', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aIds = await createFastIdeas(request, a.access_token, 3, `iso-a-${stamp()}`);
        const bIds = await createFastIdeas(request, b.access_token, 2, `iso-b-${stamp()}`);

        // A wide page for B returns exactly B's two rows — A's three are absent,
        // and A's rows never widen B's page total.
        const bPage = await listRows(request, b.access_token, '?limit=50&offset=0');
        expect(new Set(bPage.map((r) => r.id))).toEqual(new Set(bIds));
        for (const aid of aIds) {
            expect(bPage.map((r) => r.id)).not.toContain(aid);
        }
    });

    test('isolation under a search NO-OP — a blank ?search returns only your own rows', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aIds = await createFastIdeas(request, a.access_token, 2, `s-a-${stamp()}`);
        const bIds = await createFastIdeas(request, b.access_token, 2, `s-b-${stamp()}`);

        // The blank-search no-op path is still WHERE userId = caller — B sees only B.
        const bRows = await listRows(request, b.access_token, '?search=%20');
        expect(new Set(bRows.map((r) => r.id))).toEqual(new Set(bIds));
        for (const aid of aIds) {
            expect(bRows.map((r) => r.id)).not.toContain(aid);
        }
    });

    test('isolation under a full multi-status UNION — a stranger’s accepted/dismissed rows never leak in', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const tag = stamp();

        // A builds one row in each of pending / dismissed / accepted.
        const aPending = (await createIdea(request, a.access_token, `${IDEA_DESC_MIN} ap-${tag}`))
            .id;
        const aDismiss = (await createIdea(request, a.access_token, `${IDEA_DESC_MIN} ad-${tag}`))
            .id;
        await dismiss(request, a.access_token, aDismiss);
        const aAccept = (await createIdea(request, a.access_token, `${IDEA_DESC_MIN} aa-${tag}`))
            .id;
        await acceptAgainstNewWork(request, a, aAccept, tag);

        // B unions every status — a fresh B owns nothing, so the union is empty and
        // NONE of A's rows (pending/dismissed/accepted) leak across the user scope.
        const bUnion = await listRows(
            request,
            b.access_token,
            '?statuses=pending&statuses=dismissed&statuses=accepted&statuses=queued&statuses=building&statuses=failed',
        );
        const bIds = bUnion.map((r) => r.id);
        expect(bIds).not.toContain(aPending);
        expect(bIds).not.toContain(aDismiss);
        expect(bIds).not.toContain(aAccept);
    });
});
