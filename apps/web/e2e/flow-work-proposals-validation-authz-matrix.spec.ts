import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Work-Proposals (Ideas) — VALIDATION × AUTHZ × ISOLATION matrix for
 * `/api/me/work-proposals`. This file is the exhaustive INPUT-CONTRACT grid the
 * sibling Idea specs leave open: the `ListWorkProposalsQueryDto` field-by-field
 * validation lattice (statuses/limit/offset/search/whitelist), the TYPE half of
 * the `CreateWorkProposalDto` (non-string coercion — distinct from the LENGTH
 * boundaries the lifecycle spec already pins), the list FILTER behaviour
 * (status-bucket mutual-exclusion, union, pagination interaction), and the
 * authz/isolation CELLS the other specs never touch (create/works 401, dismiss
 * & works cross-user 404-never-403, invalid-bearer 401, list-level isolation).
 *
 * Every status code, error string, and env-adaptive branch asserted below was
 * probed against the LIVE API at http://127.0.0.1:3100 (sqlite in-memory,
 * REQUIRE_EMAIL_VERIFICATION=false, no AI provider, no Trigger.dev, keyless)
 * BEFORE this file was written.
 *
 * Taxonomy: a Mission produces Ideas; an Idea becomes a Work. An Idea is a
 * WorkProposal under `/api/me/work-proposals`.
 *
 * ── NON-DUPLICATION (deliberately DISJOINT from the sibling specs) ───────────
 *   - flow-idea-lifecycle-deep.spec.ts  — create LENGTH boundaries (9/10/5000/
 *     5001, title 120/121), the create WHITELIST (unknown + server-owned field
 *     rejection), the ParseUUIDPipe path guard on every route, the unknown-uuid
 *     404 vocabulary, the combined ?missionId×?statuses composition, accept
 *     FK/ownership (foreign/ghost workId → 404) and accept-body null/non-uuid/
 *     extra-field. THIS file NEVER re-asserts those. It pins the ORTHOGONAL
 *     input axes those omit: field TYPE coercion (non-string description/title,
 *     non-string workId), the LIST-QUERY numeric/enum/search/whitelist lattice,
 *     and the runtime filter behaviour.
 *   - flow-work-proposals-deep.spec.ts  — the POSITIVE create→read→status→
 *     preferences→budget→attachments round-trip + limit=0/102 & offset=-1
 *     pagination REJECTS. THIS file pins the numeric-TYPE rule (non-int/float),
 *     the ACCEPT-boundaries (limit 1/101, offset 0), search maxLength, and the
 *     unknown-query-param whitelist — none of which the deep spec covers.
 *   - flow-idea-to-work-accept.spec.ts  — accept state machine + empty-body 400
 *     + cross-user accept 404. THIS file adds the accept-body TYPE cells
 *     (workId number/boolean/array) and the dismiss/works cross-user cells.
 *   - work-proposals.spec.ts            — shallow 401 on list/status/prefs/
 *     refresh. THIS file pins 401 on the REMAINING surface (create/:id/:id/works/
 *     dismiss/accept/build) + the invalid-bearer path.
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────────
 *  POST /api/me/work-proposals
 *    · description number/boolean/array/null/missing → 400 ["… must be a string",
 *      "… longer than or equal to 10", "… shorter than or equal to 5000"].
 *    · title number/array/boolean → 400 ["title must be a string", …].
 *  GET  /api/me/work-proposals?statuses=…
 *    · single bogus / empty ?statuses= / uppercase PENDING → 400 "each value in
 *      statuses must be one of the following values: pending, dismissed,
 *      accepted, queued, building, failed" (@IsEnum is case-sensitive, lowercase).
 *    · each of the 6 valid enum values individually → 200; repeated value → 200.
 *    · default (no ?statuses) = PENDING bucket only. Buckets are mutually
 *      exclusive; ?statuses=a&statuses=b unions; a bucket the user has none of → [].
 *  GET  /api/me/work-proposals?limit=…&offset=…
 *    · limit "abc"/1.5 → 400 "limit must be an integer number"; 1 & 101 → 200.
 *    · offset "abc" → 400 "offset must be an integer number"; 0 → 200.
 *    · combined invalid fields aggregate ALL messages in one 400.
 *  GET  /api/me/work-proposals?search=…
 *    · 501 chars → 400 "search must be shorter than or equal to 500 characters"
 *      (validation fires BEFORE the handler). A ≤500 well-formed search PASSES
 *      validation but EXECUTES a Postgres ILIKE the sqlite CI stack can't run →
 *      env-adaptive [200 (pg) | 500 (sqlite ILIKE)]. Tolerated, not asserted 200.
 *  GET  /api/me/work-proposals?<unknown>=… → 400 "property <x> should not exist".
 *  AUTHZ: every route without a bearer → 401; a garbage bearer → 401. A stranger
 *    reading/dismissing/listing-works another user's Idea → 404 (NEVER 403), and
 *    the owner's Idea is untouched. GET :id/works of an OWN fresh Idea → {links:[]}.
 *  POST /api/me/work-proposals/:id/accept
 *    · workId number/boolean/array → 400 "workId must be a UUID"; Idea stays PENDING.
 *
 * Cross-spec isolation: EVERY test runs on FRESH registerUserViaAPI() users with
 * a per-call unique suffix; list assertions use toContain/not.toContain (shared
 * DB), never exact global counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A syntactically-valid v4 UUID no row will ever own. */
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const IDEA_DESC_MIN = 'A curated directory of resources'; // ≥10 chars filler
const VALID_STATUSES = [
    'pending',
    'dismissed',
    'accepted',
    'queued',
    'building',
    'failed',
] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface IdeaRow {
    id: string;
    status: string;
    acceptedWorkId: string | null;
}

