import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-mission-run-now-record — the manual Mission TICK endpoint
 * (`POST /api/me/missions/:id/run-now`, controller line 230, backed by
 * `MissionsService.runNow` → `MissionTickService.runOnce`) pinned as an
 * OUTCOME / RUN-RECORD contract, NOT as a generation. Every status code,
 * body shape, and message string asserted below was confirmed against the
 * LIVE API at http://127.0.0.1:3100 before being written.
 *
 * This stack is KEYLESS (no LLM provider, no user profile) — a real
 * generation can NEVER produce Ideas here. So, like the sibling specs, we
 * assert the run-RECORD CONTRACT (the outcome union, the no-provider
 * reason, idempotency, ownership) and NEVER idea content / completion.
 *
 * NON-DUPLICATION — net-new vs the two existing run-now specs:
 *   - flow-mission-idea-build.spec.ts pins: the run-now union, a single
 *     static cap=0 cap-hit, the COMPLETED 400 gate, the missing-UUID 404.
 *   - flow-mission-tick-cap.spec.ts pins: the cap as a *live re-resolved*
 *     value across ticks, the PAUSED tick path, the cron-bypass, the
 *     effective-cap fallback ladder, the count-field-iff-spawned discipline,
 *     and the cross-tenant 404 (no existence leak).
 *   This file pins surface NEITHER sibling asserts:
 *     1. The exact `no-ideas` REASON the controller forwards on a keyless
 *        stack — `message:"skipped-no-profile"` — i.e. the generator's
 *        short-circuit `status` propagated verbatim through the tick
 *        outcome's `message` (work-proposal.service.ts:252). The siblings
 *        only accept `no-ideas` as a status; they never pin this string.
 *     2. The controller's response PROJECTION — only
 *        { status, missionId, ideasCreated?, ideasQueued?, message? } is
 *        returned; the tick outcome's internal `outstanding` / `cap`
 *        diagnostics are STRIPPED and never surface on `no-ideas`.
 *     3. RUN-RECORD-NOT-COMPLETION as a *non-mutation* invariant: a keyless
 *        run-now leaves the Mission untouched — `status`, `outstandingIdeasCap`,
 *        and `updatedAt` are byte-identical before/after, and the Mission's
 *        `?missionId` Idea scope stays empty. The tick is a no-op record.
 *     4. BYTE-stable idempotency of repeated run-now (the no-ideas body is
 *        identical across N calls — the siblings assert shape-stability, not
 *        body equality).
 *     5. The 401 ANONYMOUS shape ({message:"Unauthorized",statusCode:401} —
 *        no `error` key) vs the 400 malformed-id shape
 *        ("Validation failed (uuid is expected)") vs the 404 not-found shape.
 *     6. DELETE-then-run-now: delete is allowed from any status, after which
 *        run-now 404s (the run-record gate sees no Mission). A lifecycle
 *        SEQUENCE neither sibling walks.
 *
 * PROBED CONTRACTS (live, keyless stack):
 *   POST /api/me/missions/:id/run-now (runnable, cap-headroom)
 *     → 200 { status:'no-ideas', missionId, message:'skipped-no-profile' }
 *       — NO ideasCreated / ideasQueued / outstanding / cap keys.
 *   repeated run-now on the same runnable Mission → byte-identical body.
 *   run-now never mutates the Mission (status / cap / updatedAt unchanged;
 *     ?missionId Idea scope stays []).
 *   run-now from PAUSED → same no-ideas record (cron paused, manual honoured).
 *   run-now anonymously → 401 { message:'Unauthorized', statusCode:401 }.
 *   run-now with a non-UUID id → 400 'Validation failed (uuid is expected)'.
 *   run-now on an unknown UUID → 404 { message:'Mission not found', ... }.
 *   run-now on a COMPLETED Mission → 400 'Mission cannot be run from status
 *     "completed". Allowed: active, paused.'
 *   run-now after DELETE → 404 'Mission not found'.
 *
 * Cross-spec isolation: every mutation runs on a FRESH registerUserViaAPI()
 * user (these are pure bearer-auth API flows — no shared seeded user, no
 * storageState cookie). A per-test counter (NOT a module-scope clock) builds
 * unique titles.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '11111111-1111-1111-1111-111111111111';

