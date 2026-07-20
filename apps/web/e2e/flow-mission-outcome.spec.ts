import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-mission-outcome — PR-3 (domain-model evolution) END-TO-END INTEGRATION
 * flows for the Mission conclusion-OUTCOME surface
 * (`apps/api/src/missions/missions.controller.ts` POST /:id/complete +
 * `@ever-works/agent/missions` MissionsService.complete → Mission.outcome /
 * Mission.completedAt, migration 1781800000000).
 *
 * Contract under test (source-verified against this branch):
 *
 *   POST /api/me/missions/:id/complete            body {} | { outcome }
 *     - `outcome` is OPTIONAL and IsIn-validated (CompleteMissionDto):
 *       succeeded | partially_succeeded | failed | cancelled | superseded.
 *     - Omitted outcome keeps today's behavior exactly: status → 'completed',
 *       outcome stays NULL, completedAt is stamped.
 *     - An out-of-vocabulary outcome → 400 from the global ValidationPipe
 *       (the mission is untouched — still completable afterwards).
 *     - complete is legal from active|paused ONLY; a second complete on an
 *       already-completed Mission → 400
 *       ("Mission cannot be completed from status \"completed\"").
 *   POST /api/me/missions/:id/resume
 *     - legal from paused|failed ONLY (FAILED is tick-worker-territory; not
 *       producible via the public API, so the failed→active revival leg is
 *       covered by agent-package unit tests, not here).
 *     - resume from 'completed' → 400 (completed is NOT revivable via resume).
 *     - transition() clears outcome/completedAt whenever the target status is
 *       ACTIVE — a pause→resume round-trip on a never-completed Mission leaves
 *       both fields null (no phantom verdict).
 *   GET /api/activity-log?actionType=mission_completed
 *     - MissionsService.complete writes a best-effort activity row
 *       (actionType=mission_completed, details.missionId + details.outcome)
 *       via the @Optional ActivityLogService; the row is user-scoped.
 *
 * HUMAN-ONLY invariant (I-4): outcome is a human's judgment. The complete verb
 * is reachable only from user-authenticated surfaces (this API + the dashboard
 * chat tool that runs in the human's session); the autonomous agent runtime has
 * NO complete-mission tool. These flows exercise the human path exclusively.
 *
 * NON-DUPLICATION — sibling mission specs already own:
 *   - flow-mission-lifecycle-deep.spec.ts → the legal state-machine walk,
 *     budget endpoint, PATCH matrix, delete sweep, list paging, isolation.
 *   - flow-mission-crud-schedule.spec.ts → create-time validation + the
 *     exhaustive illegal-transition grid (pre-outcome).
 *   This file pins ONLY the net-new outcome/completedAt semantics + the
 *   mission_completed activity emission.
 *
 * Cross-spec isolation: every flow runs on a FRESH registerUserViaAPI() user
 * (mission + activity rows are user-scoped). No module-scope data loads —
 * unique suffixes derive from a per-test counter.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type MissionOutcome = 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled' | 'superseded';

interface MissionDto {
    id: string;
    title: string;
    description: string;
    type: 'one-shot' | 'scheduled';
    status: 'active' | 'paused' | 'completed' | 'failed';
    outcome: MissionOutcome | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface ActivityRow {
    id: string;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    details?: Record<string, unknown> | null;
    createdAt: string;
}

interface ActivityList {
    activities: ActivityRow[];
    total: number;
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

async function postVerb(
    request: APIRequestContext,
    token: string,
    id: string,
    verb: 'pause' | 'resume' | 'complete',
    body: Record<string, unknown> = {},
) {
    return request.post(`${API_BASE}/api/me/missions/${id}/${verb}`, {
        headers: authedHeaders(token),
        data: body,
    });
}

test.describe('flow: Mission completion outcome + completedAt + activity emission', () => {
    // ──────────────────────────────────────────────────────────────────
    // FLOW 1 — COMPLETE WITHOUT AN OUTCOME: the pre-PR-3 behavior is preserved
    // byte-for-byte on the status axis, and the two NEW columns behave as
    // specced: `outcome` stays NULL when the human offers no verdict, while
    // `completedAt` is ALWAYS stamped (a valid ISO instant at/after creation).
    // Both survive a fresh GET (persisted, not response-only).
    // ──────────────────────────────────────────────────────────────────
    test('complete with empty body → completed, outcome null, completedAt stamped ISO', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('no-outcome');

        const m = await createMission(request, token, {
            title: `No Outcome ${sfx}`,
            description: `complete without verdict ${sfx}`,
            type: 'one-shot',
        });
        // At birth the conclusion fields are both null.
        expect(m.outcome).toBeNull();
        expect(m.completedAt).toBeNull();

        const res = await postVerb(request, token, m.id, 'complete', {});
        expect(res.status(), `complete body=${await res.text()}`).toBe(200);
        const completed = (await res.json()) as MissionDto;
        expect(completed.status).toBe('completed');
        expect(completed.outcome).toBeNull();
        expect(completed.completedAt).not.toBeNull();
        expect(typeof completed.completedAt).toBe('string');
        expect(completed.completedAt as string).toMatch(ISO_RE);
        // completedAt is a sane instant: at/after creation, not in the future
        // beyond clock skew.
        const stamped = new Date(completed.completedAt as string).getTime();
        expect(Number.isNaN(stamped)).toBe(false);
        expect(stamped).toBeGreaterThanOrEqual(new Date(m.createdAt).getTime() - 5_000);
        expect(stamped).toBeLessThanOrEqual(Date.now() + 60_000);

        // The verdict-less completion persists across a fresh GET.
        const reread = await getMission(request, token, m.id);
        expect(reread.status).toBe('completed');
        expect(reread.outcome).toBeNull();
        expect(reread.completedAt).toBe(completed.completedAt);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 2 — COMPLETE WITH AN EXPLICIT OUTCOME: the human's verdict round-trips
    // through the response AND a fresh GET. 'partially_succeeded' is the probe
    // value (the longest enum member — catches column-width/enum-mapping slips).
    // ──────────────────────────────────────────────────────────────────
    test('complete with outcome partially_succeeded → verdict persisted and re-readable', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('with-outcome');

        const m = await createMission(request, token, {
            title: `With Outcome ${sfx}`,
            description: `complete with verdict ${sfx}`,
            type: 'one-shot',
        });

        const res = await postVerb(request, token, m.id, 'complete', {
            outcome: 'partially_succeeded',
        });
        expect(res.status(), `complete body=${await res.text()}`).toBe(200);
        const completed = (await res.json()) as MissionDto;
        expect(completed.status).toBe('completed');
        expect(completed.outcome).toBe('partially_succeeded');
        expect(completed.completedAt).toMatch(ISO_RE);

        const reread = await getMission(request, token, m.id);
        expect(reread.status).toBe('completed');
        expect(reread.outcome).toBe('partially_succeeded');
        expect(reread.completedAt).toBe(completed.completedAt);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 3 — AN OUT-OF-VOCABULARY OUTCOME IS REJECTED 400 (CompleteMissionDto
    // IsIn allowlist at the ValidationPipe boundary — non-ASCII probe value so
    // no accidental substring match against a real member). The rejected call
    // is side-effect-free: the mission stays active with no phantom verdict,
    // and a follow-up VALID complete still works.
    // ──────────────────────────────────────────────────────────────────
    test('complete with an invalid outcome → 400 and the mission is untouched', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('bad-outcome');

        const m = await createMission(request, token, {
            title: `Bad Outcome ${sfx}`,
            description: `invalid verdict rejected ${sfx}`,
            type: 'one-shot',
        });

        const res = await postVerb(request, token, m.id, 'complete', { outcome: 'победа' });
        expect(res.status()).toBe(400);
        // ValidationPipe message (string or string[]) names the offending field.
        const body = (await res.json()) as { message?: string | string[] };
        expect(JSON.stringify(body.message ?? '')).toMatch(/outcome/i);

        // Side-effect-free rejection: still active, no verdict, no timestamp.
        const after = await getMission(request, token, m.id);
        expect(after.status).toBe('active');
        expect(after.outcome).toBeNull();
        expect(after.completedAt).toBeNull();

        // The mission is still completable with a LEGAL outcome afterwards.
        const ok = await postVerb(request, token, m.id, 'complete', { outcome: 'succeeded' });
        expect(ok.status()).toBe(200);
        expect(((await ok.json()) as MissionDto).outcome).toBe('succeeded');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 4 — COMPLETED IS RE-COMPLETE-PROOF: a second complete (with OR
    // without an outcome) → 400 with the transition-guard message, and the
    // FIRST verdict + timestamp are never overwritten by the rejected retry.
    // ──────────────────────────────────────────────────────────────────
    test('a completed mission cannot be completed again (400; first verdict preserved)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('re-complete');

        const m = await createMission(request, token, {
            title: `Re-Complete ${sfx}`,
            description: `second complete rejected ${sfx}`,
            type: 'one-shot',
        });

        const first = await postVerb(request, token, m.id, 'complete', { outcome: 'succeeded' });
        expect(first.status()).toBe(200);
        const firstBody = (await first.json()) as MissionDto;
        expect(firstBody.outcome).toBe('succeeded');

        // Second complete without a body → 400 (illegal from 'completed').
        const again = await postVerb(request, token, m.id, 'complete', {});
        expect(again.status()).toBe(400);
        expect(((await again.json()) as { message?: string }).message ?? '').toMatch(
            /cannot be completed|completed/i,
        );

        // Second complete with a DIFFERENT outcome → still 400; no verdict swap.
        const swap = await postVerb(request, token, m.id, 'complete', { outcome: 'cancelled' });
        expect(swap.status()).toBe(400);

        const after = await getMission(request, token, m.id);
        expect(after.status).toBe('completed');
        expect(after.outcome).toBe('succeeded');
        expect(after.completedAt).toBe(firstBody.completedAt);
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 5 — THE mission_completed ACTIVITY EMISSION: completing with an
    // outcome writes a user-scoped activity row (actionType=mission_completed)
    // whose details carry the missionId (+ the outcome verdict). The write is
    // awaited-but-best-effort inside the service, so a short poll absorbs any
    // eventual-consistency in the log read path.
    // ──────────────────────────────────────────────────────────────────
    test('completing a mission emits a mission_completed activity row with details.missionId', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('activity');

        const m = await createMission(request, token, {
            title: `Activity Emit ${sfx}`,
            description: `activity emission ${sfx}`,
            type: 'one-shot',
        });
        const res = await postVerb(request, token, m.id, 'complete', {
            outcome: 'partially_succeeded',
        });
        expect(res.status(), `complete body=${await res.text()}`).toBe(200);

        // Filter server-side by actionType (probed contract: ?actionType=X
        // returns only X rows, user-scoped) and poll for our mission's row.
        async function fetchRows(): Promise<ActivityRow[]> {
            const list = await request.get(
                `${API_BASE}/api/activity-log?actionType=mission_completed&limit=100`,
                { headers: authedHeaders(token) },
            );
            expect(list.status()).toBe(200);
            const body = (await list.json()) as ActivityList;
            expect(Array.isArray(body.activities)).toBe(true);
            return body.activities;
        }

        await expect
            .poll(async () => (await fetchRows()).length, {
                message: 'mission_completed activity row appears for this user',
                timeout: 15_000,
            })
            .toBeGreaterThanOrEqual(1);

        const rows = await fetchRows();
        // The filter really filtered (no foreign actionTypes leak through).
        for (const row of rows) {
            expect(row.actionType).toBe('mission_completed');
        }
        // Our mission's row is present, addressed by details.missionId.
        const mine = rows.find((row) => row.details?.missionId === m.id);
        expect(mine, `row with details.missionId=${m.id} in ${JSON.stringify(rows)}`).toBeTruthy();
        // The verdict rides along in the details payload.
        expect(mine?.details?.outcome).toBe('partially_succeeded');
    });

    // ──────────────────────────────────────────────────────────────────
    // FLOW 6 — RESUME vs THE CONCLUSION FIELDS. The tick-only FAILED status is
    // not producible via the public API, so the failed→active revival leg lives
    // in agent-package unit tests; what IS pinnable here:
    //   (1) pause → resume on a never-completed Mission is verdict-neutral —
    //       outcome AND completedAt stay null, status lands back on active
    //       (transition() clears the conclusion fields on target=ACTIVE, which
    //       must be a no-op when they were never set).
    //   (2) resume from 'completed' → 400 (resume is legal from paused|failed
    //       ONLY — complete-then-resume is NOT a revival path), and the
    //       rejected resume leaves the completed verdict fully intact.
    // ──────────────────────────────────────────────────────────────────
    test('pause→resume keeps conclusion fields null; resume from completed → 400', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = nextSfx('resume-axis');

        // ── (1) pause → resume round-trip is verdict-neutral.
        const m = await createMission(request, token, {
            title: `Resume Neutral ${sfx}`,
            description: `pause resume verdict neutral ${sfx}`,
            type: 'one-shot',
        });
        expect((await postVerb(request, token, m.id, 'pause')).status()).toBe(200);
        const resumed = await postVerb(request, token, m.id, 'resume');
        expect(resumed.status(), `resume body=${await resumed.text()}`).toBe(200);
        const resumedBody = (await resumed.json()) as MissionDto;
        expect(resumedBody.status).toBe('active');
        expect(resumedBody.outcome).toBeNull();
        expect(resumedBody.completedAt).toBeNull();
        // And the same holds on a fresh GET (nothing weird persisted).
        const reread = await getMission(request, token, m.id);
        expect(reread.status).toBe('active');
        expect(reread.outcome).toBeNull();
        expect(reread.completedAt).toBeNull();

        // ── (2) complete-then-resume is NOT allowed; the verdict survives.
        const done = await createMission(request, token, {
            title: `No Revive ${sfx}`,
            description: `completed is not resumable ${sfx}`,
            type: 'one-shot',
        });
        const complete = await postVerb(request, token, done.id, 'complete', {
            outcome: 'superseded',
        });
        expect(complete.status()).toBe(200);
        const completedBody = (await complete.json()) as MissionDto;

        const revive = await postVerb(request, token, done.id, 'resume');
        expect(revive.status()).toBe(400);
        expect(((await revive.json()) as { message?: string }).message ?? '').toMatch(
            /cannot be resumed|resumed/i,
        );

        const after = await getMission(request, token, done.id);
        expect(after.status).toBe('completed');
        expect(after.outcome).toBe('superseded');
        expect(after.completedAt).toBe(completedBody.completedAt);
    });
});
