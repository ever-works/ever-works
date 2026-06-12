import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Mission ↔ Ideas — DEEP isolation, scope-filter existence-leak discipline,
 * lifecycle status-transitions & validation bounds. Every status code,
 * response shape and error string asserted below was probed against the LIVE
 * API at http://127.0.0.1:3100 (sqlite in-memory, keyless, the CI driver)
 * BEFORE being written.
 *
 * NON-DUPLICATION — read alongside flow-mission-ideas-isolation.spec.ts (the
 * sibling). The sibling owns: the `?missionId` exact filter for an OWNER's
 * standalone Ideas (unknown-OWN-uuid → 200 []), the idea cross-user 404
 * lattice, the Mission list updatedAt-DESC ordering + stranger-404 accessor
 * matrix, the standalone-Idea outstanding-count proof, the Idea generatedAt
 * order + dismiss/statuses partition, and the UI render isolation. It also
 * pins the OWNER-side `?missionId=not-a-uuid → 400` query guard.
 *
 * THIS file is deliberately disjoint and goes DEEPER on:
 *   - CROSS-USER scope-filter existence-leak: B filtering Ideas by A's Mission
 *     uuid → 200 [] (a silent where-clause, NOT a 404 — the filter never
 *     confirms the Mission exists). Distinct from the sibling, which only
 *     probed an OWNER filtering by an unknown-but-own uuid.
 *   - PER-MISSION cross-leak between two of the SAME user's Missions (each
 *     scope is disjoint, both empty here because linkage isn't user-settable).
 *   - The TWO distinct Idea-create rejection LAYERS: body-whitelist
 *     (`missionId should not exist`, 400) vs the sibling's query @IsUUID
 *     (`must be a UUID`, 400) — different guards, different messages.
 *   - Mission DELETE lifecycle (own 200 → GET 404 → idempotent re-DELETE 404)
 *     and the cross-user DELETE 404 that leaves A's Mission intact.
 *   - Idea build/retry STATE MACHINE on the keyless stack: build → 400
 *     "Work agent is disabled." YET transitions the Idea to `queued`
 *     (leaves the default PENDING list, re-found under ?statuses=queued);
 *     retry on the now-queued Idea → 400 whose message embeds the live status.
 *   - cap-hit diagnostic string + its cross-user unreachability (B can never
 *     even reach A's Mission to observe cap-hit — 404 first).
 *   - Idea description bound matrix (len 10 inclusive 201; <10 & >5000 → 400).
 *   - Org-context INERTNESS: a Mission created under an `x-organization-id`
 *     header still lists in the plain owner-scoped /api/me/missions and the
 *     DTO exposes NO tenantId/organizationId — proving /api/me/missions &
 *     /api/me/work-proposals are strictly USER-scoped, not org-scoped (so
 *     there is no org/tenant stamping to leak across orgs on these surfaces).
 *   - Auth wall (anonymous → 401) + fresh-user empty-state ([], []).
 *
 * PROBED CONTRACTS (verified live, 2026-06-11):
 *
 *   POST /api/auth/register { username(>=3), email, password }
 *     → 200/201 { access_token, user:{ id, email, username } }
 *
 *   Missions (`/api/me/missions`, owner-scoped only — NO org/tenant column):
 *     POST { description(1..10000, REQUIRED), type:'one-shot'|'scheduled'
 *            (REQUIRED), title?(derived from description when omitted),
 *            outstandingIdeasCap? }
 *       → 201 MissionDto { id, title, description, type, status:'active',
 *              schedule, autoBuildWorks, outstandingIdeasCap, sourceMissionId,
 *              createdAt, updatedAt }   (NO tenantId/organizationId field)
 *       · empty body → 400 (description + type required)
 *     GET    /            → 200 MissionDto[] (mine only) | anon 401
 *     GET    /:id         → 200 own | 404 stranger/unknown/deleted
 *     POST   /:id/run-now → 200 { status, missionId, message? };
 *                           cap=0 ⇒ { status:'cap-hit',
 *                                     message:'outstanding=0 >= cap=0' }
 *     DELETE /:id         → 200 own (then GET → 404; re-DELETE → 404)
 *                           | 404 stranger
 *     x-organization-id header on POST is INERT (response identical, row still
 *     listed under the plain owner GET).
 *
 *   Ideas (`/api/me/work-proposals`, owner-scoped only):
 *     POST { description(10..5000, REQUIRED), title? }  ← `missionId` REJECTED
 *       → 201 WorkProposalResponseDto { id, title, description, source:
 *              'user-manual', status:'pending', missionId:null,
 *              acceptedWorkId:null, failureMessage:null, failureKind:null,
 *              generatedAt, … }
 *       · { ..., missionId } → 400 ["property missionId should not exist"]
 *       · description len 9  → 400 ["…longer than or equal to 10 characters"]
 *       · description len 10 → 201 (boundary inclusive)
 *       · description len 5001 → 400
 *     GET    /?statuses=…&missionId=…  (default statuses=[pending])
 *       → 200 [] (generatedAt DESC) | anon 401
 *       · ?missionId=<A's-Mission-uuid> under B → 200 [] (silent filter)
 *     POST   /:id/build  → 400 "Work agent is disabled." (keyless) AND
 *                          transitions the Idea pending→queued
 *     POST   /:id/retry  → 400 "Retry is only valid for FAILED Ideas.
 *                          Current status: \"queued\"."
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A valid v4 UUID that no row will ever own (unknown-id 404 / empty-filter probes). */
function randomUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/** Per-test unique suffix derived from a monotonic counter + the test title
 * (NOT a module-scope clock — the house rules forbid that). */
let SEQ = 0;
function stamp(label: string): string {
    SEQ += 1;
    return `${label}-${SEQ}-${Math.random().toString(36).slice(2, 7)}`;
}

interface IdeaShape {
    id: string;
    status: string;
    missionId: string | null;
    generatedAt: string;
}

async function createIdea(
    request: APIRequestContext,
    headers: Record<string, string>,
    description: string,
): Promise<IdeaShape> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers,
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    const idea = await res.json();
    expect(idea.id).toMatch(UUID_RE);
    return {
        id: idea.id,
        status: idea.status,
        missionId: idea.missionId,
        generatedAt: idea.generatedAt,
    };
}

