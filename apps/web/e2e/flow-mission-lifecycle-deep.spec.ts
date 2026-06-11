import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-mission-lifecycle-deep — DEEP, multi-step END-TO-END INTEGRATION flows
 * for the Missions surface (`apps/api/src/missions/missions.controller.ts` →
 * `@ever-works/agent/missions` MissionsService + `@ever-works/agent/budgets`
 * BudgetService). Focus: the lifecycle STATE-MACHINE round-trips, the per-Mission
 * BUDGET endpoint (`GET /:id/budget`), the PATCH field-mutation matrix, and the
 * DELETE + post-delete-404 sub-resource sweep.
 *
 * Every status code / shape / error string asserted below was PROBED against the
 * LIVE API at http://127.0.0.1:3100 before assertions were written (2026-06-11):
 *
 *   POST   /api/me/missions               201 MissionDto (type one-shot|scheduled, status active)
 *   GET    /api/me/missions               200 MissionDto[] (newest createdAt first; limit/offset/search/status filters)
 *   GET    /api/me/missions/:id           200 | 404 "Mission not found" | 400 (non-uuid, ParseUUIDPipe)
 *   GET    /api/me/missions/:id/budget    200 OwnerBudgetSummary | 404 (unknown/foreign/deleted) | 400 (non-uuid) | 401 (anon)
 *   PATCH  /api/me/missions/:id           200 (partial; status NOT a writable field → 400 "property status should not exist")
 *   DELETE /api/me/missions/:id           200 { deleted: true } from ANY status; second delete → 404
 *   POST   /api/me/missions/:id/{pause,resume,complete}  lifecycle (see state grid below)
 *
 *   OwnerBudgetSummary (probed live):
 *     { ownerType:'mission', ownerId, periodStart, periodEnd, currentSpendCents:0,
 *       capCents:null, currency:'usd', percentUsed:null, allowOverage:true, blocked:false }
 *     — periodStart = 1st of the current month 00:00:00Z, periodEnd = 1st of next month.
 *
 *   State machine (POST :id/{pause,resume,complete}):
 *     pause:    active → paused
 *     resume:   paused → active
 *     complete: (active | paused) → completed
 *   A transition mutates `updatedAt` (advances ≥ createdAt); `status` is read-only via PATCH.
 *
 * NON-DUPLICATION — the two heavy sibling specs already own these angles, so this
 * file deliberately does NOT re-assert them:
 *   - flow-mission-crud-schedule.spec.ts → the CREATE-time validation matrix, the
 *     autoBuildWorks/cap TOGGLE lifecycle, the cron storage-fidelity matrix, the
 *     EXHAUSTIVE ILLEGAL-transition guard grid (every 400 message from every status),
 *     run-now cron-bypass, and the MissionCard UI chips.
 *   - flow-mission-guardrails.spec.ts → guardrailsOverride PATCH/replace/clear
 *     semantics, clone snapshots, the cap-inheritance ladder, templateRepo catalog,
 *     and guardrail-surface cross-user isolation.
 *   - missions.spec.ts → the unknown-id shallow 404 smoke + the linear CRUD happy path.
 *
 * NET-NEW angles pinned here (no overlap with the above):
 *   1. The per-Mission BUDGET endpoint's FULL shape + its invariance across ACTIVE /
 *      PAUSED / COMPLETED, and the budget read surface's auth/ownership/validation
 *      matrix (anon 401, non-uuid 400, foreign 404, deleted 404) — missions.spec.ts
 *      only pins the unknown-id 404.
 *   2. The LEGAL state-machine walk asserted via TIMESTAMP advancement + a clean
 *      GET re-read of each landed status (the orthogonal complement to the sibling's
 *      ILLEGAL grid), plus budget continuity across the walk.
 *   3. The PATCH field-mutation matrix: which fields are editable POST-create, that a
 *      completed/paused Mission is STILL editable, that `status` is not a writable
 *      field (400), that an empty PATCH is a no-op 200, and that type→scheduled on
 *      PATCH still enforces schedule consistency.
 *   4. The DELETE + post-delete sub-resource SWEEP: after delete, GET / PATCH /
 *      budget / pause / resume / complete ALL return 404, and a second delete 404s.
 *   5. List PAGINATION + SEARCH + status filter + default newest-first ORDERING +
 *      the integer-bound 400s on limit/offset — uncovered by every mission spec.
 *   6. Full per-mutation user ISOLATION + the consistent opaque "Mission not found"
 *      404 across the read/write/budget surface.
 *
 * Cross-spec isolation: every mutating flow runs on a FRESH registerUserViaAPI()
 * user (mission rows are user-scoped — no leakage into sibling specs). Unique
 * suffixes are derived from a per-test counter, never a module-scope clock.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