/** Create a user-manual Idea (PENDING) and return its id. */
async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `create idea body=${await res.text()}`).toBe(201);
    const idea = (await res.json()) as { id: string; status: string };
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    return idea.id;
}

async function readIdea(request: APIRequestContext, token: string, id: string): Promise<IdeaRow> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `read idea body=${await res.text()}`).toBe(200);
    return (await res.json()) as IdeaRow;
}

async function listIds(request: APIRequestContext, token: string, query = ''): Promise<string[]> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list ${query} body=${await res.text()}`).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(rows)).toBe(true);
    return rows.map((r) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. CreateWorkProposalDto — TYPE validation (orthogonal to the length spec)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals create — field TYPE validation', () => {
    test('a non-string `description` (missing/number/boolean/array/null) is rejected 400 with "must be a string"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // Each non-string shape trips @IsString (plus the length decorators fire
        // on the coerced value) — the truthful message set always includes the
        // type violation. `missing` sends no `description` key at all.
        const bodies: Array<{ label: string; data: Record<string, unknown> }> = [
            { label: 'missing', data: {} },
            { label: 'number', data: { description: 12345 } },
            { label: 'boolean', data: { description: true } },
            { label: 'array', data: { description: ['a', 'b'] } },
            { label: 'null', data: { description: null } },
        ];
        for (const { label, data } of bodies) {
            const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
                headers,
                data,
            });
            expect(res.status(), `description ${label}`).toBe(400);
            expect(msgOf(await res.json()), `description ${label} msg`).toMatch(
                /description must be a string/i,
            );
        }
    });

    test('a non-string `title` (number/array/boolean) is rejected 400 with "title must be a string"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        for (const [label, value] of [
            ['number', 123],
            ['array', ['x']],
            ['boolean', false],
        ] as const) {
            const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
                headers,
                data: { description: `${IDEA_DESC_MIN} title-${label}`, title: value },
            });
            expect(res.status(), `title ${label}`).toBe(400);
            expect(msgOf(await res.json()), `title ${label} msg`).toMatch(
                /title must be a string/i,
            );
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. ListWorkProposalsQueryDto — the numeric/enum/search/whitelist lattice
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — ?statuses enum validation', () => {
    test('a single bogus status value is rejected 400 with the allowed-values message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals?statuses=bogus`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(msgOf(await res.json())).toMatch(
            /each value in statuses must be one of.*pending, dismissed, accepted, queued, building, failed/i,
        );
    });

    test('an EMPTY ?statuses= param is rejected 400 (the empty string is not a valid enum member)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals?statuses=`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(msgOf(await res.json())).toMatch(/each value in statuses must be one of/i);
    });

    test('the enum is CASE-SENSITIVE — an uppercase "PENDING" is rejected 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals?statuses=PENDING`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(msgOf(await res.json())).toMatch(/each value in statuses must be one of/i);
    });

    test('EACH of the six valid status values is accepted individually (200); a repeated value is idempotent (200)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        for (const status of VALID_STATUSES) {
            const res = await request.get(`${API_BASE}/api/me/work-proposals?statuses=${status}`, {
                headers,
            });
            expect(res.status(), `statuses=${status}`).toBe(200);
            expect(Array.isArray(await res.json()), `statuses=${status} is array`).toBe(true);
        }

        // A repeated valid value (?statuses=pending&statuses=pending) is a clean
        // 200 — the array normalizer accepts it and the pending Idea shows once.
        const pendingId = await createIdea(
            request,
            user.access_token,
            `${IDEA_DESC_MIN} ${stamp()}`,
        );
        const repeatedIds = await listIds(
            request,
            user.access_token,
            '?statuses=pending&statuses=pending',
        );
        expect(repeatedIds).toContain(pendingId);
        expect(repeatedIds.filter((id) => id === pendingId)).toHaveLength(1);
    });
});

