import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Mission ↔ Ideas isolation, scoping, ordering & counting — six complex,
 * multi-step, cross-feature flows over the REAL Missions + Ideas
 * (work-proposals) surface. Every request/response shape, status code,
 * ordering rule, and error string asserted below was probed against the
 * LIVE API at http://127.0.0.1:3100 (sqlite in-memory — the CI driver)
 * BEFORE being written.
 *
 * This file is deliberately disjoint from the existing mission/idea specs
 * (missions.spec.ts, missions-ideas-hierarchy.spec.ts, ideas-extension,
 * mission-idea-task-flow, flow-mission-idea-build, flow-mission-crud-schedule,
 * flow-mission-clone, flow-mission-tick-cap). Those pin CRUD/lifecycle/clone
 * and the cap math. THIS file focuses on the *scoping & isolation lattice*:
 *   - Ideas filtered by missionId (exact, no-leak, unknown-uuid → 200 []).
 *   - Idea cross-user isolation (read/budget/dismiss/build/retry all 404).
 *   - Mission list is strictly owner-scoped + ordered updatedAt DESC.
 *   - Idea outstanding-count vs Mission (standalone Ideas NEVER count).
 *   - Idea list ordering (generatedAt DESC) + status-partitioned filtering.
 *   - Cross-user UI isolation: a stranger's Mission never renders on /missions.
 *
 * PROBED CONTRACTS (verified live):
 *
 *   POST /api/auth/register { username(>=3), email, password }
 *     → 201 { access_token, user:{ id, email, username } }
 *
 *   Missions (`/api/me/missions`, owner-scoped, list order updatedAt DESC):
 *     POST   { title, description, type:'one-shot'|'scheduled',
 *              schedule?, outstandingIdeasCap?, autoBuildWorks? }
 *       → 201 MissionDto { id, title, status:'active', type, schedule,
 *                          outstandingIdeasCap, sourceMissionId:null,
 *                          createdAt, updatedAt }
 *     GET    /            → 200 MissionDto[]  (mine only; updatedAt DESC)
 *     GET    /:id         → 200 | 404 (stranger / unknown — no existence leak)
 *     PATCH  /:id         → 200 (bumps updatedAt)
 *     POST   /:id/run-now → 200 { status, missionId, message? }
 *                           cap=0 ⇒ { status:'cap-hit',
 *                                     message:'outstanding=0 >= cap=0' }
 *     GET/PATCH/DELETE/clone/run-now/budget on a stranger's Mission → 404
 *
 *   Ideas (`/api/me/work-proposals`, owner-scoped, list order generatedAt DESC):
 *     POST   { description(10..5000), title? }  ← `missionId` NOT accepted
 *       → 201 WorkProposalResponseDto { id, title, description, source:
 *              'user-manual', status:'pending', missionId:null,
 *              acceptedWorkId:null, failureMessage:null, failureKind:null,
 *              generatedAt }
 *     GET    /?statuses=…&missionId=…  (default statuses=[pending])
 *       → 200 WorkProposalResponseDto[]  (generatedAt DESC)
 *       · ?missionId=<valid-uuid>  → exact filter; standalone (null) Ideas
 *         never leak in; an unknown-but-valid uuid → 200 []
 *       · ?missionId=not-a-uuid    → 400 "missionId must be a UUID"
 *       · ?statuses=bogus          → 400 (enum guard)
 *     GET    /:id        → 200 | 404 (stranger / unknown)
 *     GET    /:id/budget → 200 OwnerBudgetSummary | 404 (stranger)
 *     PATCH  /:id/dismiss→ 204 (own, pending) | 404 (stranger / unknown)
 *     POST   /:id/build  → 200|400 (env-adaptive) own · 404 stranger
 *     POST   /:id/retry  → 400 own non-FAILED · 404 stranger
 *
 *   KEY ISOLATION INVARIANT (verified): user-manual Ideas are born with
 *   missionId=null. Mission `outstanding` is counted ONLY over Ideas whose
 *   missionId equals that Mission (status PENDING/QUEUED/BUILDING). So a
 *   user's standalone Ideas — however many — NEVER inflate any Mission's
 *   outstanding count. We prove this deterministically through run-now's
 *   cap-hit diagnostics (no AI/Trigger.dev needed).
 *
 * Cross-spec isolation: every API mutation runs on a FRESH
 * registerUserViaAPI() user (a per-user fake key could shadow the env key
 * and break sibling chat specs). The seeded user (storageState) is used
 * ONLY for the UI-driven assertion at the bottom.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A valid v4 UUID that no row will ever own (for unknown-id 404/empty probes). */
function randomUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted to {email,password} — never pass the seeded
    // object whole (its `name` field would trigger a 400).
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token;
}

async function createIdea(
    request: APIRequestContext,
    headers: Record<string, string>,
    description: string,
    title?: string,
): Promise<{ id: string; status: string; missionId: string | null; generatedAt: string }> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers,
        data: title ? { description, title } : { description },
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
): Promise<{ id: string; title: string; updatedAt: string; outstandingIdeasCap: number | null }> {
    const data = {
        title: `Mission ${stamp()}`,
        description: 'A one-shot mission used to probe scoping and isolation invariants',
        type: 'one-shot',
        outstandingIdeasCap: 5,
        ...overrides,
    };
    const res = await request.post(`${API_BASE}/api/me/missions`, { headers, data });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = await res.json();
    expect(m.id).toMatch(UUID_RE);
    return {
        id: m.id,
        title: m.title,
        updatedAt: m.updatedAt,
        outstandingIdeasCap: m.outstandingIdeasCap,
    };
}

test.describe('Mission ↔ Ideas — scoping, isolation, ordering & counting', () => {
    test('Ideas ?missionId filter is exact: standalone Ideas never leak, unknown uuid → 200 [], malformed → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // Two Missions so we can prove the filter is per-Mission, not "any of
        // mine". Both freshly created ⇒ both have zero linked Ideas.
        const missionA = await createMission(request, headers, { title: `Filter-A ${s}` });
        const missionB = await createMission(request, headers, { title: `Filter-B ${s}` });

        // Three standalone Ideas (user-manual ⇒ born missionId:null).
        const ideaIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const idea = await createIdea(
                request,
                headers,
                `Standalone idea ${i} for ${s} — exercises the exact missionId scope filter`,
            );
            expect(idea.missionId).toBeNull();
            ideaIds.push(idea.id);
        }

        // Default list (PENDING, no filter) contains all three — shared DB ⇒
        // assert toContain, never an exact count.
        const allBody = await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers })
        ).json();
        expect(Array.isArray(allBody)).toBe(true);
        const allIds = (allBody as Array<{ id: string }>).map((p) => p.id);
        for (const id of ideaIds) expect(allIds).toContain(id);

        // ?missionId=A — exact filter; standalone Ideas DON'T leak into a
        // Mission scope, and A's empty scope returns [].
        for (const mission of [missionA, missionB]) {
            const res = await request.get(
                `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
                { headers },
            );
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(Array.isArray(body)).toBe(true);
            const ids = (body as Array<{ id: string }>).map((p) => p.id);
            for (const id of ideaIds) expect(ids).not.toContain(id);
        }

        // A valid-but-unknown missionId returns 200 [] (NOT 404 — the filter
        // is a where-clause, not a resource lookup).
        const unknown = randomUuid();
        const unknownRes = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${unknown}`,
            { headers },
        );
        expect(unknownRes.status()).toBe(200);
        expect(await unknownRes.json()).toEqual([]);

        // A malformed missionId is rejected by the @IsUUID() query guard.
        const malformed = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=not-a-uuid`,
            { headers },
        );
        expect(malformed.status()).toBe(400);
        expect(String((await malformed.json()).message)).toMatch(/missionId must be a UUID/i);
    });

    test('Idea cross-user isolation lattice: read / budget / dismiss / build / retry on a stranger Idea all 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerHeaders = authedHeaders(owner.access_token);
        const strangerHeaders = authedHeaders(stranger.access_token);
        const s = stamp();

        // Owner creates an Idea.
        const idea = await createIdea(
            request,
            ownerHeaders,
            `Owner-only idea ${s} — must be invisible & inert to every other user`,
        );

        // The stranger's own list never contains it.
        const strangerList = await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers: strangerHeaders })
        ).json();
        expect((strangerList as Array<{ id: string }>).some((p) => p.id === idea.id)).toBe(false);

        // Every owner-scoped read/write on the stranger's bearer → 404 (no
        // existence leak, no 403 that would confirm the row exists).
        const reads: Array<[string, string]> = [
            ['GET idea', `${API_BASE}/api/me/work-proposals/${idea.id}`],
            ['GET budget', `${API_BASE}/api/me/work-proposals/${idea.id}/budget`],
        ];
        for (const [label, url] of reads) {
            const res = await request.get(url, { headers: strangerHeaders });
            expect(res.status(), label).toBe(404);
        }

        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers: strangerHeaders },
        );
        expect(dismiss.status(), 'stranger dismiss').toBe(404);

        const build = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers: strangerHeaders,
        });
        expect(build.status(), 'stranger build').toBe(404);

        const retry = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/retry`, {
            headers: strangerHeaders,
        });
        expect(retry.status(), 'stranger retry').toBe(404);

        // The owner CAN still read it — the row exists, it was the bearer that
        // gated access, not a missing resource.
        const ownerGet = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: ownerHeaders,
        });
        expect(ownerGet.status()).toBe(200);
        expect((await ownerGet.json()).id).toBe(idea.id);

        // And the stranger dismissing it did NOT mutate it — still pending.
        const stillPending = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: ownerHeaders,
        });
        expect((await stillPending.json()).status).toBe('pending');
    });

    test('Mission list is strictly owner-scoped and ordered by updatedAt DESC; a PATCH bumps a Mission to the front', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerHeaders = authedHeaders(owner.access_token);
        const strangerHeaders = authedHeaders(stranger.access_token);
        const s = stamp();

        // Create three Missions with a real gap between writes so their
        // second-precision updatedAt timestamps are strictly distinct and the
        // ordering assertion is deterministic.
        const created: Array<{ id: string; title: string }> = [];
        for (const label of ['Alpha', 'Beta', 'Gamma']) {
            const m = await createMission(request, ownerHeaders, {
                title: `Order-${label} ${s}`,
            });
            created.push({ id: m.id, title: m.title });
            // 1.1s ⇒ guarantees a distinct floor-to-second timestamp.
            await new Promise((r) => setTimeout(r, 1100));
        }
        const [alpha, beta, gamma] = created;

        // Owner's list, restricted to the three we just made, must be in
        // reverse-creation order (updatedAt DESC): Gamma, Beta, Alpha.
        const listOwned = async (): Promise<Array<{ id: string }>> => {
            const res = await request.get(`${API_BASE}/api/me/missions`, { headers: ownerHeaders });
            expect(res.status()).toBe(200);
            const all = (await res.json()) as Array<{ id: string }>;
            const mine = new Set(created.map((c) => c.id));
            return all.filter((m) => mine.has(m.id));
        };
        expect((await listOwned()).map((m) => m.id)).toEqual([gamma.id, beta.id, alpha.id]);

        // PATCH the OLDEST (Alpha) — its updatedAt is touched, so it must jump
        // to the front of the owner-scoped subsequence.
        await new Promise((r) => setTimeout(r, 1100));
        const patch = await request.patch(`${API_BASE}/api/me/missions/${alpha.id}`, {
            headers: ownerHeaders,
            data: { description: `bumped ${s} to verify updatedAt re-sorts the list` },
        });
        expect(patch.status(), `patch body=${await patch.text()}`).toBe(200);
        expect((await listOwned()).map((m) => m.id)).toEqual([alpha.id, gamma.id, beta.id]);

        // The stranger's Mission list NEVER contains any of the owner's
        // Missions, and every direct accessor 404s (no existence leak).
        const strangerList = (await (
            await request.get(`${API_BASE}/api/me/missions`, { headers: strangerHeaders })
        ).json()) as Array<{ id: string }>;
        for (const c of created) {
            expect(strangerList.some((m) => m.id === c.id)).toBe(false);
        }
        const accessors: Array<[string, () => Promise<number>]> = [
            [
                'GET',
                async () =>
                    (
                        await request.get(`${API_BASE}/api/me/missions/${alpha.id}`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
            [
                'PATCH',
                async () =>
                    (
                        await request.patch(`${API_BASE}/api/me/missions/${alpha.id}`, {
                            headers: strangerHeaders,
                            data: { title: 'hijack' },
                        })
                    ).status(),
            ],
            [
                'budget',
                async () =>
                    (
                        await request.get(`${API_BASE}/api/me/missions/${alpha.id}/budget`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
            [
                'clone',
                async () =>
                    (
                        await request.post(`${API_BASE}/api/me/missions/${alpha.id}/clone`, {
                            headers: strangerHeaders,
                            data: {},
                        })
                    ).status(),
            ],
            [
                'run-now',
                async () =>
                    (
                        await request.post(`${API_BASE}/api/me/missions/${alpha.id}/run-now`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
            [
                'DELETE',
                async () =>
                    (
                        await request.delete(`${API_BASE}/api/me/missions/${alpha.id}`, {
                            headers: strangerHeaders,
                        })
                    ).status(),
            ],
        ];
        for (const [label, run] of accessors) {
            expect(await run(), `stranger ${label}`).toBe(404);
        }

        // After all that hostile traffic, the owner's Missions are untouched.
        const ownerAlpha = await request.get(`${API_BASE}/api/me/missions/${alpha.id}`, {
            headers: ownerHeaders,
        });
        expect(ownerAlpha.status()).toBe(200);
        expect((await ownerAlpha.json()).title).toBe(alpha.title);
    });

    test("Idea outstanding-count is Mission-scoped: a user's standalone Ideas never inflate any Mission's cap", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // A cap=1 Mission. With zero LINKED Ideas, outstanding=0 < cap=1 ⇒ a
        // run-now is NEVER cap-hit, no matter how many standalone Ideas exist.
        const capOne = await createMission(request, headers, {
            title: `CountScope-cap1 ${s}`,
            outstandingIdeasCap: 1,
        });

        // Create FOUR standalone Ideas (all missionId:null).
        for (let i = 0; i < 4; i++) {
            const idea = await createIdea(
                request,
                headers,
                `Standalone idea ${i} for ${s} — must not count toward any Mission's cap`,
            );
            expect(idea.missionId).toBeNull();
        }

        // These standalone Ideas are visible in the unscoped list…
        const unscoped = (await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers })
        ).json()) as Array<{ id: string }>;
        expect(unscoped.length).toBeGreaterThanOrEqual(4);

        // …but the cap=1 Mission's scope is still empty.
        const capOneScope = (await (
            await request.get(`${API_BASE}/api/me/work-proposals?missionId=${capOne.id}`, {
                headers,
            })
        ).json()) as unknown[];
        expect(capOneScope).toEqual([]);

        // run-now: outstanding (Mission-scoped) is 0 < cap 1 ⇒ NOT cap-hit.
        // On this no-AI stack it resolves to a truthful non-cap outcome
        // (e.g. no-ideas/skipped-no-profile). The key assertion: not cap-hit.
        const capOneRun = await request.post(`${API_BASE}/api/me/missions/${capOne.id}/run-now`, {
            headers,
        });
        expect(capOneRun.status()).toBe(200);
        const capOneBody = await capOneRun.json();
        expect(capOneBody.missionId).toBe(capOne.id);
        expect(capOneBody.status).not.toBe('cap-hit');

        // Now the deterministic proof of the count itself: a cap=0 Mission's
        // run-now reports the Mission-scoped outstanding count explicitly. It
        // must be exactly 0 even though FOUR standalone Ideas exist for this
        // same user — i.e. the count is per-Mission, never per-user.
        const capZero = await createMission(request, headers, {
            title: `CountScope-cap0 ${s}`,
            outstandingIdeasCap: 0,
        });
        const capZeroRun = await request.post(`${API_BASE}/api/me/missions/${capZero.id}/run-now`, {
            headers,
        });
        expect(capZeroRun.status()).toBe(200);
        const capZeroBody = await capZeroRun.json();
        expect(capZeroBody.status).toBe('cap-hit');
        // The diagnostic message embeds the Mission-scoped outstanding count.
        expect(String(capZeroBody.message)).toMatch(/outstanding=0 >= cap=0/i);
    });

    test('Idea list is generatedAt DESC and status-partitioned: dismiss removes from default, statuses filter re-finds it, bad enum 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // Create three Ideas with a >1s gap so generatedAt (second precision)
        // is strictly increasing — first, second, third.
        const first = await createIdea(
            request,
            headers,
            `Order idea ONE ${s} — created first, must sort last (oldest)`,
            `ONE ${s}`,
        );
        await new Promise((r) => setTimeout(r, 1100));
        const second = await createIdea(
            request,
            headers,
            `Order idea TWO ${s} — created second`,
            `TWO ${s}`,
        );
        await new Promise((r) => setTimeout(r, 1100));
        const third = await createIdea(
            request,
            headers,
            `Order idea THREE ${s} — created last, must sort first (newest)`,
            `THREE ${s}`,
        );

        // Default list (PENDING) restricted to our three, in generatedAt DESC:
        // THREE, TWO, ONE.
        const ours = [first.id, second.id, third.id];
        const orderedOurs = async (query = ''): Promise<string[]> => {
            const res = await request.get(`${API_BASE}/api/me/work-proposals${query}`, { headers });
            expect(res.status(), `list${query} body=${await res.text()}`).toBe(200);
            const all = (await res.json()) as Array<{ id: string }>;
            const set = new Set(ours);
            return all.filter((p) => set.has(p.id)).map((p) => p.id);
        };
        expect(await orderedOurs()).toEqual([third.id, second.id, first.id]);

        // Dismiss the MIDDLE one (TWO). 204, then it leaves the default
        // (PENDING) list, and the remaining two preserve their relative order.
        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${second.id}/dismiss`,
            { headers },
        );
        expect(dismiss.status()).toBe(204);
        expect(await orderedOurs()).toEqual([third.id, first.id]);

        // Re-dismissing an already-dismissed (non-pending) Idea is a 404 — the
        // dismiss guard only fires on PENDING rows.
        const reDismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${second.id}/dismiss`,
            { headers },
        );
        expect(reDismiss.status()).toBe(404);

        // statuses=dismissed re-finds ONLY the dismissed Idea (TWO) and
        // excludes the two still-pending ones — the list is status-partitioned.
        const dismissedScope = await orderedOurs('?statuses=dismissed');
        expect(dismissedScope).toEqual([second.id]);

        // statuses=pending&statuses=dismissed (multi) unions all three again,
        // still in generatedAt DESC.
        const union = await orderedOurs('?statuses=pending&statuses=dismissed');
        expect(union).toEqual([third.id, second.id, first.id]);

        // An unknown-but-valid Idea id is a 404, and a bogus status enum is a
        // 400 — the two failure modes are distinct.
        const unknownGet = await request.get(`${API_BASE}/api/me/work-proposals/${randomUuid()}`, {
            headers,
        });
        expect(unknownGet.status()).toBe(404);

        const badEnum = await request.get(`${API_BASE}/api/me/work-proposals?statuses=bogus`, {
            headers,
        });
        expect(badEnum.status()).toBe(400);
    });
});