async function createMission(
    request: APIRequestContext,
    headers: Record<string, string>,
    overrides: Record<string, unknown> = {},
): Promise<{ id: string; title: string; raw: Record<string, unknown> }> {
    const data = {
        title: `Mission ${stamp('m')}`,
        description: 'A one-shot mission used to probe deep scoping & isolation invariants',
        type: 'one-shot',
        outstandingIdeasCap: 5,
        ...overrides,
    };
    const res = await request.post(`${API_BASE}/api/me/missions`, { headers, data });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = await res.json();
    expect(m.id).toMatch(UUID_RE);
    return { id: m.id, title: m.title, raw: m };
}

test.describe('Mission ↔ Ideas — deep cross-user / cross-mission isolation & lifecycle', () => {
    test("cross-user scope filter is a SILENT where-clause: B filtering Ideas by A's Mission uuid → 200 [], never a 404 existence leak", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aHeaders = authedHeaders(a.access_token);
        const bHeaders = authedHeaders(b.access_token);

        // A owns a Mission and three standalone Ideas.
        const missionA = await createMission(request, aHeaders, { title: `Aown ${stamp('A')}` });
        for (let i = 0; i < 3; i++) {
            const idea = await createIdea(
                request,
                aHeaders,
                `A standalone idea ${i} ${stamp('ai')} for the cross-user filter probe`,
            );
            expect(idea.missionId).toBeNull();
        }

        // B filtering Ideas by A's REAL Mission uuid → 200 [] (NOT 404). The
        // filter is owner-scoped where-clause; it must NOT confirm the Mission
        // exists, and must NOT surface any of A's Ideas.
        const bFiltered = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${missionA.id}`,
            { headers: bHeaders },
        );
        expect(bFiltered.status()).toBe(200);
        expect(await bFiltered.json()).toEqual([]);

        // Same status for a totally unknown uuid — the two are indistinguishable
        // to B (existence-leak discipline holds at the filter layer).
        const bUnknown = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${randomUuid()}`,
            { headers: bHeaders },
        );
        expect(bUnknown.status()).toBe(200);
        expect(await bUnknown.json()).toEqual([]);

        // B's own UNFILTERED Idea list also never contains A's Ideas.
        const bList = (await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers: bHeaders })
        ).json()) as Array<{ id: string }>;
        expect(bList).toEqual([]);
    });

    test("per-Mission scopes are disjoint: the same user's two Missions each return [] and never leak the other's id", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const missionX = await createMission(request, headers, { title: `X ${stamp('X')}` });
        const missionY = await createMission(request, headers, { title: `Y ${stamp('Y')}` });
        expect(missionX.id).not.toBe(missionY.id);

        // Two standalone Ideas (born missionId:null ⇒ in NEITHER Mission scope).
        const ideaIds = [
            (
                await createIdea(
                    request,
                    headers,
                    `Disjoint idea one ${stamp('d1')} standalone proof`,
                )
            ).id,
            (
                await createIdea(
                    request,
                    headers,
                    `Disjoint idea two ${stamp('d2')} standalone proof`,
                )
            ).id,
        ];

        // Each Mission's scope is independently empty — and crucially neither
        // contains the OTHER Mission's id (proves per-Mission, not per-user).
        for (const mission of [missionX, missionY]) {
            const res = await request.get(
                `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
                { headers },
            );
            expect(res.status()).toBe(200);
            expect(await res.json()).toEqual([]);
        }

        // The standalone Ideas live in the unscoped list but in no Mission scope.
        const unscoped = (await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers })
        ).json()) as Array<{ id: string }>;
        const unscopedIds = unscoped.map((p) => p.id);
        for (const id of ideaIds) expect(unscopedIds).toContain(id);
    });

    test('Idea-create has TWO distinct rejection layers: body-whitelist (missionId should not exist) vs query @IsUUID — different guards', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const mission = await createMission(request, headers);

        // Body-whitelist: missionId is NOT an accepted create field — the
        // forbidNonWhitelisted ValidationPipe rejects it (NOT a UUID-format
        // complaint). Ideas can never be born linked to a Mission via the body.
        const linked = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: {
                description: 'An idea I try to attach to a Mission via the body missionId field',
                missionId: mission.id,
            },
        });
        expect(linked.status()).toBe(400);
        expect(String((await linked.json()).message)).toMatch(
            /property missionId should not exist/i,
        );

        // Query layer: a malformed missionId on the LIST endpoint is a different
        // guard with a different message (@IsUUID on the query DTO).
        const badQuery = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=not-a-uuid`,
            { headers },
        );
        expect(badQuery.status()).toBe(400);
        expect(String((await badQuery.json()).message)).toMatch(/missionId must be a UUID/i);
    });

    test('Idea description bound matrix: len 9 → 400, len 10 → 201 (inclusive), len 5001 → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const tooShort = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'a'.repeat(9) },
        });
        expect(tooShort.status()).toBe(400);
        expect(String((await tooShort.json()).message)).toMatch(
            /longer than or equal to 10 characters/i,
        );

        // Exactly the lower bound — inclusive, so this succeeds.
        const exactlyTen = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'a'.repeat(10) },
        });
        expect(exactlyTen.status(), `len10 body=${await exactlyTen.text()}`).toBe(201);
        expect((await exactlyTen.json()).status).toBe('pending');

        const tooLong = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'a'.repeat(5001) },
        });
        expect(tooLong.status()).toBe(400);
    });

    test('Idea build/retry STATE MACHINE on the keyless stack: build → 400 yet flips pending→queued; the queued Idea leaves PENDING and is re-found under ?statuses=queued; retry → 400 embedding the live status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const idea = await createIdea(
            request,
            headers,
            `State-machine idea ${stamp('sm')} — build flips it to queued on the keyless stack`,
        );
        expect(idea.status).toBe('pending');

        // build: the keyless stack has no Work agent ⇒ 400 with an exact message
        // — but the call still transitions the Idea to `queued`.
        const build = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers,
        });
        expect(build.status()).toBe(400);
        expect(String((await build.json()).message)).toMatch(/Work agent is disabled\./i);

        // It is now `queued`, still owned, still standalone.
        const afterBuild = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers,
        });
        expect(afterBuild.status()).toBe(200);
        const afterBuildBody = await afterBuild.json();
        expect(afterBuildBody.status).toBe('queued');
        expect(afterBuildBody.missionId).toBeNull();

        // It LEFT the default (PENDING) list…
        const pendingList = (await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers })
        ).json()) as Array<{ id: string }>;
        expect(pendingList.some((p) => p.id === idea.id)).toBe(false);

        // …and is re-found under the queued partition.
        const queuedList = (await (
            await request.get(`${API_BASE}/api/me/work-proposals?statuses=queued`, { headers })
        ).json()) as Array<{ id: string }>;
        expect(queuedList.some((p) => p.id === idea.id)).toBe(true);

        // retry only fires on FAILED Ideas; on a queued one it's a 400 whose
        // message echoes the live status — proving the guard read current state.
        const retry = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/retry`, {
            headers,
        });
        expect(retry.status()).toBe(400);
        expect(String((await retry.json()).message)).toMatch(
            /Retry is only valid for FAILED Ideas\. Current status: "queued"/i,
        );
    });

    test('Mission DELETE lifecycle: own DELETE → 200, then GET → 404, re-DELETE is idempotently 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const mission = await createMission(request, headers, { title: `DelMe ${stamp('del')}` });

        // It is visible before deletion.
        const before = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, { headers });
        expect(before.status()).toBe(200);

        const del = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, { headers });
        expect(del.status()).toBe(200);

        // Gone: GET → 404, and a second DELETE is also 404 (no resurrection /
        // no 500 on the missing row).
        const after = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, { headers });
        expect(after.status()).toBe(404);
        const reDelete = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
        });
        expect(reDelete.status()).toBe(404);

        // It is no longer in the owner's list either.
        const list = (await (
            await request.get(`${API_BASE}/api/me/missions`, { headers })
        ).json()) as Array<{ id: string }>;
        expect(list.some((m) => m.id === mission.id)).toBe(false);
    });

    test("cross-user DELETE leaves A's Mission intact: B DELETE on A's Mission → 404, A still reads it; B can never observe its cap-hit", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aHeaders = authedHeaders(a.access_token);
        const bHeaders = authedHeaders(b.access_token);

        // A owns a cap=0 Mission (so A's own run-now is a deterministic cap-hit).
        const mission = await createMission(request, aHeaders, {
            title: `Guarded ${stamp('grd')}`,
            outstandingIdeasCap: 0,
        });

        // B's hostile DELETE → 404 (no existence leak, no actual delete).
        const bDelete = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: bHeaders,
        });
        expect(bDelete.status()).toBe(404);

        // B's run-now → 404 — B never even reaches the cap logic; the resource
        // gate fires FIRST, so B can never observe the cap-hit diagnostic.
        const bRun = await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`, {
            headers: bHeaders,
        });
        expect(bRun.status()).toBe(404);

        // A still owns it, and A's run-now yields the exact cap-hit diagnostic.
        const aGet = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: aHeaders,
        });
        expect(aGet.status()).toBe(200);

        const aRun = await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`, {
            headers: aHeaders,
        });
        expect(aRun.status()).toBe(200);
        const aRunBody = await aRun.json();
        expect(aRunBody.missionId).toBe(mission.id);
        expect(aRunBody.status).toBe('cap-hit');
        expect(String(aRunBody.message)).toMatch(/outstanding=0 >= cap=0/i);
    });

    test('combined cross-user idea inertness: every owner-scoped write on a stranger Idea 404s and the Idea survives PENDING', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerHeaders = authedHeaders(owner.access_token);
        const strangerHeaders = authedHeaders(stranger.access_token);

        const idea = await createIdea(
            request,
            ownerHeaders,
            `Owner idea ${stamp('oi')} — inert to every stranger write, survives pending`,
        );

        // Each stranger write is a 404 (resource gate, not a 403 confirmation).
        const writes: Array<[string, () => Promise<number>]> = [
            [
                'build',
                async () =>
                    (
                        await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
            [
                'retry',
                async () =>
                    (
                        await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/retry`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
            [
                'dismiss',
                async () =>
                    (
                        await request.patch(
                            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
                            {
                                headers: strangerHeaders,
                            },
                        )
                    ).status(),
            ],
            [
                'budget',
                async () =>
                    (
                        await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
        ];
        for (const [label, run] of writes) {
            expect(await run(), `stranger ${label}`).toBe(404);
        }

        // The Idea is untouched — still owned, still PENDING (no state machine
        // advanced by the stranger's failed build).
        const survived = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: ownerHeaders,
        });
        expect(survived.status()).toBe(200);
        expect((await survived.json()).status).toBe('pending');
    });

    test('org-context is INERT on /api/me/missions: the x-organization-id header neither changes the DTO nor adds a tenant/org column, and the row lists under the plain owner GET', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // Create an Organization (a real tenant exists for this user)…
        const orgRes = await request.post(`${API_BASE}/api/organizations`, {
            headers,
            data: { name: `IsoOrg ${stamp('org')}` },
        });
        expect(orgRes.status(), `org create body=${await orgRes.text()}`).toBe(201);
        const org = await orgRes.json();
        expect(org.id).toMatch(UUID_RE);
        expect(org.tenantId).toMatch(UUID_RE);

        // …then create a Mission WITH the org header set. /api/me/missions is
        // strictly user-scoped: the header is inert, the DTO carries no
        // tenantId/organizationId, and the row is the user's regardless of org.
        const orgScoped = await createMission(
            request,
            { ...headers, 'x-organization-id': org.id },
            { title: `OrgHeader ${stamp('oh')}` },
        );
        expect(orgScoped.raw).not.toHaveProperty('tenantId');
        expect(orgScoped.raw).not.toHaveProperty('organizationId');
        expect(orgScoped.raw).not.toHaveProperty('orgId');

        // It lists under the PLAIN owner GET (no org header) — proving the list
        // is user-scoped, not org-partitioned.
        const plainList = (await (
            await request.get(`${API_BASE}/api/me/missions`, { headers })
        ).json()) as Array<{ id: string }>;
        expect(plainList.some((m) => m.id === orgScoped.id)).toBe(true);
    });

    test('Mission create requires description + type: an empty body is a 400 enumerating both, a description-only body derives the title', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const empty = await request.post(`${API_BASE}/api/me/missions`, { headers, data: {} });
        expect(empty.status()).toBe(400);
        const emptyMsg = JSON.stringify((await empty.json()).message);
        expect(emptyMsg).toMatch(/description/i);
        expect(emptyMsg).toMatch(/type must be one of the following values/i);

        // description-only (no title) → 201, title DERIVED from the description.
        const derivedDesc = `Derive my title ${stamp('dt')}`;
        const derived = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: { description: derivedDesc, type: 'one-shot' },
        });
        expect(derived.status(), `derive body=${await derived.text()}`).toBe(201);
        const derivedBody = await derived.json();
        expect(derivedBody.id).toMatch(UUID_RE);
        expect(derivedBody.title).toBe(derivedDesc);
    });

    test('auth wall: anonymous Mission AND Idea list both 401 (raw fetch, no bearer)', async ({
        request,
    }) => {
        // Raw requests with NO Authorization header — both owner-scoped lists
        // reject anonymous callers identically.
        const anonMissions = await request.get(`${API_BASE}/api/me/missions`);
        expect(anonMissions.status()).toBe(401);

        const anonIdeas = await request.get(`${API_BASE}/api/me/work-proposals`);
        expect(anonIdeas.status()).toBe(401);
    });

    test('fresh-user empty-state: a brand-new user owns zero Missions and zero Ideas (both 200 [])', async ({
        request,
    }) => {
        const fresh = await registerUserViaAPI(request);
        const headers = authedHeaders(fresh.access_token);

        const missions = await request.get(`${API_BASE}/api/me/missions`, { headers });
        expect(missions.status()).toBe(200);
        expect(await missions.json()).toEqual([]);

        const ideas = await request.get(`${API_BASE}/api/me/work-proposals`, { headers });
        expect(ideas.status()).toBe(200);
        expect(await ideas.json()).toEqual([]);
    });
});
