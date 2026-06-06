import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-mission-tick-cap — COMPLEX, multi-step integration flows for the
 * Mission TICK + outstanding-Ideas CAP machinery exposed by the public
 * API (`POST /api/me/missions/:id/run-now`, backed by
 * `MissionTickService.runOnce` → `evaluateAndRun`). Every request/response
 * shape, status code, and error string asserted below was confirmed
 * against the LIVE API at http://127.0.0.1:3100 before being written.
 *
 * NET-NEW vs the existing `flow-mission-idea-build.spec.ts` (which pins a
 * single static cap=0 tick, the run-now union, and the COMPLETED gate):
 * here we drive the cap as a *live, re-resolved* value across consecutive
 * ticks, exercise the PAUSED-mission tick path (run-now is allowed from
 * ACTIVE *and* PAUSED — the cron is paused but a manual push is still a
 * legitimate request), contrast the MANUAL run-now (cron bypassed) against
 * the SCHEDULED cron contract, walk the full effective-cap fallback ladder
 * (per-Mission cap → user pref → platform default 20 → -1 unlimited
 * sentinel), and pin the tick RESPONSE-shape invariants (the count fields
 * only appear on `spawned`).
 *
 * PROBED CONTRACTS (live, 2026-06-01):
 *
 *   POST /api/me/missions/:id/run-now  → 200
 *     union status ∈ {noop-placeholder,queued,spawned,cap-hit,no-ideas,
 *                     failed,cron-no-match}; body { status, missionId,
 *                     ideasCreated?, ideasQueued?, message? }.
 *     - cap=0 mission       → { status:'cap-hit', message:'outstanding=0 >= cap=0' }
 *     - null / default cap  → platform default 20 ⇒ NOT cap-hit; on this
 *                             no-AI / no-profile stack the generator
 *                             short-circuits to { status:'no-ideas',
 *                             message:'skipped-no-profile' }.
 *     - cap=-1 (unlimited)  → resolveEffectiveCap → null ⇒ NOT cap-hit.
 *     - run-now ALWAYS bypasses the cron match (allowCronMismatch=true) —
 *       a scheduled Mission whose cron can never fire (e.g. '0 0 31 2 *')
 *       still ticks; the outcome is NEVER 'cron-no-match'.
 *     - ideasCreated / ideasQueued are present ONLY on 'spawned' (the
 *       no-AI stack never spawns ⇒ they are absent on cap-hit / no-ideas).
 *   run-now lifecycle gate: ACTIVE | PAUSED allowed; COMPLETED ⇒ 400
 *     "Mission cannot be run from status \"completed\". Allowed: active, paused."
 *   run-now on a Mission owned by another user ⇒ 404 "Mission not found".
 *   run-now on an unknown UUID ⇒ 404 "Mission not found".
 *   outstandingIdeasCap @Min(-1): create/patch with -2 ⇒ 400.
 *   PATCH /:id { outstandingIdeasCap } re-resolves on the NEXT tick — the
 *     cap is read fresh per tick, so raising it lifts a prior cap-hit.
 *   Mission lifecycle: pause (ACTIVE→PAUSED), resume (PAUSED→ACTIVE),
 *     complete ((ACTIVE|PAUSED)→COMPLETED) all 200; type/schedule round-trip.
 *
 * Cross-spec isolation: ALL mutations run on FRESH registerUserViaAPI()
 * users (never the shared seeded user) — these are pure API flows and a
 * per-user shadow can't leak into sibling specs. Unique titles (stamp()),
 * assert toContain over exact counts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '11111111-1111-1111-1111-111111111111';

/** The full run-now union the controller declares. */
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
 * Non-error outcomes a runnable (NOT cap-hit) Mission tick can emit on
 * a stack with no AI provider / no user profile. We never assert the
 * specific one (env-adaptive: 'spawned' on a configured stack), only that
 * it is one of the truthful non-cap, non-cron outcomes.
 */