test.describe('Mission ↔ Ideas — cross-user UI isolation (seeded user)', () => {
    test("a stranger's Mission never renders on the seeded user's /missions page, while the seeded user's own Mission does", async ({
        page,
        request,
    }) => {
        const s = stamp();

        // A FRESH stranger creates a Mission with a globally-unique title. It
        // must never appear in the seeded user's server-rendered /missions.
        const stranger = await registerUserViaAPI(request);
        const strangerMission = await createMission(request, authedHeaders(stranger.access_token), {
            title: `STRANGER-ONLY ${s}`,
        });

        // The seeded user (the browser's storageState identity) creates its OWN
        // Mission via API under its own bearer so it's the row /missions renders.
        const token = await seededToken(request);
        const seededTitle = `SEEDED-OWN ${s}`;
        await createMission(request, authedHeaders(token), { title: seededTitle });

        const baseURL = test.info().project.use.baseURL ?? 'http://localhost:3000';
        void baseURL; // routes are unprefixed; page.goto resolves against baseURL.

        await page.goto('/missions', { waitUntil: 'domcontentloaded' });

        // The seeded user's own Mission title renders (the page is a server
        // component that fetches missionsAPI.list() for the authed user). It
        // may live behind a catch-all in some next-dev local builds, so allow
        // either the card heading or any text node, and branch generously.
        const seededCard = page
            .getByRole('heading', { name: seededTitle })
            .or(page.getByText(seededTitle));
        await expect(seededCard.first()).toBeVisible({ timeout: 30_000 });

        // The stranger's Mission title is NOT present anywhere in the DOM — the
        // list is owner-scoped end-to-end (API → server render → page).
        await expect(page.getByText(strangerMission.title)).toHaveCount(0);
    });
});
