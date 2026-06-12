import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

/**
 * flow-works-config-deep.spec.ts — the Missions/Ideas TAXONOMY LIST-QUERY contract.
 *
 * SCOPE NOTE (works-config): the `works-config` module
 * (`packages/agent/src/works-config/*`) is a GIT/REPO-SOURCED parser — it reads
 * `.works/works.yml` from a connected repository and is consumed by the generation
 * pipeline. It has NO standalone read/write HTTP controller in `apps/api`. Its ONLY
 * public HTTP surface is the zero-friction onboarding endpoint
 * (`POST/GET /api/register-work`, apps/api/src/onboarding/*), which is ALREADY fully
 * pinned by `flow-register-work-flow.spec.ts` (validation / credential / status state
 * machine) — re-probed live here and confirmed unchanged, so it is NOT re-asserted.
 * This file therefore pins the adjacent, near-greenfield REACHABLE config surface of
 * the taxonomy: the LIST-QUERY parameter contract of the two collection roots that
 * organize the Mission → Idea → Work hierarchy, which no sibling pins as a contract.
 *
 * GROUND TRUTH — every status / message / shape below was LIVE-PROBED against the
 * running sqlite-in-memory CI driver (http://127.0.0.1:3100, REQUIRE_EMAIL_VERIFICATION
 * off, keyless) on 2026-06-12, BEFORE any assertion, and cross-read against:
 *   - apps/api/src/missions/missions.controller.ts
 *       (@Controller('api/me/missions'); list() parses status/search/limit/offset by HAND
 *        via private parseStatus/parseSearch/parseLimit/parseOffset helpers)
 *   - apps/api/src/work-proposals/work-proposals.controller.ts
 *       (@Controller('api/me/work-proposals'); list() validates via a DTO)
 *   - apps/api/src/work-proposals/dto/work-proposal.dto.ts (ListWorkProposalsQueryDto)
 *
 * THE CENTRAL, PROBED CONTRAST these 12 tests pin — the SAME four logical filters
 * (status/statuses, search, limit, offset) are validated by TWO DIFFERENT mechanisms,
 * yielding TWO DIFFERENT, observable contracts:
 *
 *   MISSIONS list — MANUAL parse (controller helpers), single-string `message`:
 *     ?status=<unknown>   -> 400 { message:'Invalid status filter: <v>', error:'Bad Request', statusCode:400 }
 *                            (CASE-SENSITIVE: 'ACTIVE' is rejected; only the lowercase enum passes)
 *     ?status=''          -> 200 (empty string is falsy -> filter ignored)
 *     ?limit=<non-int>    -> 400 { message:'limit must be an integer.', ... }   (NOTE the trailing period)
 *     ?offset=<non-int>   -> 400 { message:'offset must be an integer.', ... }
 *     ?search=<>500 chars -> 400 { message:'search must be 500 characters or fewer.', ... }
 *     ?limit=0 | 9999     -> 200 SILENTLY CLAMPED (Math.min(101, Math.max(1, n)))  — NOT rejected
 *     ?offset=-5          -> 200 SILENTLY CLAMPED (Math.max(0, n))                 — NOT rejected
 *     ?bogusparam=1       -> 200 (extra params ignored — @Query reads named params individually)
 *
 *   IDEAS (work-proposals) list — DTO/class-validator, ARRAY `message`:
 *     ?statuses=<unknown> -> 400 { message:['each value in statuses must be one of the following values: pending, dismissed, accepted, queued, building, failed'], ... }
 *     ?limit=9999         -> 400 ['limit must not be greater than 101']   (HARD reject, NOT clamp)
 *     ?limit=0            -> 400 ['limit must not be less than 1']
 *     ?offset=-1          -> 400 ['offset must not be less than 0']
 *     ?missionId=<non-uuid> -> 400 ['missionId must be a UUID']
 *     ?search=<>500       -> 400 ['search must be shorter than or equal to 500 characters']
 *
 * Plus the SHARED list semantics, probed deterministically on the keyless stack:
 *   - both roots are owner-scoped: anon -> 401 { message:'Unauthorized', statusCode:401 }.
 *   - Missions list filters work: ?search=<title> returns the exact matching subset
 *     (case-insensitive); a no-match search -> 200 []; ?status=completed vs ?status=active
 *     partition the set with zero overlap.
 *   - Missions pagination is set-correct: a fresh owner's full list paginated by
 *     limit/offset yields DISJOINT pages whose UNION is the full id set, with exact page
 *     sizes (ordering DIRECTION is NOT asserted — createdAt is second-granular so rows
 *     created in the same second tie; we assert the page-partition invariant instead).
 *   - getOne: non-uuid -> 400 (ParseUUIDPipe 'Validation failed (uuid is expected)');
 *     well-formed-unknown -> 404 'Mission not found' (no existence leak).
 *
 * NON-DUPLICATION — read in full before writing this file; none pins the LIST-QUERY
 * parameter contract as its subject:
 *   - flow-register-work-flow.spec.ts → the works-config manifest HTTP surface
 *     (register-work credential/validation/status state machine). Disjoint endpoint.
 *   - flow-mission-crud-schedule / flow-mission-lifecycle-deep → CREATE-body validation,
 *     the lifecycle state machine, PATCH field matrix, budget. They MENTION limit/offset/
 *     search/status filters in prose but never assert the per-param 400 envelopes, the
 *     CLAMP-vs-REJECT divergence, or the Missions-manual vs Ideas-DTO contrast.
 *   - flow-mission-ideas-isolation(-deep) → the ?missionId scope-filter existence-leak
 *     lattice + Idea create-rejection layers. It pins ?missionId=not-a-uuid->400 on the
 *     OWNER side; this file does NOT re-assert that, and instead pins the OTHER Ideas-list
 *     query params (statuses enum / limit Min+Max / offset Min / search MaxLength) and the
 *     full Missions-list manual-parse matrix the isolation specs never touch.
 *
 * House rules: fresh registerUserViaAPI() owner per mutation; per-test unique suffix from
 * a counter seeded by the test title (no module-scope clock); anon via raw fetch with an
 * empty header set; assert RECORDS/contracts only (keyless — no AI/mail readback).
 */