const RUNNABLE_NON_CAP = ['queued', 'spawned', 'no-ideas', 'failed'];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface MissionLike {
    id: string;
    title: string;
    type: string;
    status: string;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<MissionLike> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
    const m = (await res.json()) as MissionLike;
    expect(m.id).toMatch(UUID_RE);
    return m;
}

interface RunNowBody {
    status: string;
    missionId: string;
    ideasCreated?: number;
    ideasQueued?: number;
    message?: string;
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

/**
 * Shape invariant every 200 run-now response must satisfy: the status is
 * one of the union members, the missionId echoes back, the count fields
 * are well-typed when present, and they are ONLY present on 'spawned'.
 */
function assertRunNowShape(body: RunNowBody, missionId: string): void {
    expect(RUN_NOW_STATUSES).toContain(body.status);
    expect(body.missionId).toBe(missionId);
    if (body.status === 'spawned') {
        // On a configured stack the count fields accompany a spawn.
        if (body.ideasCreated !== undefined) expect(typeof body.ideasCreated).toBe('number');
        if (body.ideasQueued !== undefined) expect(typeof body.ideasQueued).toBe('number');
    } else {
        // The no-AI stack never spawns; the count fields must be absent on
        // every non-spawn outcome (they are only meaningful for 'spawned').
        expect(body.ideasCreated).toBeUndefined();
        expect(body.ideasQueued).toBeUndefined();
    }
}

test.describe('flow: Mission tick + outstanding-Ideas cap', () => {
    // ──────────────────────────────────────────────────────────────────
    // FLOW 1 — THE CAP IS A LIVE, RE-RESOLVED VALUE ACROSS TICKS.
    // Each tick reads the effective cap fresh (resolveEffectiveCap). A
    // cap=0 Mission short-circuits to cap-hit; PATCHing the cap UP between
    // ticks lifts the throttle on the very next tick — no re-create needed.
    // This is the dynamic counterpart to the existing static-cap=0 test.
    // ──────────────────────────────────────────────────────────────────
    test('the outstanding-Ideas cap is re-resolved every tick: PATCH raises it and the next tick is no longer cap-hit', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        const mission = await createMission(request, token, {
            title: `Cap-mutation ${s}`,
            description: 'A one-shot mission whose cap is mutated between manual ticks',
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });
        expect(mission.outstandingIdeasCap).toBe(0);
        expect(mission.status).toBe('active');

        // ── Tick #1: cap=0 ⇒ deterministic cap-hit BEFORE any generation.
        const t1 = await runNow(request, token, mission.id);
        expect(t1.http).toBe(200);
        assertRunNowShape(t1.body, mission.id);
        expect(t1.body.status).toBe('cap-hit');
        expect(String(t1.body.message)).toMatch(/outstanding=0 >= cap=0/i);

        // ── Tick #2 (idempotent): same cap, same outcome — a repeated click
        // on a throttled Mission stays cap-hit (never silently spawns).
        const t1b = await runNow(request, token, mission.id);
        expect(t1b.body.status).toBe('cap-hit');
        expect(String(t1b.body.message)).toMatch(/cap=0/i);

        // ── Raise the cap to a positive value via PATCH (ACTIVE mission).
        const patchUp = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outstandingIdeasCap: 2 },
        });
        expect(patchUp.status(), `patch body=${await patchUp.text()}`).toBe(200);
        expect((await patchUp.json()).outstandingIdeasCap).toBe(2);

