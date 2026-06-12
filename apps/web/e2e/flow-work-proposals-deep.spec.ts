import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Work-Proposals (Ideas) DEEP controller contract — the POSITIVE create→list→
 * status→preferences→:id→:id/budget→attachments→build round-trip and the
 * read-path ownership edges of `/api/me/work-proposals` (the Idea half of the
 * Mission→Idea→Work taxonomy). Every status code, message, and response shape
 * asserted below was probed against the LIVE API at http://127.0.0.1:3100
 * (sqlite in-memory, REQUIRE_EMAIL_VERIFICATION=false, no AI provider / no
 * Trigger.dev, keyless) BEFORE being written.
 *
 * Taxonomy: a Mission produces Ideas; an Idea becomes a Work. An Idea is a
 * WorkProposal under `/api/me/work-proposals`.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────
 * Deliberately DISJOINT from the sibling Idea/Proposal specs:
 *   - work-proposals.spec.ts            — shallow 401-without-auth + empty-list +
 *     unknown-UUID 404 smoke pins. THIS file pins the FULL POSITIVE flow and the
 *     CROSS-USER read edges those leave open.
 *   - flow-idea-lifecycle-deep.spec.ts  — the INPUT EDGE: title/slug derivation,
 *     length boundaries, create whitelist, ParseUUIDPipe path guard, unknown-id
 *     404 vocabulary, accept FK/ownership/rollback, Mission validation lattice,
 *     and the MISSION-scoped budget. THIS file never re-asserts those.
 *   - flow-idea-build-lifecycle.spec.ts — the build/retry/rebuild/dismiss state
 *     machine. THIS file touches build only to pin the keyless 400-with-commit.
 *   - flow-idea-to-work-accept.spec.ts  — accept happy/idempotent/ownership.
 * What THIS file uniquely pins: the happy create→read DTO birth-state; list
 * DEFAULT-PENDING + creation-order + limit/offset PAGINATION and its [1,101]/[0,∞)
 * guards; the `status` endpoint `{researching, canRefresh}` contract; `refresh`
 * 202 `{status:'queued'}` IDEMPOTENCY on the keyless stack; the IDEA-scoped
 * (ownerType 'idea') budget envelope + its cross-user 404 + anon 401; the
 * preferences optOut⇆emailNotifications INVERSE round-trip + empty-body no-op +
 * per-user isolation; the attachments empty→add(ghost-edge 201)→list→delete
 * round-trip + bad-uploadId regex 400 + cross-user "Idea not found" 404; and the
 * keyless build 400 "Work agent is disabled." that STILL commits PENDING→QUEUED.
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────
 *  POST /api/me/work-proposals { description } → 201; birth state source:
 *    'user-manual', status:'pending', acceptedWorkId/missionId/failureMessage/
 *    failureKind all null, suggestedCategories/suggestedFields/recommendedPlugins
 *    all [], generatedPrompt === description.
 *  GET  /api/me/work-proposals                → 200 array, DEFAULT statuses =
 *    [pending], creation order; ?limit=1 → 1 row, ?offset=1 → the next page.
 *    ?limit=0 → 400 "limit must not be less than 1"; ?limit=102 → 400 "…not
 *    greater than 101"; ?offset=-1 → 400 "offset must not be less than 0".
 *  GET  /api/me/work-proposals/status         → 200 {researching:false,
 *    canRefresh:true} on a fresh user.
 *  POST /api/me/work-proposals/refresh        → 202 {status:'queued'}; a second
 *    immediate refresh is ALSO 202 (keyless stack never blocks → canRefresh
 *    stays true).
 *  GET  /api/me/work-proposals/:id/budget     → 200 {ownerType:'idea', ownerId,
 *    periodStart<periodEnd, currentSpendCents:0, capCents:null, currency:'usd',
 *    percentUsed:null, allowOverage:true, blocked:false}; stranger → 404; anon → 401.
 *  PUT  /api/me/work-proposals/preferences    → 200 {optOut}; emailNotifications
 *    is the INVERSE of optOut; an EMPTY body is an idempotent no-op (returns
 *    current optOut). Preferences are per-user isolated (fresh user → optOut:false).
 *  GET  /api/me/work-proposals/:id/attachments → 200 []; POST {uploadId:64hex} →
 *    201 edge (NO upload-existence FK on the keyless stack); the edge then lists;
 *    DELETE :attachmentId → 200 {deleted:true}; POST {uploadId:'not-hex'} → 400
 *    "uploadId must match …". A stranger's attachments → 404 "Idea not found".
 *  POST /api/me/work-proposals/:id/build      → 400 "Work agent is disabled."
 *    (keyless) — BUT the PENDING→QUEUED transition is committed before the
 *    goal-enqueue, so a follow-up GET :id shows status 'queued'.
 *  GET  /api/me/work-proposals/:id            → a STRANGER reading the owner's
 *    Idea is 404 "Proposal not found" (no existence leak).
 *
 * Cross-spec isolation: EVERY mutation runs on a FRESH registerUserViaAPI()
 * user. Unique suffixes come from a per-test counter (NOT a module-scope clock).
 * List assertions filter to the user's own ids — never exact global counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEA_DESC_MIN = 'A curated directory of resources'; // ≥10 chars filler

