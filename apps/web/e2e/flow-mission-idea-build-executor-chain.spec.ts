import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Mission → Idea → autoBuild / build-executor → Work CHAIN, deep.
 *
 * This file owns the BUILD-EXECUTOR spine of the taxonomy: the Mission
 * `autoBuildWorks` field as a first-class lifecycle flag, the
 * `idea-build-execute` trigger surface (`POST /:id/build`), the full
 * rebuild/retry precondition lattice, and — the angle no sibling spec
 * pins — how the `idea_works` PROVENANCE surface diverges between a
 * user-facing `accept` (appends a link, re-points `acceptedWorkId`) and
 * a keyless `build`/`rebuild` (commits the Idea state transition but
 * appends NO link, because the executor is off and the Goal never
 * completes). Every status code, error string, and body shape asserted
 * here was probed against the LIVE API at http://127.0.0.1:3100 (sqlite
 * in-memory, keyless — no LLM provider, Work Agent reports disabled,
 * idea-build executor OFF, Trigger.dev unbound) BEFORE it was written.
 *
 * ── NON-DUPLICATION ───────────────────────────────────────────────────────
 * Deliberately DISJOINT from the sibling build/mission specs:
 *   - flow-idea-build-lifecycle.spec.ts   — the Idea state machine + dismiss
 *     branch + per-build budget + pending/queued/dismissed ?statuses slices.
 *     THIS file adds the BUILDING + ACCEPTED slices, the rebuild-from-BUILDING
 *     lattice, and the build-vs-accept PROVENANCE divergence.
 *   - flow-mission-idea-build.spec.ts      — Mission create + ?missionId filter
 *     + run-now/tick + schedule consistency. THIS file adds the `autoBuildWorks`
 *     field lifecycle (create/PATCH/toggle) and its keyless no-strand invariant.
 *   - flow-mission-idea-work-chain-multistep.spec.ts — the Task/Agent scoping
 *     stitch + mission_works loop. THIS file never scopes Tasks/Agents; it
 *     owns the build lattice + idea_works multi-link provenance depth.
 *
 * ── PROBED CONTRACTS (verified live) ──────────────────────────────────────
 *  POST  /api/me/missions {title,description,type,autoBuildWorks?,cap?} → 201
 *    autoBuildWorks defaults false; `true` round-trips. Full MissionDto shape.
 *  PATCH /api/me/missions/:id {autoBuildWorks} → 200, toggles the flag,
 *    preserves untouched fields (title/cap), bumps updatedAt.
 *  POST  /api/me/missions/:id/run-now (autoBuild, keyless) →
 *    { status:'no-ideas', missionId, message:'skipped-no-profile' };
 *    cap=0 → { status:'cap-hit', message:'outstanding=0 >= cap=0' }.
 *  POST  /api/me/work-proposals {description} → 201 source:'user-manual',
 *    status:'pending', missionId:null. `missionId` in body → 400.
 *  POST  /api/me/work-proposals/:id/build → ENV-ADAPTIVE 200 { proposal
 *    (status:'queued'), goal{id,instruction,status,dryRun,createdAt} } OR
 *    keyless 400 "Work agent is disabled." — the PENDING→QUEUED transition
 *    COMMITS either way (queueForBuild lands before createBuildRequest throws).
 *    GET :id/works STAYS { links:[] } after build (executor off, no Goal
 *    completion → no provenance row). from QUEUED/BUILDING/ACCEPTED/DISMISSED
 *    → 400 'Idea cannot be queued for build from status "<s>". Allowed:
 *    pending, failed.'  unknown valid-UUID → 404. cross-user → 404. anon → 401.
 *  POST  /api/me/work-proposals/:id/rebuild → ACCEPTED-only; commits
 *    ACCEPTED→BUILDING (keyless 400 "Work agent is disabled.") with
 *    acceptedWorkId PRESERVED (re-point only on Goal completion, which can't
 *    run). from non-ACCEPTED → 400 'Rebuild is only valid for ACCEPTED (Done)
 *    Ideas. Current status: "<s>".'
 *  POST  /api/me/work-proposals/:id/retry → FAILED-only (FAILED unreachable
 *    keyless — the executor is off). from non-FAILED → 400 'Retry is only
 *    valid for FAILED Ideas. Current status: "<s>".'
 *  POST  /api/me/work-proposals/:id/accept {workId} → 200 {ok:true} from
 *    PENDING (first link) AND from ACCEPTED (additional link — re-points
 *    acceptedWorkId to the newest Work, appends a 2nd idea_works row).
 *    on a QUEUED/BUILDING Idea → 404 "Proposal not found or already finalized".
 *  PATCH /api/me/work-proposals/:id/dismiss on a QUEUED Idea → 404
 *    "Proposal not found or not pending".
 *  GET   /api/me/work-proposals/:id/works → { links:[{ id, ideaId, workId,
 *    kind:'linked', createdAt, workName, workSlug }] }. cross-user → 404.
 *  GET   /api/me/work-proposals?statuses=<enum> → 200 for each of the 6;
 *    bogus → 400 "…one of the following values: pending, dismissed, accepted,
 *    queued, building, failed".
 *
 * Cross-spec isolation: EVERY test builds on FRESH registerUserViaAPI() users
 * (unique suffixes). List/link assertions use toContain/not.toContain on the
 * caller's OWN ids — never global counts. No module-scope data loading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A syntactically valid v4 UUID that matches nothing (the @IsUUID pipes accept
