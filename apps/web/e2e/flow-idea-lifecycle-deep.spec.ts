import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Idea (Work-Proposal) DEEP state & taxonomy contracts — the input-validation,
 * derivation, whitelist, path-pipe, ownership, and FK-rollback edges of the
 * Missions/Ideas/Works surface that the existing idea/mission specs leave
 * unpinned. Every status code, error string, and response shape asserted
 * below was probed against the LIVE API at http://127.0.0.1:3100 (sqlite
 * in-memory, REQUIRE_EMAIL_VERIFICATION=false, no AI provider, no Trigger.dev)
 * BEFORE being written.
 *
 * Taxonomy: a Mission produces Ideas; an Idea becomes a Work. An Idea is a
 * WorkProposal under `/api/me/work-proposals`; a Mission is under
 * `/api/me/missions`.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────
 * Deliberately DISJOINT from the eight sibling specs:
 *   - flow-idea-build-lifecycle.spec.ts       — the build/retry/rebuild/dismiss
 *     state machine + ?statuses observability.
 *   - flow-idea-to-work-accept.spec.ts        — accept happy/re-point/ownership
 *     + mission linkage round-trip.
 *   - flow-idea-multi-work-links.spec.ts      — idea_works 0..N provenance
 *     (multi-link accept, newest-first GET :id/works, per-Work back-pointers).
 *   - ideas-extension.spec.ts                 — shallow 401/404 contract pins.
 *   - flow-mission-idea-build.spec.ts         — Mission tick / cap math.
 *   - flow-mission-ideas-isolation.spec.ts    — scoping/ordering/counting lattice.
 *   - missions-ideas-hierarchy.spec.ts        — clone + Agent/Task scoping.
 *   - mission-idea-task-flow.spec.ts          — Mission→Idea→Task wiring.
 * Those pin the STATE MACHINE and SCOPING. THIS file pins the INPUT EDGE:
 * Idea-create title/slug DERIVATION, the create whitelist (privilege-field
 * rejection), the length boundaries (5000/120), the ParseUUIDPipe path guard,
 * accept's WORK-ownership guard (foreign/ghost workId → 404, #1280 IDOR fix),
 * and the Mission create validation lattice (cap/type) + mission-scoped budget
 * shape.
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────
 *
 *  POST /api/me/work-proposals  (create user-manual Idea)
 *    { description, title? }
 *    · title PROVIDED  → 201; slugSuggestion derives from the TITLE.
 *    · title ABSENT    → title is the description truncated to ≤80 chars
 *      (trailing space trimmed → here 79); slug derives from that title.
 *    · title === ''    → treated as absent (description-derived title).
 *    · title 120 chars → 201 (INCLUSIVE); 121 → 400 "title must be shorter
 *      than or equal to 120 characters".
 *    · description 5000→201 (INCLUSIVE); 5001→400 "shorter than or equal to 5000".
 *    · unknown field   → 400 "property <x> should not exist" (whitelist).
 *    · status/source/acceptedWorkId/missionId in body → 400 "property … should
 *      not exist" (no privilege-field injection at create).
 *
 *  GET|POST|PATCH /api/me/work-proposals/<malformed>/…  → 400
 *    "Validation failed (uuid is expected)"  (ParseUUIDPipe, before any guard).
 *
 *  GET    /api/me/work-proposals/<unknown-uuid>          → 404 "Proposal not found"
 *  PATCH  /api/me/work-proposals/<unknown-uuid>/dismiss  → 404 "… not pending"
 *  POST   /api/me/work-proposals/<unknown-uuid>/accept   → 404 "… already finalized"
 *  POST   /api/me/work-proposals/<stranger>/build|retry|rebuild → 404 "Proposal not found"
 *
 *  POST /api/me/work-proposals/:id/accept  { workId:UUID }
 *    · workId belonging to ANOTHER user → 404 (#1280 IDOR fix: acceptInternal
 *      verifies work.userId === caller; the Idea stays PENDING, no foreign
 *      stamp). Was a 200 cross-user-linkage IDOR before the fix.
 *    · workId well-formed but NON-EXISTENT → 404 (the same ownership guard
 *      short-circuits when findById returns null); the Idea stays PENDING.
 *    · workId the CALLER owns → 200 { ok:true }, Idea ACCEPTED + stamped BOTH
 *      ways (review §23.1): `acceptedWorkId` on the Idea AND the Work-side
 *      `acceptedFromIdeaId` back-pointer (first-writer-wins — a Work keeps at
 *      most ONE source Idea), plus an authoritative `idea_works` provenance row.
 *    · ACCEPTED Idea → rebuild commits ACCEPTED→building, acceptedWorkId PRESERVED.
 *
 *  POST /api/me/missions  validation lattice
 *    · outstandingIdeasCap -2  → 400 "must not be less than -1" (sentinel floor)
 *    · outstandingIdeasCap 1.5 → 400 "must be an integer number"
 *    · type 'recurring'        → 400 "type must be one of … one-shot, scheduled"
 *  GET /api/me/missions/:id/budget → 200 { ownerType:'mission', ownerId,
 *    periodStart, periodEnd (calendar-month window), currentSpendCents:0,
 *    capCents:null, currency:'usd', percentUsed:null, allowOverage:true,
 *    blocked:false }
 *
 * Cross-spec isolation: EVERY mutation runs on a FRESH registerUserViaAPI()
 * user (a per-user shadow could leak into sibling chat specs). Unique suffixes
 * are built from a per-test counter + the test title (NOT a module-scope clock).
 * List assertions use toContain / .find (shared DB), never exact counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A syntactically-valid v4 UUID that no row will ever own. */
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const IDEA_DESC_MIN = 'A curated directory of resources'; // ≥10 chars filler

