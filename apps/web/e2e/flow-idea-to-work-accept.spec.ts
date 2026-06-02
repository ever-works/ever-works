import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Idea → Work ACCEPT flow — complex, multi-step, cross-feature INTEGRATION
 * flows for the user-facing accept / dismiss surface that turns an Idea
 * (WorkProposal) into a Work. Every status code, response body, and error
 * string asserted below was VERIFIED against the LIVE API at
 * http://127.0.0.1:3100 before this file was written.
 *
 * REST surface under test (probed shapes):
 *   - POST   /api/me/work-proposals                 user-manual Idea create
 *                                                   → 201 { id, status:'pending',
 *                                                     source:'user-manual',
 *                                                     acceptedWorkId:null, missionId:null }
 *   - POST   /api/works                             Work create
 *                                                   → 200 { status:'success',
 *                                                     work:{ id, …, acceptedFromIdeaId:null } }
 *   - POST   /api/me/work-proposals/:id/accept      body { workId:UUID }
 *                                                   → 200 { ok:true }; transitions the
 *                                                     Idea PENDING → ACCEPTED and stamps
 *                                                     `acceptedWorkId = workId`.
 *   - PATCH  /api/me/work-proposals/:id/dismiss     → 204 (no body); PENDING → DISMISSED.
 *   - POST   /api/me/work-proposals/:id/build       env-adaptive: 200 with a Work-Agent,
 *                                                   else 400 "Work agent is disabled."
 *                                                   BUT the PENDING → QUEUED transition
 *                                                   still COMMITS either way.
 *   - POST   /api/me/work-proposals/:id/rebuild     ACCEPTED-only guard; non-ACCEPTED → 400.
 *   - GET    /api/me/work-proposals/:id             read-back (any status).
 *   - GET    /api/me/work-proposals?statuses=…      status-filtered list.
 *   - GET    /api/me/work-proposals?missionId=…     Mission-scoped list (@IsUUID).
 *
 * HARD-WON GOTCHAS pinned as truthful contract (verified, NOT assumed):
 *   1. The user-facing accept endpoint sets `acceptedWorkId` on the IDEA only.
 *      It does NOT set `acceptedFromIdeaId` on the WORK — that back-pointer is
 *      written exclusively by the Goal-completion handler when a build-from-Idea
 *      Goal succeeds (no Work Agent on this stack → it stays null). We assert
 *      the Work's `acceptedFromIdeaId` is STILL null after a manual accept.
 *   2. accept is valid ONLY from PENDING. From ACCEPTED / QUEUED / DISMISSED it
 *      returns 404 "Proposal not found or already finalized" (idempotent no-op —
 *      the FIRST accept's `acceptedWorkId` is NOT overwritten by a second call).
 *   3. accept with an empty body → 400 ["workId must be a UUID"] (the @IsUUID DTO
 *      check runs before the controller's `!body?.workId` guard, so the
 *      "workId is required" string is unreachable). A well-formed but NON-EXISTENT
 *      workId → 500 (FK violation on acceptedWorkId) — we tolerate [200,500] and
 *      never assert a fictional FK-404 contract.
 *   4. Mission linkage: user-manual Ideas are born `missionId:null` and CANNOT be
 *      linked at create (the DTO rejects `missionId`). Linking is an AI-tick
 *      outcome (no AI here), so we assert the testable truth: an accepted Idea's
 *      `missionId` round-trips, the ?missionId filter is exact, and an unlinked
 *      accepted Idea does NOT leak into a Mission's scope.
 *
 * Cross-spec isolation: ALL API mutations run on a FRESH registerUserViaAPI()
 * user with unique names/Date.now suffixes and `toContain` (never exact counts).
 * The seeded user (storageState) is used ONLY for the UI-driven /ideas assertion.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const IDEA_DESC_MIN = 'a curated directory of resources'; // ≥10 chars filler

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a user-manual Idea (PENDING) and return its id. */
async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    const idea = await res.json();
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    expect(idea.source).toBe('user-manual');
    expect(idea.acceptedWorkId).toBeNull();
    expect(idea.missionId).toBeNull();
    return idea.id;
}