// it; the row simply doesn't exist → the not-found path, not a 400 parse fail).
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

/** The build/retry/rebuild endpoints are env-adaptive: 200 with a live Work
 *  Agent + executor, 400 "Work agent is disabled." on the keyless stack. Both
 *  are truthful; the Idea-side state transition COMMITS in both. */
const BUILD_OK_OR_DISABLED = [200, 400];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface MissionRow {
    id: string;
    title: string;
    description: string;
    type: string;
    status: string;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: unknown;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface IdeaRow {
    id: string;
    title: string;
    description: string;
    source: string;
    status: string;
    acceptedWorkId: string | null;
    missionId: string | null;
    failureMessage: string | null;
    failureKind: string | null;
}

interface LinkRow {
    id: string;
    ideaId: string;
    workId: string;
    kind: string;
    createdAt: string;
    workName: string | null;
    workSlug: string | null;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<MissionRow> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: {
            title: `Build Mission ${stamp()}`,
            description: 'a mission that auto-builds Works from its Ideas',
            type: 'one-shot',
            ...overrides,
        },
    });
    expect(res.status(), `mission create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function createIdea(
    request: APIRequestContext,
    token: string,
    description = `a curated directory of AI dev tooling ${stamp()}`,
): Promise<IdeaRow> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text().catch(() => '')}`).toBe(201);
    const idea = (await res.json()) as IdeaRow;
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    expect(idea.source).toBe('user-manual');
    return idea;
}

async function getIdea(request: APIRequestContext, token: string, id: string): Promise<IdeaRow> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

/** POST /:id/build — tolerant of the env-adaptive 200/400 split; the caller
 *  asserts the COMMITTED status separately. Returns the raw response. */
async function postBuild(request: APIRequestContext, token: string, id: string) {
    return request.post(`${API_BASE}/api/me/work-proposals/${id}/build`, {
        headers: authedHeaders(token),
    });
}

async function acceptIdea(
    request: APIRequestContext,
    token: string,
    ideaId: string,
    workId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
        headers: authedHeaders(token),
        data: { workId },
    });
    expect(res.status(), `accept body=${await res.text().catch(() => '')}`).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
}