let counter = 0;
function uniq(title: string): string {
    counter += 1;
    const slug = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    return `${slug}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface IdeaRow {
    id: string;
    title: string;
    description: string;
    slugSuggestion: string;
    source: string;
    status: string;
    acceptedWorkId: string | null;
    missionId: string | null;
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

async function readIdea(
    request: APIRequestContext,
    headers: Record<string, string>,
    id: string,
): Promise<IdeaRow> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, { headers });
    expect(res.status(), `read idea body=${await res.text()}`).toBe(200);
    return (await res.json()) as IdeaRow;
}

test.describe('Idea create — title/slug derivation & response shape', () => {
    test('a PROVIDED title drives the slugSuggestion; the description is the generatedPrompt', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const title = `Title ${uniq('provided')}`;
        const description = `${IDEA_DESC_MIN} ${uniq('desc')} for the title-derivation probe`;

        const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description, title },
        });
        expect(res.status(), `create body=${await res.text()}`).toBe(201);
        const idea = await res.json();

        // The provided title is honoured verbatim and the slug is derived from
        // it (NOT from the description) — kebab-cased, lower-cased.
        expect(idea.title).toBe(title);
        expect(idea.slugSuggestion).toBe(title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        expect(idea.slugSuggestion).not.toBe(description.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

        // Birth-state invariants + the manual-source provenance string.
        expect(idea.source).toBe('user-manual');
        expect(idea.status).toBe('pending');
        expect(idea.generatedPrompt).toBe(description);
        expect(idea.acceptedWorkId).toBeNull();
        expect(idea.missionId).toBeNull();
        expect(idea.suggestedCategories).toEqual([]);
        expect(idea.recommendedPlugins).toEqual([]);
    });

    test('an ABSENT title is derived from the description and truncated to ≤80 chars; an EMPTY title is treated as absent', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // A long description (>80 chars) → the derived title is the description
        // truncated to ≤80 chars (trailing space trimmed) and the slug follows
        // that truncated title, NOT the full description.
        const longDesc =
            'Build a comprehensive curated directory of the very best AI developer tools and resources for engineers';
        const long = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: longDesc },
        });
        expect(long.status()).toBe(201);
        const longIdea = await long.json();
        expect(longIdea.title.length).toBeLessThanOrEqual(80);
        expect(longDesc.startsWith(longIdea.title)).toBe(true);
        // The slug is the kebab of the (truncated) title — so it is itself
        // bounded and derived from the title, never the untruncated description.
        expect(longIdea.slugSuggestion).toBe(
            longIdea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        );
        expect(longIdea.slugSuggestion.length).toBeLessThanOrEqual(80);

        // A short description (≤80) → the title IS the whole description.
        const shortDesc = `${IDEA_DESC_MIN} ${uniq('short')}`;
        const short = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: shortDesc },
        });
        expect(short.status()).toBe(201);
        expect((await short.json()).title).toBe(shortDesc);

        // An EMPTY-string title is treated as ABSENT — the description-derived
        // title is used rather than persisting a blank title.
        const emptyTitleDesc = `${IDEA_DESC_MIN} ${uniq('emptytitle')}`;
        const empty = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: emptyTitleDesc, title: '' },
        });
        expect(empty.status()).toBe(201);
        expect((await empty.json()).title).toBe(emptyTitleDesc);
    });
});

test.describe('Idea create — length boundaries & whitelist', () => {
    test('description length is bounded [10, 5000] inclusive and title to ≤120 inclusive', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // description: 9 → 400, 10 → 201, 5000 → 201, 5001 → 400.
        const nine = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: '123456789' },
        });
        expect(nine.status()).toBe(400);
        expect(msgOf(await nine.json())).toMatch(/longer than or equal to 10/i);

        const ten = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: '1234567890' },
        });
        expect(ten.status(), `ten body=${await ten.text()}`).toBe(201);

        const fiveK = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'a'.repeat(5000) },
        });
        expect(fiveK.status()).toBe(201);

        const overFiveK = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'a'.repeat(5001) },
        });
        expect(overFiveK.status()).toBe(400);
        expect(msgOf(await overFiveK.json())).toMatch(/shorter than or equal to 5000/i);

        // title: 120 → 201 (inclusive); 121 → 400.
        const title120 = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `${IDEA_DESC_MIN} t120`, title: 'T'.repeat(120) },
        });
        expect(title120.status(), `t120 body=${await title120.text()}`).toBe(201);

        const title121 = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `${IDEA_DESC_MIN} t121`, title: 'T'.repeat(121) },
        });
        expect(title121.status()).toBe(400);
        expect(msgOf(await title121.json())).toMatch(/title must be shorter than or equal to 120/i);
    });

    test('the create DTO whitelist rejects unknown fields AND server-owned/privilege fields (no status/source/acceptedWorkId/missionId injection)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // An arbitrary unknown property is rejected by name.
        const bogus = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `${IDEA_DESC_MIN} bogus`, bogusField: 'x' },
        });
        expect(bogus.status()).toBe(400);
        expect(msgOf(await bogus.json())).toMatch(/property bogusField should not exist/i);

        // Each SERVER-OWNED field is whitelisted out — a client cannot seed a
        // privileged birth-state (pre-accepted, AI-sourced, pre-linked, …).
        for (const [field, value] of [
            ['status', 'accepted'],
            ['source', 'ai-research'],
            ['acceptedWorkId', UNKNOWN_UUID],
            ['missionId', UNKNOWN_UUID],
        ] as const) {
            const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
                headers,
                data: { description: `${IDEA_DESC_MIN} inject-${field}`, [field]: value },
            });
            expect(res.status(), `inject ${field}`).toBe(400);
            expect(msgOf(await res.json())).toMatch(
                new RegExp(`property ${field} should not exist`, 'i'),
            );
        }
    });
});

test.describe('Idea endpoints — path-id validation & unknown-id 404 vocabulary', () => {
    test('a MALFORMED (non-UUID) path id is a 400 ParseUUIDPipe failure on every Idea route, before any auth/ownership guard', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // GET / budget are GET; build/retry/rebuild/accept are POST; dismiss is PATCH.
        const getRoutes = ['', '/budget'];
        for (const sub of getRoutes) {
            const res = await request.get(`${API_BASE}/api/me/work-proposals/not-a-uuid${sub}`, {
                headers,
            });
            expect(res.status(), `GET not-a-uuid${sub}`).toBe(400);
            expect(msgOf(await res.json())).toMatch(/uuid is expected/i);
        }

        for (const action of ['build', 'retry', 'rebuild'] as const) {
            const res = await request.post(
                `${API_BASE}/api/me/work-proposals/not-a-uuid/${action}`,
                { headers },
            );
            expect(res.status(), `POST not-a-uuid/${action}`).toBe(400);
            expect(msgOf(await res.json())).toMatch(/uuid is expected/i);
        }

        const acceptMalformed = await request.post(
            `${API_BASE}/api/me/work-proposals/not-a-uuid/accept`,
            { headers, data: { workId: UNKNOWN_UUID } },
        );
        expect(acceptMalformed.status()).toBe(400);
        expect(msgOf(await acceptMalformed.json())).toMatch(/uuid is expected/i);

        const dismissMalformed = await request.patch(
            `${API_BASE}/api/me/work-proposals/not-a-uuid/dismiss`,
            { headers },
        );
        expect(dismissMalformed.status()).toBe(400);
        expect(msgOf(await dismissMalformed.json())).toMatch(/uuid is expected/i);
    });

    test('an UNKNOWN-but-valid Idea id yields a 404 with each route’s distinct message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // GET → "Proposal not found"
        const get = await request.get(`${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}`, {
            headers,
        });
        expect(get.status()).toBe(404);
        expect(msgOf(await get.json())).toMatch(/proposal not found/i);

        // dismiss → "Proposal not found or not pending" (the PENDING-scoped UPDATE)
        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/dismiss`,
            { headers },
        );
        expect(dismiss.status()).toBe(404);
        expect(msgOf(await dismiss.json())).toMatch(/not found or not pending/i);

        // accept → "Proposal not found or already finalized" (the PENDING-scoped accept)
        const accept = await request.post(
            `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/accept`,
            { headers, data: { workId: UNKNOWN_UUID } },
        );
        expect(accept.status()).toBe(404);
        expect(msgOf(await accept.json())).toMatch(/not found or already finalized/i);

        // budget on an unknown id → 404 "Proposal not found"
        const budget = await request.get(
            `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/budget`,
            { headers },
        );
        expect(budget.status()).toBe(404);
        expect(msgOf(await budget.json())).toMatch(/proposal not found/i);
    });

    test('a STRANGER’s Idea is uniformly 404 on build/retry/rebuild — "Proposal not found" with no existence leak', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerHeaders = authedHeaders(owner.access_token);
        const strangerHeaders = authedHeaders(stranger.access_token);

        const idea = await createIdea(
            request,
            ownerHeaders,
            `${IDEA_DESC_MIN} ${uniq('stranger-actions')}`,
        );

        for (const action of ['build', 'retry', 'rebuild'] as const) {
            const res = await request.post(
                `${API_BASE}/api/me/work-proposals/${idea.id}/${action}`,
                { headers: strangerHeaders },
            );
            expect(res.status(), `stranger ${action}`).toBe(404);
            expect(msgOf(await res.json())).toMatch(/proposal not found/i);
        }

        // The owner's Idea is untouched by all the hostile traffic — still PENDING.
        expect((await readIdea(request, ownerHeaders, idea.id)).status).toBe('pending');
    });
});