let counter = 0;
function uniq(label: string): string {
    counter += 1;
    return `${label}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

/**
 * Upload a tiny file via `POST /api/uploads/file` and return its content-addressed
 * sha256 `id` — a REAL, caller-owned uploadId. Attachment-add now validates the
 * uploadId against `user_uploads` (owned by the caller), so an arbitrary 64-hex
 * value no longer lands an edge; mint a real one.
 */
async function mintUploadId(request: APIRequestContext, token: string): Promise<string> {
    const res = await request.post(`${API_BASE}/api/uploads/file`, {
        headers: authedHeaders(token),
        multipart: {
            file: {
                name: `${uniq('idea-attach')}.md`,
                mimeType: 'text/markdown',
                buffer: Buffer.from(`# idea attachment ${uniq('body')}\n`),
            },
        },
    });
    expect(res.status(), `upload body=${await res.text()}`).toBe(201);
    const id = (await res.json()).id as string;
    expect(id, 'upload id is a sha256 hex').toMatch(/^[0-9a-f]{64}$/i);
    return id;
}

interface IdeaRow {
    id: string;
    title: string;
    description: string;
    slugSuggestion: string;
    source: string;
    status: string;
    generatedPrompt: string;
    acceptedWorkId: string | null;
    missionId: string | null;
    failureMessage: string | null;
    failureKind: string | null;
    suggestedCategories: unknown[];
    suggestedFields: unknown[];
    recommendedPlugins: unknown[];
}

async function createIdea(
    request: APIRequestContext,
    headers: Record<string, string>,
    description: string,
): Promise<IdeaRow> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers,
        data: { description },
    });
    expect(res.status(), `create idea body=${await res.text()}`).toBe(201);
    const idea = (await res.json()) as IdeaRow;
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    return idea;
}

test.describe('Work-Proposals — create → read positive round-trip', () => {
    test('POST create returns a 201 user-manual Idea birth-state and GET :id reads it back identically', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const description = `${IDEA_DESC_MIN} ${uniq('roundtrip')} positive create probe`;

        const created = await createIdea(request, headers, description);

        // Birth-state invariants of a hand-typed Idea: manual provenance, PENDING,
        // no Work/Mission linkage, no failure, empty AI-suggestion arrays, and the
        // generatedPrompt mirrors the raw description (no AI rewrite on this stack).
        expect(created.source).toBe('user-manual');
        expect(created.status).toBe('pending');
        expect(created.acceptedWorkId).toBeNull();
        expect(created.missionId).toBeNull();
        expect(created.failureMessage).toBeNull();
        expect(created.failureKind).toBeNull();
        expect(created.generatedPrompt).toBe(description);
        expect(created.suggestedCategories).toEqual([]);
        expect(created.suggestedFields).toEqual([]);
        expect(created.recommendedPlugins).toEqual([]);

        // GET :id is the same row (any status) — the read path returns the
        // identical DTO the create returned.
        const readRes = await request.get(`${API_BASE}/api/me/work-proposals/${created.id}`, {
            headers,
        });
        expect(readRes.status()).toBe(200);
        const read = (await readRes.json()) as IdeaRow;
        expect(read.id).toBe(created.id);
        expect(read.title).toBe(created.title);
        expect(read.slugSuggestion).toBe(created.slugSuggestion);
        expect(read.status).toBe('pending');
    });
});