/**
 * The full run-now union the controller declares (run-now can never emit
 * `cron-no-match` — that path requires `allowCronMismatch=false`, which only
 * the scheduled dispatcher uses; we keep it in the union for completeness).
 */
const RUN_NOW_STATUSES = [
    'noop-placeholder',
    'queued',
    'spawned',
    'cap-hit',
    'no-ideas',
    'failed',
    'cron-no-match',
];

/**
 * On THIS keyless / no-profile stack a runnable (non-cap) tick deterministically
 * short-circuits in the generator with `skipped-no-profile`, which the tick
 * service maps to outcome `no-ideas` + that exact `message`. We accept the
 * `no-ideas` outcome and pin the message; on a CONFIGURED stack this arm would
 * be `spawned` instead, so the message assertion is guarded by the status.
 */
const KEYLESS_RUNNABLE_STATUS = 'no-ideas';
const KEYLESS_RUNNABLE_MESSAGE = /^skipped-no-profile$/;

interface RunNowBody {
    status: string;
    missionId: string;
    ideasCreated?: number;
    ideasQueued?: number;
    message?: string;
}

interface MissionBody {
    id: string;
    title: string;
    type: string;
    status: string;
    schedule: string | null;
    outstandingIdeasCap: number | null;
    updatedAt: string;
}

/** Per-test unique suffix — built from the test title, NOT a module clock. */
function suffix(testInfo: { title: string }): string {
    const slug = testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<MissionBody> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = (await res.json()) as MissionBody;
    expect(m.id).toMatch(UUID_RE);
    return m;
}

