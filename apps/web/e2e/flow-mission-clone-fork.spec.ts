import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Mission CLONE (FULL FORK) — DEEP cross-feature END-TO-END integration of
 * `POST /api/me/missions/:id/clone`, backed by
 * `packages/agent/src/missions/mission-clone.service.ts`
 * (`MissionCloneService.cloneForUser`) and exposed by
 * `apps/api/src/missions/missions.controller.ts`.
 *
 * SIBLING: `flow-mission-clone.spec.ts` already pins the *baseline* clone
 * contract (default-vs-explicit title, metadata copy on a ONE-SHOT source,
 * cross-user 404 isolation, complete→clone re-activation, the empty/unknown/
 * malformed-id error trio). This file deliberately covers the gaps that spec
 * does NOT touch:
 *
 *   1. CLONE-OF-CLONE (grandchild) — the `sourceMissionId` backlink points at
 *      the IMMEDIATE parent, never transitively at the original; metadata
 *      propagates verbatim down the whole chain (probed live).
 *   2. SCHEDULED-source fidelity — a `type:'scheduled'` source carries its cron
 *      + the -1 "unlimited" cap + `missionTemplateRepo` verbatim, while
 *      `missionRepo` always resets to null (the sibling only ever forked a
 *      one-shot and never asserted schedule / templateRepo carry-over).
 *   3. CLONE ISOLATION — heavily mutating the fork (title/desc/autoBuild/
 *      guardrails/cap) and running its lifecycle leaves the source BYTE-for-byte
 *      unchanged, and vice-versa.
 *   4. BACKLINK + reverse "find all clones" lookup, and what happens to the
 *      backlink when the source is DELETED (FK is ON DELETE SET NULL per
 *      migration 1779978009000 — but the sqlite CI driver does not enforce FK
 *      cascades, so the backlink DANGLES here; asserted tolerantly).
 *   5. IDEAS-copy truthful contract — `ideasCloned`/`ideasSkipped` are both 0
 *      because the public API has no way to attach an Idea to a Mission
 *      (user-manual Ideas are born missionId=null; the only Mission→Idea linker
 *      is the AI tick, a no-op without an LLM key on this stack). The flow pins
 *      the empty Mission-scoped Idea list on BOTH source and clone, and anchors
 *      the "non-DISMISSED ideas would clone as PENDING, DISMISSED are skipped"
 *      design to the REAL dismiss 204/404 contract on a standalone Idea.
 *   6. STATUS-RESET on a non-active source — cloning a PAUSED source yields an
 *      ACTIVE fork while the source stays PAUSED; plus the title-override
 *      variants (explicit, whitespace→default) and the unauth 401 gate.
 *
 * ── PROBED LIVE (http://127.0.0.1:3100) before any assertion ──
 *   POST /api/me/missions                       → 201 MissionDto
 *   POST /api/me/missions/:id/clone  {title?}    → 201 { mission, ideasCloned, ideasSkipped }
 *     · default/empty/whitespace title → "Copy of <source.title>"
 *     · explicit title → used verbatim (DTO MinLength(1)/MaxLength(200); 201>=1, 400@201chars)
 *     · clone always status:'active', missionRepo:null, sourceMissionId = parent id
 *     · scheduled source → type+schedule carried; -1 cap + missionTemplateRepo carried
 *     · clone-of-clone backlink → IMMEDIATE parent (one level, not transitive)
 *     · ideasCloned===0 && ideasSkipped===0 (no public Mission→Idea linker)
 *     · unknown uuid → 404, malformed id → 400, no auth → 401
 *   GET  /api/me/missions/:id                    → 200 MissionDto | 404 (owner-scoped)
 *   GET  /api/me/missions                        → 200 MissionDto[] (owner-scoped)
 *   DELETE /api/me/missions/:id                  → 200 { deleted:true }; clone survives
 *   POST /api/me/missions/:id/pause|complete     → 200 MissionDto
 *   POST /api/me/work-proposals {description}     → 201; missionId ALWAYS null, status 'pending'
 *   GET  /api/me/work-proposals?missionId=:id     → 200 [] (empty for a fresh Mission)
 *   PATCH /api/me/work-proposals/:id/dismiss      → 204 (pending) then 404 (already dismissed)
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

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted — ONLY {email,password} (a `name` field 400s).
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

async function clone(
    request: APIRequestContext,
    token: string,
    missionId: string,
    body: Record<string, unknown> = {},
): Promise<CloneResult> {
    const res = await request.post(`${API_BASE}/api/me/missions/${missionId}/clone`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `clone body=${await res.text()}`).toBe(201);
    return res.json();
}

async function getMission(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<MissionDto> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `getMission body=${await res.text()}`).toBe(200);
    return res.json();
}

