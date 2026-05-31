import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Mission → Idea → Build flow — complex, multi-step orchestration of the
 * real Missions/Ideas/Works build surface exposed by the public API
 * (`/api/me/missions` + `/api/me/work-proposals`). Every request/response
 * shape, status code, and error string asserted below was confirmed
 * against the LIVE API at http://127.0.0.1:3100 before being written.
 *
 * Three end-to-end flows (one test() each):
 *
 *   1. Mission + Ideas + missionId filter + outstanding-cap behaviour.
 *      - POST /api/me/missions creates a Mission (one-shot, explicit cap).
 *      - POST /api/me/work-proposals creates Ideas (description ≥10 chars).
 *        VERIFIED: `missionId` is NOT a create field — the DTO whitelist
 *        rejects it with 400 "property missionId should not exist". User-
 *        manual Ideas are born with `missionId: null`. (The AI research /
 *        Mission-tick pipeline is what links Ideas to a Mission, and there
 *        is no AI provider on this stack — so we assert that truthfully.)
 *      - GET /api/me/work-proposals?missionId=<id> is an accepted contract
 *        that returns ONLY that Mission's Ideas (empty here — the unlinked
 *        Ideas never leak into the Mission scope).
 *      - The outstanding-Ideas cap is asserted DETERMINISTICALLY via a
 *        cap=0 Mission: run-now yields {status:'cap-hit'} regardless of
 *        whether an AI provider is configured (outstanding 0 >= cap 0).
 *
 *   2. Idea build lifecycle (build / retry precondition / per-build budget).
 *      - POST /api/me/work-proposals/:id/build queues an Idea for build.
 *        VERIFIED env-adaptive: with a Work Agent / Trigger.dev configured
 *        the endpoint returns 200 + { proposal (status:'queued'), goal };
 *        on this no-AI stack it returns 400 "Work agent is disabled." BUT
 *        the Idea's PENDING → QUEUED transition is STILL committed (the
 *        queueForBuild write lands before the goal-enqueue throws). We
 *        assert the COMMITTED status either way — never assert completion.
 *      - The QUEUED Idea then surfaces on the /ideas UI catalog (real
 *        cross-feature outcome — the page lists QUEUED rows by default).
 *      - Retry precondition: POST /:id/retry on a non-FAILED Idea is a
 *        400 "Retry is only valid for FAILED Ideas." (a fresh build can't
 *        reach FAILED without the Goal-completion worker — out of scope —
 *        so we pin the precondition guard, which is the feasible truth).
 *      - GET /:id/budget shape: { ownerType:'idea', ownerId, periodStart,
 *        periodEnd, currentSpendCents:0, capCents:null, currency:'usd',
 *        percentUsed:null, allowOverage:true, blocked:false }.
 *
 *   3. Mission tick (manual run-now) — response shape + cap respect.
 *      - POST /api/me/missions/:id/run-now returns 200 with
 *        { status, missionId, message? } (the controller's union). On this
 *        no-AI stack a runnable Mission returns {status:'no-ideas',
 *        message:'skipped-no-profile'} (the generator has no user profile)
 *        — we accept any of the truthful non-error outcomes.
 *      - The cap is respected: a cap=0 Mission returns {status:'cap-hit'}
 *        with message "outstanding=0 >= cap=0" BEFORE any generation runs.
 *      - Lifecycle gate: run-now on a COMPLETED Mission is 400; on a
 *        missing Mission is 404.
 *
 * Cross-spec isolation: all API mutations run on a FRESH registerUserViaAPI
 * user so a per-user fake-key shadow can't leak into sibling chat specs.
 * The seeded user (storageState) is used only for the UI-driven assertion.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '11111111-1111-1111-1111-111111111111';

/** Truthful non-error run-now outcomes the tick service can emit. */
const RUN_NOW_OUTCOMES = ['noop-placeholder', 'queued', 'spawned', 'cap-hit', 'no-ideas', 'failed'];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted to {email,password} — never pass the full
    // seeded object (its `name` field triggers a 400).
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Mission → idea build flow (fresh API user)', () => {
    test('Mission + Ideas: missionId is not a create field, the ?missionId filter is exact, and the outstanding-cap is enforced', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // ── 1. Create a Mission with an explicit outstanding-Ideas cap ──────
        const missionTitle = `Cap Mission ${s}`;
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: missionTitle,
                description: 'Curate a directory of AI developer tooling and resources',
                type: 'one-shot',
                outstandingIdeasCap: 2,
            },
        });
        expect(missionRes.status(), `mission create body=${await missionRes.text()}`).toBe(201);
        const mission = await missionRes.json();
        expect(mission.id).toMatch(UUID_RE);
        expect(mission.title).toBe(missionTitle);
        expect(mission.type).toBe('one-shot');
        expect(mission.status).toBe('active');
        expect(mission.schedule).toBeNull();
        expect(mission.outstandingIdeasCap).toBe(2);
        expect(mission.sourceMissionId).toBeNull();

        // ── 2. missionId is NOT accepted on the Idea create path ────────────
        const rejected = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: {
                description: 'An idea that illegally tries to set its own missionId here',
                missionId: mission.id,
            },
        });
        expect(rejected.status()).toBe(400);
        const rejectedBody = await rejected.json();
        const rejectedMsg = Array.isArray(rejectedBody.message)
            ? rejectedBody.message.join(' ')
            : String(rejectedBody.message);
        expect(rejectedMsg).toMatch(/missionId should not exist/i);

        // ── 3. A short (<10 char) description is rejected by the DTO ────────
        const tooShort = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: 'tiny' },
        });
        expect(tooShort.status()).toBe(400);

        // ── 4. Two valid user-manual Ideas — born unlinked (missionId null) ─
        const ideaIds: string[] = [];
        for (let i = 0; i < 2; i++) {
            const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
                headers,
                data: { description: `Idea ${i} for ${s} — a curated AI tooling resource list` },
            });
            expect(ideaRes.status(), `idea ${i} body=${await ideaRes.text()}`).toBe(201);
            const idea = await ideaRes.json();
            expect(idea.id).toMatch(UUID_RE);
            expect(idea.source).toBe('user-manual');
            expect(idea.status).toBe('pending');
            expect(idea.missionId).toBeNull();
            expect(idea.acceptedWorkId).toBeNull();
            expect(idea.failureMessage).toBeNull();
            expect(idea.failureKind).toBeNull();
            ideaIds.push(idea.id);
        }

        // The default list (PENDING) contains both — shared DB ⇒ toContain.
        const pendingList = await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers })
        ).json();
        expect(Array.isArray(pendingList)).toBe(true);
        const pendingIds = (pendingList as Array<{ id: string }>).map((p) => p.id);
        for (const id of ideaIds) expect(pendingIds).toContain(id);

        // ── 5. ?missionId filter is exact — unlinked Ideas DON'T leak in ────
        const byMission = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${mission.id}`,
            { headers },
        );
        expect(byMission.status()).toBe(200);
        const byMissionBody = await byMission.json();
        expect(Array.isArray(byMissionBody)).toBe(true);
        const byMissionIds = (byMissionBody as Array<{ id: string }>).map((p) => p.id);
        for (const id of ideaIds) expect(byMissionIds).not.toContain(id);

        // A malformed (non-UUID) missionId is rejected by the @IsUUID filter.
        const badFilter = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=not-a-uuid`,
            { headers },
        );
        expect(badFilter.status()).toBe(400);

        // ── 6. Outstanding-cap behaviour — deterministic via a cap=0 Mission ─
        // run-now on a cap=0 Mission must short-circuit to 'cap-hit' BEFORE
        // any generation (outstanding 0 >= cap 0), independent of AI config.
        const cap0Res = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Zero-cap Mission ${s}`,
                description: 'A capped mission used to assert the outstanding-Ideas throttle',
                type: 'one-shot',
                outstandingIdeasCap: 0,
            },
        });
        expect(cap0Res.status()).toBe(201);
        const cap0 = await cap0Res.json();
        expect(cap0.outstandingIdeasCap).toBe(0);

        const cap0Run = await request.post(`${API_BASE}/api/me/missions/${cap0.id}/run-now`, {
            headers,
        });
        expect(cap0Run.status()).toBe(200);
        const cap0Body = await cap0Run.json();
        expect(cap0Body.missionId).toBe(cap0.id);
        expect(cap0Body.status).toBe('cap-hit');
        expect(String(cap0Body.message)).toMatch(/outstanding=0 >= cap=0/i);

        // The unlimited sentinel (-1) round-trips on create.
        const unlimitedRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Unlimited Mission ${s}`,
                description: 'An uncapped mission (sentinel -1 means unlimited)',
                type: 'one-shot',
                outstandingIdeasCap: -1,
            },
        });
        expect(unlimitedRes.status()).toBe(201);
        expect((await unlimitedRes.json()).outstandingIdeasCap).toBe(-1);
    });

    test('Idea build lifecycle: build commits the QUEUED transition, retry guards on FAILED, and the per-build budget shape is stable', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // ── 1. Create a buildable Idea (PENDING) ────────────────────────────
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `Buildable idea ${s} — generate a Work from this prompt` },
        });
        expect(ideaRes.status(), `idea body=${await ideaRes.text()}`).toBe(201);
        const idea = await ideaRes.json();
        expect(idea.status).toBe('pending');
        const ideaId: string = idea.id;

        // ── 2. Queue it for build — env-adaptive on Work Agent availability ─
        const buildRes = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/build`, {
            headers,
        });
        const buildStatus = buildRes.status();
        // 200 when a Work Agent + Trigger.dev are configured; 400 "Work agent
        // is disabled." on the CI / local no-AI stack. Either is truthful.
        expect([200, 400]).toContain(buildStatus);
        if (buildStatus === 200) {
            const built = await buildRes.json();
            // Shared BuildWorkProposalResponseDto: { proposal, goal }.
            expect(built.proposal.id).toBe(ideaId);
            expect(built.proposal.status).toBe('queued');
            expect(built.goal.id).toMatch(UUID_RE);
            expect(typeof built.goal.instruction).toBe('string');
            expect(typeof built.goal.status).toBe('string');
            expect(typeof built.goal.dryRun).toBe('boolean');
        } else {
            const body = await buildRes.json();
            expect(String(body.message)).toMatch(/work agent is disabled/i);
        }

        // ── 3. KEY: the PENDING → QUEUED transition is committed regardless ─
        // (queueForBuild writes before the goal-enqueue throws on no-AI).
        const afterBuild = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}`, {
            headers,
        });
        expect(afterBuild.status()).toBe(200);
        expect((await afterBuild.json()).status).toBe('queued');

        // ── 4. Building again from QUEUED is rejected (allowed: pending/failed) ─
        const rebuildFromQueued = await request.post(
            `${API_BASE}/api/me/work-proposals/${ideaId}/build`,
            { headers },
        );
        expect(rebuildFromQueued.status()).toBe(400);
        expect(String((await rebuildFromQueued.json()).message)).toMatch(
            /cannot be queued for build from status "queued"/i,
        );

        // ── 5. Retry precondition guard — only valid for FAILED Ideas ───────
        // A QUEUED Idea can't be retried (FAILED is only reachable via the
        // Goal-completion worker, which doesn't run on this stack — so the
        // precondition guard is the feasible truth to pin here).
        const retryRes = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/retry`, {
            headers,
        });
        expect(retryRes.status()).toBe(400);
        expect(String((await retryRes.json()).message)).toMatch(
            /retry is only valid for failed ideas/i,
        );

        // ── 6. Per-Idea (per-build) budget endpoint shape ───────────────────
        const budgetRes = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/budget`, {
            headers,
        });
        expect(budgetRes.status()).toBe(200);
        const budget = await budgetRes.json();
        expect(budget.ownerType).toBe('idea');
        expect(budget.ownerId).toBe(ideaId);
        expect(typeof budget.periodStart).toBe('string');
        expect(typeof budget.periodEnd).toBe('string');
        expect(budget.currentSpendCents).toBe(0);
        expect(budget.capCents).toBeNull();
        expect(budget.currency).toBe('usd');
        expect(budget.percentUsed).toBeNull();
        expect(budget.allowOverage).toBe(true);
        expect(budget.blocked).toBe(false);

        // ── 7. The budget of another user's Idea is NOT introspectable ──────
        const other = await registerUserViaAPI(request);
        const otherBudget = await request.get(
            `${API_BASE}/api/me/work-proposals/${ideaId}/budget`,
            { headers: authedHeaders(other.access_token) },
        );
        expect(otherBudget.status()).toBe(404);

        // (The /ideas catalog UI surfacing of a QUEUED Idea is asserted in
        // the seeded-user UI test below — kept separate so this API test
        // stays pure and runs on a fresh, isolated user.)
        expect(ideaId).toMatch(UUID_RE);
    });

    test('Mission tick (run-now): truthful response shape, cap respect, and lifecycle/ownership gates', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // ── 1. A runnable one-shot Mission ──────────────────────────────────
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Tick Mission ${s}`,
                description: 'A one-shot mission to exercise the manual run-now tick endpoint',
                type: 'one-shot',
                outstandingIdeasCap: 5,
            },
        });
        expect(missionRes.status()).toBe(201);
        const mission = await missionRes.json();

        // ── 2. run-now returns 200 with the controller union shape ──────────
        const runRes = await request.post(`${API_BASE}/api/me/missions/${mission.id}/run-now`, {
            headers,
        });
        expect(runRes.status()).toBe(200);
        const run = await runRes.json();
        expect(run.missionId).toBe(mission.id);
        expect(RUN_NOW_OUTCOMES).toContain(run.status);
        // On a stack WITH an AI provider this may be 'spawned' with a count;
        // on the no-AI stack it's 'no-ideas' / 'skipped-no-profile'. Assert
        // the count fields are well-typed when present, never their value.
        if (run.ideasCreated !== undefined) expect(typeof run.ideasCreated).toBe('number');
        if (run.ideasQueued !== undefined) expect(typeof run.ideasQueued).toBe('number');
        // The cap is NOT hit (cap 5, outstanding 0) — so we never see cap-hit.
        expect(run.status).not.toBe('cap-hit');

        // ── 3. run-now respects the outstanding-Ideas cap (cap=0 ⇒ cap-hit) ─
        const cappedRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Tick Cap Mission ${s}`,
                description: 'A capped mission whose tick must short-circuit on the cap',
                type: 'one-shot',
                outstandingIdeasCap: 0,
            },
        });
        expect(cappedRes.status()).toBe(201);
        const capped = await cappedRes.json();
        const cappedRun = await request.post(`${API_BASE}/api/me/missions/${capped.id}/run-now`, {
            headers,
        });
        expect(cappedRun.status()).toBe(200);
        const cappedBody = await cappedRun.json();
        expect(cappedBody.status).toBe('cap-hit');
        expect(String(cappedBody.message)).toMatch(/cap=0/i);

        // ── 4. A SCHEDULED Mission's run-now bypasses the cron match ────────
        // (allowCronMismatch=true) — it still returns a valid non-error
        // outcome even though the cron didn't fire on this minute.
        const scheduledRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: `Scheduled Mission ${s}`,
                description: 'A scheduled mission; run-now forces a tick off-cadence',
                type: 'scheduled',
                schedule: '* * * * *',
                outstandingIdeasCap: 5,
            },
        });
        expect(scheduledRes.status(), `scheduled body=${await scheduledRes.text()}`).toBe(201);
        const scheduled = await scheduledRes.json();
        expect(scheduled.type).toBe('scheduled');
        expect(scheduled.schedule).toBe('* * * * *');
        const scheduledRun = await request.post(
            `${API_BASE}/api/me/missions/${scheduled.id}/run-now`,
            { headers },
        );
        expect(scheduledRun.status()).toBe(200);
        const scheduledBody = await scheduledRun.json();
        // run-now bypasses cron — never 'cron-no-match'.
        expect(scheduledBody.status).not.toBe('cron-no-match');
        expect(RUN_NOW_OUTCOMES).toContain(scheduledBody.status);

        // ── 5. Schedule-vs-type consistency is enforced server-side ─────────
        const scheduledNoCron = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: 'Bad scheduled',
                description: 'scheduled type with no cron must be rejected',
                type: 'scheduled',
            },
        });
        expect(scheduledNoCron.status()).toBe(400);
        expect(String((await scheduledNoCron.json()).message)).toMatch(
            /scheduled requires a non-empty `?schedule/i,
        );

        const oneShotWithCron = await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: {
                title: 'Bad one-shot',
                description: 'one-shot type with a cron must be rejected',
                type: 'one-shot',
                schedule: '* * * * *',
            },
        });
        expect(oneShotWithCron.status()).toBe(400);
        expect(String((await oneShotWithCron.json()).message)).toMatch(/one-shot must NOT have/i);

        // ── 6. Lifecycle gate — run-now on a COMPLETED Mission is 400 ───────
        const completeRes = await request.post(
            `${API_BASE}/api/me/missions/${mission.id}/complete`,
            { headers },
        );
        expect(completeRes.status()).toBe(200);
        expect((await completeRes.json()).status).toBe('completed');

        const runCompleted = await request.post(
            `${API_BASE}/api/me/missions/${mission.id}/run-now`,
            { headers },
        );
        expect(runCompleted.status()).toBe(400);
        expect(String((await runCompleted.json()).message)).toMatch(
            /cannot be run from status "completed"/i,
        );

        // ── 7. Ownership / existence gate — run-now on a missing Mission 404 ─
        const runMissing = await request.post(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/run-now`,
            { headers },
        );
        expect(runMissing.status()).toBe(404);
        expect(String((await runMissing.json()).message)).toMatch(/mission not found/i);
    });
});