async function listLinks(
    request: APIRequestContext,
    token: string,
    ideaId: string,
): Promise<LinkRow[]> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/works`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return (await res.json()).links as LinkRow[];
}

async function statusIds(
    request: APIRequestContext,
    token: string,
    statuses: string,
): Promise<string[]> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals?statuses=${statuses}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `?statuses=${statuses}`).toBe(200);
    return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
}

/** Drive a fresh Idea all the way to ACCEPTED against a real Work; returns
 *  both ids so the rebuild lattice / provenance depth can build on top. */
async function acceptedIdea(
    request: APIRequestContext,
    token: string,
): Promise<{ idea: IdeaRow; workId: string }> {
    const idea = await createIdea(request, token, `acceptable buildable idea ${stamp()}`);
    const work = await createWorkViaAPI(request, token, { name: `Accept Target ${stamp()}` });
    expect(work.id).toMatch(UUID_RE);
    await acceptIdea(request, token, idea.id, work.id);
    return { idea, workId: work.id };
}

// ───────────────────────────────────────────────────────────────────────────

test.describe('Mission autoBuildWorks — the auto-build flag as a first-class field', () => {
    test('a Mission is born with autoBuildWorks=false; create with true round-trips the full DTO', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Default: the flag is OFF.
        const off = await createMission(request, token, { title: `Default ${stamp()}` });
        expect(off.autoBuildWorks).toBe(false);

        // Explicit true round-trips, with the rest of the lifecycle DTO in its
        // zero state (active, no schedule, no source).
        const on = await createMission(request, token, {
            title: `Auto ${stamp()}`,
            autoBuildWorks: true,
            outstandingIdeasCap: 5,
        });
        expect(on.id).toMatch(UUID_RE);
        expect(on.autoBuildWorks).toBe(true);
        expect(on.status).toBe('active');
        expect(on.type).toBe('one-shot');
        expect(on.schedule).toBeNull();
        expect(on.outstandingIdeasCap).toBe(5);
        expect(on.sourceMissionId).toBeNull();
        expect(Date.parse(on.updatedAt)).toBeGreaterThanOrEqual(Date.parse(on.createdAt));
    });

    test('PATCH toggles autoBuildWorks both directions and leaves untouched fields intact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const title = `Toggle ${stamp()}`;
        const mission = await createMission(request, token, { title, outstandingIdeasCap: 3 });
        expect(mission.autoBuildWorks).toBe(false);

        // OFF → ON via a partial PATCH that carries ONLY autoBuildWorks.
        const on = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { autoBuildWorks: true },
        });
        expect(on.status()).toBe(200);
        const onBody = (await on.json()) as MissionRow;
        expect(onBody.autoBuildWorks).toBe(true);
        // The partial PATCH is truly partial — title + cap survive untouched.
        expect(onBody.title).toBe(title);
        expect(onBody.outstandingIdeasCap).toBe(3);
        expect(Date.parse(onBody.updatedAt)).toBeGreaterThanOrEqual(Date.parse(mission.createdAt));

        // ON → OFF round-trips back.
        const backOff = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { autoBuildWorks: false },
        });
        expect(backOff.status()).toBe(200);
        expect((await backOff.json()).autoBuildWorks).toBe(false);
    });

    test('an autoBuild Mission strands NOTHING on the keyless stack: run-now → no-ideas, and its Idea scope stays empty', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const mission = await createMission(request, token, {
            title: `AutoStrand ${stamp()}`,
            autoBuildWorks: true,
            outstandingIdeasCap: 5,
        });

        // run-now: the generator has no user profile / no LLM key, so it
        // truthfully reports no-ideas — autoBuildWorks has nothing to queue.
        const run = await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`, {
            headers: authedHeaders(token),
        });
        expect(run.status()).toBe(200);
        const runBody = (await run.json()) as {
            status: string;
            missionId: string;
            message?: string;
        };
        expect(runBody.missionId).toBe(mission.id);
        expect(['no-ideas', 'spawned', 'queued', 'noop-placeholder', 'cap-hit']).toContain(
            runBody.status,
        );
        // Because the tick produced no Ideas, the auto-build path queued none:
        // the Mission's Idea scope is empty (no QUEUED/BUILDING strands).
        const scoped = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
            { headers: authedHeaders(token) },
        );
        expect(scoped.status()).toBe(200);
        expect((await scoped.json()).length).toBe(0);
    });

    test('an autoBuild Mission with cap=0 short-circuits to cap-hit BEFORE any generation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const capped = await createMission(request, token, {
            title: `AutoCap0 ${stamp()}`,
            autoBuildWorks: true,
            outstandingIdeasCap: 0,
        });
        expect(capped.autoBuildWorks).toBe(true);
        expect(capped.outstandingIdeasCap).toBe(0);

        const run = await request.post(`${API_BASE}/api/me/missions/${capped.id}/run-now`, {
            headers: authedHeaders(token),
        });
        expect(run.status()).toBe(200);
        const body = (await run.json()) as { status: string; message?: string };
        // cap-hit is deterministic (outstanding 0 >= cap 0), independent of AI.
        expect(body.status).toBe('cap-hit');
        expect(String(body.message)).toMatch(/outstanding=0 >= cap=0/i);
    });
});