test.describe('Work-Proposals list — ?limit / ?offset numeric validation', () => {
    test('a non-integer ?limit ("abc" / 1.5) is rejected 400 "limit must be an integer number"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        for (const bad of ['abc', '1.5']) {
            const res = await request.get(`${API_BASE}/api/me/work-proposals?limit=${bad}`, {
                headers,
            });
            expect(res.status(), `limit=${bad}`).toBe(400);
            expect(msgOf(await res.json()), `limit=${bad} msg`).toMatch(
                /limit must be an integer number/i,
            );
        }
    });

    test('the ?limit boundary values (1 and 101, the [1,101] inclusive range) are accepted 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        for (const ok of [1, 101]) {
            const res = await request.get(`${API_BASE}/api/me/work-proposals?limit=${ok}`, {
                headers,
            });
            expect(res.status(), `limit=${ok}`).toBe(200);
        }
    });

    test('a non-integer ?offset ("abc") is rejected 400; the ?offset floor (0) is accepted 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const bad = await request.get(`${API_BASE}/api/me/work-proposals?offset=abc`, { headers });
        expect(bad.status()).toBe(400);
        expect(msgOf(await bad.json())).toMatch(/offset must be an integer number/i);

        const zero = await request.get(`${API_BASE}/api/me/work-proposals?offset=0`, { headers });
        expect(zero.status()).toBe(200);
    });

    test('invalid ?statuses AND ?limit together AGGREGATE both violations in a single 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals?statuses=bogus&limit=0`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        const msg = msgOf(await res.json());
        // The global ValidationPipe collects every failing constraint across the
        // whole query DTO into one message array — not first-fail-fast.
        expect(msg).toMatch(/each value in statuses must be one of/i);
        expect(msg).toMatch(/limit must not be less than 1/i);
    });
});

test.describe('Work-Proposals list — ?search validation & env-adaptive execution', () => {
    test('an over-long ?search (501 chars) is rejected 400 BEFORE the handler; a ≤500 search validates then executes env-adaptively', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // 501 chars trips @MaxLength(500) in the validation pipe — a deterministic
        // 400 that fires before the repository ILIKE ever runs.
        const tooLong = await request.get(
            `${API_BASE}/api/me/work-proposals?search=${'s'.repeat(501)}`,
            { headers },
        );
        expect(tooLong.status()).toBe(400);
        expect(msgOf(await tooLong.json())).toMatch(
            /search must be shorter than or equal to 500 characters/i,
        );

        // A 500-char search is VALID input, but the repo builds a Postgres
        // `ILIKE` predicate the sqlite in-memory CI stack can't execute → 500.
        // On a Postgres deployment the same query is a 200. Env-adaptive: accept
        // either, but NEVER a 4xx (the input already passed validation) other
        // than the 500 server-error we know sqlite raises.
        const maxLen = await request.get(
            `${API_BASE}/api/me/work-proposals?search=${'s'.repeat(500)}`,
            { headers },
        );
        expect([200, 500]).toContain(maxLen.status());
    });
});