const MISSIONS = `${API_BASE}/api/me/missions`;
const IDEAS = `${API_BASE}/api/me/work-proposals`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface MissionDto {
    id: string;
    title: string;
    status: string;
    type: string;
}
interface ErrorEnvelope {
    statusCode?: number;
    error?: string;
    message?: string | string[];
}

/** Per-test unique suffix — derived from the test title, NOT a module-scope clock. */
function suffixFor(title: string): string {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

async function readError(res: {
    status(): number;
    text(): Promise<string>;
}): Promise<{ status: number; body: ErrorEnvelope; text: string }> {
    const text = await res.text().catch(() => '');
    let body: ErrorEnvelope = {};
    try {
        body = JSON.parse(text || '{}') as ErrorEnvelope;
    } catch {
        body = {};
    }
    return { status: res.status(), body, text };
}

function messageArray(body: ErrorEnvelope): string[] {
    return Array.isArray(body.message) ? body.message : [];
}

/** Create a one-shot Mission for the given owner. */
async function createMission(
    request: APIRequestContext,
    owner: RegisteredUser,
    title: string,
): Promise<MissionDto> {
    const res = await request.post(MISSIONS, {
        headers: authedHeaders(owner.access_token),
        data: {
            title,
            description: `${title} — created by flow-works-config-deep for list-query probing`,
            type: 'one-shot',
        },
    });
    expect(res.status(), `create mission "${title}" body=${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return (await res.json()) as MissionDto;
}

/** GET a Missions-list query and return parsed DTO rows (asserts 200). */
async function listMissions(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<MissionDto[]> {
    const res = await request.get(`${MISSIONS}${query}`, { headers: authedHeaders(token) });
    expect(res.status(), `list missions ${query} body=${await res.text().catch(() => '')}`).toBe(
        200,
    );
    return (await res.json()) as MissionDto[];
}

test.describe('flow-works-config-deep — Missions/Ideas list-query contract', () => {
    // ─── ownership: both collection roots are owner-scoped ────────────────────
    test('both taxonomy roots reject anonymous list reads with the canonical 401 envelope', async ({
        request,
    }) => {
        for (const [label, url] of [
            ['missions', MISSIONS],
            ['ideas/work-proposals', IDEAS],
        ] as const) {
            const res = await request.get(url, { headers: {} });
            const { status, body } = await readError(res);
            expect(status, `${label} anon list -> 401`).toBe(401);
            expect(body.statusCode, `${label} anon 401 statusCode`).toBe(401);
            expect(body.message, `${label} anon 401 message`).toBe('Unauthorized');
        }
    });

    // ─── MISSIONS list — manual parseStatus ───────────────────────────────────
    test('Missions ?status: unknown token → 400 single-string "Invalid status filter", and the enum check is CASE-SENSITIVE', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        const bogus = await readError(
            await request.get(`${MISSIONS}?status=bogus`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(bogus.status, `unknown status -> 400; body=${bogus.text}`).toBe(400);
        expect(bogus.body.error, 'manual-parse rejection uses Bad Request label').toBe(
            'Bad Request',
        );
        // The Missions controller parses status by HAND -> a SINGLE string message
        // (not a class-validator array).
        expect(typeof bogus.body.message, 'manual status message is a single string').toBe(
            'string',
        );
        expect(bogus.body.message).toBe('Invalid status filter: bogus');

        // CASE-SENSITIVE: the valid enum value is lowercase 'active'; 'ACTIVE' is rejected,
        // echoing the offending token verbatim.
        const upper = await readError(
            await request.get(`${MISSIONS}?status=ACTIVE`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(upper.status, 'uppercase status is not normalized -> 400').toBe(400);
        expect(upper.body.message).toBe('Invalid status filter: ACTIVE');

        // An EMPTY status string is falsy -> the filter is simply ignored -> 200.
        const empty = await request.get(`${MISSIONS}?status=`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(empty.status(), 'empty ?status= is ignored, not rejected').toBe(200);
    });

    // ─── MISSIONS list — manual parseLimit / parseOffset (non-int reject) ──────
    test('Missions ?limit / ?offset: a non-integer value → 400 with the EXACT manual messages (period-terminated)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        const badLimit = await readError(
            await request.get(`${MISSIONS}?limit=abc`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(badLimit.status, `?limit=abc -> 400; body=${badLimit.text}`).toBe(400);
        expect(badLimit.body.error).toBe('Bad Request');
        // EXACT manual message — note the trailing period; this is DISTINCT from the
        // class-validator "limit must be an integer number" that the Ideas DTO emits.
        expect(badLimit.body.message).toBe('limit must be an integer.');

        // A fractional value is also rejected (Number.isInteger(2.5) === false).
        const fracLimit = await readError(
            await request.get(`${MISSIONS}?limit=2.5`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(fracLimit.status, 'fractional limit -> 400').toBe(400);
        expect(fracLimit.body.message).toBe('limit must be an integer.');

        const badOffset = await readError(
            await request.get(`${MISSIONS}?offset=xyz`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(badOffset.status, `?offset=xyz -> 400; body=${badOffset.text}`).toBe(400);
        expect(badOffset.body.message).toBe('offset must be an integer.');
    });

    // ─── MISSIONS list — manual parseSearch (length cap) ──────────────────────
    test('Missions ?search over 500 chars → 400 "search must be 500 characters or fewer." (manual cap, distinct wording)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const tooLong = 'a'.repeat(501);
        const res = await readError(
            await request.get(`${MISSIONS}?search=${tooLong}`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(res.status, `>500-char search -> 400; body len=${res.text.length}`).toBe(400);
        expect(res.body.error).toBe('Bad Request');
        expect(res.body.message).toBe('search must be 500 characters or fewer.');

        // Exactly 500 chars is at the boundary and accepted (no row matches -> 200 []).
        const atBoundary = await request.get(`${MISSIONS}?search=${'b'.repeat(500)}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(atBoundary.status(), '500-char search is at-or-under the cap -> 200').toBe(200);
    });

    // ─── MISSIONS list — silent CLAMP (the divergence from the Ideas DTO) ──────
    test('Missions ?limit / ?offset out-of-range are SILENTLY CLAMPED to 200 (NOT rejected) — the manual-parse divergence', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // Min/Max are enforced by Math.min(101, Math.max(1, n)) / Math.max(0, n), which
        // CLAMP rather than throw — so every out-of-range numeric value is a clean 200.
        for (const q of ['?limit=0', '?limit=9999', '?offset=-5', '?limit=-10&offset=-99']) {
            const res = await request.get(`${MISSIONS}${q}`, {
                headers: authedHeaders(owner.access_token),
            });
            expect(res.status(), `${q} is clamped, not rejected`).toBe(200);
            expect(Array.isArray(await res.json()), `${q} still returns an array`).toBe(true);
        }
    });

    // ─── MISSIONS list — unknown query params are tolerated ───────────────────
    test('Missions list ignores unknown query params (named @Query reads, no whitelist rejection)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const res = await request.get(`${MISSIONS}?bogusparam=1&another=x&limit=5`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), 'extra query params do not red the request').toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });

    // ─── MISSIONS list — filters actually filter ──────────────────────────────
    test('Missions ?search returns the exact matching subset (case-insensitive) and a no-match search → 200 []', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const s = suffixFor(test.info().title);
        const alpha = await createMission(request, owner, `AlphaTok${s}`);
        const beta = await createMission(request, owner, `BetaTok${s}`);

        // Search for the alpha title (lowercased) — case-insensitive match returns ONLY it.
        const hit = await listMissions(request, owner.access_token, `?search=alphatok${s}`);
        const hitIds = hit.map((m) => m.id);
        expect(hitIds, 'case-insensitive search matches the alpha mission').toContain(alpha.id);
        expect(hitIds, 'search does NOT return the non-matching beta mission').not.toContain(
            beta.id,
        );

        // A guaranteed no-match token returns an empty array (200), not a 404.
        const miss = await listMissions(request, owner.access_token, `?search=zzznomatch${s}`);
        expect(miss, 'a no-match search is an empty list').toHaveLength(0);
    });

    test('Missions ?status partitions the owner set: completed vs active are disjoint and exhaustive', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const s = suffixFor(test.info().title);
        const keepActive = await createMission(request, owner, `KeepActive${s}`);
        const toComplete = await createMission(request, owner, `ToComplete${s}`);

        // Drive one Mission to COMPLETED via the lifecycle endpoint.
        const complete = await request.post(`${MISSIONS}/${toComplete.id}/complete`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(complete.status(), `complete body=${await complete.text().catch(() => '')}`).toBe(
            200,
        );

        const active = await listMissions(request, owner.access_token, '?status=active');
        const completed = await listMissions(request, owner.access_token, '?status=completed');
        const activeIds = active.map((m) => m.id);
        const completedIds = completed.map((m) => m.id);

        expect(
            active.every((m) => m.status === 'active'),
            'active filter yields only active',
        ).toBe(true);
        expect(
            completed.every((m) => m.status === 'completed'),
            'completed filter yields only completed',
        ).toBe(true);
        expect(activeIds, 'the un-completed mission is in the active partition').toContain(
            keepActive.id,
        );
        expect(completedIds, 'the completed mission is in the completed partition').toContain(
            toComplete.id,
        );
        // Disjoint: a completed mission never appears in the active partition.
        expect(activeIds, 'completed mission is NOT in the active partition').not.toContain(
            toComplete.id,
        );
    });

    // ─── MISSIONS list — pagination is set-correct ────────────────────────────
    test('Missions ?limit/?offset paginate into DISJOINT pages whose union is the full id set, with exact page sizes', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const s = suffixFor(test.info().title);
        // A FRESH owner has exactly the missions we create — so the full list IS our set.
        const created: string[] = [];
        for (let i = 0; i < 5; i++) {
            created.push((await createMission(request, owner, `Page${i}_${s}`)).id);
        }

        const full = await listMissions(request, owner.access_token);
        const fullIds = full.map((m) => m.id);
        expect(fullIds.length, 'fresh owner sees exactly the 5 created missions').toBe(5);
        for (const id of created) {
            expect(fullIds, 'every created mission is in the full list').toContain(id);
        }

        // Page the set: limit=2 over offsets 0,2,4 → sizes [2,2,1].
        const page1 = (await listMissions(request, owner.access_token, '?limit=2&offset=0')).map(
            (m) => m.id,
        );
        const page2 = (await listMissions(request, owner.access_token, '?limit=2&offset=2')).map(
            (m) => m.id,
        );
        const page3 = (await listMissions(request, owner.access_token, '?limit=2&offset=4')).map(
            (m) => m.id,
        );
        expect(page1.length, 'first page is full (limit=2)').toBe(2);
        expect(page2.length, 'second page is full (limit=2)').toBe(2);
        expect(page3.length, 'third page is the remainder (1)').toBe(1);

        // Pages are pairwise DISJOINT and their union equals the full set (ordering
        // direction is intentionally NOT asserted — createdAt is second-granular).
        const union = new Set([...page1, ...page2, ...page3]);
        expect(union.size, 'paged rows are pairwise disjoint (no overlap across pages)').toBe(5);
        expect([...union].sort(), 'the union of all pages equals the full id set').toEqual(
            [...fullIds].sort(),
        );
    });

    // ─── MISSIONS getOne — uuid pipe + opaque 404 ─────────────────────────────
    test('Missions getOne: non-uuid id → 400 ParseUUIDPipe; well-formed-unknown id → 404 "Mission not found" (no existence leak)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        const nonUuid = await readError(
            await request.get(`${MISSIONS}/not-a-uuid`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(nonUuid.status, `non-uuid getOne -> 400; body=${nonUuid.text}`).toBe(400);
        expect(nonUuid.body.error).toBe('Bad Request');
        expect(nonUuid.body.message).toBe('Validation failed (uuid is expected)');

        const unknown = await readError(
            await request.get(`${MISSIONS}/${UNKNOWN_UUID}`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(unknown.status, `unknown-uuid getOne -> 404; body=${unknown.text}`).toBe(404);
        expect(unknown.body.error).toBe('Not Found');
        expect(unknown.body.message).toBe('Mission not found');
    });

    // ─── IDEAS (work-proposals) list — DTO/class-validator contract ───────────
    test('Ideas ?statuses unknown enum → 400 with the class-validator ARRAY message naming the full allowlist', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const res = await readError(
            await request.get(`${IDEAS}?statuses=bogus`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(res.status, `unknown statuses enum -> 400; body=${res.text}`).toBe(400);
        expect(res.body.error).toBe('Bad Request');
        // The Ideas list uses a DTO -> a class-validator ARRAY message (NOT a single string).
        const msgs = messageArray(res.body);
        expect(msgs.length, 'DTO rejection is an array message').toBeGreaterThan(0);
        expect(
            msgs.some((m) =>
                m.includes(
                    'each value in statuses must be one of the following values: pending, dismissed, accepted, queued, building, failed',
                ),
            ),
            `the enum allowlist is named; got ${JSON.stringify(msgs)}`,
        ).toBe(true);

        // The default (no ?statuses) is the PENDING-only view — a fresh owner has none -> [].
        const def = await request.get(IDEAS, { headers: authedHeaders(owner.access_token) });
        expect(def.status(), 'default ideas list is the pending view').toBe(200);
        expect((await def.json()) as unknown[], 'fresh owner has no pending ideas').toHaveLength(0);
    });

    test('Ideas ?limit / ?offset bounds are HARD-REJECTED by the DTO (Min/Max), NOT clamped like Missions — the mechanism divergence', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // The Ideas DTO declares @Min(1)@Max(101) on limit and @Min(0) on offset, so the
        // SAME out-of-range values that Missions silently CLAMP are here 400s — the load-
        // bearing contrast between manual-parse and DTO validation.
        const overMax = await readError(
            await request.get(`${IDEAS}?limit=9999`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(overMax.status, `ideas limit=9999 -> 400 (NOT clamped); body=${overMax.text}`).toBe(
            400,
        );
        expect(messageArray(overMax.body)).toContain('limit must not be greater than 101');

        const underMin = await readError(
            await request.get(`${IDEAS}?limit=0`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(underMin.status, 'ideas limit=0 -> 400 (NOT clamped)').toBe(400);
        expect(messageArray(underMin.body)).toContain('limit must not be less than 1');

        const negOffset = await readError(
            await request.get(`${IDEAS}?offset=-1`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(negOffset.status, 'ideas offset=-1 -> 400 (NOT clamped)').toBe(400);
        expect(messageArray(negOffset.body)).toContain('offset must not be less than 0');

        // And the search MaxLength uses the class-validator wording (distinct from Missions).
        const longSearch = await readError(
            await request.get(`${IDEAS}?search=${'c'.repeat(501)}`, {
                headers: authedHeaders(owner.access_token),
            }),
        );
        expect(longSearch.status, 'ideas >500-char search -> 400').toBe(400);
        expect(messageArray(longSearch.body)).toContain(
            'search must be shorter than or equal to 500 characters',
        );
    });

    // ─── cross-root sanity: a created Idea round-trips through the list ────────
    test('A user-created Idea round-trips: it is UUID-identified, defaults to PENDING, and is listable under the default and explicit pending views', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const s = suffixFor(test.info().title);
        // Create a USER_MANUAL Idea (description >= 10 chars; missionId is NOT a create field).
        const createRes = await request.post(IDEAS, {
            headers: authedHeaders(owner.access_token),
            data: {
                title: `Idea ${s}`,
                description: `A standalone idea ${s} created to exercise the list round-trip`,
            },
        });
        expect(
            createRes.status(),
            `create idea body=${await createRes.text().catch(() => '')}`,
        ).toBe(201);
        const idea = (await createRes.json()) as {
            id: string;
            status: string;
            missionId: string | null;
        };
        expect(idea.id, 'idea id is a uuid').toMatch(UUID_RE);
        expect(idea.status, 'a fresh user-manual idea defaults to pending').toBe('pending');
        expect(idea.missionId, 'a standalone idea has no spawning mission').toBeNull();

        // It is listable under BOTH the default (pending-only) view and the explicit
        // ?statuses=pending view — and NOT under a disjoint status filter.
        const def = (await (
            await request.get(IDEAS, { headers: authedHeaders(owner.access_token) })
        ).json()) as Array<{ id: string }>;
        expect(
            def.map((p) => p.id),
            'the new pending idea shows in the default list',
        ).toContain(idea.id);

        const explicit = (await (
            await request.get(`${IDEAS}?statuses=pending`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as Array<{ id: string }>;
        expect(
            explicit.map((p) => p.id),
            'the new pending idea shows under the explicit pending filter',
        ).toContain(idea.id);

        const accepted = (await (
            await request.get(`${IDEAS}?statuses=accepted`, {
                headers: authedHeaders(owner.access_token),
            })
        ).json()) as Array<{ id: string }>;
        expect(
            accepted.map((p) => p.id),
            'the pending idea is NOT under the accepted partition',
        ).not.toContain(idea.id);
    });
});