test.describe('Mission → idea build flow (seeded user UI)', () => {
    test('an Idea queued for build via the build endpoint surfaces on the /ideas catalog', async ({
        page,
        request,
    }) => {
        // Use the seeded user — its storageState is what the browser session
        // is authenticated as, so an Idea created under it is the row the
        // /ideas page renders for this session.
        const token = await seededToken(request);
        const headers = authedHeaders(token);
        const s = stamp();

        const desc = `Queued build idea ${s} — surfaces on the /ideas catalog after build`;
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: desc },
        });
        expect(ideaRes.status(), `idea body=${await ideaRes.text()}`).toBe(201);
        const ideaId = (await ideaRes.json()).id;

        // Queue for build. Env-adaptive: 200 when a Work Agent is configured,
        // 400 "Work agent is disabled." on the no-AI stack — but the QUEUED
        // transition commits in BOTH cases.
        const buildRes = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/build`, {
            headers,
        });
        expect([200, 400]).toContain(buildRes.status());

        // The Idea is now QUEUED — confirm via API before the UI assertion.
        await expect
            .poll(
                async () => {
                    const r = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}`, {
                        headers,
                    });
                    return r.ok() ? (await r.json()).status : 'error';
                },
                { timeout: 15_000, message: 'Idea should be QUEUED after build' },
            )
            .toBe('queued');

        // The /ideas catalog lists PENDING/QUEUED/BUILDING/FAILED by default,
        // so the QUEUED Idea must render. Its description is the card body.
        await page.goto('/ideas', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(desc).first()).toBeVisible({ timeout: 30_000 });
    });
});