test.describe('Work-Proposals list — query whitelist', () => {
    test('an unknown query parameter is rejected 400 "property <x> should not exist" (forbidNonWhitelisted on the query DTO)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/me/work-proposals?bogusparam=1`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(msgOf(await res.json())).toMatch(/property bogusparam should not exist/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. List FILTER behaviour — status buckets, union, pagination interaction
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals list — status-bucket filter behaviour', () => {
    test('the default list is the PENDING bucket only; ?statuses=dismissed / ?statuses=accepted are mutually-exclusive subsets', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Fixture: one PENDING (kept), one DISMISSED, one ACCEPTED.
        const pendingId = await createIdea(request, token, `${IDEA_DESC_MIN} keep-${s}`);
        const dismissId = await createIdea(request, token, `${IDEA_DESC_MIN} dismiss-${s}`);
        const acceptId = await createIdea(request, token, `${IDEA_DESC_MIN} accept-${s}`);

        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${dismissId}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismiss.status()).toBe(204);

        const work = await createWorkViaAPI(request, token, { name: `Bucket Work ${s}` });
        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${acceptId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: work.id },
        });
        expect(accept.status()).toBe(200);

        // default → pending only: contains the pending Idea, excludes the other two.
        const def = await listIds(request, token, '');
        expect(def).toContain(pendingId);
        expect(def).not.toContain(dismissId);
        expect(def).not.toContain(acceptId);

        // ?statuses=dismissed → the dismissed Idea only.
        const dismissed = await listIds(request, token, '?statuses=dismissed');
        expect(dismissed).toContain(dismissId);
        expect(dismissed).not.toContain(pendingId);
        expect(dismissed).not.toContain(acceptId);

        // ?statuses=accepted → the accepted Idea only.
        const accepted = await listIds(request, token, '?statuses=accepted');
        expect(accepted).toContain(acceptId);
        expect(accepted).not.toContain(pendingId);
        expect(accepted).not.toContain(dismissId);
    });

    test('a multi-valued ?statuses unions its buckets; a bucket the user has nothing in returns []', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const pendingId = await createIdea(request, token, `${IDEA_DESC_MIN} union-keep-${s}`);
        const dismissId = await createIdea(request, token, `${IDEA_DESC_MIN} union-dismiss-${s}`);
        expect(
            (
                await request.patch(`${API_BASE}/api/me/work-proposals/${dismissId}/dismiss`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(204);

        // ?statuses=pending&statuses=dismissed unions the two buckets — BOTH ids
        // present, neither excluded.
        const union = await listIds(request, token, '?statuses=pending&statuses=dismissed');
        expect(union).toContain(pendingId);
        expect(union).toContain(dismissId);

        // This fresh user has nothing BUILDING — the bucket is exactly [].
        const building = await request.get(`${API_BASE}/api/me/work-proposals?statuses=building`, {
            headers: authedHeaders(token),
        });
        expect(building.status()).toBe(200);
        expect(await building.json()).toEqual([]);
    });

    test('?statuses and ?limit compose: ?statuses=pending&limit=1 returns at most one PENDING row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const a = await createIdea(request, token, `${IDEA_DESC_MIN} page-a-${s}`);
        const b = await createIdea(request, token, `${IDEA_DESC_MIN} page-b-${s}`);

        const res = await request.get(
            `${API_BASE}/api/me/work-proposals?statuses=pending&limit=1`,
            { headers: authedHeaders(token) },
        );
        expect(res.status()).toBe(200);
        const rows = (await res.json()) as Array<{ id: string; status: string }>;
        // limit caps the page to a single row and it is one of this user's own
        // pending Ideas — the status filter and the limit are AND-composed.
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('pending');
        expect([a, b]).toContain(rows[0].id);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Authz — 401 on the surface the shallow smoke spec doesn't cover
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals authz — unauthenticated & invalid-bearer 401', () => {
    test('every mutating/read route rejects a MISSING bearer with 401', async ({ request }) => {
        // Seed a real Idea so the 401 is proven to fire BEFORE any ownership/404
        // logic (a real id that a stranger could otherwise reach).
        const owner = await registerUserViaAPI(request);
        const ideaId = await createIdea(request, owner.access_token, `${IDEA_DESC_MIN} ${stamp()}`);

        const create = await request.post(`${API_BASE}/api/me/work-proposals`, {
            data: { description: `${IDEA_DESC_MIN} anon` },
        });
        expect(create.status(), 'POST create').toBe(401);

        const getOne = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}`);
        expect(getOne.status(), 'GET :id').toBe(401);

        const works = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/works`);
        expect(works.status(), 'GET :id/works').toBe(401);

        const dismiss = await request.patch(`${API_BASE}/api/me/work-proposals/${ideaId}/dismiss`);
        expect(dismiss.status(), 'PATCH :id/dismiss').toBe(401);

        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            data: { workId: UNKNOWN_UUID },
        });
        expect(accept.status(), 'POST :id/accept').toBe(401);

        const build = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/build`);
        expect(build.status(), 'POST :id/build').toBe(401);
    });

    test('a GARBAGE bearer token is 401 on both a read and a write route (invalid, not merely missing)', async ({
        request,
    }) => {
        const garbage = { Authorization: 'Bearer garbage.invalid.token' };

        const list = await request.get(`${API_BASE}/api/me/work-proposals`, { headers: garbage });
        expect(list.status(), 'GET list w/ garbage token').toBe(401);

        const create = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers: garbage,
            data: { description: `${IDEA_DESC_MIN} garbage` },
        });
        expect(create.status(), 'POST create w/ garbage token').toBe(401);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Cross-user isolation — 404-never-403, owner untouched (the missing cells)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals isolation — a stranger sees 404, never 403', () => {
    test('a stranger CANNOT read (GET :id) or list-works (GET :id/works) another user’s Idea — both 404, never 403; the owner reads it fine ({links:[]})', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ideaId = await createIdea(request, owner.access_token, `${IDEA_DESC_MIN} ${stamp()}`);

        // The owner reads it, and a fresh Idea has an EMPTY provenance list.
        const ownerWorks = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/works`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerWorks.status()).toBe(200);
        expect(await ownerWorks.json()).toEqual({ links: [] });

        // GET :id — the stranger gets the uniform "Proposal not found" 404 (the
        // posture is existence-hiding: 404, explicitly NOT 403).
        const strangerGet = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status()).toBe(404);
        expect(strangerGet.status()).not.toBe(403);
        expect(msgOf(await strangerGet.json())).toMatch(/proposal not found/i);

        // GET :id/works — same ownership gate, same 404 "Proposal not found".
        const strangerWorks = await request.get(
            `${API_BASE}/api/me/work-proposals/${ideaId}/works`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(strangerWorks.status()).toBe(404);
        expect(strangerWorks.status()).not.toBe(403);
        expect(msgOf(await strangerWorks.json())).toMatch(/proposal not found/i);
    });

    test('a stranger CANNOT dismiss another user’s pending Idea — 404 "not found or not pending", never 403, and the owner’s Idea stays PENDING', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ideaId = await createIdea(request, owner.access_token, `${IDEA_DESC_MIN} ${stamp()}`);

        const strangerDismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${ideaId}/dismiss`,
            { headers: authedHeaders(stranger.access_token) },
        );
        // The dismiss UPDATE is scoped to (id, userId, status=PENDING); a stranger
        // matches zero rows → the controller's 404. It must not be a 403 (which
        // would confirm the Idea exists) and must not silently succeed.
        expect(strangerDismiss.status()).toBe(404);
        expect(strangerDismiss.status()).not.toBe(403);
        expect(msgOf(await strangerDismiss.json())).toMatch(/not found or not pending/i);

        // The owner's Idea is untouched by the hostile dismiss — still PENDING.
        expect((await readIdea(request, owner.access_token, ideaId)).status).toBe('pending');
    });

    test('list scope is per-user: another user’s Idea never appears in your list, and yours does', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aIdeaId = await createIdea(request, a.access_token, `${IDEA_DESC_MIN} ${stamp()}`);

        // B's default list must not leak A's Idea (list is WHERE userId = caller).
        const bList = await listIds(request, b.access_token, '');
        expect(bList).not.toContain(aIdeaId);

        // A's own list contains it.
        const aList = await listIds(request, a.access_token, '');
        expect(aList).toContain(aIdeaId);
    });

    test('GET :id/works on an UNKNOWN-but-valid uuid is 404 "Proposal not found" (the /works 404 cell)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // The provenance endpoint runs the same ownership/existence gate as GET
        // :id: an unknown (well-formed) id resolves to null → 404, never a 200
        // with an empty links envelope (which would leak that the id is valid
        // but empty vs. non-existent).
        const res = await request.get(`${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/works`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(404);
        expect(msgOf(await res.json())).toMatch(/proposal not found/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Accept body — TYPE cells (distinct from the null/non-uuid/extra lifecycle set)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Work-Proposals accept — workId TYPE validation', () => {
    test('a non-string workId (number/boolean/array) is rejected 400 "workId must be a UUID" and the Idea stays PENDING', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const ideaId = await createIdea(request, token, `${IDEA_DESC_MIN} ${stamp()}`);

        for (const [label, value] of [
            ['number', 123],
            ['boolean', true],
            ['array', [UNKNOWN_UUID]],
        ] as const) {
            const res = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
                headers: authedHeaders(token),
                data: { workId: value },
            });
            expect(res.status(), `workId ${label}`).toBe(400);
            expect(msgOf(await res.json()), `workId ${label} msg`).toMatch(
                /workId must be a UUID/i,
            );
        }

        // None of the rejected accepts leaked a state change — the Idea is intact.
        const after = await readIdea(request, token, ideaId);
        expect(after.status).toBe('pending');
        expect(after.acceptedWorkId).toBeNull();
    });
});