test.describe('Work-Proposals — list default-status, ordering & pagination', () => {
    test('the default list returns only PENDING in creation order, and ?limit/?offset paginate', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const a = await createIdea(request, headers, `${IDEA_DESC_MIN} ${uniq('page-a')}`);
        const b = await createIdea(request, headers, `${IDEA_DESC_MIN} ${uniq('page-b')}`);

        // Default (no ?statuses) lists PENDING only and includes BOTH fresh Ideas
        // in creation order (the user is isolated, so the first two own rows are
        // exactly a then b).
        const defRes = await request.get(`${API_BASE}/api/me/work-proposals`, { headers });
        expect(defRes.status()).toBe(200);
        const def = (await defRes.json()) as IdeaRow[];
        const ownIds = def.map((p) => p.id).filter((id) => id === a.id || id === b.id);
        expect(ownIds).toEqual([a.id, b.id]);
        expect(def.every((p) => p.status === 'pending')).toBe(true);

        // ?limit=1 caps the page to a single row; ?offset=1 skips the first.
        const firstPage = await request.get(`${API_BASE}/api/me/work-proposals?limit=1`, {
            headers,
        });
        expect(firstPage.status()).toBe(200);
        const firstRows = (await firstPage.json()) as IdeaRow[];
        expect(firstRows).toHaveLength(1);
        expect(firstRows[0].id).toBe(a.id);

        const secondPage = await request.get(`${API_BASE}/api/me/work-proposals?limit=1&offset=1`, {
            headers,
        });
        expect(secondPage.status()).toBe(200);
        const secondRows = (await secondPage.json()) as IdeaRow[];
        expect(secondRows).toHaveLength(1);
        expect(secondRows[0].id).toBe(b.id);
    });

    test('pagination guards reject out-of-range ?limit/?offset with 400 boundary messages', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // limit floor is 1 (Min), ceiling is 101 (Max); offset floor is 0 (Min).
        const limitZero = await request.get(`${API_BASE}/api/me/work-proposals?limit=0`, {
            headers,
        });
        expect(limitZero.status()).toBe(400);
        expect(msgOf(await limitZero.json())).toMatch(/limit must not be less than 1/i);

        const limitOver = await request.get(`${API_BASE}/api/me/work-proposals?limit=102`, {
            headers,
        });
        expect(limitOver.status()).toBe(400);
        expect(msgOf(await limitOver.json())).toMatch(/limit must not be greater than 101/i);

        const offsetNeg = await request.get(`${API_BASE}/api/me/work-proposals?offset=-1`, {
            headers,
        });
        expect(offsetNeg.status()).toBe(400);
        expect(msgOf(await offsetNeg.json())).toMatch(/offset must not be less than 0/i);
    });
});

test.describe('Work-Proposals — refresh status & refresh idempotency', () => {
    test('GET /status returns {researching,canRefresh} and is true/idle for a fresh user', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const res = await request.get(`${API_BASE}/api/me/work-proposals/status`, { headers });
        expect(res.status()).toBe(200);
        const status = (await res.json()) as { researching: boolean; canRefresh: boolean };
        // A user that has never triggered a run is idle and allowed to start one.
        expect(status.researching).toBe(false);
        expect(status.canRefresh).toBe(true);
    });

    test('POST /refresh accepts (202 {status:"queued"}) and is idempotent on the keyless stack', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const first = await request.post(`${API_BASE}/api/me/work-proposals/refresh`, { headers });
        expect(first.status(), `refresh body=${await first.text()}`).toBe(202);
        expect(await first.json()).toEqual({ status: 'queued' });

        // Keyless: no AI provider ⇒ the "run" resolves immediately and never holds
        // an in-flight lock, so a SECOND immediate refresh is also 202 'queued'
        // (not 429 rate-limited) and status stays idle/refreshable.
        const second = await request.post(`${API_BASE}/api/me/work-proposals/refresh`, { headers });
        expect(second.status()).toBe(202);
        expect((await second.json()).status).toBe('queued');

        const status = await request.get(`${API_BASE}/api/me/work-proposals/status`, { headers });
        expect(status.status()).toBe(200);
        expect((await status.json()).canRefresh).toBe(true);
    });
});