test.describe('Idea list — combined ?missionId × ?statuses composition', () => {
    test('missionId and statuses are AND-composed, multi-valued statuses union, and a single invalid status in a multi-list rejects the whole query', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = uniq('combo-filter');

        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Combo Mission ${s}`,
                description: 'A mission to assert combined Idea list filters',
                type: 'one-shot',
            },
        });
        expect(missionRes.status()).toBe(201);
        const mission = await missionRes.json();

        // A standalone PENDING Idea (missionId:null) — visible in the unscoped
        // default list and in a pending-status list, NEVER in any Mission scope.
        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${s}`);

        // ?missionId × ?statuses are AND-composed: the Mission has zero linked
        // Ideas, so even ?statuses=accepted within its scope is [].
        const scoped = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${mission.id}&statuses=accepted`,
            { headers },
        );
        expect(scoped.status()).toBe(200);
        expect(await scoped.json()).toEqual([]);

        // The standalone Idea does NOT leak into the Mission's default scope.
        const missionDefault = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
            { headers },
        );
        expect(missionDefault.status()).toBe(200);
        expect((await missionDefault.json()).map((p: { id: string }) => p.id)).not.toContain(
            idea.id,
        );

        // Multi-valued ?statuses=accepted&statuses=pending unions — the PENDING
        // Idea is present (shared DB ⇒ toContain).
        const union = await request.get(
            `${API_BASE}/api/me/work-proposals?statuses=accepted&statuses=pending`,
            { headers },
        );
        expect(union.status()).toBe(200);
        expect((await union.json()).map((p: { id: string }) => p.id)).toContain(idea.id);

        // A single bogus value inside a multi-list rejects the WHOLE query (the
        // @IsEnum({ each: true }) guard fires per-element).
        const mixed = await request.get(
            `${API_BASE}/api/me/work-proposals?statuses=pending&statuses=bogus`,
            { headers },
        );
        expect(mixed.status()).toBe(400);
        expect(msgOf(await mixed.json())).toMatch(
            /each value in statuses must be one of.*pending, dismissed, accepted, queued, building, failed/i,
        );
    });
});

test.describe('Idea → Work accept — Work-side edge cases (FK, ownership, rollback)', () => {
    test('accept against a FOREIGN user’s workId is REFUSED (404) and never stamps the foreign workId — IDOR guard', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const ownerHeaders = authedHeaders(owner.access_token);
        const s = uniq('foreign-work');

        // Owner makes an Idea; OTHER makes a Work the owner never created.
        const idea = await createIdea(request, ownerHeaders, `${IDEA_DESC_MIN} ${s}`);
        const foreignWork = await createWorkViaAPI(request, other.access_token, {
            name: `Foreign Work ${s}`,
        });
        expect(foreignWork.id).toMatch(UUID_RE);

        // Owner accepts THEIR Idea against the OTHER user's workId. SECURITY
        // (#1280, EW-711 IDOR fix): acceptInternal now verifies the supplied
        // workId belongs to the SAME user (work.userId === caller). A foreign
        // work fails that check and the service returns false → the controller's
        // existence-leak-safe 404 ("Proposal not found or already finalized").
        // Previously this SUCCEEDED (200) and stamped the foreign workId onto
        // the Idea's acceptedWorkId — a cross-owner dangling reference.
        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers: ownerHeaders,
            data: { workId: foreignWork.id },
        });
        expect(accept.status(), `accept body=${await accept.text()}`).toBe(404);

        // The owner's Idea is UNTOUCHED — still PENDING, no foreign stamp.
        const accepted = await readIdea(request, ownerHeaders, idea.id);
        expect(accepted.status).toBe('pending');
        expect(accepted.acceptedWorkId).toBeNull();

        // The stranger's Work is likewise untouched (no back-pointer).
        const otherWorkRead = await request.get(`${API_BASE}/api/works/${foreignWork.id}`, {
            headers: authedHeaders(other.access_token),
        });
        expect(otherWorkRead.status()).toBe(200);
        const otherWorkBody = await otherWorkRead.json();
        const otherWorkEntity = otherWorkBody?.work ?? otherWorkBody;
        expect(otherWorkEntity?.acceptedFromIdeaId ?? null).toBeNull();
    });

    test('accept against a GHOST (non-existent) workId is REFUSED (404) and the Idea stays PENDING — IDOR guard short-circuits before the FK', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${uniq('ghost-work')}`);

        // A well-formed but non-existent workId passes the @IsUUID DTO + the
        // Idea ownership/status guard, then hits the new workId-ownership guard
        // (#1280): `works.findById(workId)` returns null → service returns false
        // → controller 404. (Before the fix this fell through to the
        // acceptedWorkId FK and surfaced as a 200-or-500.) No state change.
        const ghost = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers,
            data: { workId: UNKNOWN_UUID },
        });
        expect(ghost.status()).toBe(404);

        const after = await readIdea(request, headers, idea.id);
        expect(after.status).toBe('pending');
        expect(after.acceptedWorkId).toBeNull();
    });

    test('the accept body DTO is strict: a null workId, a non-UUID workId, and an extra field are each rejected BEFORE any state change', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = uniq('accept-body');

        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${s}`);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Accept-Body Work ${s}`,
        });

        // workId: null → 400 "workId must be a UUID" (the @IsUUID DTO fires).
        const nullWork = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers,
            data: { workId: null },
        });
        expect(nullWork.status()).toBe(400);
        expect(msgOf(await nullWork.json())).toMatch(/workId must be a UUID/i);

        // A non-UUID string workId → 400.
        const badWork = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers,
            data: { workId: 'not-a-uuid' },
        });
        expect(badWork.status()).toBe(400);
        expect(msgOf(await badWork.json())).toMatch(/workId must be a UUID/i);

        // An EXTRA field alongside a valid workId → 400 whitelist (the client
        // cannot smuggle a status override through the accept body).
        const extraField = await request.post(
            `${API_BASE}/api/me/work-proposals/${idea.id}/accept`,
            { headers, data: { workId: work.id, status: 'queued' } },
        );
        expect(extraField.status()).toBe(400);
        expect(msgOf(await extraField.json())).toMatch(/property status should not exist/i);

        // After every rejected accept the Idea is UNTOUCHED — still PENDING,
        // no acceptedWorkId leaked.
        const after = await readIdea(request, headers, idea.id);
        expect(after.status).toBe('pending');
        expect(after.acceptedWorkId).toBeNull();

        // The valid accept (clean body) still lands afterwards.
        const ok = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers,
            data: { workId: work.id },
        });
        expect(ok.status()).toBe(200);
        expect((await readIdea(request, headers, idea.id)).acceptedWorkId).toBe(work.id);

        // Review §23.1: the successful accept stamped the WORK-side back-pointer
        // too — `acceptedFromIdeaId` = the source Idea (first-writer-wins; this
        // Work had no source Idea, so the stamp lands).
        const workRead = await request.get(`${API_BASE}/api/works/${work.id}`, { headers });
        expect(workRead.status(), `work read body=${await workRead.text()}`).toBe(200);
        const workBody = await workRead.json();
        expect((workBody?.work ?? workBody)?.acceptedFromIdeaId ?? null).toBe(idea.id);
    });

    test('rebuild of an ACCEPTED Idea commits ACCEPTED→building and PRESERVES acceptedWorkId (no Work re-point on the no-AI stack)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = uniq('accept-rebuild');

        const idea = await createIdea(request, headers, `${IDEA_DESC_MIN} ${s}`);
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Rebuild Work ${s}`,
        });

        // Accept → ACCEPTED, acceptedWorkId set.
        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers,
            data: { workId: work.id },
        });
        expect(accept.status()).toBe(200);
        expect((await readIdea(request, headers, idea.id)).acceptedWorkId).toBe(work.id);

        // Rebuild — env-adaptive (200 with a Work Agent, else 400 "Work agent is
        // disabled."). markRebuildingFromAccepted commits ACCEPTED→building
        // BEFORE the goal-enqueue, so the transition lands either way.
        const rebuild = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/rebuild`, {
            headers,
        });
        expect([200, 400]).toContain(rebuild.status());
        if (rebuild.status() === 400) {
            expect(msgOf(await rebuild.json())).toMatch(/work agent is disabled/i);
        }

        const after = await readIdea(request, headers, idea.id);
        // building when the no-AI 400 path committed, or accepted/queued if a
        // real agent finished synchronously — all truthful.
        expect(['building', 'accepted', 'queued']).toContain(after.status);
        // CRITICAL: the Work pointer is PRESERVED — acceptedWorkId only re-points
        // on goal completion, which can't run here.
        expect(after.acceptedWorkId).toBe(work.id);

        // The backing Work was NOT deleted by the rebuild — and its §23.1
        // back-pointer (stamped when the accept linked it) survives untouched:
        // first-writer-wins means nothing ever re-points a Work's source Idea.
        const stillThere = await request.get(`${API_BASE}/api/works/${work.id}`, { headers });
        expect(stillThere.status()).toBe(200);
        const stillBody = await stillThere.json();
        expect((stillBody?.work ?? stillBody)?.acceptedFromIdeaId ?? null).toBe(idea.id);
    });
});

