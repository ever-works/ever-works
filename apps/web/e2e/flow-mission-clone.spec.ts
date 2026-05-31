import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Mission clone (full fork) + guardrails — deep, multi-step END-TO-END
 * orchestration of the real Missions surface
 * (`apps/api/src/missions/missions.controller.ts`, backed by
 * `@ever-works/agent/missions` MissionsService + MissionCloneService).
 *
 * Every endpoint shape below was probed against the LIVE API at
 * http://127.0.0.1:3100 before assertions were written. The three flows:
 *
 *  1. CLONE (full fork): create a Mission with a guardrailsOverride + a
 *     non-default outstandingIdeasCap + autoBuildWorks=true; full-fork
 *     clone it (default title + explicit-title-override variants); assert
 *     the clone copies ALL metadata verbatim, sets status='active' (even
 *     when the source is COMPLETED), sets the `sourceMissionId` backlink,
 *     resets `missionRepo` to null, and carries the non-DISMISSED Ideas
 *     count truthfully. A standalone Work is created on the owner and we
 *     prove it never appears scoped to the clone — Works are NOT cloned
 *     (Decisions A25/A26).
 *
 *  2. UPDATE: PATCH title/description/autoBuildWorks/schedule and pin the
 *     one-shot vs scheduled consistency rule the service enforces
 *     (`assertScheduleConsistency`): scheduled needs a cron, one-shot must
 *     clear it. Assert each change persists via a fresh GET. Also pins
 *     guardrailsOverride + outstandingIdeasCap PATCH round-trips and the
 *     -1 "unlimited" cap sentinel.
 *
 *  3. ISOLATION + list scoping: a second user cannot GET / PATCH / clone
 *     the owner's Mission (all 404, same opaque "Mission not found"), and
 *     `GET /api/me/missions` returns ONLY the caller's own Missions.
 *
 * DEVIATION (documented, see `risks`): the public API has NO deterministic
 * path to attach an Idea to a Mission. `POST /api/me/work-proposals`
 * (user-manual) always births the Idea with `missionId=null`, and the only
 * Mission→Idea linker is the AI research tick (`run-now`), which returns
 * `{status:'no-ideas', message:'skipped-no-profile'}` on the CI/local stack
 * (no LLM provider). So the clone's `ideasCloned` is necessarily 0 here.
 * Rather than fake a linkage the platform rejects, flow 1 asserts the
 * TRUTHFUL contract: ideasCloned===0 + an empty Mission-scoped Idea list on
 * BOTH source and clone, while still fully pinning the metadata-copy +
 * backlink + Works-not-cloned guarantees the clone path is responsible for.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface MissionDto {
    id: string;
    title: string;
    description: string;
    type: 'one-shot' | 'scheduled';
    status: 'active' | 'paused' | 'completed' | 'failed';
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: Record<string, unknown> | null;
    missionTemplateRepo: string | null;
    missionRepo: string | null;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface CloneResult {
    mission: MissionDto;
    ideasCloned: number;
    ideasSkipped: number;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted — pass ONLY {email,password} (a `name` field
    // would 400 with "property name should not exist").
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token as string;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<MissionDto> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    return res.json();
}

async function listMissionScopedIdeas(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<Array<{ id: string }>> {
    // Probed live: returns a bare JSON array. Tolerate a wrapped shape too.
    const res = await request.get(`${API_BASE}/api/me/work-proposals?missionId=${missionId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return Array.isArray(body) ? body : (body?.proposals ?? body?.data ?? []);
}

test.describe('Mission clone + guardrails', () => {
    /**
     * Flow 1 — Full-fork clone. Create a richly-configured one-shot Mission
     * (guardrailsOverride + outstandingIdeasCap + autoBuildWorks=true), clone
     * it two ways (default title, explicit title), and assert the fork copies
     * metadata + sets the backlink + does NOT carry Works.
     */
    test('full-fork clone copies metadata + backlink; works are not cloned', async ({
        request,
    }) => {
        // Use a FRESH API-only user for these mutations so the shared
        // in-memory DB stays clean for sibling specs.
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        const guardrails = { maxWorksPerRun: 3, allowAutoMerge: false };
        const sourceTitle = `Source Mission ${stamp}`;
        const source = await createMission(request, token, {
            title: sourceTitle,
            description: `Curate AI dev tools ${stamp}`,
            type: 'one-shot',
            autoBuildWorks: true,
            outstandingIdeasCap: 7,
            guardrailsOverride: guardrails,
        });
        expect(source.id).toMatch(UUID_RE);
        expect(source.status).toBe('active');
        expect(source.sourceMissionId).toBeNull();
        expect(source.missionRepo).toBeNull();
        expect(source.guardrailsOverride).toEqual(guardrails);

        // Create a user-manual Idea + a standalone Work. NEITHER is linked
        // to the Mission via the public API (user-manual Ideas are born
        // missionId=null; Works have no Mission FK at create time). This is
        // the setup that proves the clone fabricates nothing.
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers: authedHeaders(token),
            data: { description: `Standalone Idea for ${stamp} that is not mission-linked` },
        });
        expect(ideaRes.status(), `idea create body=${await ideaRes.text()}`).toBe(201);
        const idea = await ideaRes.json();
        expect(idea.missionId).toBeNull();

        const work = await createWorkViaAPI(request, token, { name: `Clone Probe Work ${stamp}` });
        expect(work.id, `work id from ${JSON.stringify(work.raw)}`).toMatch(UUID_RE);

        // The source Mission has NO Ideas scoped to it (the user-manual Idea
        // is unlinked) — so the fork has nothing to carry. Pin that truth.
        expect(await listMissionScopedIdeas(request, token, source.id)).toHaveLength(0);

        // ── Clone A: default title ("Copy of <source>") ──────────────────
        const cloneARes = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(cloneARes.status(), `clone body=${await cloneARes.text()}`).toBe(201);
        const cloneA: CloneResult = await cloneARes.json();

        // Fresh identity, status reset to ACTIVE, backlink to the source.
        expect(cloneA.mission.id).toMatch(UUID_RE);
        expect(cloneA.mission.id).not.toBe(source.id);
        expect(cloneA.mission.status).toBe('active');
        expect(cloneA.mission.sourceMissionId).toBe(source.id);
        // Default title is "Copy of <source.title>".
        expect(cloneA.mission.title).toBe(`Copy of ${sourceTitle}`);
        // Metadata copied verbatim.
        expect(cloneA.mission.description).toBe(source.description);
        expect(cloneA.mission.type).toBe('one-shot');
        expect(cloneA.mission.schedule).toBeNull();
        expect(cloneA.mission.autoBuildWorks).toBe(true);
        expect(cloneA.mission.outstandingIdeasCap).toBe(7);
        expect(cloneA.mission.guardrailsOverride).toEqual(guardrails);
        // The clone gets its OWN repo at scaffold time → null until then.
        expect(cloneA.mission.missionRepo).toBeNull();
        expect(cloneA.mission.missionTemplateRepo).toBeNull();
        // No mission-linked Ideas existed → none carried, none skipped.
        expect(cloneA.ideasCloned).toBe(0);
        expect(cloneA.ideasSkipped).toBe(0);

        // GET the clone back — the backlink + metadata persist.
        const cloneAGet = await request.get(`${API_BASE}/api/me/missions/${cloneA.mission.id}`, {
            headers: authedHeaders(token),
        });
        expect(cloneAGet.status()).toBe(200);
        const cloneAFresh: MissionDto = await cloneAGet.json();
        expect(cloneAFresh.sourceMissionId).toBe(source.id);
        expect(cloneAFresh.guardrailsOverride).toEqual(guardrails);

        // WORKS ARE NOT CLONED: the clone's Mission-scoped Idea list is empty
        // and the standalone Work never surfaces there. (Works attach to a
        // Mission only transitively via accepted Ideas; the clone copies
        // neither the Works nor any accepted Idea, per Decisions A25/A26.)
        const cloneScopedIdeas = await listMissionScopedIdeas(request, token, cloneA.mission.id);
        expect(cloneScopedIdeas).toHaveLength(0);
        expect(cloneScopedIdeas.map((i) => i.id)).not.toContain(work.id);
        expect(cloneScopedIdeas.map((i) => i.id)).not.toContain(idea.id);

        // ── Clone B: explicit title override ─────────────────────────────
        const forkTitle = `Forked ${stamp}`;
        const cloneBRes = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            headers: authedHeaders(token),
            data: { title: forkTitle },
        });
        expect(cloneBRes.status()).toBe(201);
        const cloneB: CloneResult = await cloneBRes.json();
        expect(cloneB.mission.title).toBe(forkTitle);
        expect(cloneB.mission.id).not.toBe(cloneA.mission.id);
        expect(cloneB.mission.sourceMissionId).toBe(source.id);
        expect(cloneB.mission.guardrailsOverride).toEqual(guardrails);

        // The owner's list now contains the source + both clones; the source
        // itself is unchanged (still has no backlink).
        const listRes = await request.get(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
        });
        expect(listRes.status()).toBe(200);
        const all: MissionDto[] = await listRes.json();
        const ids = all.map((m) => m.id);
        expect(ids).toContain(source.id);
        expect(ids).toContain(cloneA.mission.id);
        expect(ids).toContain(cloneB.mission.id);
        const sourceFresh = all.find((m) => m.id === source.id)!;
        expect(sourceFresh.sourceMissionId).toBeNull();

        // ── Clone of a COMPLETED Mission re-activates the fork ───────────
        // Complete the source, then clone — the fork comes back ACTIVE.
        const completeRes = await request.post(
            `${API_BASE}/api/me/missions/${source.id}/complete`,
            { headers: authedHeaders(token) },
        );
        expect(completeRes.status()).toBe(200);
        expect((await completeRes.json()).status).toBe('completed');

        const cloneCRes = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            headers: authedHeaders(token),
            data: { title: `Revived ${stamp}` },
        });
        expect(cloneCRes.status()).toBe(201);
        const cloneC: CloneResult = await cloneCRes.json();
        expect(cloneC.mission.status).toBe('active');
        expect(cloneC.mission.sourceMissionId).toBe(source.id);

        // ── Clone error cases ────────────────────────────────────────────
        // Unknown (but well-formed) UUID → 404 NotFound.
        const cloneMissing = await request.post(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/clone`,
            { headers: authedHeaders(token), data: {} },
        );
        expect(cloneMissing.status()).toBe(404);
        // Malformed id → 400 from ParseUUIDPipe.
        const cloneBadId = await request.post(`${API_BASE}/api/me/missions/not-a-uuid/clone`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(cloneBadId.status()).toBe(400);
    });

    /**
     * Flow 2 — Mission update + one-shot vs ongoing/scheduled behaviour. PATCH
     * the writable fields and pin the service-side schedule-consistency rule.
     */
    test('PATCH updates persist; one-shot vs scheduled consistency is enforced', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        // Start as a one-shot with the -1 "unlimited" cap sentinel.
        const mission = await createMission(request, token, {
            title: `Update Source ${stamp}`,
            description: `original description ${stamp}`,
            type: 'one-shot',
            outstandingIdeasCap: -1,
        });
        expect(mission.type).toBe('one-shot');
        expect(mission.schedule).toBeNull();
        expect(mission.outstandingIdeasCap).toBe(-1);

        // ── one-shot → scheduled WITHOUT a cron is rejected (400) ─────────
        const noCron = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: { type: 'scheduled' },
        });
        expect(noCron.status()).toBe(400);
        expect((await noCron.json()).message).toMatch(/scheduled requires a non-empty/i);

        // ── PATCH title/description/autoBuildWorks + flip to SCHEDULED ────
        const newTitle = `Renamed ${stamp}`;
        const newDesc = `updated description ${stamp}`;
        const cron = '0 9 * * 1';
        const patched = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: {
                title: newTitle,
                description: newDesc,
                autoBuildWorks: true,
                type: 'scheduled',
                schedule: cron,
            },
        });
        expect(patched.status(), `patch body=${await patched.text()}`).toBe(200);
        const patchedBody: MissionDto = await patched.json();
        expect(patchedBody.title).toBe(newTitle);
        expect(patchedBody.description).toBe(newDesc);
        expect(patchedBody.autoBuildWorks).toBe(true);
        expect(patchedBody.type).toBe('scheduled');
        expect(patchedBody.schedule).toBe(cron);
        // updatedAt advanced past createdAt.
        expect(new Date(patchedBody.updatedAt).getTime()).toBeGreaterThanOrEqual(
            new Date(patchedBody.createdAt).getTime(),
        );

        // Persisted — a fresh GET returns the new values.
        const afterPatch = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
        });
        expect(afterPatch.status()).toBe(200);
        const afterBody: MissionDto = await afterPatch.json();
        expect(afterBody.title).toBe(newTitle);
        expect(afterBody.type).toBe('scheduled');
        expect(afterBody.schedule).toBe(cron);

        // ── A SCHEDULED mission cannot clear its cron while staying scheduled
        const clearCron = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: { schedule: null },
        });
        expect(clearCron.status()).toBe(400);
        expect((await clearCron.json()).message).toMatch(/scheduled requires a non-empty/i);

        // ── scheduled → one-shot AUTO-CLEARS the orphan cron ─────────────
        const toOneShot = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: { type: 'one-shot' },
        });
        expect(toOneShot.status()).toBe(200);
        const oneShotBody: MissionDto = await toOneShot.json();
        expect(oneShotBody.type).toBe('one-shot');
        expect(oneShotBody.schedule).toBeNull();

        // ── PATCH guardrailsOverride + outstandingIdeasCap round-trips ───
        const nextGuardrails = { maxWorksPerRun: 2, allowAutoMerge: true };
        const patchGuard = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: { guardrailsOverride: nextGuardrails, outstandingIdeasCap: 12 },
        });
        expect(patchGuard.status()).toBe(200);
        const guardBody: MissionDto = await patchGuard.json();
        expect(guardBody.guardrailsOverride).toEqual(nextGuardrails);
        expect(guardBody.outstandingIdeasCap).toBe(12);

        const afterGuard: MissionDto = await (
            await request.get(`${API_BASE}/api/me/missions/${mission.id}`, { headers })
        ).json();
        expect(afterGuard.guardrailsOverride).toEqual(nextGuardrails);
        expect(afterGuard.outstandingIdeasCap).toBe(12);

        // ── PATCH on unknown / malformed ids ─────────────────────────────
        const patchMissing = await request.patch(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}`, {
            headers,
            data: { title: 'nope' },
        });
        expect(patchMissing.status()).toBe(404);
        const patchBadId = await request.patch(`${API_BASE}/api/me/missions/not-a-uuid`, {
            headers,
            data: { title: 'nope' },
        });
        expect(patchBadId.status()).toBe(400);
    });

    /**
     * Flow 3 — Cross-user isolation + list scoping. A second user can neither
     * read, mutate, nor clone the owner's Mission, and `GET /api/me/missions`
     * is strictly owner-scoped.
     */
    test('cross-user isolation: a stranger cannot read, patch, or clone; list is owner-scoped', async ({
        request,
    }) => {
        // The OWNER is the seeded UI user (so this asserts isolation against
        // a real, persistent account). All mutations land on the owner.
        const ownerToken = await seededToken(request);
        const ownerHeaders = authedHeaders(ownerToken);
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        const mission = await createMission(request, ownerToken, {
            title: `Private Mission ${stamp}`,
            description: `owned by seeded user ${stamp}`,
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 4 },
        });
        expect(mission.id).toMatch(UUID_RE);

        // A brand-new stranger.
        const stranger = await registerUserViaAPI(request);
        const strangerHeaders = authedHeaders(stranger.access_token);

        // GET by id → 404 with the opaque "Mission not found" (no leak of
        // whether the id exists).
        const strangerGet = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: strangerHeaders,
        });
        expect(strangerGet.status()).toBe(404);
        expect((await strangerGet.json()).message).toMatch(/not found/i);

        // The stranger's list does NOT contain the owner's Mission. (Brand-new
        // user → starts empty, but assert containment-negative to be robust
        // against the shared DB rather than asserting an exact length.)
        const strangerList = await request.get(`${API_BASE}/api/me/missions`, {
            headers: strangerHeaders,
        });
        expect(strangerList.status()).toBe(200);
        const strangerMissions: MissionDto[] = await strangerList.json();
        expect(strangerMissions.map((m) => m.id)).not.toContain(mission.id);
        // Everything the stranger CAN see is theirs — never the owner's.
        for (const m of strangerMissions) {
            expect(m.id).not.toBe(mission.id);
        }

        // PATCH → 404 (cannot mutate someone else's Mission).
        const strangerPatch = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: strangerHeaders,
            data: { title: 'hijacked' },
        });
        expect(strangerPatch.status()).toBe(404);

        // CLONE → 404 (cannot fork someone else's Mission; the clone service
        // loads the source scoped to the caller's userId and 404s when absent).
        const strangerClone = await request.post(
            `${API_BASE}/api/me/missions/${mission.id}/clone`,
            { headers: strangerHeaders, data: {} },
        );
        expect(strangerClone.status()).toBe(404);

        // Lifecycle transitions are equally gated.
        const strangerComplete = await request.post(
            `${API_BASE}/api/me/missions/${mission.id}/complete`,
            { headers: strangerHeaders },
        );
        expect(strangerComplete.status()).toBe(404);

        // The owner still sees the Mission, intact, with its original title.
        const ownerList = await request.get(`${API_BASE}/api/me/missions`, {
            headers: ownerHeaders,
        });
        expect(ownerList.status()).toBe(200);
        const ownerMissions: MissionDto[] = await ownerList.json();
        const stillThere = ownerMissions.find((m) => m.id === mission.id);
        expect(stillThere, 'owner should still see their Mission').toBeTruthy();
        expect(stillThere!.title).toBe(`Private Mission ${stamp}`);
        // Untouched by the stranger's PATCH attempt.
        expect(stillThere!.title).not.toBe('hijacked');
    });
});