test.describe('build-executor trigger — QUEUED commit + provenance divergence', () => {
    test('build commits PENDING→QUEUED even when the Work Agent / executor is unbound; the goal DTO is well-shaped when present', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const idea = await createIdea(request, token);
        expect(idea.acceptedWorkId).toBeNull();
        expect(idea.failureMessage).toBeNull();
        expect(idea.failureKind).toBeNull();

        const build = await postBuild(request, token, idea.id);
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());
        if (build.status() === 200) {
            const built = await build.json();
            expect(built.proposal.id).toBe(idea.id);
            expect(built.proposal.status).toBe('queued');
            expect(built.goal.id).toMatch(UUID_RE);
            expect(typeof built.goal.instruction).toBe('string');
            expect(typeof built.goal.status).toBe('string');
            expect(typeof built.goal.dryRun).toBe('boolean');
        } else {
            expect(msgOf(await build.json())).toMatch(/work agent is disabled/i);
        }

        // The COMMITTED truth: PENDING→QUEUED lands regardless of the enqueue
        // outcome. This is the observable that never lies on either stack.
        expect((await getIdea(request, token, idea.id)).status).toBe('queued');
    });

    test('build appends NO idea_works provenance row (executor off) — unlike accept, which does', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // ── Path A: build. The Goal is created but the executor is off, so it
        //    never completes → no Idea→Work link is ever appended. ───────────
        const built = await createIdea(request, token, `provenance-build idea ${stamp()}`);
        expect(await listLinks(request, token, built.id)).toEqual([]);
        const build = await postBuild(request, token, built.id);
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());
        expect((await getIdea(request, token, built.id)).status).toBe('queued');
        // The provenance surface is STILL empty after build — the divergence.
        expect(await listLinks(request, token, built.id)).toEqual([]);

        // ── Path B: accept. The user-facing accept DOES append a link row. ──
        const accepted = await createIdea(request, token, `provenance-accept idea ${stamp()}`);
        const work = await createWorkViaAPI(request, token, { name: `Prov Work ${stamp()}` });
        await acceptIdea(request, token, accepted.id, work.id);
        const links = await listLinks(request, token, accepted.id);
        expect(links.map((l) => l.workId)).toContain(work.id);
        const link = links.find((l) => l.workId === work.id)!;
        expect(link.ideaId).toBe(accepted.id);
        expect(link.kind).toBe('linked');
        expect(typeof link.workName).toBe('string');
        expect(typeof link.workSlug).toBe('string');
    });

    test('build is single-shot: a second build from QUEUED is rejected with its precondition 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const idea = await createIdea(request, token);

        const first = await postBuild(request, token, idea.id);
        expect(BUILD_OK_OR_DISABLED).toContain(first.status());
        expect((await getIdea(request, token, idea.id)).status).toBe('queued');

        const second = await postBuild(request, token, idea.id);
        expect(second.status()).toBe(400);
        expect(msgOf(await second.json())).toMatch(
            /cannot be queued for build from status "queued"\. allowed: pending, failed/i,
        );
    });

    test('build closes the user-accept door: accept + dismiss on a QUEUED (build-started) Idea both 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const idea = await createIdea(request, token);
        const work = await createWorkViaAPI(request, token, { name: `Closed Work ${stamp()}` });

        const build = await postBuild(request, token, idea.id);
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());
        expect((await getIdea(request, token, idea.id)).status).toBe('queued');

        // accept is PENDING/ACCEPTED-only → a QUEUED Idea is "already finalized".
        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
            headers: authedHeaders(token),
            data: { workId: work.id },
        });
        expect(accept.status()).toBe(404);
        expect(msgOf(await accept.json())).toMatch(/not found or already finalized/i);

        // dismiss is PENDING-only → a QUEUED Idea is "not pending".
        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismiss.status()).toBe(404);
        expect(msgOf(await dismiss.json())).toMatch(/not found or not pending/i);
    });
});

