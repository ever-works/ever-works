import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Idea (Work-Proposal) BUILD LIFECYCLE — complex, multi-step, cross-feature
 * end-to-end integration flows over the real Idea build surface under
 * `/api/me/work-proposals`. Every status code, error string, and response
 * shape asserted here was probed against the LIVE API at
 * http://127.0.0.1:3100 (sqlite, no AI provider, no Trigger.dev) before
 * being written.
 *
 * This file deliberately covers the FULL state machine and its terminal
 * branches that the existing `flow-mission-idea-build.spec.ts` (Mission-
 * centric) and the shallow `ideas-extension.spec.ts` (401/404 contract pins)
 * do NOT exercise:
 *
 *   create → build → accept → rebuild, the dismiss terminal branch, the
 *   full transition-guard lattice, per-build budget across the lifecycle,
 *   and the `?statuses=` filter as the lifecycle observability surface.
 *
 * ── PROBED CONTRACTS (verified live) ───────────────────────────────────
 *
 *  POST /api/me/work-proposals  (create user-manual Idea)
 *    body { description (10..5000), title? } → 201
 *      { id, title, description, slugSuggestion, suggestedCategories:[],
 *        suggestedFields:[], recommendedPlugins:[], generatedPrompt,
 *        reasoning, source:'user-manual', status:'pending',
 *        acceptedWorkId:null, missionId:null, failureMessage:null,
 *        failureKind:null, generatedAt }
 *    description < 10 chars → 400 ["description must be longer than or equal to 10 characters"]
 *    description === 10 chars → 201 (boundary is INCLUSIVE)
 *    missionId in body → 400 (whitelist rejects — covered elsewhere)
 *
 *  POST /api/me/work-proposals/:id/build  (queue for build)
 *    ENV-ADAPTIVE: 200 { proposal(status:'queued'), goal } when a Work
 *      Agent + Trigger.dev are configured; on the no-AI stack 400
 *      "Work agent is disabled." — BUT the PENDING→QUEUED transition is
 *      ALREADY COMMITTED (queueForBuild writes before createGoal throws).
 *    from QUEUED/BUILDING/ACCEPTED/DISMISSED → 400
 *      'Idea cannot be queued for build from status "<s>". Allowed: pending, failed.'
 *    non-owner → 404 "Proposal not found"
 *
 *  POST /api/me/work-proposals/:id/retry  (FAILED-only)
 *    from non-FAILED → 400 'Retry is only valid for FAILED Ideas. Current status: "<s>".'
 *
 *  POST /api/me/work-proposals/:id/rebuild  (ACCEPTED-only)
 *    from non-ACCEPTED → 400 'Rebuild is only valid for ACCEPTED (Done) Ideas. Current status: "<s>".'
 *    from ACCEPTED → commits ACCEPTED→BUILDING (markRebuildingFromAccepted)
 *      then createGoal 400s on no-AI. acceptedWorkId is PRESERVED (re-pointed
 *      only on goal completion, which can't run here).
 *
 *  POST /api/me/work-proposals/:id/accept  (PENDING-only, user-facing)
 *    body { workId: UUID } required; missing/invalid → 400 ["workId must be a UUID"]
 *    valid workId from PENDING → 200 { ok:true }; status→'accepted', acceptedWorkId set
 *
 *  PATCH /api/me/work-proposals/:id/dismiss  (PENDING-only)
 *    from PENDING → 204; status→'dismissed'
 *    from non-PENDING (incl. already dismissed) → 404 "Proposal not found or not pending"
 *
 *  GET /api/me/work-proposals/:id/budget
 *    owner → 200 { ownerType:'idea', ownerId, periodStart, periodEnd,
 *      currentSpendCents:0, capCents:null, currency:'usd', percentUsed:null,
 *      allowOverage:true, blocked:false }
 *    non-owner → 404 "Proposal not found"
 *
 *  GET /api/me/work-proposals?statuses=<...>
 *    default (omitted) → PENDING only. ?statuses=queued, multi
 *    ?statuses=a&statuses=b accepted. bad value → 400 (enum lists all 6).
 *    ?missionId=<uuid> exact filter (standalone Ideas excluded).
 *
 * Cross-spec isolation: all API mutations run on FRESH registerUserViaAPI()
 * users (unique emails); list assertions use toContain (shared DB). The
 * seeded user (storageState) is used ONLY for the UI-driven flow.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '99999999-9999-9999-9999-999999999999';

/** The build/retry/rebuild endpoints are env-adaptive: 200 with a real
 *  Work Agent, 400 "Work agent is disabled." on the no-AI CI/local stack.
 *  Both are truthful; the Idea-side state transition commits in BOTH. */
const BUILD_OK_OR_DISABLED = [200, 400];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface IdeaRow {
    id: string;
    status: string;
    title: string;
    source: string;
    acceptedWorkId: string | null;
    missionId: string | null;
    failureMessage: string | null;
    failureKind: string | null;
}

async function createIdea(
    request: APIRequestContext,
    headers: Record<string, string>,
    description: string,
): Promise<IdeaRow> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers,
        data: { description },
    });
    expect(res.status(), `create idea body=${await res.text()}`).toBe(201);
    const idea = (await res.json()) as IdeaRow;
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    expect(idea.source).toBe('user-manual');
    return idea;
}

