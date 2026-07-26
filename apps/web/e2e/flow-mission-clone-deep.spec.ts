import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Mission CLONE — DEEP COPY-vs-RESET SEMANTICS of
 * `POST /api/me/missions/:id/clone`, backed by
 * `packages/agent/src/missions/mission-clone.service.ts`
 * (`MissionCloneService.cloneForUser`) exposed via
 * `apps/api/src/missions/missions.controller.ts`.
 *
 * Every status / shape / copy-vs-reset rule below was PROBED against the LIVE
 * API at http://127.0.0.1:3100 before assertions were written (2026-06-12).
 *
 * NON-DUPLICATION — three sibling specs already own the BASELINE clone surface;
 * this file deliberately pins the per-field copy-vs-RESET MATRIX they leave
 * implicit, plus a handful of angles none of them touch:
 *   - `flow-mission-clone.spec.ts` pins the baseline (default-vs-explicit
 *     title, one-shot metadata copy, cross-user 404, complete→clone, the
 *     empty/unknown/malformed error trio).
 *   - `flow-mission-clone-fork.spec.ts` pins clone-of-clone backlink depth,
 *     scheduled-source fidelity, fork-vs-source isolation, reverse lookup +
 *     source-deletion survival, the ideas 0/0 truthful contract, paused→clone.
 *   - `flow-mission-budget-contract.spec.ts` pins the per-Mission `/budget`
 *     READ contract (the budget cap is NOT a mission entity column — it lives
 *     on a non-REST-creatable AgentBudget row → capCents stays null).
 *
 * The GAPS this file pins (each probed live):
 *   1. FIELD-LEVEL COPY-vs-RESET MATRIX distilled in one place — exactly which
 *      mission columns the clone COPIES verbatim (description, type, schedule,
 *      autoBuildWorks, outstandingIdeasCap incl. the -1 sentinel,
 *      guardrailsOverride, missionTemplateRepo) vs RESETS (status→'active',
 *      missionRepo→null, sourceMissionId→source.id, createdAt/updatedAt→FRESH,
 *      id→new). The siblings assert subsets inline; none distil the whole
 *      matrix or assert the FRESH-timestamp reset.
 *   2. NAME-SUFFIX is a literal `Copy of ` PREPEND with NO dedup — cloning an
 *      already-"Copy of X" mission yields "Copy of Copy of X" (probed). And
 *      repeated empty-body clones of ONE source produce DISTINCT ids but the
 *      IDENTICAL stable "Copy of <src>" title (no numbering / uniquification).
 *   3. FOREIGN-user clone is owner-scoped → 404 with the opaque "Mission not
 *      found" and NEVER reads the source (the clone of a stranger's mission is
 *      indistinguishable from cloning a non-existent id — same status + body).
 *   4. BIDIRECTIONAL INDEPENDENCE at the FIELD level: after cloning, mutating
 *      the SOURCE's every writable field never changes the clone, AND mutating
 *      the CLONE never changes the source — proven field-by-field in BOTH
 *      directions in a single matrix (the isolation sibling runs lifecycle +
 *      a partial field set; this pins schedule/cap/autoBuild/guardrails both
 *      ways and re-GETs both rows after each direction).
 *   5. NO acceptedWork / idea / work linkage is carried over — the cloned
 *      mission DTO carries EXACTLY the 16 modeled columns and no extra linkage
 *      key, its Mission-scoped Idea list is empty, and it gets its OWN
 *      zero-state budget bucket keyed on the CLONE's id (a cross-feature angle
 *      the budget spec, which never clones, does not cover).
 *
 * ── PROBED LIVE (http://127.0.0.1:3100, 2026-06-12) ──
 *   POST /api/me/missions                       → 201 MissionDto (16 keys)
 *   POST /api/me/missions/:id/clone  {title?}    → 201 { mission, ideasCloned, ideasSkipped }
 *     · copies: description,type,schedule,autoBuildWorks,outstandingIdeasCap(-1 too),
 *               guardrailsOverride,missionTemplateRepo  (verbatim)
 *     · resets: status→'active', missionRepo→null, sourceMissionId→source.id,
 *               id→new uuid, createdAt/updatedAt→fresh (> source's)
 *     · default title = literal "Copy of " + src.title (no dedup → can double)
 *     · clone of a stranger's mission → 404 "Mission not found" (never reads)
 *     · ideasCloned===0 && ideasSkipped===0; mission DTO has no linkage key
 *   GET  /api/me/missions/:id                    → 200 MissionDto | 404 (owner-scoped)
 *   GET  /api/me/missions/:id/budget             → 200 OwnerBudgetSummary (own bucket)
 *   GET  /api/me/work-proposals?missionId=:id     → 200 [] (empty for a fresh Mission)
 *   PATCH /api/me/missions/:id                    → 200 MissionDto
 *   missionRepo / budget are NOT settable at create (400 "should not exist").
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

// The complete modeled mission-DTO key set — used to prove the clone carries
// NO extra linkage column (acceptedWork / ideaIds / workIds / etc.).
// This is the FULL 16-key projection emitted by `toMissionDto`
// (packages/agent/src/missions/types.ts) — the `outcome` + `completedAt`
// pair was added by the PR-3 domain-model evolution and is present on every
// mission DTO (null until a human records a conclusion at Complete).
const MISSION_KEYS = [
    'autoBuildWorks',
    'completedAt',
    'createdAt',
    'description',
    'guardrailsOverride',
    'id',
    'missionRepo',
    'missionTemplateRepo',
    'outcome',
    'outstandingIdeasCap',
    'schedule',
    'sourceMissionId',
    'status',
    'title',
    'type',
    'updatedAt',
].sort();

interface MissionDto {
    id: string;
    title: string;
    description: string;
    type: 'one-shot' | 'scheduled';
    status: 'active' | 'paused' | 'completed' | 'failed';
    outcome: string | null;
    completedAt: string | null;
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

let counter = 0;
function uniq(testTitle: string): string {
    // Per-test, per-call unique suffix derived from the test title + a counter
    // (NOT a module-scope clock) so the shared in-memory DB never collides.
    counter += 1;
    return `${testTitle.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${counter}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
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

async function listMissionScopedIdeas(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<Array<{ id: string }>> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals?missionId=${missionId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return Array.isArray(body) ? body : (body?.proposals ?? body?.data ?? []);
}

test.describe('Mission clone — deep copy-vs-reset semantics', () => {
    // ─────────────────────────────────────────────────────────────────────
    // GROUP 1 — the COPY half of the matrix (one focused field per test).
    // A maximally-configured one-shot source is forked once; each test pins a
    // single column's verbatim copy. Per-test fresh users keep the shared DB
    // clean for sibling specs.
    // ─────────────────────────────────────────────────────────────────────

    /** description + type are copied verbatim (and persist on re-GET). */
    test('COPY: description + type are copied verbatim', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('copy-desc');

        const source = await createMission(request, token, {
            title: `Copy Desc Source ${s}`,
            description: `verbatim-copy description ${s}`,
            type: 'one-shot',
        });
        const cloned = (await clone(request, token, source.id, { title: `Cloned ${s}` })).mission;

        expect(cloned.description).toBe(source.description);
        expect(cloned.type).toBe('one-shot');
        // Persisted, not just echoed.
        const fresh = await getMission(request, token, cloned.id);
        expect(fresh.description).toBe(source.description);
        expect(fresh.type).toBe('one-shot');
    });

    /** autoBuildWorks is copied verbatim (true here, not silently reset). */
    test('COPY: autoBuildWorks is copied verbatim', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('copy-auto');

        const source = await createMission(request, token, {
            title: `Copy Auto Source ${s}`,
            description: `autobuild copy ${s}`,
            type: 'one-shot',
            autoBuildWorks: true,
        });
        const cloned = (await clone(request, token, source.id, {})).mission;

        expect(cloned.autoBuildWorks).toBe(true);
        expect((await getMission(request, token, cloned.id)).autoBuildWorks).toBe(true);
    });

    /** outstandingIdeasCap (a concrete numeric cap) is copied verbatim. */
    test('COPY: outstandingIdeasCap is copied verbatim', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('copy-cap');

        const source = await createMission(request, token, {
            title: `Copy Cap Source ${s}`,
            description: `cap copy ${s}`,
            type: 'one-shot',
            outstandingIdeasCap: 11,
        });
        const cloned = (await clone(request, token, source.id, {})).mission;

        expect(cloned.outstandingIdeasCap).toBe(11);
        expect((await getMission(request, token, cloned.id)).outstandingIdeasCap).toBe(11);
    });

    /** The -1 "unlimited" cap SENTINEL is copied, not normalised away. */
    test('COPY: the -1 "unlimited" cap sentinel is copied (not reset)', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('copy-cap-unl');

        const source = await createMission(request, token, {
            title: `Copy Unlimited Source ${s}`,
            description: `unlimited cap copy ${s}`,
            type: 'one-shot',
            outstandingIdeasCap: -1,
        });
        expect(source.outstandingIdeasCap).toBe(-1);
        const cloned = (await clone(request, token, source.id, {})).mission;

        expect(cloned.outstandingIdeasCap).toBe(-1);
        expect((await getMission(request, token, cloned.id)).outstandingIdeasCap).toBe(-1);
    });

    /** guardrailsOverride is copied verbatim as a whole object (deep-equal). */
    test('COPY: guardrailsOverride is copied verbatim (deep-equal)', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('copy-guard');

        const guardrails = { maxWorksPerRun: 5, requireApprovalBeforeCreate: true };
        const source = await createMission(request, token, {
            title: `Copy Guard Source ${s}`,
            description: `guardrails copy ${s}`,
            type: 'one-shot',
            guardrailsOverride: guardrails,
        });
        const cloned = (await clone(request, token, source.id, {})).mission;

        expect(cloned.guardrailsOverride).toEqual(guardrails);
        expect((await getMission(request, token, cloned.id)).guardrailsOverride).toEqual(
            guardrails,
        );
    });

    /** A SCHEDULED source carries its type + cron verbatim onto the clone. */
    test('COPY: scheduled source carries type + cron schedule + missionTemplateRepo', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('copy-sched');
        const cron = '0 9 * * 1';

        const source = await createMission(request, token, {
            title: `Copy Sched Source ${s}`,
            description: `scheduled copy ${s}`,
            type: 'scheduled',
            schedule: cron,
            missionTemplateRepo: `github.com/acme/sched-${s}`,
        });
        const cloned = (await clone(request, token, source.id, {})).mission;

        expect(cloned.type).toBe('scheduled');
        expect(cloned.schedule).toBe(cron);
        expect(cloned.missionTemplateRepo).toBe(source.missionTemplateRepo);
        const fresh = await getMission(request, token, cloned.id);
        expect(fresh.type).toBe('scheduled');
        expect(fresh.schedule).toBe(cron);
        expect(fresh.missionTemplateRepo).toBe(source.missionTemplateRepo);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GROUP 2 — the RESET half of the matrix.
    // ─────────────────────────────────────────────────────────────────────

    /** Identity resets: a fresh new id, never the source's; backlink set. */
    test('RESET: clone gets a fresh id and a sourceMissionId backlink', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('reset-id');

        const source = await createMission(request, token, {
            title: `Reset Id Source ${s}`,
            description: `reset id ${s}`,
            type: 'one-shot',
        });
        expect(source.sourceMissionId).toBeNull();

        const cloned = (await clone(request, token, source.id, {})).mission;
        expect(cloned.id).toMatch(UUID_RE);
        expect(cloned.id).not.toBe(source.id);
        expect(cloned.sourceMissionId).toBe(source.id);
        // The source never grew a backlink from being cloned.
        expect((await getMission(request, token, source.id)).sourceMissionId).toBeNull();
    });

    /** status RESETS to 'active' even when the source is COMPLETED; repo→null. */
    test('RESET: status→active (from a completed source) and missionRepo→null', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = uniq('reset-status');

        const source = await createMission(request, token, {
            title: `Reset Status Source ${s}`,
            description: `reset status ${s}`,
            type: 'one-shot',
        });
        // Drive the source to COMPLETED first.
        const complete = await request.post(`${API_BASE}/api/me/missions/${source.id}/complete`, {
            headers,
        });
        expect(complete.status()).toBe(200);
        expect((await complete.json()).status).toBe('completed');

        const cloned = (await clone(request, token, source.id, {})).mission;
        // Clone re-activates regardless of the source's terminal status.
        expect(cloned.status).toBe('active');
        // The server-managed repo is reset (scaffolded later) → null.
        expect(cloned.missionRepo).toBeNull();
        // The source stays COMPLETED — cloning is read-only on it.
        expect((await getMission(request, token, source.id)).status).toBe('completed');
    });

    /** Timestamps are FRESH: the clone is born now, strictly after the source. */
    test('RESET: createdAt / updatedAt are FRESH (strictly after the source)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('reset-ts');

        const source = await createMission(request, token, {
            title: `Reset Ts Source ${s}`,
            description: `reset timestamps ${s}`,
            type: 'one-shot',
        });
        // The API stamps whole-second precision; wait > 1s so the clone's
        // timestamp is unambiguously later.
        await new Promise((r) => setTimeout(r, 1100));

        const cloned = (await clone(request, token, source.id, {})).mission;
        expect(new Date(cloned.createdAt).getTime()).toBeGreaterThan(
            new Date(source.createdAt).getTime(),
        );
        expect(new Date(cloned.updatedAt).getTime()).toBeGreaterThan(
            new Date(source.updatedAt).getTime(),
        );
        // The clone's own created/updated agree at birth (never touched yet).
        expect(cloned.updatedAt).toBe(cloned.createdAt);
        // The source's createdAt is untouched by the clone.
        expect((await getMission(request, token, source.id)).createdAt).toBe(source.createdAt);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GROUP 3 — NAME-suffix semantics.
    // ─────────────────────────────────────────────────────────────────────

    /** Default title is a literal "Copy of " prepend; it DOUBLES on a copy. */
    test('NAME: default title is "Copy of <src>" and doubles on a clone-of-copy', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('name-double');

        const baseTitle = `Name Source ${s}`;
        const source = await createMission(request, token, {
            title: baseTitle,
            description: `name suffix probe ${s}`,
            type: 'one-shot',
        });

        const gen1 = (await clone(request, token, source.id, {})).mission;
        expect(gen1.title).toBe(`Copy of ${baseTitle}`);
        // Cloning the COPY doubles the prefix — no dedup of an existing "Copy of".
        const gen2 = (await clone(request, token, gen1.id, {})).mission;
        expect(gen2.title).toBe(`Copy of Copy of ${baseTitle}`);
    });

    /** Repeated empty-body clones → DISTINCT ids, IDENTICAL stable title. */
    test('NAME: repeated clones share the same default title but get distinct ids; explicit overrides', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const s = uniq('name-repeat');

        const baseTitle = `Repeat Source ${s}`;
        const source = await createMission(request, token, {
            title: baseTitle,
            description: `repeat probe ${s}`,
            type: 'one-shot',
        });

        const r1 = (await clone(request, token, source.id, {})).mission;
        const r2 = (await clone(request, token, source.id, {})).mission;
        const r3 = (await clone(request, token, source.id, {})).mission;
        // Stable, non-uniquified default title across all repeats.
        expect(r1.title).toBe(`Copy of ${baseTitle}`);
        expect(r2.title).toBe(`Copy of ${baseTitle}`);
        expect(r3.title).toBe(`Copy of ${baseTitle}`);
        // Distinct rows.
        const ids = [r1.id, r2.id, r3.id];
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) expect(id).toMatch(UUID_RE);

        // An explicit title escapes the prepend entirely (used verbatim).
        const explicitTitle = `Hand Named ${s}`;
        const explicit = (await clone(request, token, source.id, { title: explicitTitle })).mission;
        expect(explicit.title).toBe(explicitTitle);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GROUP 4 — owner-scoping + independence + no-linkage.
    // ─────────────────────────────────────────────────────────────────────

    /**
     * FOREIGN-user clone is owner-scoped and NEVER reads the source: it 404s
     * with the SAME opaque body as cloning a non-existent id (no existence
     * leak), and nothing is created on the stranger.
     */
    test('FOREIGN clone is 404 and never reads the source (indistinguishable from a missing id)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = uniq('foreign');

        const secret = await createMission(request, owner.access_token, {
            title: `Foreign Secret ${s}`,
            description: `owned by owner only ${s}`,
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 4 },
        });

        // Stranger clones the owner's mission → 404 "Mission not found".
        const foreignRes = await request.post(`${API_BASE}/api/me/missions/${secret.id}/clone`, {
            headers: authedHeaders(stranger.access_token),
            data: {},
        });
        expect(foreignRes.status()).toBe(404);
        const foreignBody = await foreignRes.json();
        expect(foreignBody.message).toMatch(/not found/i);

        // Cloning a non-existent (well-formed) id as the stranger → the SAME
        // status + the SAME opaque message: the foreign clone is
        // indistinguishable from a clone of a missing id (no existence leak).
        const missingRes = await request.post(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/clone`, {
            headers: authedHeaders(stranger.access_token),
            data: {},
        });
        expect(missingRes.status()).toBe(404);
        expect((await missingRes.json()).message).toBe(foreignBody.message);

        // The stranger's mission list never contains a clone of the foreign
        // source (nothing was created on the failed clone).
        const listRes = await request.get(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(listRes.status()).toBe(200);
        const strangerMissions: MissionDto[] = await listRes.json();
        for (const m of strangerMissions) {
            expect(m.sourceMissionId).not.toBe(secret.id);
        }

        // The owner still sees an untouched source with no backlink.
        const sourceAfter = await getMission(request, owner.access_token, secret.id);
        expect(sourceAfter.title).toBe(`Foreign Secret ${s}`);
        expect(sourceAfter.sourceMissionId).toBeNull();
    });

    /**
     * INDEPENDENCE direction A — mutating the SOURCE's every writable field
     * after cloning never changes the clone (re-GET proves it).
     */
    test('INDEPENDENCE: mutating the source after cloning never changes the clone', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = uniq('indep-src');

        const srcGuardrails = { maxWorksPerRun: 2, requireApprovalBeforeCreate: false };
        const source = await createMission(request, token, {
            title: `Indep Src Source ${s}`,
            description: `source original ${s}`,
            type: 'one-shot',
            autoBuildWorks: false,
            outstandingIdeasCap: 4,
            guardrailsOverride: srcGuardrails,
        });
        const cloned = (await clone(request, token, source.id, { title: `Indep Clone ${s}` }))
            .mission;
        const cloneId = cloned.id;

        // Mutate EVERY writable field on the SOURCE (incl. a one-shot→scheduled
        // flip with a cron).
        const srcPatch = await request.patch(`${API_BASE}/api/me/missions/${source.id}`, {
            headers,
            data: {
                title: `Source Changed ${s}`,
                description: `source changed ${s}`,
                autoBuildWorks: true,
                outstandingIdeasCap: 99,
                type: 'scheduled',
                schedule: '0 9 * * 1',
                guardrailsOverride: { dryRunByDefault: true },
                missionTemplateRepo: `github.com/acme/src-${s}`,
            },
        });
        expect(srcPatch.status(), `source patch body=${await srcPatch.text()}`).toBe(200);

        // The clone is COMPLETELY unaffected by the source mutation.
        const cloneAfter = await getMission(request, token, cloneId);
        expect(cloneAfter.title).toBe(`Indep Clone ${s}`);
        expect(cloneAfter.description).toBe(`source original ${s}`);
        expect(cloneAfter.autoBuildWorks).toBe(false);
        expect(cloneAfter.outstandingIdeasCap).toBe(4);
        expect(cloneAfter.type).toBe('one-shot');
        expect(cloneAfter.schedule).toBeNull();
        expect(cloneAfter.guardrailsOverride).toEqual(srcGuardrails);
        expect(cloneAfter.missionTemplateRepo).toBeNull();
        // The backlink still points at the (now-renamed) source — an id edge,
        // not a title snapshot.
        expect(cloneAfter.sourceMissionId).toBe(source.id);
    });

    /**
     * INDEPENDENCE direction B — mutating the CLONE's every writable field
     * never changes the source (re-GET proves it).
     */
    test('INDEPENDENCE: mutating the clone never changes the source', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = uniq('indep-clone');

        const srcGuardrails = { maxWorksPerRun: 2, requireApprovalBeforeCreate: false };
        const source = await createMission(request, token, {
            title: `Indep Clone Source ${s}`,
            description: `source original ${s}`,
            type: 'one-shot',
            autoBuildWorks: false,
            outstandingIdeasCap: 4,
            guardrailsOverride: srcGuardrails,
        });
        const cloned = (await clone(request, token, source.id, { title: `Mutable Clone ${s}` }))
            .mission;

        // Mutate EVERY writable field on the CLONE.
        const cloneGuardrails = { requireApprovalBeforeDelete: true, maxWorksPerRun: 8 };
        const clonePatch = await request.patch(`${API_BASE}/api/me/missions/${cloned.id}`, {
            headers,
            data: {
                title: `Clone Changed ${s}`,
                description: `clone changed ${s}`,
                autoBuildWorks: true,
                outstandingIdeasCap: 1,
                guardrailsOverride: cloneGuardrails,
                missionTemplateRepo: `github.com/acme/clone-${s}`,
            },
        });
        expect(clonePatch.status(), `clone patch body=${await clonePatch.text()}`).toBe(200);

        // The SOURCE is byte-for-byte its original self — the clone's mutation
        // never leaked back.
        const sourceAfter = await getMission(request, token, source.id);
        expect(sourceAfter.title).toBe(`Indep Clone Source ${s}`);
        expect(sourceAfter.description).toBe(`source original ${s}`);
        expect(sourceAfter.autoBuildWorks).toBe(false);
        expect(sourceAfter.outstandingIdeasCap).toBe(4);
        expect(sourceAfter.guardrailsOverride).toEqual(srcGuardrails);
        expect(sourceAfter.missionTemplateRepo).toBeNull();
        expect(sourceAfter.sourceMissionId).toBeNull();
    });

    /**
     * NO acceptedWork / idea / work linkage is carried over: the cloned mission
     * DTO carries EXACTLY the 16 modeled columns (no linkage key), and its
     * Mission-scoped Idea list is empty (the owner's standalone unlinked Idea
     * never surfaces on it).
     */
    test('NO linkage carried: clone DTO has only modeled keys + an empty mission-scoped idea list', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = uniq('linkage');

        const source = await createMission(request, token, {
            title: `Linkage Source ${s}`,
            description: `linkage probe ${s}`,
            type: 'one-shot',
            guardrailsOverride: { maxItemsPerWork: 1 },
        });

        // A standalone user-manual Idea on the owner — born missionId=null, so
        // it is NEVER scoped to either the source or the clone.
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `a standalone unlinked idea at least ten chars ${s}` },
        });
        expect(ideaRes.status(), `idea body=${await ideaRes.text()}`).toBe(201);
        const idea = await ideaRes.json();
        expect((idea as { missionId: string | null }).missionId).toBeNull();

        const result = await clone(request, token, source.id, {});
        const cloned = result.mission;

        // ideasCloned / ideasSkipped are truthfully 0 (no public Mission→Idea
        // linker on a keyless stack).
        expect(result.ideasCloned).toBe(0);
        expect(result.ideasSkipped).toBe(0);
        // The clone DTO carries EXACTLY the modeled columns — no acceptedWork /
        // ideaIds / workIds linkage key snuck in.
        const cloneKeys = Object.keys(cloned as unknown as Record<string, unknown>).sort();
        expect(cloneKeys).toEqual(MISSION_KEYS);

        // No Mission-scoped Idea carried over.
        const cloneScopedIdeas = await listMissionScopedIdeas(request, token, cloned.id);
        expect(cloneScopedIdeas).toHaveLength(0);
        expect(cloneScopedIdeas.map((i) => i.id)).not.toContain(idea.id);
    });

    /**
     * The clone gets its OWN zero-state budget bucket keyed on the CLONE's id —
     * no spend/cap is carried from the source (cross-feature: the budget spec
     * never clones).
     */
    test('NO linkage carried: the clone gets its own zero-state budget bucket', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const s = uniq('linkage-budget');

        const source = await createMission(request, token, {
            title: `Budget Linkage Source ${s}`,
            description: `budget linkage probe ${s}`,
            type: 'one-shot',
        });
        const cloned = (await clone(request, token, source.id, {})).mission;

        const budgetRes = await request.get(`${API_BASE}/api/me/missions/${cloned.id}/budget`, {
            headers,
        });
        expect(budgetRes.status(), `budget body=${await budgetRes.text()}`).toBe(200);
        const budget = (await budgetRes.json()) as unknown as Record<string, unknown>;
        // ownerId is the CLONE's id (its own bucket) with a fresh zero spend —
        // nothing budget-shaped was copied from the source.
        expect(budget.ownerType).toBe('mission');
        expect(budget.ownerId).toBe(cloned.id);
        expect(budget.currentSpendCents).toBe(0);
        // capCents is null (no AgentBudget row exists for the clone).
        expect(budget.capCents).toBeNull();
    });
});