test.describe('rebuild lattice + resulting Work linkage', () => {
    test('accept→rebuild commits ACCEPTED→BUILDING and PRESERVES acceptedWorkId (no re-point without Goal completion)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { idea, workId } = await acceptedIdea(request, token);

        // After accept: ACCEPTED, denormalized pointer set, one provenance link.
        const afterAccept = await getIdea(request, token, idea.id);
        expect(afterAccept.status).toBe('accepted');
        expect(afterAccept.acceptedWorkId).toBe(workId);

        const rebuild = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/rebuild`, {
            headers: authedHeaders(token),
        });
        expect(BUILD_OK_OR_DISABLED).toContain(rebuild.status());
        if (rebuild.status() === 400) {
            expect(msgOf(await rebuild.json())).toMatch(/work agent is disabled/i);
        }

        // The ACCEPTED→BUILDING transition committed (keyless) OR a live agent
        // completed it synchronously — both truthful.
        const afterRebuild = await getIdea(request, token, idea.id);
        expect(['building', 'accepted', 'queued']).toContain(afterRebuild.status);
        // KEY: the original Work pointer is PRESERVED. The rebuild re-points
        // acceptedWorkId only on Goal completion (which can't run keyless), so
        // the born-from-accept Work is still the pointer AND still resolvable.
        if (afterRebuild.status === 'building') {
            expect(afterRebuild.acceptedWorkId).toBe(workId);
        }
        const workStillThere = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(workStillThere.status()).toBe(200);
    });

    test('rebuild after accept appends NO provenance row on the keyless stack — the accept link stands alone', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { idea, workId } = await acceptedIdea(request, token);

        const before = await listLinks(request, token, idea.id);
        expect(before.map((l) => l.workId)).toEqual([workId]);

        const rebuild = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/rebuild`, {
            headers: authedHeaders(token),
        });
        expect(BUILD_OK_OR_DISABLED).toContain(rebuild.status());

        // The executor never completes the rebuild Goal, so no NEW idea_works
        // row is appended — the provenance list is unchanged.
        const after = await listLinks(request, token, idea.id);
        expect(after.map((l) => l.workId)).toEqual([workId]);
    });

    test('every build/retry/rebuild is illegal from BUILDING — the triple-guard names the current status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { idea } = await acceptedIdea(request, token);

        // Drive ACCEPTED → BUILDING via rebuild (commits before the enqueue).
        const rebuild = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/rebuild`, {
            headers: authedHeaders(token),
        });
        expect(BUILD_OK_OR_DISABLED).toContain(rebuild.status());
        const nowBuilding = await getIdea(request, token, idea.id);
        // Only meaningful when the keyless commit left it BUILDING.
        test.skip(nowBuilding.status !== 'building', 'a live agent completed the rebuild');

        const build = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers: authedHeaders(token),
        });
        expect(build.status()).toBe(400);
        expect(msgOf(await build.json())).toMatch(
            /cannot be queued for build from status "building"/i,
        );

        const retry = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/retry`, {
            headers: authedHeaders(token),
        });
        expect(retry.status()).toBe(400);
        expect(msgOf(await retry.json())).toMatch(
            /retry is only valid for failed ideas\. current status: "building"/i,
        );

        const reRebuild = await request.post(
            `${API_BASE}/api/me/work-proposals/${idea.id}/rebuild`,
            { headers: authedHeaders(token) },
        );
        expect(reRebuild.status()).toBe(400);
        expect(msgOf(await reRebuild.json())).toMatch(
            /rebuild is only valid for accepted \(done\) ideas\. current status: "building"/i,
        );
    });

    test('rebuild precondition is exact: from PENDING and from QUEUED it 400s, naming each status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // PENDING → rebuild illegal.
        const pending = await createIdea(request, token, `rebuild-guard pending ${stamp()}`);
        const rp = await request.post(`${API_BASE}/api/me/work-proposals/${pending.id}/rebuild`, {
            headers: authedHeaders(token),
        });
        expect(rp.status()).toBe(400);
        expect(msgOf(await rp.json())).toMatch(
            /rebuild is only valid for accepted \(done\) ideas\. current status: "pending"/i,
        );

        // QUEUED → rebuild illegal (drive it via build first).
        const build = await postBuild(request, token, pending.id);
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());
        expect((await getIdea(request, token, pending.id)).status).toBe('queued');
        const rq = await request.post(`${API_BASE}/api/me/work-proposals/${pending.id}/rebuild`, {
            headers: authedHeaders(token),
        });
        expect(rq.status()).toBe(400);
        expect(msgOf(await rq.json())).toMatch(/current status: "queued"/i);
    });
});