async function runNow(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<{ http: number; body: RunNowBody }> {
    const res = await request.post(`${API_BASE}/api/me/missions/${missionId}/run-now`, {
        headers: authedHeaders(token),
    });
    const http = res.status();
    const body = (
        http === 200 ? await res.json() : await res.json().catch(() => ({}))
    ) as RunNowBody;
    return { http, body };
}

async function getMission(
    request: APIRequestContext,
    token: string,
    missionId: string,
): Promise<{ http: number; body: MissionBody }> {
    const res = await request.get(`${API_BASE}/api/me/missions/${missionId}`, {
        headers: authedHeaders(token),
    });
    return { http: res.status(), body: (await res.json().catch(() => ({}))) as MissionBody };
}

/** The keyless run-record assertion: a runnable tick is a no-op `no-ideas` record. */
function expectKeylessRunRecord(body: RunNowBody, missionId: string): void {
    expect(RUN_NOW_STATUSES).toContain(body.status);
    expect(body.missionId).toBe(missionId);
    expect(body.status).toBe(KEYLESS_RUNNABLE_STATUS);
    expect(String(body.message)).toMatch(KEYLESS_RUNNABLE_MESSAGE);
}

test.describe('flow: Mission run-now as an outcome/run-record contract (keyless)', () => {
    test('a runnable tick records no-ideas with the verbatim skipped-no-profile reason', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        const mission = await createMission(request, token, {
            title: `RunNow reason ${s}`,
            description: 'A runnable one-shot mission whose keyless tick reports no provider',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        const tick = await runNow(request, token, mission.id);
        expect(tick.http).toBe(200);
        // The exact generator short-circuit reason is forwarded as the message —
        // `skipped-no-profile` (work-proposal.service.ts), proving the tick ran
        // the generator and got a no-provider short-circuit (not a cap / cron skip).
        expectKeylessRunRecord(tick.body, mission.id);
    });

    test('the controller projects only {status,missionId,message} — outstanding/cap diagnostics are stripped on no-ideas', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        const mission = await createMission(request, token, {
            title: `RunNow projection ${s}`,
            description: 'A mission used to pin the run-now response field projection',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        const tick = await runNow(request, token, mission.id);
        expect(tick.http).toBe(200);
        expectKeylessRunRecord(tick.body, mission.id);

        // Count fields are meaningful only for `spawned` — absent on no-ideas.
        expect(tick.body.ideasCreated).toBeUndefined();
        expect(tick.body.ideasQueued).toBeUndefined();
        // The tick outcome carries internal `outstanding` / `cap` diagnostics,
        // but the controller does NOT forward them — only message survives.
        const body = tick.body as unknown as Record<string, unknown>;
        const keys = Object.keys(body).sort();
        expect(keys).toEqual(['message', 'missionId', 'status']);
        expect(body.outstanding, 'internal outstanding must not leak').toBeUndefined();
        expect(body.cap, 'internal cap must not leak').toBeUndefined();
    });

    test('run-now is a no-op RECORD: it does not mutate the Mission or create Ideas (run-record-not-completion)', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        const mission = await createMission(request, token, {
            title: `RunNow no-mutate ${s}`,
            description: 'A mission whose keyless run-now must leave it byte-identical',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        const before = await getMission(request, token, mission.id);
        expect(before.http).toBe(200);

        const tick = await runNow(request, token, mission.id);
        expectKeylessRunRecord(tick.body, mission.id);

        // The Mission is unchanged — a keyless tick is a record, not a state change.
        const after = await getMission(request, token, mission.id);
        expect(after.http).toBe(200);
        expect(after.body.status).toBe('active');
        expect(after.body.status).toBe(before.body.status);
        expect(after.body.outstandingIdeasCap).toBe(before.body.outstandingIdeasCap);
        expect(after.body.updatedAt).toBe(before.body.updatedAt);

        // And no Ideas were created under the Mission's scope — the ?missionId
        // filter stays empty (the tick never reached the spawn path).
        const scoped = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(scoped.status()).toBe(200);
        const scopedBody = (await scoped.json()) as Array<{ id: string }>;
        expect(Array.isArray(scopedBody)).toBe(true);
        expect(scopedBody.length).toBe(0);
    });

    test('repeated run-now is byte-idempotent: the no-ideas record is identical across consecutive calls', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        const mission = await createMission(request, token, {
            title: `RunNow idempotent ${s}`,
            description: 'A mission ticked repeatedly to prove the record is byte-stable',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        const first = await runNow(request, token, mission.id);
        expectKeylessRunRecord(first.body, mission.id);

        // Three more clicks: the body is byte-identical every time (the keyless
        // no-op record never drifts — no hidden counter, timestamp, or token).
        for (let i = 0; i < 3; i++) {
            const again = await runNow(request, token, mission.id);
            expect(again.http).toBe(200);
            expect(again.body).toEqual(first.body);
        }
    });

    test('run-now from PAUSED records the same no-ideas reason (cron paused, manual push honoured)', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        const mission = await createMission(request, token, {
            title: `RunNow paused ${s}`,
            description: 'A paused mission whose owner manually ticks it off-cadence',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        const pause = await request.post(`${API_BASE}/api/me/missions/${mission.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(pause.status()).toBe(200);
        expect((await pause.json()).status).toBe('paused');

        // PAUSED is a runnable status for run-now — the record is the same
        // no-ideas/skipped-no-profile as the ACTIVE path (the gate is identical).
        const tick = await runNow(request, token, mission.id);
        expect(tick.http).toBe(200);
        expectKeylessRunRecord(tick.body, mission.id);

        // And the manual tick did NOT resume the Mission — it stays PAUSED.
        const after = await getMission(request, token, mission.id);
        expect(after.body.status).toBe('paused');
    });

    test('run-now anonymously is 401 with the bare Unauthorized shape (no error key)', async ({
        request,
    }, testInfo) => {
        // Set up the Mission as an authed owner, then hit run-now with NO bearer
        // — the `request` fixture carries no storageState cookie, so an Authless
        // call is genuinely anonymous.
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);
        const mission = await createMission(request, token, {
            title: `RunNow anon ${s}`,
            description: 'A mission used to assert the anonymous run-now rejection shape',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        const res = await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`);
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.statusCode).toBe(401);
        expect(String(body.message)).toMatch(/unauthorized/i);
        // The 401 envelope is the bare {message,statusCode} — distinct from the
        // 400/404 envelopes which also carry an `error` key.
        expect(body.error).toBeUndefined();
    });

    test('run-now error envelopes are distinct: 400 malformed-id vs 404 unknown vs 400 completed-gate', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const headers = authedHeaders(token);
        const s = suffix(testInfo);

        // ── 400: a non-UUID id is rejected by the ParseUUIDPipe BEFORE the
        // service runs — exact NestJS message + the `error:'Bad Request'` key.
        const malformed = await request.post(`${API_BASE}/api/me/missions/not-a-uuid/run-now`, {
            headers,
        });
        expect(malformed.status()).toBe(400);
        const malformedBody = await malformed.json();
        expect(String(malformedBody.message)).toMatch(/validation failed \(uuid is expected\)/i);
        expect(malformedBody.error).toBe('Bad Request');

        // ── 404: a well-formed but unknown UUID — the run-record gate 404s.
        const unknown = await runNow(request, token, UNKNOWN_UUID);
        expect(unknown.http).toBe(404);
        expect(String(unknown.body.message)).toMatch(/mission not found/i);

        // ── 400: the lifecycle gate — a COMPLETED mission cannot be ticked,
        // with the exact allowed-states diagnostic + the `error:'Bad Request'`.
        const mission = await createMission(request, token, {
            title: `RunNow envelopes ${s}`,
            description: 'A mission completed then ticked to assert the lifecycle gate envelope',
            type: 'one-shot',
        });
        const complete = await request.post(`${API_BASE}/api/me/missions/${mission.id}/complete`, {
            headers,
        });
        expect(complete.status()).toBe(200);
        const completedTick = await request.post(
            `${API_BASE}/api/me/missions/${mission.id}/run-now`,
            { headers },
        );
        expect(completedTick.status()).toBe(400);
        const completedBody = await completedTick.json();
        expect(String(completedBody.message)).toMatch(
            /cannot be run from status "completed"\. allowed: active, paused/i,
        );
        expect(completedBody.error).toBe('Bad Request');
    });

    test('run-now after DELETE is 404: delete is allowed from any status, then the run-record gate sees no Mission', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const headers = authedHeaders(token);
        const s = suffix(testInfo);

        const mission = await createMission(request, token, {
            title: `RunNow deleted ${s}`,
            description: 'A mission deleted while ACTIVE, after which run-now must 404',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        // The Mission ticks fine while it exists (establishes it is real).
        const before = await runNow(request, token, mission.id);
        expectKeylessRunRecord(before.body, mission.id);

        // DELETE is allowed from ANY status (controller doc) — 200 {deleted:true}.
        const del = await request.delete(`${API_BASE}/api/me/missions/${mission.id}`, { headers });
        expect(del.status()).toBe(200);
        expect((await del.json()).deleted).toBe(true);

        // After delete the run-record gate finds no Mission ⇒ 404.
        const after = await runNow(request, token, mission.id);
        expect(after.http).toBe(404);
        expect(String(after.body.message)).toMatch(/mission not found/i);
    });

    test('run-now is owner-scoped on the no-ideas record: a stranger 404s without observing the reason', async ({
        request,
    }, testInfo) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        const mission = await createMission(request, owner.access_token, {
            title: `RunNow scoped ${s}`,
            description: 'A mission whose run-record reason a stranger must not be able to read',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        // The owner sees the full no-ideas/skipped-no-profile record.
        const ownerTick = await runNow(request, owner.access_token, mission.id);
        expectKeylessRunRecord(ownerTick.body, mission.id);

        // The stranger gets a 404 — NOT the run record. The reason string is
        // never exposed cross-tenant (the 404 carries no `status`/`message:
        // skipped-no-profile`, only the not-found envelope).
        const strangerTick = await runNow(request, stranger.access_token, mission.id);
        expect(strangerTick.http).toBe(404);
        expect(String(strangerTick.body.message)).toMatch(/mission not found/i);
        expect(strangerTick.body.status).toBeUndefined();

        // The owner's tick still works after the stranger's failed attempt —
        // the rejected cross-tenant call didn't lock or mutate the Mission.
        const ownerTick2 = await runNow(request, owner.access_token, mission.id);
        expectKeylessRunRecord(ownerTick2.body, mission.id);
        expect(ownerTick2.body).toEqual(ownerTick.body);
    });

    test('a one-shot Mission (no schedule) records the same no-ideas tick as a never-firing scheduled one — run-now bypasses cron', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        // A one-shot mission has NO schedule; run-now still ticks it.
        const oneShot = await createMission(request, token, {
            title: `RunNow oneshot ${s}`,
            description: 'A one-shot mission with no cron at all ticks via manual run-now',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });
        expect(oneShot.schedule).toBeNull();
        const oneShotTick = await runNow(request, token, oneShot.id);
        expectKeylessRunRecord(oneShotTick.body, oneShot.id);

        // A scheduled mission whose cron can NEVER fire (Feb 31) records the
        // SAME no-ideas tick — proving run-now's cron bypass makes the schedule
        // irrelevant to the run-record outcome (never `cron-no-match`).
        const scheduled = await createMission(request, token, {
            title: `RunNow sched ${s}`,
            description: 'A scheduled mission with a never-firing cron ticked manually',
            type: 'scheduled',
            schedule: '0 0 31 2 *',
            outstandingIdeasCap: 5,
        });
        expect(scheduled.type).toBe('scheduled');
        const schedTick = await runNow(request, token, scheduled.id);
        expectKeylessRunRecord(schedTick.body, scheduled.id);
        // Both records are byte-identical save the missionId — the tick outcome
        // is schedule-independent under run-now.
        expect({ ...schedTick.body, missionId: 'X' }).toEqual({
            ...oneShotTick.body,
            missionId: 'X',
        });
    });

    test('run-now with a positive cap and zero outstanding records no-ideas (headroom path), distinct from a cap-hit record', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = suffix(testInfo);

        // cap=1, outstanding=0 ⇒ headroom ⇒ the tick reaches the generator and
        // records `no-ideas` (NOT cap-hit). This pins that the gate is
        // `outstanding >= cap`, observable as a DIFFERENT record than cap=0.
        const headroom = await createMission(request, token, {
            title: `RunNow headroom ${s}`,
            description: 'A cap-of-one mission with zero outstanding ideas still runs the tick',
            type: 'one-shot',
            outstandingIdeasCap: 1,
        });
        const headroomTick = await runNow(request, token, headroom.id);
        expectKeylessRunRecord(headroomTick.body, headroom.id);
        expect(headroomTick.body.status).not.toBe('cap-hit');

        // Contrast: a cap=0 mission records cap-hit (NOT no-ideas) — the cap
        // gate short-circuits BEFORE the generator, so no skipped-no-profile.
        const capped = await createMission(request, token, {
            title: `RunNow capzero ${s}`,
            description: 'A zero-cap mission whose tick short-circuits to a cap-hit record',
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });
        const cappedTick = await runNow(request, token, capped.id);
        expect(cappedTick.http).toBe(200);
        expect(cappedTick.body.status).toBe('cap-hit');
        expect(String(cappedTick.body.message)).toMatch(/outstanding=0 >= cap=0/i);
        // The two run-records are genuinely different outcomes for the same user.
        expect(cappedTick.body.status).not.toBe(headroomTick.body.status);
    });

    test('run-now records survive a PATCH round-trip: the reason is re-derived fresh each tick, never cached on the Mission', async ({
        request,
    }, testInfo) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const headers = authedHeaders(token);
        const s = suffix(testInfo);

        // Start cap=0 ⇒ cap-hit record (generator never runs).
        const mission = await createMission(request, token, {
            title: `RunNow patch-record ${s}`,
            description: 'A mission whose run-record flips with the live cap, never cached',
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });
        const capHit = await runNow(request, token, mission.id);
        expect(capHit.body.status).toBe('cap-hit');

        // PATCH the cap up ⇒ the NEXT tick re-derives a no-ideas record (the
        // outcome is computed per-tick, not stored on the Mission row).
        const patch = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: { outstandingIdeasCap: 5 },
        });
        expect(patch.status()).toBe(200);
        expect((await patch.json()).outstandingIdeasCap).toBe(5);

        const afterPatch = await runNow(request, token, mission.id);
        expectKeylessRunRecord(afterPatch.body, mission.id);
        expect(afterPatch.body.status).not.toBe('cap-hit');

        // PATCH back to 0 ⇒ the record re-arms to cap-hit on the very next tick.
        const patchDown = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers,
            data: { outstandingIdeasCap: 0 },
        });
        expect(patchDown.status()).toBe(200);
        const reArmed = await runNow(request, token, mission.id);
        expect(reArmed.body.status).toBe('cap-hit');
        expect(String(reArmed.body.message)).toMatch(/cap=0/i);
    });
});