async function getStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
    id: string,
): Promise<string> {
    const r = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, { headers });
    expect(r.status()).toBe(200);
    return (await r.json()).status;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted to {email,password} — never pass the seeded
    // object's `name` field (extra prop → 400).
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Idea build lifecycle (fresh API users)', () => {
    test('Happy path: create → build (PENDING→QUEUED) → accept(workId) → rebuild (ACCEPTED→BUILDING, Work preserved)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // ── 1. Create a buildable Idea ─────────────────────────────────────
        const idea = await createIdea(
            request,
            headers,
            `Lifecycle idea ${s} — generate a curated Work from this brief`,
        );
        // A freshly-created user-manual Idea is born unlinked + un-failed.
        expect(idea.acceptedWorkId).toBeNull();
        expect(idea.missionId).toBeNull();
        expect(idea.failureMessage).toBeNull();
        expect(idea.failureKind).toBeNull();

        // ── 2. Queue for build — env-adaptive on Work Agent availability ────
        const buildRes = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers,
        });
        expect(BUILD_OK_OR_DISABLED).toContain(buildRes.status());
        if (buildRes.status() === 200) {
            const built = await buildRes.json();
            expect(built.proposal.id).toBe(idea.id);
            expect(built.proposal.status).toBe('queued');
            expect(built.goal.id).toMatch(UUID_RE);
            expect(typeof built.goal.instruction).toBe('string');
            expect(typeof built.goal.dryRun).toBe('boolean');
        } else {
            expect(msgOf(await buildRes.json())).toMatch(/work agent is disabled/i);
        }

        // KEY: the PENDING→QUEUED transition is committed regardless of the
        // goal-enqueue outcome (queueForBuild lands before createGoal throws).
        expect(await getStatus(request, headers, idea.id)).toBe('queued');

        // A QUEUED Idea cannot be re-queued via build (allowed: pending/failed).
        const reBuild = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers,
        });
        expect(reBuild.status()).toBe(400);
        expect(msgOf(await reBuild.json())).toMatch(
            /cannot be queued for build from status "queued"/i,
        );

        // ── 3. Create a real Work, then user-accept a SECOND Idea with it ───
        // (accept is PENDING-only, so we use a fresh Idea — the QUEUED one
        // above can't be accepted by the user-facing endpoint. The terminal
        // ACCEPTED state is what unlocks the rebuild branch below.)
        const work = await createWorkViaAPI(request, user.access_token, {
            name: `Accept Target ${s}`,
            description: 'Work that an Idea is accepted against',
        });
        expect(work.id).toMatch(UUID_RE);

        const acceptIdea = await createIdea(
            request,
            headers,
            `Acceptable idea ${s} — will be accepted then rebuilt`,
        );

        // accept without a workId → 400 (DTO @IsUUID fires before the
        // controller's manual "workId is required" guard).
        const acceptNoBody = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptIdea.id}/accept`,
            { headers, data: {} },
        );
        expect(acceptNoBody.status()).toBe(400);
        expect(msgOf(await acceptNoBody.json())).toMatch(/workId must be a UUID/i);

        // accept WITH the workId → 200 { ok:true }; Idea → ACCEPTED.
        const acceptRes = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptIdea.id}/accept`,
            { headers, data: { workId: work.id } },
        );
        expect(acceptRes.status(), `accept body=${await acceptRes.text()}`).toBe(200);
        expect((await acceptRes.json()).ok).toBe(true);

        const afterAccept = await request.get(
            `${API_BASE}/api/me/work-proposals/${acceptIdea.id}`,
            { headers },
        );
        expect(afterAccept.status()).toBe(200);
        const acceptedIdea = await afterAccept.json();
        expect(acceptedIdea.status).toBe('accepted');
        expect(acceptedIdea.acceptedWorkId).toBe(work.id);

        // An ACCEPTED Idea cannot be `build`-queued (only pending/failed).
        const buildAccepted = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptIdea.id}/build`,
            { headers },
        );
        expect(buildAccepted.status()).toBe(400);
        expect(msgOf(await buildAccepted.json())).toMatch(
            /cannot be queued for build from status "accepted"/i,
        );

        // ── 4. Rebuild the ACCEPTED Idea (Decision A27) ─────────────────────
        // rebuild commits ACCEPTED→BUILDING (markRebuildingFromAccepted)
        // BEFORE createGoal — so on the no-AI stack it 400s but the Idea is
        // now BUILDING. The original Work is PRESERVED (acceptedWorkId only
        // re-points on goal completion, which doesn't run here).
        const rebuildRes = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptIdea.id}/rebuild`,
            { headers },
        );
        expect(BUILD_OK_OR_DISABLED).toContain(rebuildRes.status());
        if (rebuildRes.status() === 400) {
            expect(msgOf(await rebuildRes.json())).toMatch(/work agent is disabled/i);
        }

        const afterRebuild = await request.get(
            `${API_BASE}/api/me/work-proposals/${acceptIdea.id}`,
            { headers },
        );
        expect(afterRebuild.status()).toBe(200);
        const rebuiltIdea = await afterRebuild.json();
        // BUILDING when the transition committed (no-AI 400 path) or ACCEPTED
        // if a real agent completed it synchronously — both are truthful.
        expect(['building', 'accepted', 'queued']).toContain(rebuiltIdea.status);
        // The original Work was NOT deleted — still resolvable.
        const workStillThere = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers,
        });
        expect(workStillThere.status()).toBe(200);
    });

    test('Transition-guard lattice: every illegal build/retry/rebuild emits its truthful precondition 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // PENDING Idea — the only state from which build is legal.
        const pending = await createIdea(request, headers, `Guard pending ${s} — fresh idea`);

        // From PENDING: retry and rebuild are both illegal.
        const retryPending = await request.post(
            `${API_BASE}/api/me/work-proposals/${pending.id}/retry`,
            { headers },
        );
        expect(retryPending.status()).toBe(400);
        expect(msgOf(await retryPending.json())).toMatch(
            /retry is only valid for failed ideas\. current status: "pending"/i,
        );

        const rebuildPending = await request.post(
            `${API_BASE}/api/me/work-proposals/${pending.id}/rebuild`,
            { headers },
        );
        expect(rebuildPending.status()).toBe(400);
        expect(msgOf(await rebuildPending.json())).toMatch(
            /rebuild is only valid for accepted \(done\) ideas\. current status: "pending"/i,
        );

        // Drive PENDING → QUEUED via build, then assert retry/rebuild guards
        // from QUEUED (which name the current status precisely).
        const build = await request.post(`${API_BASE}/api/me/work-proposals/${pending.id}/build`, {
            headers,
        });
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());
        expect(await getStatus(request, headers, pending.id)).toBe('queued');

        const retryQueued = await request.post(
            `${API_BASE}/api/me/work-proposals/${pending.id}/retry`,
            { headers },
        );
        expect(retryQueued.status()).toBe(400);
        expect(msgOf(await retryQueued.json())).toMatch(
            /retry is only valid for failed ideas\. current status: "queued"/i,
        );

        const rebuildQueued = await request.post(
            `${API_BASE}/api/me/work-proposals/${pending.id}/rebuild`,
            { headers },
        );
        expect(rebuildQueued.status()).toBe(400);
        expect(msgOf(await rebuildQueued.json())).toMatch(
            /rebuild is only valid for accepted \(done\) ideas\. current status: "queued"/i,
        );

        // Unknown id on every action → 404 (or 400 if the state-guard runs
        // after a load that returned the not-found path — controller maps to
        // NotFound). No 5xx allowed.
        for (const action of ['build', 'retry', 'rebuild'] as const) {
            const res = await request.post(
                `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/${action}`,
                { headers },
            );
            expect([400, 404]).toContain(res.status());
        }
    });

    test('Dismiss terminal branch: PENDING→DISMISSED is terminal — build rejected, re-dismiss 404, status filter exact', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        const idea = await createIdea(request, headers, `Dismissable idea ${s} — to be dismissed`);

        // ── 1. Dismiss a PENDING Idea → 204, status→DISMISSED ──────────────
        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers },
        );
        expect(dismiss.status()).toBe(204);
        expect(await getStatus(request, headers, idea.id)).toBe('dismissed');

        // ── 2. A DISMISSED Idea cannot be queued for build ─────────────────
        const buildDismissed = await request.post(
            `${API_BASE}/api/me/work-proposals/${idea.id}/build`,
            { headers },
        );
        expect(buildDismissed.status()).toBe(400);
        expect(msgOf(await buildDismissed.json())).toMatch(
            /cannot be queued for build from status "dismissed"/i,
        );

        // ── 3. Re-dismissing is a 404 (the PENDING-scoped UPDATE matched 0) ─
        const reDismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers },
        );
        expect(reDismiss.status()).toBe(404);
        expect(msgOf(await reDismiss.json())).toMatch(/not found or not pending/i);

        // ── 4. The DISMISSED Idea is invisible to the default (PENDING) list
        //      but visible under ?statuses=dismissed ───────────────────────
        const defaultList = await (
            await request.get(`${API_BASE}/api/me/work-proposals`, { headers })
        ).json();
        expect((defaultList as Array<{ id: string }>).map((p) => p.id)).not.toContain(idea.id);

        const dismissedList = await (
            await request.get(`${API_BASE}/api/me/work-proposals?statuses=dismissed`, {
                headers,
            })
        ).json();
        expect((dismissedList as Array<{ id: string }>).map((p) => p.id)).toContain(idea.id);

        // retry/rebuild from DISMISSED are also illegal (terminal).
        const retryDismissed = await request.post(
            `${API_BASE}/api/me/work-proposals/${idea.id}/retry`,
            { headers },
        );
        expect(retryDismissed.status()).toBe(400);
        expect(msgOf(await retryDismissed.json())).toMatch(/current status: "dismissed"/i);
    });

    test('Per-build budget is stable across the lifecycle and is NOT introspectable cross-user', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const other = await registerUserViaAPI(request);
        const otherHeaders = authedHeaders(other.access_token);
        const s = stamp();

        const idea = await createIdea(request, headers, `Budget idea ${s} — track per-build spend`);

        // Helper to read + assert the stable per-Idea budget shape.
        const assertBudgetShape = async (phase: string) => {
            const res = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`, {
                headers,
            });
            expect(res.status(), `budget@${phase}`).toBe(200);
            const b = await res.json();
            expect(b.ownerType).toBe('idea');
            expect(b.ownerId).toBe(idea.id);
            expect(typeof b.periodStart).toBe('string');
            expect(typeof b.periodEnd).toBe('string');
            expect(b.currentSpendCents).toBe(0);
            expect(b.capCents).toBeNull();
            expect(b.currency).toBe('usd');
            expect(b.percentUsed).toBeNull();
            expect(b.allowOverage).toBe(true);
            expect(b.blocked).toBe(false);
            return b;
        };

        // Budget exists immediately at PENDING (no spend yet, no cap).
        const atPending = await assertBudgetShape('pending');

        // Drive PENDING → QUEUED via build; the budget remains identical
        // (no AI ran, so no spend was recorded).
        const build = await request.post(`${API_BASE}/api/me/work-proposals/${idea.id}/build`, {
            headers,
        });
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());
        expect(await getStatus(request, headers, idea.id)).toBe('queued');
        const atQueued = await assertBudgetShape('queued');

        // The period window is identical across the transition.
        expect(atQueued.periodStart).toBe(atPending.periodStart);
        expect(atQueued.periodEnd).toBe(atPending.periodEnd);

        // ── Cross-user isolation: the non-owner cannot read the budget, the
        //    Idea, or queue a build — all collapse to 404 "Proposal not found"
        //    (the per-Idea spend stays private). ────────────────────────────
        const otherBudget = await request.get(
            `${API_BASE}/api/me/work-proposals/${idea.id}/budget`,
            { headers: otherHeaders },
        );
        expect(otherBudget.status()).toBe(404);
        expect(msgOf(await otherBudget.json())).toMatch(/proposal not found/i);

        const otherGet = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}`, {
            headers: otherHeaders,
        });
        expect(otherGet.status()).toBe(404);

        const otherBuild = await request.post(
            `${API_BASE}/api/me/work-proposals/${idea.id}/build`,
            { headers: otherHeaders },
        );
        expect(otherBuild.status()).toBe(404);

        // budget without auth → 401.
        const anon = await request.get(`${API_BASE}/api/me/work-proposals/${idea.id}/budget`);
        expect(anon.status()).toBe(401);
    });

    test('Status filter is the lifecycle observability surface: create cohort, queue some, dismiss one, then slice by status', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = stamp();

        // description boundary: exactly 10 chars is INCLUSIVE (201); 9 → 400.
        const tooShort = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: '123456789' },
        });
        expect(tooShort.status()).toBe(400);
        expect(msgOf(await tooShort.json())).toMatch(/longer than or equal to 10/i);

        const exactlyTen = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: '1234567890' },
        });
        expect(exactlyTen.status(), `ten body=${await exactlyTen.text()}`).toBe(201);
        const tenId = (await exactlyTen.json()).id;

        // Build a small cohort: 2 will be queued, 1 stays pending, 1 dismissed.
        const keep = await createIdea(request, headers, `Cohort keep ${s} — stays pending`);
        const queueA = await createIdea(request, headers, `Cohort queueA ${s} — to be queued`);
        const queueB = await createIdea(request, headers, `Cohort queueB ${s} — to be queued`);
        const drop = await createIdea(request, headers, `Cohort drop ${s} — to be dismissed`);

        for (const id of [queueA.id, queueB.id]) {
            const r = await request.post(`${API_BASE}/api/me/work-proposals/${id}/build`, {
                headers,
            });
            expect(BUILD_OK_OR_DISABLED).toContain(r.status());
        }
        const dropDismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${drop.id}/dismiss`,
            { headers },
        );
        expect(dropDismiss.status()).toBe(204);

        const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

        // Default list (no ?statuses) = PENDING only — contains keep + tenId,
        // excludes the queued + dismissed rows.
        const pendingDefault = idsOf(
            await (await request.get(`${API_BASE}/api/me/work-proposals`, { headers })).json(),
        );
        expect(pendingDefault).toContain(keep.id);
        expect(pendingDefault).toContain(tenId);
        expect(pendingDefault).not.toContain(queueA.id);
        expect(pendingDefault).not.toContain(queueB.id);
        expect(pendingDefault).not.toContain(drop.id);

        // ?statuses=queued = exactly the two we queued (excludes pending).
        const queuedOnly = idsOf(
            await (
                await request.get(`${API_BASE}/api/me/work-proposals?statuses=queued`, {
                    headers,
                })
            ).json(),
        );
        expect(queuedOnly).toContain(queueA.id);
        expect(queuedOnly).toContain(queueB.id);
        expect(queuedOnly).not.toContain(keep.id);

        // Multi-status ?statuses=queued&statuses=dismissed = union.
        const union = idsOf(
            await (
                await request.get(
                    `${API_BASE}/api/me/work-proposals?statuses=queued&statuses=dismissed`,
                    { headers },
                )
            ).json(),
        );
        expect(union).toContain(queueA.id);
        expect(union).toContain(drop.id);
        expect(union).not.toContain(keep.id);

        // A bogus status value → 400 with the full allowed-enum vocabulary.
        const bogus = await request.get(`${API_BASE}/api/me/work-proposals?statuses=bogus`, {
            headers,
        });
        expect(bogus.status()).toBe(400);
        expect(msgOf(await bogus.json())).toMatch(
            /pending, dismissed, accepted, queued, building, failed/i,
        );

        // ?missionId=<uuid> is an exact scope — standalone Ideas (all of this
        // cohort) never leak into a Mission's slice. The DTO validates this
        // query param with @IsUUID(), so it must be a SYNTACTICALLY valid UUID
        // (UNKNOWN_UUID's `9999…` version nibble is invalid → 400); a well-
        // formed-but-unmatched v4 UUID yields the intended empty slice (200 []).
        const unmatchedMissionUuid = '00000000-0000-4000-8000-000000000000';
        const byUnknownMission = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${unmatchedMissionUuid}`,
            { headers },
        );
        expect(byUnknownMission.status()).toBe(200);
        expect(idsOf(await byUnknownMission.json())).toHaveLength(0);
    });
});

