import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-mission-guardrails — COMPLEX, multi-step END-TO-END INTEGRATION flows
 * for the Mission `guardrailsOverride` policy envelope, the `missionTemplateRepo`
 * pointer, and the way both are persisted, snapshotted on clone, inherited, and
 * enforced. Drives the real Missions surface
 * (`apps/api/src/missions/missions.controller.ts` →
 * `@ever-works/agent/missions` MissionsService / MissionCloneService /
 * MissionTickService), the user-level guardrail prefs
 * (`apps/api/src/work-agent/work-agent.controller.ts` →
 * `GET|PUT /api/me/work-agent/preferences`), and the Mission-Templates catalog
 * filter (`GET /api/templates?kind=mission`).
 *
 * Every request/response shape, status code, and error string asserted below
 * was PROBED against the LIVE API at http://127.0.0.1:3100 before being written
 * (2026-06-01).
 *
 * NET-NEW vs the two sibling Mission specs (no overlap):
 *   - `flow-mission-clone.spec.ts`  pins clone metadata-copy + backlink +
 *     a single whole-object guardrails round-trip + cross-user isolation.
 *   - `flow-mission-tick-cap.spec.ts` pins the outstanding-Ideas CAP machinery
 *     (cap-hit ladder, paused tick, cron bypass) via run-now.
 *   This file pins the GUARDRAILS-specific contracts neither covers:
 *     1. REPLACE-not-merge + sparse-partial semantics of `guardrailsOverride`
 *        (a single-key PATCH drops the rest; clear-to-null; non-object 400;
 *        unknown keys 400 — it is a STRICT typed schema, not a free-form blob).
 *     2. Clone takes a SNAPSHOT of the source's CURRENT guardrails, after
 *        which source and clone are BIDIRECTIONALLY independent.
 *     3. Guardrails + missionTemplateRepo survive every lifecycle transition
 *        (pause/resume/complete) and are INDEPENDENTLY editable.
 *     4. missionTemplateRepo aligns with the seeded Mission-Templates catalog
 *        (`starter-business` / `starter-content`) and rides through clone; the
 *        repo string is free-form (not FK-validated) but length-capped at 200.
 *     5. The guardrail/cap INHERITANCE ladder: a null-cap Mission inherits the
 *        user pref `missionDefaultOutstandingCap`, a per-Mission cap OVERRIDES
 *        it, and editing the pref re-propagates to all null-cap Missions on the
 *        next tick (observable through run-now's cap-hit diagnostic).
 *     6. Guardrail-surface cross-user isolation + edit-persistence: a stranger
 *        can neither read nor edit another user's guardrails / template repo
 *        (404), and rejected edits leave the stored guardrails intact.
 *
 * PROBED CONTRACTS (live, 2026-06-01):
 *   POST /api/me/missions  → 201  { id, title, description, type, status,
 *     schedule, autoBuildWorks, outstandingIdeasCap, guardrailsOverride,
 *     missionTemplateRepo, missionRepo, sourceMissionId, createdAt, updatedAt }.
 *   guardrailsOverride is a SPARSE Partial<WorkAgentGuardrails>:
 *     { maxWorksPerRun, maxItemsPerWork, maxBudgetCentsPerRun,
 *       requireApprovalBeforeCreate, requireApprovalBeforeDelete,
 *       requireApprovalAboveBudgetCents, dryRunByDefault }.
 *   PATCH /:id { guardrailsOverride: {...} } REPLACES the whole stored object
 *     (NOT a deep merge) — patching one key drops the others.
 *   PATCH /:id { guardrailsOverride: null }      → clears it (stored null).
 *   PATCH /:id { guardrailsOverride: "string" }  → 400 (DTO rejects non-object).
 *   PATCH /:id { guardrailsOverride: { bogusKey } } → 400 (WorkAgentGuardrailsDto
 *     is a STRICT typed schema; forbidNonWhitelisted rejects unknown keys).
 *   missionTemplateRepo: free-form string @MaxLength(200); >200 ⇒ 400; null clears.
 *   POST /:id/clone snapshots guardrailsOverride + missionTemplateRepo from the
 *     source's CURRENT row; afterwards source/clone are independent.
 *   GET  /api/me/work-agent/preferences → { guardrails:{...}, missionDefaultOutstandingCap, ... }.
 *   PUT  /api/me/work-agent/preferences { missionDefaultOutstandingCap:N }
 *     → 200; @Min(-1) @Max(1000) (1001 ⇒ 400).
 *   A null-cap Mission's run-now resolves cap = per-Mission ?? pref ?? 20:
 *     pref missionDefaultOutstandingCap=0 ⇒ null-cap Mission ticks 'cap-hit'
 *     "outstanding=0 >= cap=0"; a per-Mission cap of -1/positive OVERRIDES it.
 *   GET  /api/templates?kind=mission → { status:'success', kind:'mission',
 *     templates:[{id:'starter-business'},{id:'starter-content'}] } (2 seeded).
 *   Cross-user: GET/PATCH on another user's Mission ⇒ 404 "Mission not found".
 *
 * Cross-spec isolation: ALL guardrail/pref MUTATIONS run on FRESH
 * registerUserViaAPI() users (a user-scoped pref must never leak into sibling
 * specs). The seeded user (storageState) is touched ONLY for read-only
 * owner-scoping assertions in the isolation flow. Unique stamps everywhere;
 * assert toContain / shape over exact counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '22222222-2222-2222-2222-222222222222';

/** The full WorkAgentGuardrails key set the override is a sparse Partial of. */
const GUARDRAIL_KEYS = [
    'maxWorksPerRun',
    'maxItemsPerWork',
    'maxBudgetCentsPerRun',
    'requireApprovalBeforeCreate',
    'requireApprovalBeforeDelete',
    'requireApprovalAboveBudgetCents',
    'dryRunByDefault',
] as const;

/** Non-error run-now outcomes a runnable (NOT cap-hit) tick can emit on the
 *  no-AI / no-profile CI stack. Env-adaptive: 'spawned' on a configured stack. */
const RUNNABLE_NON_CAP = ['queued', 'spawned', 'no-ideas', 'failed'];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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
    // LOGIN DTO is whitelisted — pass ONLY {email,password}.
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
    const m = (await res.json()) as MissionDto;
    expect(m.id).toMatch(UUID_RE);
    return m;
}