test.describe('Work-Proposals — Idea-scoped budget envelope & ownership', () => {
    test('GET :id/budget returns an idea-scoped OwnerBudgetSummary with a calendar-month window', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${uniq('budget-shape')}`);

        const res = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`, {
            headers,
        });
        expect(res.status()).toBe(200);
        const b = (await res.json()) as {
            ownerType: string;
            ownerId: string;
            periodStart: string;
            periodEnd: string;
            currentSpendCents: number;
            capCents: number | null;
            currency: string;
            percentUsed: number | null;
            allowOverage: boolean;
            blocked: boolean;
        };
        // Owner type is IDEA (vs the Mission budget's 'mission') — same envelope.
        expect(b.ownerType).toBe('idea');
        expect(b.ownerId).toBe(idea.id);
        expect(typeof b.periodStart).toBe('string');
        expect(typeof b.periodEnd).toBe('string');
        expect(Date.parse(b.periodStart)).toBeLessThan(Date.parse(b.periodEnd));
        // A brand-new Idea has spent nothing, has no cap, and is not blocked.
        expect(b.currentSpendCents).toBe(0);
        expect(b.capCents).toBeNull();
        expect(b.currency).toBe('usd');
        expect(b.percentUsed).toBeNull();
        expect(b.allowOverage).toBe(true);
        expect(b.blocked).toBe(false);
    });

    test('an Idea budget is NOT introspectable cross-user (stranger → 404) and requires auth (anon → 401)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const idea = await createIdea(
            request,
            authedHeaders(owner.access_token),
            `${IDEA_DESC_MIN} ${uniq('budget-owner')}`,
        );

        // The ownership gate runs BEFORE summarizing spend — a stranger sees the
        // uniform "Proposal not found" 404, never the per-Idea spend.
        const strangerRes = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/budget`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(strangerRes.status()).toBe(404);
        expect(msgOf(await strangerRes.json())).toMatch(/proposal not found/i);

        const anon = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`);
        expect(anon.status()).toBe(401);
    });
});

test.describe('Work-Proposals — research preferences round-trip', () => {
    test('preferences: emailNotifications is the INVERSE of optOut and round-trips both directions', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // Default: a fresh user is opted IN (optOut:false).
        const initial = await request.get(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers,
        });
        expect(initial.status()).toBe(200);
        expect(await initial.json()).toEqual({ optOut: false });

        // emailNotifications:false ⇒ optOut:true (the web-client-friendly inverse).
        const optOut = await request.put(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers,
            data: { emailNotifications: false },
        });
        expect(optOut.status()).toBe(200);
        expect((await optOut.json()).optOut).toBe(true);

        // The canonical optOut:false field flips it straight back to opted-in.
        const optIn = await request.put(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers,
            data: { optOut: false },
        });
        expect(optIn.status()).toBe(200);
        expect((await optIn.json()).optOut).toBe(false);
    });

    test('an EMPTY preferences body is an idempotent no-op, and preferences are per-user isolated', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const headersA = authedHeaders(userA.access_token);

        // A → opt OUT.
        const setA = await request.put(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers: headersA,
            data: { optOut: true },
        });
        expect(setA.status()).toBe(200);
        expect((await setA.json()).optOut).toBe(true);

        // An empty body validates cleanly but touches nothing — it re-reads the
        // current (opted-out) state.
        const noop = await request.put(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers: headersA,
            data: {},
        });
        expect(noop.status()).toBe(200);
        expect((await noop.json()).optOut).toBe(true);

        // B's preferences are untouched by A's opt-out — B is still the default
        // opted-in. Preferences are scoped to the authenticated user.
        const readB = await request.get(`${API_BASE}/api/me/work-proposals/preferences`, {
            headers: authedHeaders(userB.access_token),
        });
        expect(readB.status()).toBe(200);
        expect(await readB.json()).toEqual({ optOut: false });
    });
});