test.describe('retry precondition lattice (FAILED-only)', () => {
    test('retry is rejected from every non-FAILED state, each 400 naming the current status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const retryFrom = async (id: string) => {
            const res = await request.post(`${API_BASE}/api/me/work-proposals/${id}/retry`, {
                headers: authedHeaders(token),
            });
            expect(res.status()).toBe(400);
            return msgOf(await res.json());
        };

        // PENDING.
        const pending = await createIdea(request, token, `retry pending ${stamp()}`);
        expect(await retryFrom(pending.id)).toMatch(
            /retry is only valid for failed ideas\. current status: "pending"/i,
        );

        // QUEUED (build a fresh Idea).
        const queued = await createIdea(request, token, `retry queued ${stamp()}`);
        expect(BUILD_OK_OR_DISABLED).toContain(
            (await postBuild(request, token, queued.id)).status(),
        );
        expect(await retryFrom(queued.id)).toMatch(/current status: "queued"/i);

        // ACCEPTED.
        const { idea: accepted } = await acceptedIdea(request, token);
        expect(await retryFrom(accepted.id)).toMatch(/current status: "accepted"/i);

        // DISMISSED.
        const dropped = await createIdea(request, token, `retry dismissed ${stamp()}`);
        expect(
            (
                await request.patch(`${API_BASE}/api/me/work-proposals/${dropped.id}/dismiss`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(204);
        expect(await retryFrom(dropped.id)).toMatch(/current status: "dismissed"/i);
    });
});

test.describe('idea_works multi-link provenance depth', () => {
    test('accept-from-ACCEPTED appends a 2nd link and re-points acceptedWorkId to the newest Work; both Works survive', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const idea = await createIdea(request, token, `multi-link idea ${stamp()}`);
        const w1 = await createWorkViaAPI(request, token, { name: `Link One ${stamp()}` });
        const w2 = await createWorkViaAPI(request, token, { name: `Link Two ${stamp()}` });

        // First accept (from PENDING) → link #1, pointer = w1.
        await acceptIdea(request, token, idea.id, w1.id);
        expect((await getIdea(request, token, idea.id)).acceptedWorkId).toBe(w1.id);

        // Second accept (from ACCEPTED) → link #2, pointer RE-POINTS to w2.
        await acceptIdea(request, token, idea.id, w2.id);
        const after = await getIdea(request, token, idea.id);
        expect(after.status).toBe('accepted');
        expect(after.acceptedWorkId).toBe(w2.id);

        // The provenance panel carries BOTH links (0..N), each a 'linked' row.
        const links = await listLinks(request, token, idea.id);
        const workIds = links.map((l) => l.workId);
        expect(workIds).toContain(w1.id);
        expect(workIds).toContain(w2.id);
        expect(links.every((l) => l.kind === 'linked')).toBe(true);
        expect(links.every((l) => l.ideaId === idea.id)).toBe(true);

        // Both underlying Works are independently resolvable (accept never
        // deletes; the first link's Work is not orphaned by the re-point).
        for (const id of [w1.id, w2.id]) {
            expect(
                (
                    await request.get(`${API_BASE}/api/works/${id}`, {
                        headers: authedHeaders(token),
                    })
                ).status(),
            ).toBe(200);
        }
    });
});