async function getMission(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<MissionDto> {
    const res = await request.get(`${API_BASE}/api/me/missions/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

async function patchMission(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
): Promise<{ http: number; body: MissionDto }> {
    const res = await request.patch(`${API_BASE}/api/me/missions/${id}`, {
        headers: authedHeaders(token),
        data,
    });
    const http = res.status();
    const body = (await res.json().catch(() => ({}))) as MissionDto;
    return { http, body };
}

async function runNow(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<{ http: number; status: string; message?: string }> {
    const res = await request.post(`${API_BASE}/api/me/missions/${id}/run-now`, {
        headers: authedHeaders(token),
    });
    const http = res.status();
    const j = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    return { http, status: j.status ?? '', message: j.message };
}

test.describe('flow: Mission guardrails + templateRepo persistence, snapshot, inheritance', () => {
    // ──────────────────────────────────────────────────────────────────
    // FLOW 1 — guardrailsOverride IS A SPARSE, STRICTLY-TYPED OVERRIDE WITH
    // REPLACE-NOT-MERGE PATCH SEMANTICS. The full WorkAgentGuardrails shape
    // round-trips; a single-key PATCH REPLACES the whole stored object (drops
    // the rest); null clears; a non-object is rejected; unknown keys are
    // rejected 400 (WorkAgentGuardrailsDto is an allowlist with per-key bounds,
    // hardened by fix:security to block JSON-DoS / schema drift).
    // ──────────────────────────────────────────────────────────────────
    test('guardrailsOverride round-trips the full shape, PATCH replaces (not merges), clears on null, rejects non-objects, rejects unknown keys', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // ── Create with a FULL guardrails shape — every key persists verbatim.
        const full = {
            maxWorksPerRun: 4,
            maxItemsPerWork: 30,
            maxBudgetCentsPerRun: 5000,
            requireApprovalBeforeCreate: true,
            requireApprovalBeforeDelete: false,
            requireApprovalAboveBudgetCents: 2500,
            dryRunByDefault: true,
        };
        const mission = await createMission(request, token, {
            title: `Guard full ${s}`,
            description: 'A mission carrying every guardrail key to prove verbatim persistence',
            type: 'one-shot',
            guardrailsOverride: full,
        });
        expect(mission.guardrailsOverride).toEqual(full);
        // Every documented WorkAgentGuardrails key is present in the stored blob.
        for (const k of GUARDRAIL_KEYS) {
            expect(mission.guardrailsOverride).toHaveProperty(k);
        }
        // Persisted — a fresh GET returns the identical object.
        expect((await getMission(request, token, mission.id)).guardrailsOverride).toEqual(full);

        // ── REPLACE-not-merge: PATCH only `maxWorksPerRun` — the rest are DROPPED.
        const replaced = await patchMission(request, token, mission.id, {
            guardrailsOverride: { maxWorksPerRun: 7 },
        });
        expect(replaced.http).toBe(200);
        expect(replaced.body.guardrailsOverride).toEqual({ maxWorksPerRun: 7 });
        // Proof it is a REPLACE, not a deep merge: a key from `full` is gone.
        expect(replaced.body.guardrailsOverride).not.toHaveProperty('dryRunByDefault');
        expect(await (await getMission(request, token, mission.id)).guardrailsOverride).toEqual({
            maxWorksPerRun: 7,
        });

        // ── Clear: PATCH guardrailsOverride:null wipes it to null.
        const cleared = await patchMission(request, token, mission.id, {
            guardrailsOverride: null,
        });
        expect(cleared.http).toBe(200);
        expect(cleared.body.guardrailsOverride).toBeNull();
        expect((await getMission(request, token, mission.id)).guardrailsOverride).toBeNull();

        // ── A non-object override is rejected by the DTO (@IsObject) — 400.
        const badType = await patchMission(request, token, mission.id, {
            guardrailsOverride: 'not-an-object',
        });
        expect(badType.http).toBe(400);
        // The rejected PATCH did not write — still null from the clear above.
        expect((await getMission(request, token, mission.id)).guardrailsOverride).toBeNull();

        // ── Unknown keys are REJECTED: guardrailsOverride is a STRICT typed
        // schema (WorkAgentGuardrailsDto), so the global ValidationPipe
        // (forbidNonWhitelisted) 400s any non-guardrail key. Mixing a real key
        // with bogus ones still rejects the whole PATCH — nothing is written.
        const rejected = await patchMission(request, token, mission.id, {
            guardrailsOverride: { maxWorksPerRun: 3, futureFlag: 'x', nested: { a: 1 } },
        });
        expect(rejected.http).toBe(400);
        // The rejected PATCH did not write — still null from the clear above.
        expect((await getMission(request, token, mission.id)).guardrailsOverride).toBeNull();

        // ── An EMPTY object is a valid (if vacuous) override — distinct from null.
        const empty = await patchMission(request, token, mission.id, { guardrailsOverride: {} });
        expect(empty.http).toBe(200);
        expect(empty.body.guardrailsOverride).toEqual({});
        expect(empty.body.guardrailsOverride).not.toBeNull();
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 2 — CLONE TAKES A SNAPSHOT OF THE SOURCE'S CURRENT GUARDRAILS,
    // THEN SOURCE + CLONE ARE BIDIRECTIONALLY INDEPENDENT. The clone copies
    // whatever the source's guardrails are AT CLONE TIME (including a prior
    // edit). Editing the source AFTER the clone never touches the clone, and
    // editing the clone never touches the source. A null-guardrail source
    // clones to a null-guardrail clone.
    // ──────────────────────────────────────────────────────────────────
    test('clone snapshots the source guardrails at clone-time; source and clone then diverge independently', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        const source = await createMission(request, token, {
            title: `Snapshot src ${s}`,
            description: 'Source mission whose guardrails are edited before and after clone',
            type: 'one-shot',
            guardrailsOverride: { maxWorksPerRun: 2, requireApprovalBeforeCreate: true },
            missionTemplateRepo: 'starter-business',
        });

        // ── Edit the source guardrails BEFORE cloning — the clone must copy the
        // edited (current) value, not the create-time value. (REPLACE semantics:
        // the new object fully replaces the old.)
        const preEdit = await patchMission(request, token, source.id, {
            guardrailsOverride: { maxWorksPerRun: 6, dryRunByDefault: true },
        });
        expect(preEdit.http).toBe(200);

        // ── Clone — snapshots guardrails + missionTemplateRepo from the source's
        // CURRENT row, sets the backlink, resets missionRepo, starts ACTIVE.
        const cloneRes = await request.post(`${API_BASE}/api/me/missions/${source.id}/clone`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(cloneRes.status(), `clone body=${await cloneRes.text()}`).toBe(201);
        const clone = (await cloneRes.json()) as CloneResult;
        expect(clone.mission.sourceMissionId).toBe(source.id);
        expect(clone.mission.guardrailsOverride).toEqual({
            maxWorksPerRun: 6,
            dryRunByDefault: true,
        });
        expect(clone.mission.missionTemplateRepo).toBe('starter-business');
        expect(clone.mission.missionRepo).toBeNull();

        // ── Now edit the SOURCE again — the clone must be UNAFFECTED.
        await patchMission(request, token, source.id, {
            guardrailsOverride: { maxWorksPerRun: 19 },
        });
        const sourceAfter = await getMission(request, token, source.id);
        const cloneAfter = await getMission(request, token, clone.mission.id);
        expect(sourceAfter.guardrailsOverride).toEqual({ maxWorksPerRun: 19 });
        // The snapshot is frozen — the clone kept the clone-time value.
        expect(cloneAfter.guardrailsOverride).toEqual({ maxWorksPerRun: 6, dryRunByDefault: true });

        // ── And the reverse: editing the CLONE leaves the SOURCE untouched.
        await patchMission(request, token, clone.mission.id, {
            guardrailsOverride: { maxItemsPerWork: 12 },
        });
        expect((await getMission(request, token, clone.mission.id)).guardrailsOverride).toEqual({
            maxItemsPerWork: 12,
        });
        expect((await getMission(request, token, source.id)).guardrailsOverride).toEqual({
            maxWorksPerRun: 19,
        });

        // ── A source with NULL guardrails clones to a NULL-guardrail clone.
        const nullSrc = await createMission(request, token, {
            title: `Null guard src ${s}`,
            description: 'Source mission with no guardrails override clones to a null override',
            type: 'one-shot',
        });
        expect(nullSrc.guardrailsOverride).toBeNull();
        const nullCloneRes = await request.post(`${API_BASE}/api/me/missions/${nullSrc.id}/clone`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(nullCloneRes.status()).toBe(201);
        const nullClone = (await nullCloneRes.json()) as CloneResult;
        expect(nullClone.mission.guardrailsOverride).toBeNull();
        expect(nullClone.mission.missionTemplateRepo).toBeNull();
        expect(nullClone.mission.sourceMissionId).toBe(nullSrc.id);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 3 — GUARDRAILS + missionTemplateRepo SURVIVE THE FULL LIFECYCLE
    // AND ARE INDEPENDENTLY EDITABLE. pause/resume/complete never mutate
    // either field. The two fields are orthogonal: clearing the template
    // repo leaves the guardrails intact and vice-versa. The template repo is
    // length-capped at 200.
    // ──────────────────────────────────────────────────────────────────
    test('guardrails + templateRepo survive pause/resume/complete and are independently editable; templateRepo is length-capped', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        const guard = {
            maxWorksPerRun: 4,
            maxItemsPerWork: 25,
            requireApprovalBeforeCreate: true,
            dryRunByDefault: false,
        };
        const mission = await createMission(request, token, {
            title: `Lifecycle guard ${s}`,
            description: 'A mission whose guardrails + template repo must survive every transition',
            type: 'one-shot',
            guardrailsOverride: guard,
            missionTemplateRepo: 'starter-content',
        });
        expect(mission.guardrailsOverride).toEqual(guard);
        expect(mission.missionTemplateRepo).toBe('starter-content');

        // ── pause (ACTIVE→PAUSED) — neither field changes.
        const paused = await request.post(`${API_BASE}/api/me/missions/${mission.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(paused.status()).toBe(200);
        const pausedBody = (await paused.json()) as MissionDto;
        expect(pausedBody.status).toBe('paused');
        expect(pausedBody.guardrailsOverride).toEqual(guard);
        expect(pausedBody.missionTemplateRepo).toBe('starter-content');

        // ── resume (PAUSED→ACTIVE) — still intact.
        const resumed = await request.post(`${API_BASE}/api/me/missions/${mission.id}/resume`, {
            headers: authedHeaders(token),
        });
        expect(resumed.status()).toBe(200);
        const resumedBody = (await resumed.json()) as MissionDto;
        expect(resumedBody.status).toBe('active');
        expect(resumedBody.guardrailsOverride).toEqual(guard);

        // ── complete ((ACTIVE|PAUSED)→COMPLETED) — guardrails persist even after
        // the Mission is archived (the policy envelope is part of its history).
        const completed = await request.post(`${API_BASE}/api/me/missions/${mission.id}/complete`, {
            headers: authedHeaders(token),
        });
        expect(completed.status()).toBe(200);
        const completedBody = (await completed.json()) as MissionDto;
        expect(completedBody.status).toBe('completed');
        expect(completedBody.guardrailsOverride).toEqual(guard);
        expect(completedBody.missionTemplateRepo).toBe('starter-content');
        // And a fresh GET on the completed Mission still carries both.
        const refetched = await getMission(request, token, mission.id);
        expect(refetched.guardrailsOverride).toEqual(guard);
        expect(refetched.missionTemplateRepo).toBe('starter-content');

        // ── Orthogonality: clear the template repo — guardrails MUST be untouched.
        const tplCleared = await patchMission(request, token, mission.id, {
            missionTemplateRepo: null,
        });
        expect(tplCleared.http).toBe(200);
        expect(tplCleared.body.missionTemplateRepo).toBeNull();
        expect(tplCleared.body.guardrailsOverride).toEqual(guard);

        // ── Reverse orthogonality: edit guardrails — the (now null) template repo
        // stays null, and ONLY the guardrails change.
        const guardEdited = await patchMission(request, token, mission.id, {
            guardrailsOverride: { maxWorksPerRun: 1 },
        });
        expect(guardEdited.http).toBe(200);
        expect(guardEdited.body.guardrailsOverride).toEqual({ maxWorksPerRun: 1 });
        expect(guardEdited.body.missionTemplateRepo).toBeNull();

        // ── missionTemplateRepo length cap (@MaxLength(200)) — 201 chars ⇒ 400.
        const tooLong = 'a'.repeat(201);
        const longRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: {
                title: `Long tpl ${s}`,
                description: 'A mission whose template repo exceeds the 200-char limit must 400',
                type: 'one-shot',
                missionTemplateRepo: tooLong,
            },
        });
        expect(longRes.status()).toBe(400);
        // A 200-char repo is right at the boundary and accepted.
        const okLong = await createMission(request, token, {
            title: `Boundary tpl ${s}`,
            description: 'A mission whose template repo is exactly 200 chars is accepted',
            type: 'one-shot',
            missionTemplateRepo: 'b'.repeat(200),
        });
        expect(okLong.missionTemplateRepo).toHaveLength(200);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 4 — missionTemplateRepo ALIGNS WITH THE SEEDED MISSION-TEMPLATES
    // CATALOG AND RIDES THROUGH CLONE. The two built-in Mission Templates
    // (`starter-business`, `starter-content`) surface via
    // GET /api/templates?kind=mission. Missions can pin either as their
    // `missionTemplateRepo`, the pointer survives a clone, AND a free-form
    // (non-catalog) repo string is still accepted (the field is a provenance
    // pointer, not an FK).
    // ──────────────────────────────────────────────────────────────────
    test('missionTemplateRepo tracks the seeded mission-template catalog and survives clone; non-catalog strings are accepted', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // ── The Mission-Templates catalog filter returns the two seeded starters.
        const catalogRes = await request.get(`${API_BASE}/api/templates?kind=mission`, {
            headers: authedHeaders(token),
        });
        expect(catalogRes.status()).toBe(200);
        const catalog = (await catalogRes.json()) as {
            status: string;
            kind: string;
            templates: Array<{ id: string; name?: string }>;
        };
        expect(catalog.status).toBe('success');
        expect(catalog.kind).toBe('mission');
        const catalogIds = catalog.templates.map((t) => t.id);
        // Tolerate user-added custom templates (shared DB) — assert containment.
        expect(catalogIds).toContain('starter-business');
        expect(catalogIds).toContain('starter-content');

        // ── Pin each seeded template id as a Mission's provenance pointer.
        for (const templateId of ['starter-business', 'starter-content']) {
            const m = await createMission(request, token, {
                title: `From ${templateId} ${s}`,
                description: `A mission scaffolded from the ${templateId} template`,
                type: 'one-shot',
                missionTemplateRepo: templateId,
                guardrailsOverride: { maxWorksPerRun: 3 },
            });
            expect(m.missionTemplateRepo).toBe(templateId);
            // missionRepo (the per-Mission brain repo) is NOT the template repo —
            // it is null until the Phase 8 scaffolder runs.
            expect(m.missionRepo).toBeNull();

            // ── The template pointer + guardrails ride through a clone verbatim.
            const cloneRes = await request.post(`${API_BASE}/api/me/missions/${m.id}/clone`, {
                headers: authedHeaders(token),
                data: { title: `Fork of ${templateId} ${s}` },
            });
            expect(cloneRes.status()).toBe(201);
            const clone = (await cloneRes.json()) as CloneResult;
            expect(clone.mission.missionTemplateRepo).toBe(templateId);
            expect(clone.mission.guardrailsOverride).toEqual({ maxWorksPerRun: 3 });
            // The clone gets its OWN repo at scaffold time → still null here.
            expect(clone.mission.missionRepo).toBeNull();
            expect(clone.mission.sourceMissionId).toBe(m.id);
        }

        // ── A free-form (non-catalog) repo string is accepted — the field is a
        // provenance pointer (e.g. a custom `owner/repo`), not a catalog FK.
        const custom = await createMission(request, token, {
            title: `Custom tpl ${s}`,
            description: 'A mission pointing at a custom, non-catalog template repo string',
            type: 'one-shot',
            missionTemplateRepo: `acme/custom-mission-template-${s}`,
        });
        expect(custom.missionTemplateRepo).toBe(`acme/custom-mission-template-${s}`);

        // ── Re-pointing the template repo via PATCH round-trips.
        const repointed = await patchMission(request, token, custom.id, {
            missionTemplateRepo: 'starter-business',
        });
        expect(repointed.http).toBe(200);
        expect(repointed.body.missionTemplateRepo).toBe('starter-business');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 5 — THE GUARDRAIL/CAP INHERITANCE LADDER FROM USER PREFS. A
    // null-cap Mission INHERITS the user pref `missionDefaultOutstandingCap`;
    // a per-Mission cap OVERRIDES it; editing the pref RE-PROPAGATES to every
    // null-cap Mission on the next tick. We observe this through run-now's
    // cap-hit diagnostic ("outstanding=0 >= cap=N") with NO AI dependency.
    // (Distinct from flow-mission-tick-cap, which drives the per-Mission cap
    // directly and never sets the USER-PREF rung of the ladder.)
    // ──────────────────────────────────────────────────────────────────
    test('a null-cap Mission inherits the user-pref default cap; a per-Mission cap overrides it; editing the pref re-propagates', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // ── Baseline: fresh user pref has missionDefaultOutstandingCap=null
        // (⇒ platform default 20). A null-cap Mission is therefore runnable.
        const prefs0 = await request.get(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(token),
        });
        expect(prefs0.status()).toBe(200);
        expect((await prefs0.json()).missionDefaultOutstandingCap).toBeNull();

        const inheritM = await createMission(request, token, {
            title: `Inherit cap ${s}`,
            description: 'A null-cap mission that inherits the user-pref default outstanding cap',
            type: 'one-shot',
        });
        expect(inheritM.outstandingIdeasCap).toBeNull();
        const tickDefault = await runNow(request, token, inheritM.id);
        expect(tickDefault.http).toBe(200);
        // Platform default 20 ⇒ 0 outstanding < 20 ⇒ NOT cap-hit.
        expect(tickDefault.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(tickDefault.status);

        // ── Set the user pref to 0 — the SAME null-cap Mission now inherits 0 and
        // its NEXT tick is cap-hit. This proves inheritance is read fresh per tick.
        const putZero = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(token),
            data: { missionDefaultOutstandingCap: 0 },
        });
        expect(putZero.status(), `put prefs body=${await putZero.text()}`).toBe(200);
        expect((await putZero.json()).missionDefaultOutstandingCap).toBe(0);

        const tickInherited = await runNow(request, token, inheritM.id);
        expect(tickInherited.http).toBe(200);
        expect(tickInherited.status).toBe('cap-hit');
        expect(String(tickInherited.message)).toMatch(/outstanding=0 >= cap=0/i);

        // ── A SECOND null-cap Mission created under the same pref ALSO inherits 0
        // — the pref edit re-propagates to every null-cap Mission, not just the
        // one that existed when it was set.
        const inheritM2 = await createMission(request, token, {
            title: `Inherit cap 2 ${s}`,
            description: 'A second null-cap mission inheriting the same zero default cap',
            type: 'one-shot',
        });
        const tick2 = await runNow(request, token, inheritM2.id);
        expect(tick2.status).toBe('cap-hit');
        expect(String(tick2.message)).toMatch(/cap=0/i);

        // ── A per-Mission cap OVERRIDES the pref: a Mission with its own -1
        // (unlimited) sentinel ignores the pref's 0 and is runnable.
        const overrideM = await createMission(request, token, {
            title: `Override cap ${s}`,
            description:
                'A mission whose explicit unlimited cap overrides the zero user-pref default',
            type: 'one-shot',
            outstandingIdeasCap: -1,
        });
        expect(overrideM.outstandingIdeasCap).toBe(-1);
        const overrideTick = await runNow(request, token, overrideM.id);
        expect(overrideTick.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(overrideTick.status);

        // ── Raise the pref above 0 — the null-cap Mission's throttle LIFTS on the
        // next tick (inheritance follows the pref up as well as down).
        const putHigh = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(token),
            data: { missionDefaultOutstandingCap: 50 },
        });
        expect(putHigh.status()).toBe(200);
        expect((await putHigh.json()).missionDefaultOutstandingCap).toBe(50);
        const tickLifted = await runNow(request, token, inheritM.id);
        expect(tickLifted.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(tickLifted.status);

        // ── The pref cap is bounded @Min(-1) @Max(1000): 1001 ⇒ 400, leaving the
        // previously-stored 50 intact (rejected write does not mutate the pref).
        const putBad = await request.put(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(token),
            data: { missionDefaultOutstandingCap: 1001 },
        });
        expect(putBad.status()).toBe(400);
        const prefsFinal = await request.get(`${API_BASE}/api/me/work-agent/preferences`, {
            headers: authedHeaders(token),
        });
        expect((await prefsFinal.json()).missionDefaultOutstandingCap).toBe(50);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 6 — GUARDRAIL-SURFACE CROSS-USER ISOLATION + EDIT PERSISTENCE.
    // The guardrails / template repo of one user's Mission are invisible and
    // unwritable to a stranger (404, same opaque "Mission not found" as a
    // missing Mission — no existence leak). Owner edits to the guardrails
    // persist across GET and the list endpoint; a rejected edit (non-object)
    // leaves the stored guardrails intact. The OWNER is the seeded user, so
    // this also asserts isolation against a real persistent account.
    // ──────────────────────────────────────────────────────────────────
    test('guardrails + templateRepo are owner-scoped: a stranger cannot read or edit them; owner edits persist; rejected edits do not mutate', async ({
        request,
    }) => {
        const ownerToken = await seededToken(request);
        const s = stamp();

        const guard = { maxWorksPerRun: 5, requireApprovalBeforeDelete: true };
        const mission = await createMission(request, ownerToken, {
            title: `Private guard ${s}`,
            description: 'A seeded-user mission whose guardrails a stranger must not see or edit',
            type: 'one-shot',
            guardrailsOverride: guard,
            missionTemplateRepo: 'starter-business',
        });

        // ── A brand-new stranger.
        const stranger = await registerUserViaAPI(request);
        const sh = authedHeaders(stranger.access_token);

        // ── Stranger GET → 404 (opaque) — cannot read the guardrails at all.
        const strangerGet = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: sh,
        });
        expect(strangerGet.status()).toBe(404);
        expect((await strangerGet.json()).message).toMatch(/not found/i);

        // ── Stranger PATCH of the guardrails → 404 (cannot mutate the envelope).
        const strangerPatch = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: sh,
            data: { guardrailsOverride: { maxWorksPerRun: 25 } },
        });
        expect(strangerPatch.status()).toBe(404);

        // ── Stranger PATCH of the template repo → 404 too.
        const strangerTpl = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: sh,
            data: { missionTemplateRepo: 'evil/repo' },
        });
        expect(strangerTpl.status()).toBe(404);

        // ── The stranger's list never surfaces the owner's Mission (no leak).
        const strangerList = await request.get(`${API_BASE}/api/me/missions`, { headers: sh });
        expect(strangerList.status()).toBe(200);
        expect(((await strangerList.json()) as MissionDto[]).map((m) => m.id)).not.toContain(
            mission.id,
        );

        // ── Owner edits the guardrails — the change persists across GET + list.
        const ownerEdit = await patchMission(request, ownerToken, mission.id, {
            guardrailsOverride: { maxWorksPerRun: 8, dryRunByDefault: true },
        });
        expect(ownerEdit.http).toBe(200);
        expect(ownerEdit.body.guardrailsOverride).toEqual({
            maxWorksPerRun: 8,
            dryRunByDefault: true,
        });
        const ownerGet = await getMission(request, ownerToken, mission.id);
        expect(ownerGet.guardrailsOverride).toEqual({ maxWorksPerRun: 8, dryRunByDefault: true });
        // Untouched by any stranger attempt — the stranger's value never landed.
        expect(ownerGet.guardrailsOverride).not.toMatchObject({ maxWorksPerRun: 25 });
        expect(ownerGet.missionTemplateRepo).toBe('starter-business');

        const ownerList = (await (
            await request.get(`${API_BASE}/api/me/missions`, { headers: authedHeaders(ownerToken) })
        ).json()) as MissionDto[];
        const inList = ownerList.find((m) => m.id === mission.id);
        expect(inList, 'owner should still see their guardrailed Mission').toBeTruthy();
        expect(inList!.guardrailsOverride).toEqual({ maxWorksPerRun: 8, dryRunByDefault: true });

        // ── A rejected owner edit (non-object) does NOT mutate the stored value.
        const rejected = await patchMission(request, ownerToken, mission.id, {
            guardrailsOverride: 42,
        });
        expect(rejected.http).toBe(400);
        expect((await getMission(request, ownerToken, mission.id)).guardrailsOverride).toEqual({
            maxWorksPerRun: 8,
            dryRunByDefault: true,
        });

        // ── An unknown UUID is the SAME 404 as the stranger case (consistent
        // opaque response across the guardrail read surface).
        const unknown = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}`, {
            headers: authedHeaders(ownerToken),
        });
        expect(unknown.status()).toBe(404);
    });
});