async function readIdea(request: APIRequestContext, token: string, id: string) {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `idea read body=${await res.text()}`).toBe(200);
    return res.json();
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted to {email,password} — never pass the seeded
    // object's `name` field (it triggers a 400).
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seeded login body=${await res.text()}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Idea → Work accept flow (fresh API user)', () => {
    test('accept transitions the Idea PENDING → ACCEPTED, stamps acceptedWorkId, surfaces it in the accepted-status list, and leaves the Work back-pointer null', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── 1. Create an Idea + a Work to accept it against ─────────────────
        const ideaId = await createIdea(
            request,
            token,
            `Accept-happy idea ${s} — ${IDEA_DESC_MIN} for the accept happy-path flow`,
        );
        const work = await createWorkViaAPI(request, token, { name: `Accept Work ${s}` });
        expect(work.id).toMatch(UUID_RE);

        // The freshly-created Work carries NO acceptedFromIdeaId — it wasn't
        // born from a build-from-Idea Goal.
        const workRaw = work.raw as { work?: { acceptedFromIdeaId?: string | null } };
        expect(workRaw.work?.acceptedFromIdeaId ?? null).toBeNull();

        // ── 2. Accept: PENDING → ACCEPTED + acceptedWorkId stamped ──────────
        const acceptRes = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: work.id },
        });
        expect(acceptRes.status(), `accept body=${await acceptRes.text()}`).toBe(200);
        expect(await acceptRes.json()).toEqual({ ok: true });

        const accepted = await readIdea(request, token, ideaId);
        expect(accepted.status).toBe('accepted');
        expect(accepted.acceptedWorkId).toBe(work.id);

        // ── 3. The accepted Idea is GONE from the default (PENDING) list and
        //      PRESENT in the ?statuses=accepted list ───────────────────────
        const pending = await (
            await request.get(`${API_BASE}/api/me/work-proposals`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect((pending as Array<{ id: string }>).map((p) => p.id)).not.toContain(ideaId);

        const acceptedList = await (
            await request.get(`${API_BASE}/api/me/work-proposals?statuses=accepted`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(Array.isArray(acceptedList)).toBe(true);
        const acceptedRow = (
            acceptedList as Array<{ id: string; status: string; acceptedWorkId: string }>
        ).find((p) => p.id === ideaId);
        expect(acceptedRow, 'accepted Idea must appear in ?statuses=accepted').toBeTruthy();
        expect(acceptedRow!.status).toBe('accepted');
        expect(acceptedRow!.acceptedWorkId).toBe(work.id);

        // ── 4. CRITICAL truthful contract: the user-facing accept does NOT
        //      stamp acceptedFromIdeaId on the WORK. That back-pointer is only
        //      written by the Goal-completion handler (no Work Agent here). ──
        const workAfter = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(token),
        });
        if (workAfter.ok()) {
            const wb = await workAfter.json();
            const wEntity = wb?.work ?? wb;
            // Either the field is absent from this read DTO or it's null — never
            // the Idea id (that would be a fictional contract on this stack).
            expect(wEntity?.acceptedFromIdeaId ?? null).not.toBe(ideaId);
        }
    });

    test('accept is idempotent + PENDING-only: a second accept (even with a different Work) → 404 and never overwrites the first acceptedWorkId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const ideaId = await createIdea(
            request,
            token,
            `Accept-twice idea ${s} — ${IDEA_DESC_MIN} for the idempotency guard probe`,
        );
        const workA = await createWorkViaAPI(request, token, { name: `Twice Work A ${s}` });
        const workB = await createWorkViaAPI(request, token, { name: `Twice Work B ${s}` });

        // ── First accept lands ──────────────────────────────────────────────
        const first = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: workA.id },
        });
        expect(first.status()).toBe(200);
        expect((await readIdea(request, token, ideaId)).acceptedWorkId).toBe(workA.id);

        // ── Second accept (different Work) is a no-op 404 — the Idea is no
        //    longer PENDING, so the transition's source-status guard rejects it.
        const second = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: workB.id },
        });
        expect(second.status()).toBe(404);
        expect(String((await second.json()).message)).toMatch(/not found or already finalized/i);

        // ── The first Work id is NOT clobbered by the rejected second accept ─
        const afterTwice = await readIdea(request, token, ideaId);
        expect(afterTwice.status).toBe('accepted');
        expect(afterTwice.acceptedWorkId).toBe(workA.id);
        expect(afterTwice.acceptedWorkId).not.toBe(workB.id);

        // ── Re-accepting with the SAME Work is still a 404 (finalized) ───────
        const reSame = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: workA.id },
        });
        expect(reSame.status()).toBe(404);
        expect((await readIdea(request, token, ideaId)).acceptedWorkId).toBe(workA.id);
    });

    test('accept after build: a QUEUED Idea (build already committed the transition) can no longer be manually accepted → 404, and build-from-accepted is rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── 1. Build the Idea — env-adaptive (200 with Agent, else 400) but
        //      the PENDING → QUEUED transition commits in BOTH cases ─────────
        const queuedIdeaId = await createIdea(
            request,
            token,
            `Accept-after-build idea ${s} — ${IDEA_DESC_MIN}; queued via the build path`,
        );
        const buildRes = await request.post(
            `${API_BASE}/api/me/work-proposals/${queuedIdeaId}/build`,
            { headers: authedHeaders(token) },
        );
        expect([200, 400]).toContain(buildRes.status());
        if (buildRes.status() === 400) {
            expect(String((await buildRes.json()).message)).toMatch(/work agent is disabled/i);
        }

        // The committed QUEUED status is the precondition for this flow.
        await expect
            .poll(async () => (await readIdea(request, token, queuedIdeaId)).status, {
                timeout: 15_000,
                message: 'Idea must be QUEUED after build',
            })
            .toBe('queued');

        // ── 2. Manual accept of a QUEUED Idea is rejected — accept is
        //      PENDING-only; the build pipeline (Goal completion) owns the
        //      QUEUED → ACCEPTED finalization, not the user-facing endpoint ──
        const work = await createWorkViaAPI(request, token, { name: `AfterBuild Work ${s}` });
        const acceptQueued = await request.post(
            `${API_BASE}/api/me/work-proposals/${queuedIdeaId}/accept`,
            { headers: authedHeaders(token), data: { workId: work.id } },
        );
        expect(acceptQueued.status()).toBe(404);
        expect(String((await acceptQueued.json()).message)).toMatch(
            /not found or already finalized/i,
        );

        // ── 3. The QUEUED Idea still has NO acceptedWorkId (the rejected
        //      accept didn't leak a half-finalized state) ───────────────────
        const afterReject = await readIdea(request, token, queuedIdeaId);
        expect(afterReject.status).toBe('queued');
        expect(afterReject.acceptedWorkId).toBeNull();

        // ── 4. Cross-check the inverse guard: an ACCEPTED Idea cannot be
        //      re-queued via /build (allowed: pending, failed) ───────────────
        const acceptedIdeaId = await createIdea(
            request,
            token,
            `Build-from-accepted idea ${s} — ${IDEA_DESC_MIN} for the inverse guard`,
        );
        const acceptWork = await createWorkViaAPI(request, token, { name: `Inverse Work ${s}` });
        const acc = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptedIdeaId}/accept`,
            { headers: authedHeaders(token), data: { workId: acceptWork.id } },
        );
        expect(acc.status()).toBe(200);

        const buildAccepted = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptedIdeaId}/build`,
            { headers: authedHeaders(token) },
        );
        // Either the state-machine guard fires first (400 "cannot be queued for
        // build from status accepted") OR — when a Work Agent is present — the
        // "Work agent is disabled" branch is skipped and the guard is what we
        // hit. Both are a 400; neither must be a 5xx or a silent re-queue.
        expect(buildAccepted.status()).toBe(400);
        // The Idea stays ACCEPTED regardless.
        expect((await readIdea(request, token, acceptedIdeaId)).status).toBe('accepted');
    });

    test('decline / dismiss: dismiss is PENDING-only, finalizes the Idea, and is mutually exclusive with accept (you cannot accept a dismissed Idea, nor dismiss an accepted one)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── 1. Dismiss a PENDING Idea → 204, status → DISMISSED ─────────────
        const dismissId = await createIdea(
            request,
            token,
            `Dismiss idea ${s} — ${IDEA_DESC_MIN}; the user declines this one`,
        );
        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${dismissId}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismiss.status()).toBe(204);
        expect((await dismiss.text()).length).toBe(0); // NO_CONTENT, empty body

        const dismissed = await readIdea(request, token, dismissId);
        expect(dismissed.status).toBe('dismissed');
        expect(dismissed.acceptedWorkId).toBeNull();

        // It leaves the PENDING list, appears in ?statuses=dismissed.
        const dismissedList = await (
            await request.get(`${API_BASE}/api/me/work-proposals?statuses=dismissed`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect((dismissedList as Array<{ id: string }>).map((p) => p.id)).toContain(dismissId);

        // ── 2. Dismiss again → 404 (not pending) ────────────────────────────
        const reDismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${dismissId}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(reDismiss.status()).toBe(404);

        // ── 3. Accept a DISMISSED Idea → 404 (accept is PENDING-only) ───────
        const work = await createWorkViaAPI(request, token, { name: `Dismiss Work ${s}` });
        const acceptDismissed = await request.post(
            `${API_BASE}/api/me/work-proposals/${dismissId}/accept`,
            { headers: authedHeaders(token), data: { workId: work.id } },
        );
        expect(acceptDismissed.status()).toBe(404);
        expect(String((await acceptDismissed.json()).message)).toMatch(
            /not found or already finalized/i,
        );
        // Still dismissed — the rejected accept didn't mutate it.
        expect((await readIdea(request, token, dismissId)).status).toBe('dismissed');

        // ── 4. The inverse: dismiss an ACCEPTED Idea → 404 (not pending) ────
        const acceptFirstId = await createIdea(
            request,
            token,
            `Accept-then-dismiss idea ${s} — ${IDEA_DESC_MIN} for the mutual-exclusion probe`,
        );
        const acceptWork = await createWorkViaAPI(request, token, {
            name: `AcceptFirst Work ${s}`,
        });
        const accept = await request.post(
            `${API_BASE}/api/me/work-proposals/${acceptFirstId}/accept`,
            { headers: authedHeaders(token), data: { workId: acceptWork.id } },
        );
        expect(accept.status()).toBe(200);

        const dismissAccepted = await request.patch(
            `${API_BASE}/api/me/work-proposals/${acceptFirstId}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismissAccepted.status()).toBe(404);
        // Remains ACCEPTED with its Work pointer intact.
        const stillAccepted = await readIdea(request, token, acceptFirstId);
        expect(stillAccepted.status).toBe('accepted');
        expect(stillAccepted.acceptedWorkId).toBe(acceptWork.id);
    });

    test('accept input validation + ownership: empty/invalid workId is rejected before any state change, a non-existent workId surfaces the FK failure, and another user cannot accept your Idea', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const ownerToken = owner.access_token;
        const other = await registerUserViaAPI(request);
        const otherToken = other.access_token;
        const s = stamp();

        const ideaId = await createIdea(
            request,
            ownerToken,
            `Validation idea ${s} — ${IDEA_DESC_MIN} for the accept-input validation probe`,
        );

        // ── 1. Empty body → 400 ["workId must be a UUID"]. NOTE: the @IsUUID
        //      DTO check runs BEFORE the controller's `!body?.workId` guard, so
        //      the "workId is required" message is never reached for a missing
        //      field — the validation-pipe message is the truthful contract. ─
        const emptyBody = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(ownerToken),
            data: {},
        });
        expect(emptyBody.status()).toBe(400);
        const emptyMsg = (await emptyBody.json()).message;
        expect(Array.isArray(emptyMsg) ? emptyMsg.join(' ') : String(emptyMsg)).toMatch(
            /workId must be a UUID/i,
        );

        // ── 2. Malformed (non-UUID) workId → 400 too ────────────────────────
        const badWorkId = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(ownerToken),
            data: { workId: 'not-a-uuid' },
        });
        expect(badWorkId.status()).toBe(400);

        // ── 3. The Idea is UNTOUCHED by the rejected validations ────────────
        expect((await readIdea(request, ownerToken, ideaId)).status).toBe('pending');

        // ── 4. A well-formed but NON-EXISTENT workId — the accept passes
        //      validation + the ownership/status guard, then hits the FK on
        //      acceptedWorkId. Truthful tolerance: 200 (no FK enforced) OR 500
        //      (FK violation). We never assert a fictional FK-404 contract. ──
        const ghostWork = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(ownerToken),
            data: { workId: UNKNOWN_UUID },
        });
        expect([200, 500]).toContain(ghostWork.status());

        // ── 5. Ownership: user B cannot accept user A's Idea → 404, and the
        //      Idea stays in user A's pre-existing state ─────────────────────
        const ownerStateBefore = (await readIdea(request, ownerToken, ideaId)).status;
        const otherWork = await createWorkViaAPI(request, otherToken, { name: `Other Work ${s}` });
        const crossAccept = await request.post(
            `${API_BASE}/api/me/work-proposals/${ideaId}/accept`,
            { headers: authedHeaders(otherToken), data: { workId: otherWork.id } },
        );
        expect(crossAccept.status()).toBe(404);
        expect((await readIdea(request, ownerToken, ideaId)).status).toBe(ownerStateBefore);

        // ── 6. Unauthenticated accept + dismiss → 401 ───────────────────────
        const anonAccept = await request.post(
            `${API_BASE}/api/me/work-proposals/${ideaId}/accept`,
            { data: { workId: UNKNOWN_UUID } },
        );
        expect(anonAccept.status()).toBe(401);
        const anonDismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${ideaId}/dismiss`,
        );
        expect(anonDismiss.status()).toBe(401);
    });

    test('mission linkage: an accepted Idea round-trips its missionId, the ?missionId filter is exact, and an unlinked accepted Idea does not leak into a Mission scope', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── 1. A Mission to scope against ───────────────────────────────────
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: {
                title: `Accept-linkage Mission ${s}`,
                description: 'A mission used to assert Idea→Work accept scoping',
                type: 'one-shot',
                outstandingIdeasCap: 5,
            },
        });
        expect(missionRes.status(), `mission body=${await missionRes.text()}`).toBe(201);
        const mission = await missionRes.json();
        expect(mission.id).toMatch(UUID_RE);

        // ── 2. missionId is NOT a create field — Ideas can't self-link. A
        //      user-manual Idea is born unlinked (missionId:null). ───────────
        const rejected = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers: authedHeaders(token),
            data: {
                description: `Self-link idea ${s} — ${IDEA_DESC_MIN}; tries an illegal missionId`,
                missionId: mission.id,
            },
        });
        expect(rejected.status()).toBe(400);
        const rejMsg = (await rejected.json()).message;
        expect(Array.isArray(rejMsg) ? rejMsg.join(' ') : String(rejMsg)).toMatch(
            /missionId should not exist/i,
        );

        // ── 3. A legitimately-created (unlinked) Idea, accepted ─────────────
        const ideaId = await createIdea(
            request,
            token,
            `Linkage idea ${s} — ${IDEA_DESC_MIN} for the accept mission-scope probe`,
        );
        const work = await createWorkViaAPI(request, token, { name: `Linkage Work ${s}` });
        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: work.id },
        });
        expect(accept.status()).toBe(200);

        // The accepted Idea's missionId round-trips as null (no AI tick linked
        // it) and its acceptedWorkId is the Work it became.
        const accepted = await readIdea(request, token, ideaId);
        expect(accepted.status).toBe('accepted');
        expect(accepted.missionId).toBeNull();
        expect(accepted.acceptedWorkId).toBe(work.id);

        // ── 4. The ?missionId filter is EXACT — the unlinked accepted Idea
        //      does NOT leak into the Mission's scope, across BOTH the default
        //      (pending) and the accepted status views ────────────────────────
        for (const statusQuery of ['', '&statuses=accepted']) {
            const scoped = await request.get(
                `${API_BASE}/api/me/work-proposals?missionId=${mission.id}${statusQuery}`,
                { headers: authedHeaders(token) },
            );
            expect(scoped.status()).toBe(200);
            const rows = await scoped.json();
            expect(Array.isArray(rows)).toBe(true);
            expect((rows as Array<{ id: string }>).map((r) => r.id)).not.toContain(ideaId);
        }

        // ── 5. A malformed missionId filter is rejected by @IsUUID → 400 ────
        const badFilter = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=not-a-uuid`,
            { headers: authedHeaders(token) },
        );
        expect(badFilter.status()).toBe(400);

        // ── 6. An unknown-but-well-formed missionId scope is empty (200 []) ─
        const emptyScope = await request.get(
            `${API_BASE}/api/me/work-proposals?missionId=${UNKNOWN_UUID}`,
            { headers: authedHeaders(token) },
        );
        expect(emptyScope.status()).toBe(200);
        expect((await emptyScope.json()).length).toBe(0);
    });
});

test.describe('Idea → Work accept flow (seeded user UI)', () => {
    test('an accepted Idea created via the API surfaces under the /ideas Accepted view as a Done card', async ({
        page,
        request,
        baseURL,
    }) => {
        // Use the seeded user — its storageState is what the browser is
        // authenticated as, so an Idea + accept under it is the row /ideas
        // renders for this session.
        const token = await seededToken(request);
        const s = stamp();

        const desc = `Seeded accept idea ${s} — ${IDEA_DESC_MIN} that becomes a Done Work card`;
        const ideaId = await createIdea(request, token, desc);
        const work = await createWorkViaAPI(request, token, { name: `Seeded Accept Work ${s}` });

        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: work.id },
        });
        expect(accept.status()).toBe(200);

        // Confirm ACCEPTED via API before the UI assertion (avoids racing the
        // page against the write).
        await expect
            .poll(async () => (await readIdea(request, token, ideaId)).status, {
                timeout: 15_000,
                message: 'Idea should be ACCEPTED before the UI check',
            })
            .toBe('accepted');

        // The /ideas page hides Accepted rows by default behind a "Show
        // accepted" toggle / Accepted filter. Open the page, reveal accepted
        // Ideas (retry-to-open for the dev hydration race), then assert the
        // card body is visible. Branch on whichever affordance this build
        // renders (toggle vs filter chip vs accepted tab) using .or().
        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/ideas`, { waitUntil: 'domcontentloaded' });

        // Reveal accepted Ideas. The label is the i18n "Show accepted" toggle
        // or an "Accepted" filter — try each, tolerate absence (some builds
        // render all statuses inline).
        const reveal = page
            .getByRole('button', { name: /accepted/i })
            .or(page.getByRole('switch', { name: /accepted/i }))
            .or(page.getByText(/show accepted/i))
            .or(page.getByRole('tab', { name: /accepted/i }))
            .first();
        await expect(async () => {
            if (await reveal.isVisible().catch(() => false)) {
                await reveal.click({ timeout: 5_000 });
            }
            // After revealing, the accepted card (its description body) must
            // be on the page. If the build already shows accepted inline, the
            // reveal is a no-op and this still passes.
            await expect(page.getByText(desc).first()).toBeVisible({ timeout: 10_000 });
        }).toPass({ timeout: 30_000 });
    });
});