        // ── Tick #3: cap=2, outstanding=0 ⇒ headroom ⇒ NO LONGER cap-hit.
        // On the no-AI stack the generator short-circuits (no-ideas), but
        // the cap gate is the assertion that matters: it must have lifted.
        const t2 = await runNow(request, token, mission.id);
        expect(t2.http).toBe(200);
        assertRunNowShape(t2.body, mission.id);
        expect(t2.body.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(t2.body.status);

        // ── PATCH the cap to the -1 "unlimited" sentinel — resolveEffectiveCap
        // maps negative → null ⇒ still no cap.
        const patchUnlimited = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outstandingIdeasCap: -1 },
        });
        expect(patchUnlimited.status()).toBe(200);
        expect((await patchUnlimited.json()).outstandingIdeasCap).toBe(-1);

        const t3 = await runNow(request, token, mission.id);
        expect(t3.body.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(t3.body.status);

        // ── Drop the cap back to 0 ⇒ the throttle re-arms on the next tick.
        const patchDown = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outstandingIdeasCap: 0 },
        });
        expect(patchDown.status()).toBe(200);
        const t4 = await runNow(request, token, mission.id);
        expect(t4.body.status).toBe('cap-hit');
        expect(String(t4.body.message)).toMatch(/cap=0/i);

        // ── A below-sentinel cap (-2) is rejected by the @Min(-1) DTO rule.
        const badCap = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outstandingIdeasCap: -2 },
        });
        expect(badCap.status()).toBe(400);
        // The cap is unchanged by the rejected PATCH — the tick is still cap-hit.
        const t5 = await runNow(request, token, mission.id);
        expect(t5.body.status).toBe('cap-hit');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 2 — TICK ON A PAUSED MISSION (run-now is allowed from PAUSED).
    // The cron is paused, but the user's manual "run this once anyway"
    // click is honoured. The cap is STILL enforced on a paused Mission
    // (so paused-then-spam can't bypass the throttle). After complete the
    // gate flips to 400. The existing spec only covers the COMPLETED gate.
    // ──────────────────────────────────────────────────────────────────
    test('run-now is honoured on a PAUSED mission (cap still enforced), resumes, then 400s once COMPLETED', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // ── A null-cap mission (omit outstandingIdeasCap ⇒ platform default 20).
        const mission = await createMission(request, token, {
            title: `Paused-tick ${s}`,
            description: 'A mission paused then manually ticked off-cadence by its owner',
            type: 'one-shot',
        });
        expect(mission.outstandingIdeasCap).toBeNull();

        // ── Pause it (ACTIVE → PAUSED).
        const pause = await request.post(`${API_BASE}/api/me/missions/${mission.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(pause.status()).toBe(200);
        expect((await pause.json()).status).toBe('paused');

        // ── run-now is STILL allowed from PAUSED. Null cap ⇒ default 20 ⇒
        // not cap-hit ⇒ a truthful runnable outcome (no-ideas on no-AI).
        const pausedTick = await runNow(request, token, mission.id);
        expect(pausedTick.http).toBe(200);
        assertRunNowShape(pausedTick.body, mission.id);
        expect(pausedTick.body.status).not.toBe('cap-hit');
        expect(pausedTick.body.status).not.toBe('cron-no-match');
        expect(RUNNABLE_NON_CAP).toContain(pausedTick.body.status);

        // ── A PAUSED mission with cap=0 STILL cap-hits on run-now — pausing
        // does not disarm the throttle (otherwise paused-spam bypasses it).
        const capped = await createMission(request, token, {
            title: `Paused-capped ${s}`,
            description: 'A paused mission with a zero cap still throttles manual ticks',
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });
        await request.post(`${API_BASE}/api/me/missions/${capped.id}/pause`, {
            headers: authedHeaders(token),
        });
        const pausedCapTick = await runNow(request, token, capped.id);
        expect(pausedCapTick.body.status).toBe('cap-hit');
        expect(String(pausedCapTick.body.message)).toMatch(/outstanding=0 >= cap=0/i);

        // ── Resume (PAUSED → ACTIVE) — run-now keeps working post-resume.
        const resume = await request.post(`${API_BASE}/api/me/missions/${mission.id}/resume`, {
            headers: authedHeaders(token),
        });
        expect(resume.status()).toBe(200);
        expect((await resume.json()).status).toBe('active');
        const resumedTick = await runNow(request, token, mission.id);
        expect(resumedTick.body.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(resumedTick.body.status);

        // ── Pause → complete ((ACTIVE|PAUSED) → COMPLETED), then run-now 400.
        await request.post(`${API_BASE}/api/me/missions/${mission.id}/pause`, {
            headers: authedHeaders(token),
        });
        const complete = await request.post(`${API_BASE}/api/me/missions/${mission.id}/complete`, {
            headers: authedHeaders(token),
        });
        expect(complete.status()).toBe(200);
        expect((await complete.json()).status).toBe('completed');

        const completedTick = await runNow(request, token, mission.id);
        expect(completedTick.http).toBe(400);
        expect(String(completedTick.body.message)).toMatch(
            /cannot be run from status "completed"\. allowed: active, paused/i,
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 3 — MANUAL run-now BYPASSES CRON; SCHEDULED vs ONE-SHOT contract.
    // run-now sets allowCronMismatch=true, so a SCHEDULED Mission whose
    // cron can NEVER fire on the current minute (e.g. '0 0 31 2 *' — Feb 31)
    // still ticks; the outcome is never 'cron-no-match'. A one-shot Mission
    // has no schedule at all yet ticks identically. The cap is orthogonal
    // to type — both honour it.
    // ──────────────────────────────────────────────────────────────────
    test('manual run-now bypasses the cron match for a never-firing scheduled mission and still honours the cap', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // ── A SCHEDULED mission with a cron that cannot match this minute.
        const scheduled = await createMission(request, token, {
            title: `Off-cadence ${s}`,
            description: 'A scheduled mission with a never-firing cron, ticked manually',
            type: 'scheduled',
            schedule: '0 0 31 2 *', // Feb 31 — never a real date.
            outstandingIdeasCap: 5,
        });
        expect(scheduled.type).toBe('scheduled');
        expect(scheduled.schedule).toBe('0 0 31 2 *');

        // run-now forces the tick despite the cron never matching.
        const schedTick = await runNow(request, token, scheduled.id);
        expect(schedTick.http).toBe(200);
        assertRunNowShape(schedTick.body, scheduled.id);
        expect(schedTick.body.status).not.toBe('cron-no-match');
        expect(RUNNABLE_NON_CAP).toContain(schedTick.body.status);

        // ── A ONE-SHOT mission (no schedule at all) ticks the same way.
        const oneShot = await createMission(request, token, {
            title: `One-shot tick ${s}`,
            description: 'A one-shot mission with no cron ticks via manual run-now',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });
        expect(oneShot.type).toBe('one-shot');
        expect(oneShot.schedule).toBeNull();
        const oneShotTick = await runNow(request, token, oneShot.id);
        expect(oneShotTick.body.status).not.toBe('cron-no-match');
        expect(RUNNABLE_NON_CAP).toContain(oneShotTick.body.status);

        // ── The cap is type-orthogonal: a scheduled cap=0 mission ALSO
        // cap-hits on manual run-now (the cron bypass doesn't bypass the cap).
        const schedCapped = await createMission(request, token, {
            title: `Sched cap0 ${s}`,
            description: 'A scheduled mission with a zero cap throttles manual ticks too',
            type: 'scheduled',
            schedule: '* * * * *', // matches every minute — irrelevant under run-now.
            outstandingIdeasCap: 0,
        });
        const schedCapTick = await runNow(request, token, schedCapped.id);
        expect(schedCapTick.body.status).toBe('cap-hit');
        expect(String(schedCapTick.body.message)).toMatch(/cap=0/i);

        // ── Schedule-vs-type consistency is server-enforced (sanity guard so
        // the "scheduled" arms above are real): scheduled REQUIRES a cron.
        const badScheduled = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: {
                title: `Bad scheduled ${s}`,
                description: 'A scheduled mission with no cron must be rejected at create',
                type: 'scheduled',
            },
        });
        expect(badScheduled.status()).toBe(400);
        expect(String((await badScheduled.json()).message)).toMatch(
            /scheduled requires a non-empty `?schedule/i,
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 4 — THE EFFECTIVE-CAP FALLBACK LADDER (resolveEffectiveCap).
    // Priority: per-Mission cap (incl. -1) → user pref → platform default
    // (20). We pin the OBSERVABLE behaviour at each rung WITHOUT relying on
    // AI: cap=0 ⇒ cap-hit with the exact "cap=0" diagnostic; null/default
    // and -1 ⇒ never cap-hit. The cap-hit message echoes the resolved cap,
    // so it is the proof the resolver picked the right rung.
    // ──────────────────────────────────────────────────────────────────
    test('the effective-cap fallback ladder is observable through run-now: explicit 0, default (null), and -1 unlimited', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // ── Rung 1: explicit per-Mission cap=0 ⇒ cap-hit, diagnostic "cap=0".
        const capZero = await createMission(request, token, {
            title: `Ladder zero ${s}`,
            description: 'Explicit zero cap mission — the strictest rung of the ladder',
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });
        const zeroTick = await runNow(request, token, capZero.id);
        expect(zeroTick.body.status).toBe('cap-hit');
        expect(String(zeroTick.body.message)).toMatch(/outstanding=0 >= cap=0/);

        // ── Rung 2: null cap (omitted) ⇒ falls to user pref / platform
        // default (20) ⇒ outstanding 0 < 20 ⇒ NEVER cap-hit.
        const capDefault = await createMission(request, token, {
            title: `Ladder default ${s}`,
            description: 'Null cap mission falls through to the platform default of twenty',
            type: 'one-shot',
        });
        expect(capDefault.outstandingIdeasCap).toBeNull();
        const defaultTick = await runNow(request, token, capDefault.id);
        expect(defaultTick.body.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(defaultTick.body.status);

        // ── Rung 3: explicit -1 "unlimited" sentinel ⇒ resolveEffectiveCap
        // returns null ⇒ NEVER cap-hit, regardless of outstanding count.
        const capUnlimited = await createMission(request, token, {
            title: `Ladder unlimited ${s}`,
            description: 'Unlimited cap mission uses the negative-one sentinel for no cap',
            type: 'one-shot',
            outstandingIdeasCap: -1,
        });
        expect(capUnlimited.outstandingIdeasCap).toBe(-1);
        const unlimitedTick = await runNow(request, token, capUnlimited.id);
        expect(unlimitedTick.body.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(unlimitedTick.body.status);

        // ── A positive cap > 0 with 0 outstanding also has headroom ⇒ the
        // "cap=N" arm only triggers when outstanding meets the cap. Here a
        // cap=1 mission with 0 outstanding is runnable, proving the gate is
        // `outstanding >= cap`, not merely `cap is set`.
        const capOne = await createMission(request, token, {
            title: `Ladder one ${s}`,
            description: 'A cap of one with zero outstanding ideas still has headroom to run',
            type: 'one-shot',
            outstandingIdeasCap: 1,
        });
        const oneTick = await runNow(request, token, capOne.id);
        expect(oneTick.body.status).not.toBe('cap-hit');
        expect(RUNNABLE_NON_CAP).toContain(oneTick.body.status);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 5 — THE run-now RESPONSE-SHAPE CONTRACT + COUNT-FIELD DISCIPLINE.
    // Across a matrix of missions (cap-hit, runnable, autoBuildWorks on/off)
    // every 200 response must satisfy the union-status + missionId echo
    // invariant, and the ideasCreated/ideasQueued count fields must appear
    // ONLY on 'spawned'. autoBuildWorks round-trips on create but does NOT
    // change the response shape on a non-spawning (no-AI) stack.
    // ──────────────────────────────────────────────────────────────────
    test('every run-now response obeys the union+echo shape and the count fields appear only on spawn', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const s = stamp();

        // autoBuildWorks=true round-trips and is the flag that, on a
        // configured stack, would drive ideasQueued > 0 inside a 'spawned'.
        const autoBuild = await createMission(request, token, {
            title: `Autobuild ${s}`,
            description: 'A mission with autoBuildWorks enabled to exercise the queued path',
            type: 'one-shot',
            outstandingIdeasCap: 5,
            autoBuildWorks: true,
        });
        expect(autoBuild.autoBuildWorks).toBe(true);

        const noAutoBuild = await createMission(request, token, {
            title: `No-autobuild ${s}`,
            description: 'A mission with autoBuildWorks left at its default of false',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });
        expect(noAutoBuild.autoBuildWorks).toBe(false);

        const capHit = await createMission(request, token, {
            title: `Shape cap0 ${s}`,
            description: 'A zero-cap mission whose tick must be a count-field-free cap-hit',
            type: 'one-shot',
            outstandingIdeasCap: 0,
        });

        for (const m of [autoBuild, noAutoBuild, capHit]) {
            const tick = await runNow(request, token, m.id);
            expect(tick.http).toBe(200);
            // The universal shape invariant — including the count-field
            // discipline (present iff spawned).
            assertRunNowShape(tick.body, m.id);
        }

        // The cap=0 mission is specifically cap-hit AND carries no counts.
        const capTick = await runNow(request, token, capHit.id);
        expect(capTick.body.status).toBe('cap-hit');
        expect(capTick.body.ideasCreated).toBeUndefined();
        expect(capTick.body.ideasQueued).toBeUndefined();
        expect(typeof capTick.body.message).toBe('string');

        // A runnable mission's tick is repeatable and shape-stable across
        // consecutive calls (idempotent under the no-AI no-op outcome).
        const a = await runNow(request, token, autoBuild.id);
        const b = await runNow(request, token, autoBuild.id);
        assertRunNowShape(a.body, autoBuild.id);
        assertRunNowShape(b.body, autoBuild.id);
        expect(a.body.status).not.toBe('cap-hit');
        expect(b.body.status).not.toBe('cap-hit');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 6 — TICK OWNERSHIP + EXISTENCE GATES (no cross-tenant ticking).
    // run-now is owner-scoped: a second user can neither tick nor even
    // distinguish another user's Mission from a missing one (both 404
    // "Mission not found" — no existence leak). An unknown UUID 404s; a
    // malformed (non-UUID) id is a 400 ParseUUIDPipe rejection.
    // ──────────────────────────────────────────────────────────────────
    test('run-now is owner-scoped: a stranger gets 404 (no existence leak), unknown UUID 404s, malformed id 400s', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = stamp();

        const mission = await createMission(request, owner.access_token, {
            title: `Owned ${s}`,
            description: 'A mission owned by one user that a stranger must not be able to tick',
            type: 'one-shot',
            outstandingIdeasCap: 5,
        });

        // ── Owner can tick it (sanity — establishes the mission is real).
        const ownerTick = await runNow(request, owner.access_token, mission.id);
        expect(ownerTick.http).toBe(200);
        assertRunNowShape(ownerTick.body, mission.id);

        // ── Stranger cannot tick it — 404, identical to a missing Mission.
        const strangerTick = await runNow(request, stranger.access_token, mission.id);
        expect(strangerTick.http).toBe(404);
        expect(String(strangerTick.body.message)).toMatch(/mission not found/i);

        // ── A real-but-unknown UUID 404s with the SAME message (no leak of
        // whether the owner's id exists — the stranger can't tell them apart).
        const unknownTick = await runNow(request, stranger.access_token, UNKNOWN_UUID);
        expect(unknownTick.http).toBe(404);
        expect(String(unknownTick.body.message)).toMatch(/mission not found/i);

        // ── A malformed (non-UUID) id is rejected by the ParseUUIDPipe (400)
        // BEFORE the service runs — a different failure mode than 404.
        const malformed = await request.post(`${API_BASE}/api/me/missions/not-a-uuid/run-now`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(malformed.status()).toBe(400);

        // ── The stranger also can't observe the mission via GET — the
        // owner-scoped 404 is consistent across the read + tick surfaces.
        const strangerGet = await request.get(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status()).toBe(404);

        // ── And the owner's tick still works afterward — the stranger's
        // failed attempts did not mutate or lock the Mission.
        const ownerTick2 = await runNow(request, owner.access_token, mission.id);
        expect(ownerTick2.http).toBe(200);
        assertRunNowShape(ownerTick2.body, mission.id);
    });
});