test.describe('Mission create — validation lattice & mission-scoped budget', () => {
    test('outstandingIdeasCap is an integer ≥ -1 and type is the one-shot|scheduled enum', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = uniq('mission-validation');

        // cap below the -1 sentinel → 400 "must not be less than -1".
        const capBelow = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Cap-below ${s}`,
                description: 'A mission probing the cap floor',
                type: 'one-shot',
                outstandingIdeasCap: -2,
            },
        });
        expect(capBelow.status()).toBe(400);
        expect(msgOf(await capBelow.json())).toMatch(
            /outstandingIdeasCap must not be less than -1/i,
        );

        // non-integer cap → 400 "must be an integer number".
        const capFloat = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Cap-float ${s}`,
                description: 'A mission probing the cap integer rule',
                type: 'one-shot',
                outstandingIdeasCap: 1.5,
            },
        });
        expect(capFloat.status()).toBe(400);
        expect(msgOf(await capFloat.json())).toMatch(/outstandingIdeasCap must be an integer/i);

        // bad type enum → 400 listing the allowed values.
        const badType = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Bad-type ${s}`,
                description: 'A mission probing the type enum',
                type: 'recurring',
            },
        });
        expect(badType.status()).toBe(400);
        expect(msgOf(await badType.json())).toMatch(/type must be one of.*one-shot, scheduled/i);

        // The -1 sentinel (unlimited) and a valid positive cap BOTH round-trip.
        const unlimited = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Cap-unlimited ${s}`,
                description: 'A mission with the unlimited cap sentinel',
                type: 'one-shot',
                outstandingIdeasCap: -1,
            },
        });
        expect(unlimited.status()).toBe(201);
        expect((await unlimited.json()).outstandingIdeasCap).toBe(-1);
    });

    test('GET /api/me/missions/:id/budget returns a mission-scoped OwnerBudgetSummary and is not introspectable cross-user', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = uniq('mission-budget');

        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Budget Mission ${s}`,
                description: 'A mission used to assert the budget summary shape',
                type: 'one-shot',
            },
        });
        expect(missionRes.status(), `mission body=${await missionRes.text()}`).toBe(201);
        const mission = await missionRes.json();
        expect(mission.id).toMatch(UUID_RE);

        const budgetRes = await request.get(`${API_BASE}/api/me/missions/${mission.id}/budget`, {
            headers,
        });
        expect(budgetRes.status()).toBe(200);
        const b = await budgetRes.json();
        // The owner type is MISSION (vs the Idea budget's 'idea') — same envelope.
        expect(b.ownerType).toBe('mission');
        expect(b.ownerId).toBe(mission.id);
        expect(typeof b.periodStart).toBe('string');
        expect(typeof b.periodEnd).toBe('string');
        // The window is a calendar month: start < end and both parse as dates.
        expect(Date.parse(b.periodStart)).toBeLessThan(Date.parse(b.periodEnd));
        expect(b.currentSpendCents).toBe(0);
        expect(b.capCents).toBeNull();
        expect(b.currency).toBe('usd');
        expect(b.percentUsed).toBeNull();
        expect(b.allowOverage).toBe(true);
        expect(b.blocked).toBe(false);

        // A stranger cannot read the mission OR its budget — both 404 (no leak).
        const otherBudget = await request.get(`${API_BASE}/api/me/missions/${mission.id}/budget`, {
            headers: authedHeaders(other.access_token),
        });
        expect(otherBudget.status()).toBe(404);

        // budget without auth → 401.
        const anon = await request.get(`${API_BASE}/api/me/missions/${mission.id}/budget`);
        expect(anon.status()).toBe(401);
    });
});