test.describe('Work-Proposals — Idea attachments edge surface', () => {
    test('attachments empty → add(64-hex edge, 201) → list → delete round-trip', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${uniq('attach-rt')}`);

        // A fresh Idea has no attachments.
        const empty = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/attachments`,
            {
                headers,
            },
        );
        expect(empty.status()).toBe(200);
        expect(await empty.json()).toEqual([]);

        // Attach a REAL, caller-owned upload (its sha256 id). Attachment-add now
        // validates the uploadId against `user_uploads`, so the edge lands only
        // for an upload the caller actually owns (a ghost/foreign id is 404 —
        // see the negatives test below).
        const uploadId = await mintUploadId(request, user.access_token);
        const add = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/attachments`, {
            headers,
            data: { uploadId },
        });
        expect(add.status(), `add body=${await add.text()}`).toBe(201);
        const edge = (await add.json()) as { id: string; workProposalId: string; uploadId: string };
        expect(edge.id).toMatch(UUID_RE);
        expect(edge.workProposalId).toBe(idea.id);
        expect(edge.uploadId).toBe(uploadId);

        // The edge now lists.
        const listed = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/attachments`,
            { headers },
        );
        expect(listed.status()).toBe(200);
        const rows = (await listed.json()) as Array<{ id: string }>;
        expect(rows.map((r) => r.id)).toContain(edge.id);

        // DELETE removes it; the list is empty again.
        const del = await request.delete(
            `${API_BASE}/api/me/work-proposals/${idea.id}/attachments/${edge.id}`,
            { headers },
        );
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        const afterDelete = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/attachments`,
            { headers },
        );
        expect(afterDelete.status()).toBe(200);
        expect(await afterDelete.json()).toEqual([]);
    });

    test('add-attachment rejects a non-hash uploadId with 400, and a stranger sees 404 "Idea not found"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerHeaders = authedHeaders(owner.access_token);
        const idea = await createIdea(
            request,
            ownerHeaders,
            `${IDEA_DESC_MIN} ${uniq('attach-edge')}`,
        );

        // The uploadId must match the 64-hex SHA shape — a short/garbage id is a
        // 400 DTO violation before any edge write.
        const badUpload = await request.post(
            `${API_BASE}/api/me/work-proposals/${idea.id}/attachments`,
            { headers: ownerHeaders, data: { uploadId: 'not-a-hash' } },
        );
        expect(badUpload.status()).toBe(400);
        expect(msgOf(await badUpload.json())).toMatch(/uploadId must match/i);

        // A stranger cannot even LIST the owner's Idea attachments — the
        // attachment surface raises its own "Idea not found" 404 (distinct from
        // the "Proposal not found" used by GET :id / :id/budget).
        const strangerList = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/attachments`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(strangerList.status()).toBe(404);
        expect(msgOf(await strangerList.json())).toMatch(/idea not found/i);
    });
});

test.describe('Work-Proposals — read ownership & keyless build transition', () => {
    test('GET :id of another user’s Idea is a 404 "Proposal not found" (no existence leak)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const idea = await createIdea(
            request,
            authedHeaders(owner.access_token),
            `${IDEA_DESC_MIN} ${uniq('read-owner')}`,
        );

        const strangerRead = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerRead.status()).toBe(404);
        expect(msgOf(await strangerRead.json())).toMatch(/proposal not found/i);

        // The owner still reads it fine — the 404 is an ownership scope, not a
        // vanished row.
        const ownerRead = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerRead.status()).toBe(200);
    });

    test('build on the keyless stack returns 400 "Work agent is disabled." but STILL commits PENDING→QUEUED', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${uniq('build-commit')}`);
        expect(idea.status).toBe('pending');

        // Env-adaptive: with a Work Agent the build is 200; on the keyless CI stack
        // the goal-enqueue raises 400 "Work agent is disabled." AFTER the Idea has
        // already been transitioned PENDING→QUEUED inside the same call.
        const build = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers,
        });
        expect([200, 400]).toContain(build.status());
        if (build.status() === 400) {
            expect(msgOf(await build.json())).toMatch(/work agent is disabled/i);
        }

        // Either way the Idea has left PENDING — the QUEUED transition is committed
        // before the enqueue failure (or a real agent advanced it further).
        const after = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers,
        });
        expect(after.status()).toBe(200);
        const status = ((await after.json()) as IdeaRow).status;
        expect(status).not.toBe('pending');
        expect(['queued', 'building', 'accepted']).toContain(status);
    });
});