async function listMissions(request: APIRequestContext, token: string): Promise<MissionDto[]> {
    const res = await request.get(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

async function listMissionScopedIdeas(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<Array<{ id: string; missionId: string | null; status: string }>> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals?missionId=${missionId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return Array.isArray(body) ? body : (body?.proposals ?? body?.data ?? []);
}

test.describe('Mission clone (full fork) — deep integration', () => {
    /**
     * Flow 1 — CLONE-OF-CLONE. A three-generation chain
     * (source → child → grandchild). The grandchild's `sourceMissionId`
     * points at its IMMEDIATE parent (the child), NOT transitively at the
     * original source — the backlink is a single edge, the lineage is a
     * chain you walk one hop at a time. Metadata propagates verbatim the
     * whole way down; every generation is its own row with a fresh id and
     * its own ACTIVE status.
     */
    test('clone-of-clone: backlink points at the immediate parent, metadata propagates down the chain', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = stamp();

        const guardrails = { maxWorksPerRun: 3, requireApprovalBeforeCreate: false };
        const sourceTitle = `Chain Source ${s}`;
        const source = await createMission(request, token, {
            title: sourceTitle,
            description: `original chain description ${s}`,
            type: 'one-shot',
            autoBuildWorks: true,
            outstandingIdeasCap: 9,
            guardrailsOverride: guardrails,
            missionTemplateRepo: `github.com/acme/chain-${s}`,
        });
        expect(source.sourceMissionId).toBeNull();

        // ── Gen 2: child (explicit title) ───────────────────────────────
        const childTitle = `Child ${s}`;
        const child = await clone(request, token, source.id, { title: childTitle });
        expect(child.mission.id).toMatch(UUID_RE);
        expect(child.mission.id).not.toBe(source.id);
        expect(child.mission.title).toBe(childTitle);
        expect(child.mission.status).toBe('active');
        expect(child.mission.sourceMissionId).toBe(source.id);
        // Metadata copied verbatim onto gen-2.
        expect(child.mission.description).toBe(source.description);
        expect(child.mission.autoBuildWorks).toBe(true);
        expect(child.mission.outstandingIdeasCap).toBe(9);
        expect(child.mission.guardrailsOverride).toEqual(guardrails);
        expect(child.mission.missionTemplateRepo).toBe(source.missionTemplateRepo);
        expect(child.mission.missionRepo).toBeNull();

        // ── Gen 3: grandchild — clone the CHILD ─────────────────────────
        const grandTitle = `Grandchild ${s}`;
        const grand = await clone(request, token, child.mission.id, { title: grandTitle });
        expect(grand.mission.id).not.toBe(child.mission.id);
        expect(grand.mission.id).not.toBe(source.id);
        expect(grand.mission.title).toBe(grandTitle);
        expect(grand.mission.status).toBe('active');
        // THE key assertion: backlink is the IMMEDIATE parent (child),
        // NOT the original source — one hop, not transitive.
        expect(grand.mission.sourceMissionId).toBe(child.mission.id);
        expect(grand.mission.sourceMissionId).not.toBe(source.id);
        // Metadata still propagates verbatim two generations down.
        expect(grand.mission.description).toBe(source.description);
        expect(grand.mission.guardrailsOverride).toEqual(guardrails);
        expect(grand.mission.outstandingIdeasCap).toBe(9);
        expect(grand.mission.missionTemplateRepo).toBe(source.missionTemplateRepo);
        expect(grand.mission.missionRepo).toBeNull();

        // Persistence: a fresh GET on the grandchild confirms the backlink
        // edge survives a round-trip (not just an in-response artefact).
        const grandFresh = await getMission(request, token, grand.mission.id);
        expect(grandFresh.sourceMissionId).toBe(child.mission.id);

        // Walk the lineage one hop at a time and confirm it terminates at
        // the original source whose own backlink is null.
        const childFresh = await getMission(request, token, grandFresh.sourceMissionId!);
        expect(childFresh.id).toBe(child.mission.id);
        expect(childFresh.sourceMissionId).toBe(source.id);
        const sourceFresh = await getMission(request, token, childFresh.sourceMissionId!);
        expect(sourceFresh.id).toBe(source.id);
        expect(sourceFresh.sourceMissionId).toBeNull();

        // All three generations co-exist as distinct rows in the list.
        const ids = (await listMissions(request, token)).map((m) => m.id);
        expect(ids).toContain(source.id);
        expect(ids).toContain(child.mission.id);
        expect(ids).toContain(grand.mission.id);
    });

    /**
     * Flow 2 — SCHEDULED-source fidelity. The sibling spec only ever forked
     * a one-shot Mission. Here the source is a SCHEDULED Mission with a cron,
     * the -1 "unlimited" cap sentinel, and a `missionTemplateRepo`. The fork
     * must carry the cron + type + cap + templateRepo verbatim, reset
     * `missionRepo` to null, and start ACTIVE.
     */
    test('scheduled source: cron + type + unlimited-cap + missionTemplateRepo all carry; missionRepo resets', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = stamp();
        const cron = '0 9 * * 1';

        const source = await createMission(request, token, {
            title: `Scheduled Source ${s}`,
            description: `recurring curation ${s}`,
            type: 'scheduled',
            schedule: cron,
            autoBuildWorks: true,
            outstandingIdeasCap: -1, // "unlimited" sentinel
            guardrailsOverride: { maxWorksPerRun: 2 },
            missionTemplateRepo: `github.com/acme/sched-${s}`,
        });
        expect(source.type).toBe('scheduled');
        expect(source.schedule).toBe(cron);
        expect(source.outstandingIdeasCap).toBe(-1);
        expect(source.missionRepo).toBeNull();

        const forked = await clone(request, token, source.id, { title: `Forked Schedule ${s}` });
        // Scheduling identity carried verbatim — a scheduled clone is still
        // scheduled and keeps its cron (a clone is a runnable fork, not a
        // one-shot snapshot).
        expect(forked.mission.type).toBe('scheduled');
        expect(forked.mission.schedule).toBe(cron);
        expect(forked.mission.outstandingIdeasCap).toBe(-1);
        expect(forked.mission.autoBuildWorks).toBe(true);
        expect(forked.mission.guardrailsOverride).toEqual({ maxWorksPerRun: 2 });
        expect(forked.mission.missionTemplateRepo).toBe(source.missionTemplateRepo);
        // The fork gets its OWN repo at scaffold time → null until then,
        // regardless of the source's repo state.
        expect(forked.mission.missionRepo).toBeNull();
        // Status always resets to ACTIVE.
        expect(forked.mission.status).toBe('active');
        expect(forked.mission.sourceMissionId).toBe(source.id);

        // Re-GET confirms scheduled identity persisted, not just echoed.
        const forkedFresh = await getMission(request, token, forked.mission.id);
        expect(forkedFresh.type).toBe('scheduled');
        expect(forkedFresh.schedule).toBe(cron);
        expect(forkedFresh.outstandingIdeasCap).toBe(-1);
        expect(forkedFresh.missionTemplateRepo).toBe(source.missionTemplateRepo);
    });

    /**
     * Flow 3 — CLONE ISOLATION. After forking, mutate the clone heavily
     * (every writable field) AND run its lifecycle (pause → complete). The
     * source must be BYTE-for-byte unchanged. Then mutate the SOURCE and
     * prove the clone is likewise untouched — the two are fully independent
     * rows that merely share a backlink edge.
     */
    test('clone isolation: mutating + transitioning the fork never touches the source (and vice-versa)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        const originalGuardrails = { requireApprovalBeforeCreate: true, maxWorksPerRun: 4 };
        const source = await createMission(request, token, {
            title: `Isolation Source ${s}`,
            description: `pristine source description ${s}`,
            type: 'one-shot',
            autoBuildWorks: false,
            outstandingIdeasCap: 3,
            guardrailsOverride: originalGuardrails,
        });

        const fork = await clone(request, token, source.id, { title: `Fork ${s}` });
        const forkId = fork.mission.id;

        // ── Mutate EVERY writable field on the fork ─────────────────────
        const mutatedGuardrails = { dryRunByDefault: true, maxWorksPerRun: 9 };
        const patchFork = await request.patch(`${API_BASE}/api/me/missions/${forkId}`, {
            headers,
            data: {
                title: `Fork Mutated ${s}`,
                description: `fork changed ${s}`,
                autoBuildWorks: true,
                outstandingIdeasCap: 42,
                guardrailsOverride: mutatedGuardrails,
                missionTemplateRepo: `github.com/acme/fork-${s}`,
            },
        });
        expect(patchFork.status(), `patch fork body=${await patchFork.text()}`).toBe(200);

        // ── Run the fork's lifecycle: ACTIVE → PAUSED → COMPLETED ───────
        const pauseFork = await request.post(`${API_BASE}/api/me/missions/${forkId}/pause`, {
            headers,
        });
        expect(pauseFork.status()).toBe(200);
        expect((await pauseFork.json()).status).toBe('paused');
        const completeFork = await request.post(`${API_BASE}/api/me/missions/${forkId}/complete`, {
            headers,
        });
        expect(completeFork.status()).toBe(200);
        expect((await completeFork.json()).status).toBe('completed');

        // ── SOURCE must be completely untouched ─────────────────────────
        const sourceAfter = await getMission(request, token, source.id);
        expect(sourceAfter.title).toBe(`Isolation Source ${s}`);
        expect(sourceAfter.description).toBe(`pristine source description ${s}`);
        expect(sourceAfter.autoBuildWorks).toBe(false);
        expect(sourceAfter.outstandingIdeasCap).toBe(3);
        expect(sourceAfter.guardrailsOverride).toEqual(originalGuardrails);
        expect(sourceAfter.missionTemplateRepo).toBeNull();
        // The source is still ACTIVE — the fork's pause/complete never
        // leaked across the backlink edge.
        expect(sourceAfter.status).toBe('active');
        // And the source never grew a backlink of its own.
        expect(sourceAfter.sourceMissionId).toBeNull();

        // ── Now mutate the SOURCE; the (completed) fork stays frozen ─────
        // guardrailsOverride is a STRICT typed allowlist (WorkAgentGuardrailsDto):
        // only the canonical guardrail keys are accepted and any unknown key
        // (e.g. an arbitrary `sourceTouched`) is rejected 400 by the global
        // ValidationPipe (forbidNonWhitelisted) — verified live against the API.
        // Use a REAL allowlisted key that is deliberately DISTINCT from the
        // fork's guardrails so the isolation intent is preserved: mutating the
        // source's guardrails must not leak into the (independent) fork.
        const patchSource = await request.patch(`${API_BASE}/api/me/missions/${source.id}`, {
            headers,
            data: {
                title: `Source Mutated ${s}`,
                guardrailsOverride: { requireApprovalBeforeDelete: true },
            },
        });
        expect(patchSource.status()).toBe(200);

        const forkAfter = await getMission(request, token, forkId);
        expect(forkAfter.title).toBe(`Fork Mutated ${s}`);
        expect(forkAfter.guardrailsOverride).toEqual(mutatedGuardrails);
        expect(forkAfter.outstandingIdeasCap).toBe(42);
        expect(forkAfter.status).toBe('completed');
        // The fork still points at the source even after the source's title
        // changed — the backlink is an id edge, not a title snapshot.
        expect(forkAfter.sourceMissionId).toBe(source.id);
    });

    /**
     * Flow 4 — BACKLINK reverse-lookup + source DELETION. Fork a source
     * twice, then prove the "find all clones of this source" reverse lookup
     * (filter the owner's list by `sourceMissionId === source.id`) sees both
     * forks and never the source itself. Then DELETE the source: the forks
     * survive intact. The FK is declared ON DELETE SET NULL (migration
     * 1779978009000) but the sqlite CI driver does not enforce FK cascades —
     * so the backlink may DANGLE (still equal the deleted id) here while it
     * would be nulled on Postgres. Asserted tolerantly via `.or`-style logic.
     */
    test('reverse clone-lookup sees all forks; forks survive source deletion (dangling-or-null backlink)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = stamp();

        const source = await createMission(request, token, {
            title: `Reverse Source ${s}`,
            description: `source with two forks ${s}`,
            type: 'one-shot',
            guardrailsOverride: { dryRunByDefault: true },
        });

        const forkA = await clone(request, token, source.id, { title: `Fork A ${s}` });
        const forkB = await clone(request, token, source.id, { title: `Fork B ${s}` });
        expect(forkA.mission.id).not.toBe(forkB.mission.id);

        // Reverse lookup — both forks, never the source, point back at it.
        const beforeDelete = await listMissions(request, token);
        const clonesOfSource = beforeDelete.filter((m) => m.sourceMissionId === source.id);
        const cloneIds = clonesOfSource.map((m) => m.id).sort();
        expect(cloneIds).toEqual([forkA.mission.id, forkB.mission.id].sort());
        expect(cloneIds).not.toContain(source.id);

        // ── DELETE the source ───────────────────────────────────────────
        const del = await request.delete(`${API_BASE}/api/me/missions/${source.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect((await del.json()).deleted).toBe(true);
        // The source is gone — GET 404s.
        const goneGet = await request.get(`${API_BASE}/api/me/missions/${source.id}`, {
            headers: authedHeaders(token),
        });
        expect(goneGet.status()).toBe(404);

        // ── The forks SURVIVE the source deletion ───────────────────────
        const forkAAfter = await getMission(request, token, forkA.mission.id);
        const forkBAfter = await getMission(request, token, forkB.mission.id);
        // Their own data is intact (deleting the source never cascades into
        // the clones — Decision A25: a clone is fully independent).
        expect(forkAAfter.title).toBe(`Fork A ${s}`);
        expect(forkAAfter.guardrailsOverride).toEqual({ dryRunByDefault: true });
        expect(forkBAfter.title).toBe(`Fork B ${s}`);
        // The backlink is either nulled (Postgres ON DELETE SET NULL) OR
        // left dangling at the deleted id (sqlite CI driver — no FK cascade).
        // Both are acceptable; what matters is the row didn't disappear.
        for (const f of [forkAAfter, forkBAfter]) {
            const dangledOrNull = f.sourceMissionId === null || f.sourceMissionId === source.id;
            expect(
                dangledOrNull,
                `backlink should be null or the deleted source id, got ${f.sourceMissionId}`,
            ).toBe(true);
        }
    });

    /**
     * Flow 5 — IDEAS-copy truthful contract + title-override matrix + error
     * matrix. The clone service copies every NON-DISMISSED Idea as PENDING
     * and skips DISMISSED ones (Decision A25). But the public API has NO way
     * to attach an Idea to a Mission (user-manual Ideas are born
     * missionId=null; the only linker is the AI tick, a no-op without an LLM
     * key). So `ideasCloned`/`ideasSkipped` are necessarily 0 here — pinned
     * truthfully on both source and clone, alongside the empty Mission-scoped
     * Idea list. The dismiss 204→404 contract that the clone's
     * "skip DISMISSED" rule keys off is exercised directly on a standalone
     * Idea so the design intent is anchored to a REAL transition.
     */
    test('ideas-copy contract is truthful (0/0, empty scoped list); dismiss + title + error matrix', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = stamp();

        const source = await createMission(request, token, {
            title: `Ideas Source ${s}`,
            description: `mission with no linkable ideas ${s}`,
            type: 'one-shot',
            guardrailsOverride: { maxItemsPerWork: 1 },
        });

        // A standalone user-manual Idea — born missionId=null, status pending.
        // This is exactly why the clone can carry no Ideas via the public API.
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `a standalone idea that is at least ten chars long ${s}` },
        });
        expect(ideaRes.status(), `idea body=${await ideaRes.text()}`).toBe(201);
        const idea = await ideaRes.json();
        expect(idea.missionId).toBeNull();
        expect(idea.status).toBe('pending');
        // The source has ZERO Mission-scoped Ideas (the standalone one is
        // unlinked) → nothing for the clone to carry.
        expect(await listMissionScopedIdeas(request, token, source.id)).toHaveLength(0);

        // Exercise the dismiss transition the clone's "skip DISMISSED" rule
        // keys off: PENDING → dismiss → 204; a second dismiss → 404 (no
        // longer pending). This anchors A25's "DISMISSED ideas are filtered
        // out so cloning never resurfaces them as PENDING noise".
        const dismiss1 = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers },
        );
        expect(dismiss1.status()).toBe(204);
        const dismiss2 = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers },
        );
        expect(dismiss2.status()).toBe(404);

        // ── Title-override matrix ───────────────────────────────────────
        // (a) empty body → default "Copy of <source>" + truthful 0/0 ideas.
        const cloneDefault = await clone(request, token, source.id, {});
        expect(cloneDefault.mission.title).toBe(`Copy of Ideas Source ${s}`);
        expect(cloneDefault.ideasCloned).toBe(0);
        expect(cloneDefault.ideasSkipped).toBe(0);
        // The clone's Mission-scoped Idea list is also empty, and never
        // surfaces the unlinked standalone Idea.
        const cloneScoped = await listMissionScopedIdeas(request, token, cloneDefault.mission.id);
        expect(cloneScoped).toHaveLength(0);
        expect(cloneScoped.map((i) => i.id)).not.toContain(idea.id);

        // (b) whitespace-only title → trims to '' → falls back to default
        // (the service does `overrides.title?.trim() || "Copy of <src>"`).
        const cloneWs = await clone(request, token, source.id, { title: '   ' });
        expect(cloneWs.mission.title).toBe(`Copy of Ideas Source ${s}`);
        expect(cloneWs.ideasCloned).toBe(0);

        // (c) explicit title → used verbatim.
        const explicit = `Hand-Named Fork ${s}`;
        const cloneExplicit = await clone(request, token, source.id, { title: explicit });
        expect(cloneExplicit.mission.title).toBe(explicit);

        // ── Clone error matrix ──────────────────────────────────────────
        // unknown (well-formed) uuid → 404.
        const unknown = await request.post(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/clone`, {
            headers,
            data: {},
        });
        expect(unknown.status()).toBe(404);
        // malformed id → 400 (ParseUUIDPipe).
        const malformed = await request.post(`${API_BASE}/api/me/missions/not-a-uuid/clone`, {
            headers,
            data: {},
        });
        expect(malformed.status()).toBe(400);
        // over-long title (>200) → 400 (DTO MaxLength).
        const longTitle = 'z'.repeat(201);
        const tooLong = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            headers,
            data: { title: longTitle },
        });
        expect(tooLong.status()).toBe(400);
    });

    /**
     * Flow 6 — STATUS-RESET on a non-active source + unauth gate. Cloning a
     * PAUSED source yields an ACTIVE fork while the source STAYS paused (the
     * sibling spec only covered the COMPLETED→clone re-activation, never the
     * PAUSED case, and never asserted the source's post-clone status). Also
     * pins the 401 unauth gate and that the seeded UI user (storageState
     * account) can fork its own paused Mission — exercising the real
     * persistent account, not just throwaway API users.
     */
    test('clone of a PAUSED source re-activates the fork while the source stays paused; unauth 401', async ({
        request,
    }) => {
        // Owner = the seeded persistent UI account (so this asserts the
        // clone path against a real account, mirroring the sibling spec's
        // isolation flow which also uses the seeded user).
        const token = await seededToken(request);
        const headers = authedHeaders(token);
        const s = stamp();

        const source = await createMission(request, token, {
            title: `Pausable Source ${s}`,
            description: `will be paused before cloning ${s}`,
            type: 'one-shot',
            autoBuildWorks: true,
            guardrailsOverride: { requireApprovalBeforeDelete: true },
        });
        expect(source.status).toBe('active');

        // Pause the source.
        const pause = await request.post(`${API_BASE}/api/me/missions/${source.id}/pause`, {
            headers,
        });
        expect(pause.status()).toBe(200);
        expect((await pause.json()).status).toBe('paused');

        // Clone the PAUSED source → fork comes back ACTIVE (status reset).
        const fork = await clone(request, token, source.id, { title: `Revived Paused ${s}` });
        expect(fork.mission.status).toBe('active');
        expect(fork.mission.sourceMissionId).toBe(source.id);
        // Metadata still carried verbatim from a non-active source.
        expect(fork.mission.autoBuildWorks).toBe(true);
        expect(fork.mission.guardrailsOverride).toEqual({ requireApprovalBeforeDelete: true });

        // The source is STILL paused — cloning is read-only on the source.
        const sourceAfter = await getMission(request, token, source.id);
        expect(sourceAfter.status).toBe('paused');

        // ── Unauth gate: cloning with NO auth → 401, even for a well-formed
        // (but unknown) id, before any ownership/existence resolution. ───
        const anon = await request.post(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/clone`, {
            data: {},
        });
        expect(anon.status()).toBe(401);
        // And an unauth clone of the real (existing) source is equally 401 —
        // the auth guard runs before ownership, so it never leaks existence.
        const anonReal = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            data: {},
        });
        expect(anonReal.status()).toBe(401);
    });
});