type MissionStatus = 'active' | 'paused' | 'completed' | 'failed';

interface MissionDto {
    id: string;
    title: string;
    description: string;
    type: 'one-shot' | 'scheduled';
    status: MissionStatus;
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

interface OwnerBudgetSummary {
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
}

let counter = 0;
function nextSfx(title: string): string {
    counter += 1;
    const slug = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 16);
    return `${slug}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
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

async function transition(
    request: APIRequestContext,
    token: string,
    id: string,
    verb: 'pause' | 'resume' | 'complete',
) {
    return request.post(`${API_BASE}/api/me/missions/${id}/${verb}`, {
        headers: authedHeaders(token),
        data: {},
    });
}

test.describe('flow: Mission lifecycle state-machine, budget endpoint, PATCH + DELETE deep', () => {
    // ──────────────────────────────────────────────────────────────────
    // FLOW 1 — THE LEGAL STATE-MACHINE WALK, ASSERTED VIA THE LANDED STATUS
    // AND `updatedAt` ADVANCEMENT. The sibling crud-schedule spec pins the
    // ILLEGAL-transition message grid; here we pin the COMPLEMENT: every LEGAL
    // hop (create→pause→resume→pause→complete) returns the right next status,
    // each hop bumps `updatedAt` forward (proving the transition writes), and a
    // fresh GET re-reads the landed status verbatim.
    // ──────────────────────────────────────────────────────────────────
    test('legal walk create→pause→resume→pause→complete lands each status and advances updatedAt', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('legal-walk');

        const m = await createMission(request, token, {
            title: `Legal Walk ${sfx}`,
            description: `legal lifecycle walk ${sfx}`,
            type: 'one-shot',
        });
        expect(m.status).toBe('active');
        // createdAt == updatedAt at birth (no mutation yet).
        const t0 = new Date(m.updatedAt).getTime();
        expect(t0).toBeGreaterThanOrEqual(new Date(m.createdAt).getTime());

        // active → paused.
        const pause1 = await transition(request, token, m.id, 'pause');
        expect(pause1.status(), `pause body=${await pause1.text()}`).toBe(200);
        const paused1 = (await pause1.json()) as MissionDto;
        expect(paused1.status).toBe('paused');
        const t1 = new Date(paused1.updatedAt).getTime();
        expect(t1).toBeGreaterThanOrEqual(t0);
        // The status survives a fresh GET — the transition persisted.
        expect((await getMission(request, token, m.id)).status).toBe('paused');

        // paused → active (resume).
        const resume = await transition(request, token, m.id, 'resume');
        expect(resume.status()).toBe(200);
        const resumed = (await resume.json()) as MissionDto;
        expect(resumed.status).toBe('active');
        expect(new Date(resumed.updatedAt).getTime()).toBeGreaterThanOrEqual(t1);

        // active → paused again (the machine cycles freely between the two).
        const pause2 = await transition(request, token, m.id, 'pause');
        expect(pause2.status()).toBe(200);
        expect(((await pause2.json()) as MissionDto).status).toBe('paused');

        // paused → completed (complete is legal from BOTH active and paused).
        const complete = await transition(request, token, m.id, 'complete');
        expect(complete.status()).toBe(200);
        const completed = (await complete.json()) as MissionDto;
        expect(completed.status).toBe('completed');
        expect((await getMission(request, token, m.id)).status).toBe('completed');

        // A SECOND mission proves complete is reachable DIRECTLY from active too.
        const direct = await createMission(request, token, {
            title: `Direct Complete ${sfx}`,
            description: `complete straight from active ${sfx}`,
            type: 'one-shot',
        });
        const directComplete = await transition(request, token, direct.id, 'complete');
        expect(directComplete.status()).toBe(200);
        expect(((await directComplete.json()) as MissionDto).status).toBe('completed');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 2 — THE PER-MISSION BUDGET ENDPOINT'S FULL SHAPE, INVARIANT ACROSS
    // EVERY LIFECYCLE STATUS. `GET /:id/budget` returns the OwnerBudgetSummary
    // for ownerType='mission'; on this no-spend stack every numeric is the
    // zero-state (currentSpendCents 0, capCents null, percentUsed null,
    // allowOverage true, blocked false) and the period is the current calendar
    // month. The summary is IDENTICAL whether the Mission is active, paused, or
    // completed — the budget window is owner+period, not status. (missions.spec.ts
    // only pins the unknown-id 404; the full shape + status-invariance is net-new.)
    // ──────────────────────────────────────────────────────────────────
    test('GET :id/budget returns the full owner-budget summary, identical across active/paused/completed', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('budget-shape');

        const m = await createMission(request, token, {
            title: `Budget Shape ${sfx}`,
            description: `per-mission budget shape ${sfx}`,
            type: 'one-shot',
        });

        async function budget(id: string): Promise<OwnerBudgetSummary> {
            const res = await request.get(`${API_BASE}/api/me/missions/${id}/budget`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `budget body=${await res.text()}`).toBe(200);
            return res.json();
        }

        // ── ACTIVE: the full zero-state summary for this Mission owner.
        const active = await budget(m.id);
        expect(active.ownerType).toBe('mission');
        expect(active.ownerId).toBe(m.id);
        expect(active.currentSpendCents).toBe(0);
        expect(active.capCents).toBeNull();
        expect(active.currency).toBe('usd');
        expect(active.percentUsed).toBeNull();
        expect(active.allowOverage).toBe(true);
        expect(active.blocked).toBe(false);
        // The period window is a calendar month [1st 00:00Z, next-1st 00:00Z).
        const start = new Date(active.periodStart);
        const end = new Date(active.periodEnd);
        expect(start.getUTCDate()).toBe(1);
        expect(start.getUTCHours()).toBe(0);
        expect(end.getUTCDate()).toBe(1);
        expect(end.getTime()).toBeGreaterThan(start.getTime());
        // "now" lies inside the budgeting window.
        const now = Date.now();
        expect(now).toBeGreaterThanOrEqual(start.getTime());
        expect(now).toBeLessThan(end.getTime());

        // ── PAUSED: the summary is byte-identical to the active one.
        expect((await transition(request, token, m.id, 'pause')).status()).toBe(200);
        const paused = await budget(m.id);
        expect(paused).toEqual(active);

        // ── COMPLETED: still identical — the budget tracks owner+period, not status.
        // (resume back to active first so complete is a legal hop.)
        expect((await transition(request, token, m.id, 'resume')).status()).toBe(200);
        expect((await transition(request, token, m.id, 'complete')).status()).toBe(200);
        const completed = await budget(m.id);
        expect(completed).toEqual(active);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 3 — THE BUDGET READ SURFACE'S AUTH / OWNERSHIP / VALIDATION MATRIX.
    // `GET /:id/budget` is gated identically to the rest of the controller:
    // anonymous → 401, a non-uuid path → 400 (ParseUUIDPipe), an unknown UUID
    // and a FOREIGN Mission → the same opaque 404 "Mission not found" (no
    // existence/spend leak), and a DELETED Mission's budget → 404. The
    // ownership gate runs BEFORE the budget summarization, so a stranger can
    // never introspect another user's per-Mission spend.
    // ──────────────────────────────────────────────────────────────────
    test('budget endpoint enforces auth, uuid validation, and opaque 404 for unknown/foreign/deleted', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const sfx = nextSfx('budget-authz');

        const m = await createMission(request, owner.access_token, {
            title: `Budget Authz ${sfx}`,
            description: `budget access control ${sfx}`,
            type: 'one-shot',
        });

        // ── Anonymous (no Authorization header) → 401.
        const anon = await request.get(`${API_BASE}/api/me/missions/${m.id}/budget`);
        expect(anon.status()).toBe(401);

        // ── Non-uuid path → 400 from ParseUUIDPipe (before any service call).
        const nonUuid = await request.get(`${API_BASE}/api/me/missions/not-a-uuid/budget`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(nonUuid.status()).toBe(400);

        // ── Unknown (well-formed) UUID → opaque 404 "Mission not found".
        const unknown = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/budget`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).message).toMatch(/not found/i);

        // ── A stranger asking for the OWNER's mission budget → the SAME opaque 404
        // (ownership gate fires first; no spend introspection across users).
        const foreign = await request.get(`${API_BASE}/api/me/missions/${m.id}/budget`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(foreign.status()).toBe(404);
        expect((await foreign.json()).message).toMatch(/not found/i);

        // ── The owner CAN read it (sanity: the 404s above are isolation, not breakage).
        const ok = await request.get(`${API_BASE}/api/me/missions/${m.id}/budget`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ok.status()).toBe(200);
        expect((await ok.json()).ownerId).toBe(m.id);

        // ── After DELETE, the budget endpoint 404s (no orphan budget read).
        const del = await request.delete(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(del.status()).toBe(200);
        const afterDelete = await request.get(`${API_BASE}/api/me/missions/${m.id}/budget`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(afterDelete.status()).toBe(404);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 4 — THE PATCH FIELD-MUTATION MATRIX. Pins which fields are editable
    // POST-create and the editability invariants the sibling toggle test does
    // not: a single-field rename persists, an EMPTY PATCH is a 200 no-op, and
    // `status` is NOT a writable field (the global ValidationPipe rejects it
    // 400 "property status should not exist" — the ONLY way to move status is
    // the lifecycle endpoints).
    // ──────────────────────────────────────────────────────────────────
    test('PATCH edits title/description/type but rejects status; empty PATCH is a no-op 200', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('patch-matrix');

        const m = await createMission(request, token, {
            title: `Patch Matrix ${sfx}`,
            description: `patch matrix base ${sfx}`,
            type: 'one-shot',
        });

        // ── A single-field rename persists; other fields are untouched.
        const renamed = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(token),
            data: { title: `Renamed ${sfx}` },
        });
        expect(renamed.status()).toBe(200);
        const renamedBody = (await renamed.json()) as MissionDto;
        expect(renamedBody.title).toBe(`Renamed ${sfx}`);
        expect(renamedBody.description).toBe(`patch matrix base ${sfx}`);
        expect(renamedBody.status).toBe('active');
        expect((await getMission(request, token, m.id)).title).toBe(`Renamed ${sfx}`);

        // ── Description edit persists independently.
        const reDesc = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(token),
            data: { description: `patch matrix edited ${sfx}` },
        });
        expect(reDesc.status()).toBe(200);
        expect(((await reDesc.json()) as MissionDto).description).toBe(
            `patch matrix edited ${sfx}`,
        );

        // ── type one-shot → scheduled WITHOUT a schedule is rejected (the same
        // schedule↔type consistency check the create path runs, enforced on PATCH).
        const badType = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(token),
            data: { type: 'scheduled' },
        });
        expect(badType.status()).toBe(400);
        expect((await badType.json()).message).toMatch(
            /scheduled requires a non-empty `schedule`/i,
        );

        // ── type one-shot → scheduled WITH a schedule is accepted and round-trips.
        const okType = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(token),
            data: { type: 'scheduled', schedule: '0 9 * * 1' },
        });
        expect(okType.status()).toBe(200);
        const okTypeBody = (await okType.json()) as MissionDto;
        expect(okTypeBody.type).toBe('scheduled');
        expect(okTypeBody.schedule).toBe('0 9 * * 1');

        // ── `status` is NOT a writable field — the ValidationPipe rejects it 400.
        // The ONLY way to change status is the lifecycle endpoints.
        const statusWrite = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(token),
            data: { status: 'completed' },
        });
        expect(statusWrite.status()).toBe(400);
        expect((await statusWrite.json()).message.join?.(' ') ?? '').toMatch(
            /property status should not exist/i,
        );
        // The rejected PATCH did not move the status.
        expect((await getMission(request, token, m.id)).status).toBe('active');

        // ── An EMPTY PATCH body is a valid no-op (200; nothing changes).
        const empty = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(empty.status()).toBe(200);
        const emptyBody = (await empty.json()) as MissionDto;
        expect(emptyBody.title).toBe(`Renamed ${sfx}`);
        expect(emptyBody.status).toBe('active');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 5 — A MISSION IS STILL EDITABLE AFTER IT IS PAUSED OR COMPLETED.
    // The lifecycle status gates the pause/resume/complete TRANSITIONS, but the
    // metadata PATCH is NOT status-gated: a paused mission's description and a
    // COMPLETED (archived) mission's title can both still be edited (the status
    // is preserved across the edit). This pins that PATCH and the state machine
    // are independent axes.
    // ──────────────────────────────────────────────────────────────────
    test('metadata PATCH is not status-gated: paused and completed missions stay editable', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('patch-states');

        // ── Edit while PAUSED — description changes, status stays paused.
        const paused = await createMission(request, token, {
            title: `Editable Paused ${sfx}`,
            description: `editable while paused ${sfx}`,
            type: 'one-shot',
        });
        expect((await transition(request, token, paused.id, 'pause')).status()).toBe(200);
        const editPaused = await request.patch(`${API_BASE}/api/me/missions/${paused.id}`, {
            headers: authedHeaders(token),
            data: { description: `edited while paused ${sfx}` },
        });
        expect(editPaused.status()).toBe(200);
        const editPausedBody = (await editPaused.json()) as MissionDto;
        expect(editPausedBody.status).toBe('paused');
        expect(editPausedBody.description).toBe(`edited while paused ${sfx}`);

        // ── Edit while COMPLETED — title changes, status stays completed.
        const completed = await createMission(request, token, {
            title: `Editable Completed ${sfx}`,
            description: `editable while completed ${sfx}`,
            type: 'one-shot',
        });
        expect((await transition(request, token, completed.id, 'complete')).status()).toBe(200);
        const editCompleted = await request.patch(`${API_BASE}/api/me/missions/${completed.id}`, {
            headers: authedHeaders(token),
            data: { title: `Renamed After Complete ${sfx}` },
        });
        expect(editCompleted.status()).toBe(200);
        const editCompletedBody = (await editCompleted.json()) as MissionDto;
        expect(editCompletedBody.status).toBe('completed');
        expect(editCompletedBody.title).toBe(`Renamed After Complete ${sfx}`);
        // And it persists across a fresh GET (the archive carries the edit).
        const refetched = await getMission(request, token, completed.id);
        expect(refetched.status).toBe('completed');
        expect(refetched.title).toBe(`Renamed After Complete ${sfx}`);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 6 — DELETE IS ALLOWED FROM EVERY STATUS, AND AFTER A DELETE THE
    // ENTIRE SUB-RESOURCE SURFACE 404s. Delete an ACTIVE, a PAUSED, and a
    // COMPLETED mission (each → 200 { deleted: true }); then prove the gone
    // mission's GET, PATCH, budget, pause, resume, complete AND a second DELETE
    // all return 404 — there is no orphaned read or write path post-delete.
    // ──────────────────────────────────────────────────────────────────
    test('delete works from any status; post-delete the whole sub-resource surface 404s', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('delete-sweep');
        const headers = authedHeaders(token);

        async function mk(label: string): Promise<MissionDto> {
            return createMission(request, token, {
                title: `Delete ${label} ${sfx}`,
                description: `delete from ${label} ${sfx}`,
                type: 'one-shot',
            });
        }

        // ── Delete from ACTIVE.
        const active = await mk('active');
        const delActive = await request.delete(`${API_BASE}/api/me/missions/${active.id}`, {
            headers,
        });
        expect(delActive.status()).toBe(200);
        expect(await delActive.json()).toEqual({ deleted: true });

        // ── Delete from PAUSED.
        const paused = await mk('paused');
        expect((await transition(request, token, paused.id, 'pause')).status()).toBe(200);
        const delPaused = await request.delete(`${API_BASE}/api/me/missions/${paused.id}`, {
            headers,
        });
        expect(delPaused.status()).toBe(200);
        expect(await delPaused.json()).toEqual({ deleted: true });

        // ── Delete from COMPLETED.
        const completed = await mk('completed');
        expect((await transition(request, token, completed.id, 'complete')).status()).toBe(200);
        const delCompleted = await request.delete(`${API_BASE}/api/me/missions/${completed.id}`, {
            headers,
        });
        expect(delCompleted.status()).toBe(200);
        expect(await delCompleted.json()).toEqual({ deleted: true });

        // ── Post-delete sub-resource sweep on the (active) deleted mission: every
        // read AND write path returns 404 — nothing dangles.
        const gone = active.id;
        expect(
            (await request.get(`${API_BASE}/api/me/missions/${gone}`, { headers })).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${API_BASE}/api/me/missions/${gone}`, {
                    headers,
                    data: { title: 'zombie' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (await request.get(`${API_BASE}/api/me/missions/${gone}/budget`, { headers })).status(),
        ).toBe(404);
        for (const verb of ['pause', 'resume', 'complete'] as const) {
            const res = await transition(request, token, gone, verb);
            expect(res.status(), `${verb} on deleted mission`).toBe(404);
        }
        // ── A SECOND delete on the already-gone mission → 404 (delete is not idempotent-200).
        const delAgain = await request.delete(`${API_BASE}/api/me/missions/${gone}`, { headers });
        expect(delAgain.status()).toBe(404);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 7 — LIST PAGINATION, SEARCH, STATUS FILTER, AND DEFAULT ORDERING.
    // `GET /api/me/missions` defaults to newest-createdAt-first, honors
    // limit/offset windowing, a `search` substring match on title, and a
    // `status` filter; malformed integer params 400 (ParseInt guards). None of
    // the mission specs pin the pagination/search/ordering surface.
    // ──────────────────────────────────────────────────────────────────
    test('list supports newest-first ordering, limit/offset paging, search, status filter, and 400s bad ints', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('list-page');
        const headers = authedHeaders(token);

        // Create 5 missions in order; the unique token in each title lets `search`
        // home in on exactly one without colliding with sibling-spec rows.
        const created: MissionDto[] = [];
        for (let i = 1; i <= 5; i += 1) {
            created.push(
                await createMission(request, token, {
                    title: `List ${sfx} item ${i}`,
                    description: `list paging row ${i} ${sfx}`,
                    type: 'one-shot',
                }),
            );
        }

        // ── Default list: all 5 present, ordered by createdAt DESCENDING. NOTE:
        // `createdAt` is second-truncated (probed live: `...:35.000Z`), so five
        // rapid creates can share an identical timestamp and the intra-second
        // tiebreak is NOT a guaranteed contract — assert the genuinely-probed
        // non-increasing-timestamp invariant + full membership, not an exact head.
        const allRes = await request.get(`${API_BASE}/api/me/missions`, { headers });
        expect(allRes.status()).toBe(200);
        const all = (await allRes.json()) as MissionDto[];
        expect(all.length).toBe(5);
        const times = all.map((m) => new Date(m.createdAt).getTime());
        for (let i = 1; i < times.length; i += 1) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }
        // All five created missions surface in the list (no drops, no extras).
        expect(new Set(all.map((m) => m.id))).toEqual(new Set(created.map((m) => m.id)));

        // ── limit windows the result: limit=2 → 2 rows, limit=2&offset=2 → 2
        // rows, offset=4&limit=2 → the final 1 row (5 total). These SIZE
        // invariants are deterministic regardless of the intra-second tiebreak.
        const page1 = (await (
            await request.get(`${API_BASE}/api/me/missions?limit=2`, { headers })
        ).json()) as MissionDto[];
        expect(page1.length).toBe(2);
        const page2 = (await (
            await request.get(`${API_BASE}/api/me/missions?limit=2&offset=2`, { headers })
        ).json()) as MissionDto[];
        expect(page2.length).toBe(2);
        const tail = (await (
            await request.get(`${API_BASE}/api/me/missions?limit=2&offset=4`, { headers })
        ).json()) as MissionDto[];
        expect(tail.length).toBe(1);
        // Offset past the end yields an empty window (not an error, not a wrap).
        const past = (await (
            await request.get(`${API_BASE}/api/me/missions?limit=2&offset=10`, { headers })
        ).json()) as MissionDto[];
        expect(past.length).toBe(0);
        // Every paged row is one of the five we created (no foreign rows leak in).
        const createdIds = new Set(created.map((m) => m.id));
        for (const m of [...page1, ...page2, ...tail]) {
            expect(createdIds.has(m.id)).toBe(true);
        }

        // ── search narrows to the single row whose title carries that token.
        const target = created[2];
        const searchRes = await request.get(
            `${API_BASE}/api/me/missions?search=${encodeURIComponent(`List ${sfx} item 3`)}`,
            { headers },
        );
        expect(searchRes.status()).toBe(200);
        const found = (await searchRes.json()) as MissionDto[];
        expect(found.length).toBe(1);
        expect(found[0].id).toBe(target.id);

        // ── status filter: pause one mission, then status=paused returns only it.
        expect((await transition(request, token, created[0].id, 'pause')).status()).toBe(200);
        const pausedList = (await (
            await request.get(`${API_BASE}/api/me/missions?status=paused`, { headers })
        ).json()) as MissionDto[];
        expect(pausedList.length).toBe(1);
        expect(pausedList[0].id).toBe(created[0].id);
        expect(pausedList.every((m) => m.status === 'paused')).toBe(true);

        // ── An invalid status filter value → 400 (not a silent empty list).
        const badStatus = await request.get(`${API_BASE}/api/me/missions?status=bogus`, {
            headers,
        });
        expect(badStatus.status()).toBe(400);

        // ── Non-integer limit / offset → 400 (ParseInt guards in the controller).
        expect(
            (await request.get(`${API_BASE}/api/me/missions?limit=abc`, { headers })).status(),
        ).toBe(400);
        expect(
            (await request.get(`${API_BASE}/api/me/missions?offset=xyz`, { headers })).status(),
        ).toBe(400);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 8 — FULL CROSS-USER ISOLATION OF THE WHOLE LIFECYCLE/WRITE SURFACE.
    // A stranger cannot GET, PATCH, pause, resume, complete, read the budget of,
    // or DELETE another user's Mission — every attempt is the SAME opaque 404
    // "Mission not found", and the owner's Mission is provably untouched
    // afterward (no hijacked rename, still active). Complements the guardrails
    // spec (which isolates only the guardrails surface) by sweeping the LIFECYCLE
    // verbs + delete.
    // ──────────────────────────────────────────────────────────────────
    test('a stranger cannot read, mutate, transition, budget-read, or delete the owner mission (opaque 404)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const sfx = nextSfx('isolation');
        const sh = authedHeaders(stranger.access_token);

        const m = await createMission(request, owner.access_token, {
            title: `Owned ${sfx}`,
            description: `owner-only mission ${sfx}`,
            type: 'one-shot',
        });

        // ── Read paths → 404.
        expect(
            (await request.get(`${API_BASE}/api/me/missions/${m.id}`, { headers: sh })).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/me/missions/${m.id}/budget`, { headers: sh })
            ).status(),
        ).toBe(404);

        // ── PATCH (hijack rename) → 404 with the opaque message.
        const hijack = await request.patch(`${API_BASE}/api/me/missions/${m.id}`, {
            headers: sh,
            data: { title: `Hijacked ${sfx}` },
        });
        expect(hijack.status()).toBe(404);
        expect((await hijack.json()).message).toMatch(/not found/i);

        // ── Every lifecycle verb → 404.
        for (const verb of ['pause', 'resume', 'complete'] as const) {
            const res = await request.post(`${API_BASE}/api/me/missions/${m.id}/${verb}`, {
                headers: sh,
                data: {},
            });
            expect(res.status(), `stranger ${verb}`).toBe(404);
        }

        // ── DELETE → 404.
        expect(
            (await request.delete(`${API_BASE}/api/me/missions/${m.id}`, { headers: sh })).status(),
        ).toBe(404);

        // ── The stranger's own list never surfaces the owner's mission.
        const strangerList = (await (
            await request.get(`${API_BASE}/api/me/missions`, { headers: sh })
        ).json()) as MissionDto[];
        expect(strangerList.map((x) => x.id)).not.toContain(m.id);

        // ── The owner's mission is provably untouched: still active, original title.
        const after = await getMission(request, owner.access_token, m.id);
        expect(after.status).toBe('active');
        expect(after.title).toBe(`Owned ${sfx}`);
    });
});