test.describe('build-lattice ?statuses observability across the full chain', () => {
    test('a cohort driven into pending/queued/building/accepted/dismissed slices each ?statuses partition exactly', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // pending — untouched.
        const pending = await createIdea(request, token, `slice pending ${s}`);
        // queued — build.
        const queued = await createIdea(request, token, `slice queued ${s}`);
        expect(BUILD_OK_OR_DISABLED).toContain(
            (await postBuild(request, token, queued.id)).status(),
        );
        // accepted — accept against a Work.
        const { idea: accepted } = await acceptedIdea(request, token);
        // building — accept then rebuild (keyless commit lands in BUILDING).
        const { idea: buildingIdea } = await acceptedIdea(request, token);
        const rebuild = await request.post(
            `${API_BASE}/api/me/work-proposals/${buildingIdea.id}/rebuild`,
            { headers: authedHeaders(token) },
        );
        expect(BUILD_OK_OR_DISABLED).toContain(rebuild.status());
        const buildingStatus = (await getIdea(request, token, buildingIdea.id)).status;
        // dismissed — dismiss a pending Idea.
        const dismissed = await createIdea(request, token, `slice dismissed ${s}`);
        expect(
            (
                await request.patch(`${API_BASE}/api/me/work-proposals/${dismissed.id}/dismiss`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(204);

        // ?statuses=pending — contains only the untouched Idea of this cohort.
        const pendingSlice = await statusIds(request, token, 'pending');
        expect(pendingSlice).toContain(pending.id);
        expect(pendingSlice).not.toContain(queued.id);
        expect(pendingSlice).not.toContain(accepted.id);
        expect(pendingSlice).not.toContain(dismissed.id);

        // ?statuses=queued — the built Idea; excludes pending/accepted.
        const queuedSlice = await statusIds(request, token, 'queued');
        expect(queuedSlice).toContain(queued.id);
        expect(queuedSlice).not.toContain(pending.id);
        expect(queuedSlice).not.toContain(accepted.id);

        // ?statuses=accepted — the accepted Idea; excludes queued.
        const acceptedSlice = await statusIds(request, token, 'accepted');
        expect(acceptedSlice).toContain(accepted.id);
        expect(acceptedSlice).not.toContain(queued.id);

        // ?statuses=dismissed — the dismissed Idea; excludes pending.
        const dismissedSlice = await statusIds(request, token, 'dismissed');
        expect(dismissedSlice).toContain(dismissed.id);
        expect(dismissedSlice).not.toContain(pending.id);

        // ?statuses=building — contains the rebuilt Idea IFF the keyless commit
        // left it BUILDING (a live agent would have completed it to accepted).
        const buildingSlice = await statusIds(request, token, 'building');
        if (buildingStatus === 'building') {
            expect(buildingSlice).toContain(buildingIdea.id);
        }
        expect(buildingSlice).not.toContain(pending.id);
        expect(buildingSlice).not.toContain(queued.id);

        // Multi-status union spans the lattice; bogus → 400 with the full enum.
        const union = await statusIds(request, token, 'queued&statuses=dismissed');
        expect(union).toContain(queued.id);
        expect(union).toContain(dismissed.id);
        expect(union).not.toContain(accepted.id);

        const bogus = await request.get(`${API_BASE}/api/me/work-proposals?statuses=bogus`, {
            headers: authedHeaders(token),
        });
        expect(bogus.status()).toBe(400);
        expect(msgOf(await bogus.json())).toMatch(
            /pending, dismissed, accepted, queued, building, failed/i,
        );
    });
});

test.describe('build-chain isolation + not-found lattice', () => {
    test('a stranger cannot build/retry/rebuild/accept/dismiss the owner’s Idea — all 404, owner state untouched', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = authedHeaders(stranger.access_token);
        const idea = await createIdea(request, owner.access_token, `isolation idea ${stamp()}`);
        const strangerWork = await createWorkViaAPI(request, stranger.access_token, {
            name: `Stranger Work ${stamp()}`,
        });

        for (const action of ['build', 'retry', 'rebuild'] as const) {
            const res = await request.post(
                `${API_BASE}/api/me/work-proposals/${idea.id}/${action}`,
                { headers: s },
            );
            expect(res.status(), `stranger ${action}`).toBe(404);
        }
        // accept + dismiss also 404 for the stranger (no existence leak).
        expect(
            (
                await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`, {
                    headers: s,
                    data: { workId: strangerWork.id },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`, {
                    headers: s,
                })
            ).status(),
        ).toBe(404);

        // The stranger cannot read the Idea's provenance or budget either.
        expect(
            (
                await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/works`, {
                    headers: s,
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`, {
                    headers: s,
                })
            ).status(),
        ).toBe(404);

        // None of the failed stranger writes moved the owner's Idea off PENDING.
        expect((await getIdea(request, owner.access_token, idea.id)).status).toBe('pending');
    });

    test('anonymous callers get 401 on every build-lattice action; unknown-but-valid ids get 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const idea = await createIdea(request, token, `anon-vs-unknown idea ${stamp()}`);

        // Anonymous → 401 on each mutating action (auth guard fires first).
        for (const action of ['build', 'retry', 'rebuild'] as const) {
            expect(
                (
                    await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/${action}`)
                ).status(),
                `anon ${action}`,
            ).toBe(401);
        }
        expect(
            (await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/accept`)).status(),
        ).toBe(401);
        expect(
            (await request.patch(`${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`)).status(),
        ).toBe(401);

        // Authenticated but the row doesn't exist → the ownership/existence gate
        // 404s before any status precondition can run.
        for (const action of ['build', 'retry', 'rebuild'] as const) {
            expect(
                (
                    await request.post(
                        `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/${action}`,
                        { headers: authedHeaders(token) },
                    )
                ).status(),
                `unknown ${action}`,
            ).toBe(404);
        }
        // A malformed (non-UUID) id is rejected by the ParseUUIDPipe → 400.
        expect(
            (
                await request.post(`${API_BASE}/api/me/work-proposals/not-a-uuid/build`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(400);
    });
});

test.describe('Mission ↔ autoBuild ↔ build-chain, end to end', () => {
    test('autoBuild Mission + manual Idea + build: the manual Idea never joins the Mission scope, but its born-from-accept Work rejoins via the mission_works "created" edge', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // 1. An autoBuild Mission.
        const mission = await createMission(request, token, {
            title: `E2E AutoBuild ${stamp()}`,
            autoBuildWorks: true,
            outstandingIdeasCap: 5,
        });

        // 2. A manual Idea — born UNLINKED (missionId null); build it to QUEUED.
        const manual = await createIdea(request, token, `e2e manual idea ${stamp()}`);
        expect(manual.missionId).toBeNull();
        expect(BUILD_OK_OR_DISABLED).toContain(
            (await postBuild(request, token, manual.id)).status(),
        );
        expect((await getIdea(request, token, manual.id)).status).toBe('queued');

        // 3. The manual Idea NEVER enters the Mission's Idea scope — only
        //    generator-spawned (MISSION-source) Ideas carry a missionId, and
        //    there is no generator on the keyless stack. The scope stays empty
        //    across the default AND the queued slice.
        for (const q of ['', '&statuses=queued']) {
            const scoped = await request.get(
                `${API_BASE}/api/me/work-proposals?missionId=${mission.id}${q}`,
                { headers: authedHeaders(token) },
            );
            expect(scoped.status()).toBe(200);
            expect((await scoped.json()).map((r: { id: string }) => r.id)).not.toContain(manual.id);
        }

        // 4. Take a SEPARATE Idea all the way to ACCEPTED, then close the loop:
        //    attach its born-from-accept Work back to the Mission under the
        //    'created' provenance relation.
        const { idea: accepted, workId } = await acceptedIdea(request, token);
        expect((await getIdea(request, token, accepted.id)).acceptedWorkId).toBe(workId);

        const attach = await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
            data: { workId, relation: 'created' },
        });
        expect(attach.status(), `attach body=${await attach.text().catch(() => '')}`).toBe(201);
        const attached = (await attach.json()).relations as Array<{
            workId: string;
            relation: string;
        }>;
        expect(attached.map((r) => r.workId)).toContain(workId);
        expect(attached.find((r) => r.workId === workId)!.relation).toBe('created');

        // 5. The reverse lookup agrees — the Work knows its origin Mission.
        const reverse = await request.get(`${API_BASE}/api/me/missions/related-to-work/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(reverse.status()).toBe(200);
        const { relations } = (await reverse.json()) as {
            relations: Array<{ missionId: string; relation: string }>;
        };
        expect(relations.map((r) => r.missionId)).toContain(mission.id);
        expect(relations.find((r) => r.missionId === mission.id)!.relation).toBe('created');
    });
});