test.describe('Idea build lifecycle (seeded user UI)', () => {
    test('the /ideas catalog reflects the lifecycle: a queued Idea shows by default, an accepted Idea only with the "Show accepted" toggle', async ({
        page,
        request,
    }) => {
        // Use the seeded user — its storageState is the browser session's
        // identity, so Ideas created under it are the rows /ideas renders.
        const token = await seededToken(request);
        const headers = authedHeaders(token);
        const s = stamp();

        // 1. A QUEUED Idea (built) — actionable, shown by default.
        const queuedDesc = `UI queued idea ${s} — surfaces on the catalog by default`;
        const queued = await createIdea(request, headers, queuedDesc);
        const build = await request.post(`${API_BASE}/api/me/work-proposals/${queued.id}/build`, {
            headers,
        });
        expect(BUILD_OK_OR_DISABLED).toContain(build.status());

        await expect
            .poll(() => getStatus(request, headers, queued.id), {
                timeout: 15_000,
                message: 'queued Idea should reach QUEUED after build',
            })
            .toBe('queued');

        // 2. An ACCEPTED Idea (accepted against a real Work) — terminal,
        //    hidden until the "Show accepted" toggle is checked.
        const work = await createWorkViaAPI(request, token, {
            name: `UI Accept Target ${s}`,
            description: 'Work backing an accepted Idea for the UI flow',
        });
        const acceptedDesc = `UI accepted idea ${s} — hidden until Show-accepted toggle`;
        const accepted = await createIdea(request, headers, acceptedDesc);
        const acceptRes = await request.post(
            `${API_BASE}/api/me/work-proposals/${accepted.id}/accept`,
            { headers, data: { workId: work.id } },
        );
        expect(acceptRes.status()).toBe(200);

        // ── Render the /ideas catalog ──────────────────────────────────────
        await page.goto('/ideas', { waitUntil: 'domcontentloaded' });

        // The QUEUED Idea is in ACTIONABLE_STATUSES → visible immediately.
        await expect(page.getByText(queuedDesc).first()).toBeVisible({ timeout: 30_000 });

        // The ACCEPTED (terminal) Idea is hidden under the default
        // `actionable` Status filter (accepted ∉ ACTIONABLE_STATUSES).
        await expect(page.getByText(acceptedDesc).first()).toHaveCount(0);

        // Reveal accepted Ideas via the real filter surface: the page is
        // server-filtered through a Status <select> (`name="status"`) +
        // an "Apply" submit, which navigates to `/ideas?status=<value>`.
        // (There is no client-side "Show accepted" toggle — selecting the
        // "Accepted" option and applying is how the catalog surfaces them.)
        const statusSelect = page.locator('select[name="status"]');
        await expect(statusSelect).toBeVisible({ timeout: 30_000 });
        await statusSelect.selectOption({ label: 'Accepted' });
        await page.getByRole('button', { name: 'Apply' }).click();

        // The Apply submit reloads the route under the accepted filter.
        await page.waitForURL(/[?&]status=accepted\b/, { timeout: 30_000 });
        await expect(page.getByText(acceptedDesc).first()).toBeVisible({ timeout: 30_000 });

        // The "Done" filter (status=done → accepted-with-Work) is the same
        // server-filter surface. Re-select it and apply; the accepted Idea
        // (backed by a real Work) stays visible.
        await expect(statusSelect).toBeVisible({ timeout: 30_000 });
        await statusSelect.selectOption({ label: 'Done' });
        await page.getByRole('button', { name: 'Apply' }).click();
        await page.waitForURL(/[?&]status=done\b/, { timeout: 30_000 });
        await expect(page.getByText(acceptedDesc).first()).toBeVisible({ timeout: 30_000 });
    });
});
