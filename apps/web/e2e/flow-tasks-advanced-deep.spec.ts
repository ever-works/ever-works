import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI, transitionTaskViaAPI } from './helpers/agents-tasks';

/**
 * Tasks advanced sub-resources — the long-tail of `api/tasks/:id/*` write
 * verbs that the existing Works/Tasks specs leave UNCOVERED or only smoke.
 * This file pins, against the LIVE API, the REVIEWER add lifecycle, the
 * RELATION add lifecycle (related / duplicates / follow-up), the per-Task
 * SPEND rollup contract, and the block add→reflect→DELETE verb sequence.
 *
 * ── NON-DUPLICATION (sibling specs read first) ──────────────────────────────
 *   - `flow-task-approvers-gate.spec.ts` + `flow-task-full-lattice.spec.ts`
 *     own the APPROVER gate (requireAllApprovers firing on →done, force
 *     override, approver edges) and the BLOCKER gate/cascade/auto-unblock
 *     (add/remove/guards, self-block 400, dup 409, resolution cascade). This
 *     file does NOT re-derive any gate firing — it pins the reviewer/relation/
 *     spend VERBS those specs never touch, plus the single block add→DELETE
 *     verb pair (the DELETE `{deleted:true}` shape + gate-reopen), referencing
 *     the lattice spec for everything cascade-related.
 *   - `tasks-collaboration.spec.ts` only smokes "reviewer/approver born
 *     pending". It never pins the agent-actor reviewer, reviewer edges
 *     (bad-type/agent-unknown/missing-id/duplicate-500), the absent
 *     approve/remove-reviewer routes, or cross-user/auth closure. This file
 *     does.
 *   - `flow-task-collaboration.spec.ts` owns the CHAT thread (post/edit/
 *     mentions/audit) — out of scope here.
 *   - `flow-task-assignees-deep.spec.ts` / `agent-task-assignment-flow.spec.ts`
 *     own ASSIGNEES + agent-run dispatch — out of scope here.
 *   - `flow-task-scope-linkage.spec.ts` owns scope linkage; `flow-budget-
 *     agent-spend.spec.ts` owns the AGENT/account-wide budget surfaces — but
 *     NEITHER touches `GET /api/tasks/:id/spend` (the per-Task rollup), which
 *     this file pins.
 *
 * ── PROBED CONTRACTS (curl against http://127.0.0.1:3100 before asserting) ──
 *   REVIEWERS  POST /api/tasks/:id/reviewers { reviewerType:'user'|'agent', reviewerId }
 *     → 201 { taskId, reviewerType, reviewerId, tenantId, organizationId,
 *             reviewedAt:null, id, reviewState:'pending', createdAt }. ALWAYS
 *             born 'pending'. Agent reviewers must point at an OWNED agent.
 *       · bad reviewerType ('robot') → 400 class-validator array message
 *         "reviewerType must be one of the following values: user, agent"
 *         (the @IsIn pipe fires before the controller's assertActorType).
 *       · reviewerType:'agent' + unknown/unowned id → 400
 *         "Agent <id> is not reachable for this user — cannot assign."
 *       · missing reviewerId → 400 (@IsString/@MaxLength).
 *       · DUPLICATE (same taskId+type+id) → 500 (unique index).
 *       · cross-user (stranger on my task) → 404 "Task <id> not found."
 *       · no auth → 401 ; bad task uuid → 400 (ParseUUIDPipe).
 *       · There is NO approve route and NO remove-reviewer route:
 *         DELETE /api/tasks/:id/reviewers/:rid → 404 (route absent); reviewers
 *         are write-once + advisory on this build (no review-gate wired).
 *       · GET /api/tasks/:id/reviewers → 404 (no list route; not embedded in
 *         GET /api/tasks/:id either — the task body omits side rows).
 *
 *   RELATIONS  POST /api/tasks/:id/relations { relatedTaskId, kind }
 *     kind ∈ {related, duplicates, follow-up} → 201 { taskId, relatedTaskId,
 *             kind, tenantId, organizationId, id, createdAt }.
 *       · invalid kind → 400 class-validator array message "kind must be one
 *         of the following values: related, duplicates, follow-up".
 *       · missing kind / missing relatedTaskId → 400.
 *       · unknown relatedTaskId (well-formed uuid) → 400 "Related Task <id>
 *         not found." (FK + ownership enforced); a FOREIGN user's task as the
 *         target is the SAME 400 (no existence leak via that field).
 *       · SELF relation (A→A) → 201 ALLOWED — there is NO self-guard here
 *         (deliberate contrast with the blocker's self-block 400).
 *       · UNIQUENESS is (taskId, relatedTaskId), KIND-AGNOSTIC + DIRECTIONAL:
 *         A→B related then A→B duplicates → 409 (same pair, any kind);
 *         BUT reverse B→A related → 201, and A→C related → 201.
 *       · cross-user (stranger on my task) → 404 ; no auth → 401.
 *       · no DELETE route: DELETE /api/tasks/:id/relations/:rid → 404.
 *
 *   SPEND  GET /api/tasks/:id/spend[?currency&since&until]
 *     → 200 { taskId, totalCents:0, currency } — env-adaptive: keyless CI has
 *       NO plugin-usage ingestion + NO billing, so totalCents is ALWAYS 0. The
 *       `currency` query param is echoed verbatim (default 'usd'); since/until
 *       narrow the (empty) window without changing the 0 result.
 *       · ownership is checked via service.getOne FIRST → cross-user / unknown
 *         uuid → 404 "Task <id> not found." ; bad uuid → 400 ; no auth → 401.
 *
 *   BLOCKS (verb pair only — cascade lives in flow-task-full-lattice)
 *     POST /api/tasks/:id/blocks { blockedByTaskId } → 201 { taskId,
 *       blockedByTaskId, id, … }; the open blocker gates →in_progress (409
 *       "has N open blocker(s)."). DELETE /api/tasks/:id/blocks/:blockId →
 *       200 { deleted:true } and the dependent's gate REOPENS (→in_progress
 *       200). Unknown blockId → 404 "Blocker <id> not found."
 *
 * All flows run on FRESH `registerUserViaAPI` users (cross-spec isolation;
 * per-user T-n slugs reset per user). Unique suffixes from a per-test counter
 * (NOT a module-scope clock).
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const REQ_TIMEOUT = 20_000;

/** Per-test unique-suffix counter (no module-scope clock; title-derived seed). */
let suffixCounter = 0;
function uniq(label: string): string {
    suffixCounter += 1;
    return `${label}-${suffixCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

async function getTask(request: APIRequestContext, token: string, taskId: string) {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
        headers: authedHeaders(token),
        timeout: REQ_TIMEOUT,
    });
    expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

function addReviewer(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/reviewers`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

function addRelation(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/relations`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

function getSpend(request: APIRequestContext, token: string, taskId: string, query = '') {
    return request.get(`${API_BASE}/api/tasks/${taskId}/spend${query}`, {
        headers: authedHeaders(token),
        timeout: REQ_TIMEOUT,
    });
}

// ── Reviewers ───────────────────────────────────────────────────────────────

test.describe('Task reviewers — add lifecycle (API)', () => {
    test('a user reviewer is born pending with the full row shape; an OWNED agent is a first-class polymorphic reviewer', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Reviewer shape') });

        // (a) USER reviewer → 201, the full documented row, reviewState 'pending'.
        const userRes = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(userRes.status(), `user reviewer body=${await userRes.text().catch(() => '')}`).toBe(
            201,
        );
        const reviewer = await userRes.json();
        expect(reviewer.taskId).toBe(task.id);
        expect(reviewer.reviewerType).toBe('user');
        expect(reviewer.reviewerId).toBe(u.user.id);
        expect(reviewer.reviewState, 'reviewers are born pending').toBe('pending');
        expect(reviewer.reviewedAt, 'no reviewedAt until reviewed').toBeNull();
        expect(typeof reviewer.id).toBe('string');
        expect(typeof reviewer.createdAt).toBe('string');

        // (b) AGENT reviewer (owned) → 201, also pending — polymorphic actor.
        const agent = await createAgentViaAPI(request, token, { name: uniq('Reviewer Bot') });
        const agentRes = await addReviewer(request, token, task.id, {
            reviewerType: 'agent',
            reviewerId: agent.id,
        });
        expect(
            agentRes.status(),
            `agent reviewer body=${await agentRes.text().catch(() => '')}`,
        ).toBe(201);
        const agentReviewer = await agentRes.json();
        expect(agentReviewer.reviewerType).toBe('agent');
        expect(agentReviewer.reviewerId).toBe(agent.id);
        expect(agentReviewer.reviewState).toBe('pending');

        // Reviewers are NOT embedded in the task GET body (side rows are
        // write-only on this build); the task itself is unchanged by the add.
        const fresh = await getTask(request, token, task.id);
        expect(fresh).not.toHaveProperty('reviewers');
        expect(fresh.status).toBe('backlog');
    });

    test('reviewer validation + uniqueness: bad actor 400, unknown agent 400, missing id 400, duplicate 409; no approve/remove-reviewer route (404)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Reviewer edges') });

        // (a) Invalid reviewerType → 400, class-validator array message (the
        // @IsIn pipe rejects before the controller's assertActorType string).
        const badType = await addReviewer(request, token, task.id, {
            reviewerType: 'robot',
            reviewerId: u.user.id,
        });
        expect(badType.status()).toBe(400);
        expect(String((await badType.json()).message)).toMatch(/one of the following values/i);

        // (b) Agent reviewer pointing at an unknown/unowned agent → 400.
        const unownedAgent = await addReviewer(request, token, task.id, {
            reviewerType: 'agent',
            reviewerId: NIL_UUID,
        });
        expect(unownedAgent.status()).toBe(400);
        expect((await unownedAgent.json()).message).toMatch(/not reachable for this user/i);

        // (c) Missing reviewerId → 400 (DTO @IsString/@MaxLength).
        const missingId = await addReviewer(request, token, task.id, { reviewerType: 'user' });
        expect(missingId.status()).toBe(400);

        // (d) First valid add → 201, then a TRUE duplicate (same task+type+id)
        // → 500 (unique index; the build surfaces it as a 500, not a typed 409).
        const first = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(first.status()).toBe(201);
        const reviewerId = (await first.json()).id;
        expect(reviewerId).toBeTruthy();
        const dup = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(dup.status(), `dup reviewer body=${await dup.text().catch(() => '')}`).toBe(409);

        // (e) There is NO approve route and NO remove-reviewer route — reviewers
        // are write-once + advisory on this build (no review-gate is wired).
        const removeById = await request.delete(
            `${API_BASE}/api/tasks/${task.id}/reviewers/${reviewerId}`,
            { headers: authedHeaders(token) },
        );
        expect(removeById.status(), 'remove-reviewer route absent').toBe(404);

        // (f) No GET list route either (and not embedded in the task body).
        const listRoute = await request.get(`${API_BASE}/api/tasks/${task.id}/reviewers`, {
            headers: authedHeaders(token),
        });
        expect(listRoute.status(), 'reviewers list route absent').toBe(404);
    });

    test('the SAME actor can be reviewer + approver + assignee on one task at once — the three side-rows live in independent tables with no unique-key collision', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Coexist roles') });

        // reviewer(user) and approver(user) and assignee(user) for the SAME user
        // on the SAME task all succeed — the per-role unique index is scoped to
        // its own table, so one actor wearing three hats never trips a constraint.
        const reviewer = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(reviewer.status(), `reviewer body=${await reviewer.text().catch(() => '')}`).toBe(
            201,
        );
        expect((await reviewer.json()).reviewState).toBe('pending');

        const approver = await request.post(`${API_BASE}/api/tasks/${task.id}/approvers`, {
            headers: authedHeaders(token),
            data: { approverType: 'user', approverId: u.user.id },
        });
        expect(approver.status(), `approver body=${await approver.text().catch(() => '')}`).toBe(
            201,
        );
        expect((await approver.json()).approvalState).toBe('pending');

        const assignee = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers: authedHeaders(token),
            data: { assigneeType: 'user', assigneeId: u.user.id },
        });
        expect(assignee.status(), `assignee body=${await assignee.text().catch(() => '')}`).toBe(
            201,
        );
        expect((await assignee.json()).assigneeId).toBe(u.user.id);

        // The duplicate guard is PER-ROLE: a second reviewer(user, same id) still
        // 409s on the reviewer table even though approver/assignee rows exist for
        // the same actor — the tables don't share a key.
        const dupReviewer = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(dupReviewer.status(), 'reviewer dup is per-table → 409 Conflict').toBe(409);
    });

    test('reviewer closure: cross-user add → 404 (no existence leak), no auth → 401, bad task uuid → 400', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: uniq('Reviewer closure'),
        });

        // Stranger adding a reviewer to my task → 404 "Task <id> not found."
        const crossUser = await addReviewer(request, stranger.access_token, task.id, {
            reviewerType: 'user',
            reviewerId: stranger.user.id,
        });
        expect(crossUser.status(), 'cross-user reviewer → 404 not-found').toBe(404);
        expect((await crossUser.json()).message).toMatch(/not found/i);

        // No auth → 401.
        const anon = await request.post(`${API_BASE}/api/tasks/${task.id}/reviewers`, {
            data: { reviewerType: 'user', reviewerId: owner.user.id },
        });
        expect(anon.status(), 'unauth reviewer → 401').toBe(401);

        // Malformed task id → 400 (ParseUUIDPipe).
        const badUuid = await addReviewer(request, owner.access_token, 'not-a-uuid', {
            reviewerType: 'user',
            reviewerId: owner.user.id,
        });
        expect(badUuid.status(), 'bad task uuid → 400').toBe(400);
    });
});

// ── Relations ─────────────────────────────────────────────────────────────────

test.describe('Task relations — related / duplicates / follow-up edges (API)', () => {
    test('add a `related` edge returns the full row shape; `duplicates` and `follow-up` both land on distinct target pairs', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const a = await createTaskViaAPI(request, token, { title: uniq('Rel A') });
        const b = await createTaskViaAPI(request, token, { title: uniq('Rel B') });
        const c = await createTaskViaAPI(request, token, { title: uniq('Rel C') });
        const d = await createTaskViaAPI(request, token, { title: uniq('Rel D') });

        // `related` A→B → 201, full documented edge row.
        const relatedRes = await addRelation(request, token, a.id, {
            relatedTaskId: b.id,
            kind: 'related',
        });
        expect(relatedRes.status(), `related body=${await relatedRes.text().catch(() => '')}`).toBe(
            201,
        );
        const edge = await relatedRes.json();
        expect(edge.taskId).toBe(a.id);
        expect(edge.relatedTaskId).toBe(b.id);
        expect(edge.kind).toBe('related');
        expect(typeof edge.id).toBe('string');
        expect(typeof edge.createdAt).toBe('string');

        // `duplicates` A→C and `follow-up` A→D — both valid kinds on fresh pairs.
        const dupKind = await addRelation(request, token, a.id, {
            relatedTaskId: c.id,
            kind: 'duplicates',
        });
        expect(dupKind.status(), `duplicates body=${await dupKind.text().catch(() => '')}`).toBe(
            201,
        );
        expect((await dupKind.json()).kind).toBe('duplicates');

        const followUp = await addRelation(request, token, a.id, {
            relatedTaskId: d.id,
            kind: 'follow-up',
        });
        expect(followUp.status(), `follow-up body=${await followUp.text().catch(() => '')}`).toBe(
            201,
        );
        expect((await followUp.json()).kind).toBe('follow-up');
    });

    test('self-relation (A→A) is REJECTED (400) — now consistent with the blocker self-block guard', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const a = await createTaskViaAPI(request, token, { title: uniq('Self rel') });

        // Relations now carry a self-guard (mirroring POST /blocks which 400s on
        // self-block). A task may NOT relate to itself — the guard fires before
        // any insert, so no self-relation row is ever created.
        const selfRel = await addRelation(request, token, a.id, {
            relatedTaskId: a.id,
            kind: 'related',
        });
        expect(selfRel.status(), `self-relation body=${await selfRel.text().catch(() => '')}`).toBe(
            400,
        );
        expect(
            String((await selfRel.json()).message ?? ''),
            'the 400 names the self-relation rejection',
        ).toContain('itself');
    });

    test('uniqueness is (taskId, relatedTaskId) — KIND-AGNOSTIC and DIRECTIONAL: same pair any kind → 409, reverse → 201, different target → 201', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const a = await createTaskViaAPI(request, token, { title: uniq('Uniq A') });
        const b = await createTaskViaAPI(request, token, { title: uniq('Uniq B') });
        const c = await createTaskViaAPI(request, token, { title: uniq('Uniq C') });

        // A→B related → 201.
        const first = await addRelation(request, token, a.id, {
            relatedTaskId: b.id,
            kind: 'related',
        });
        expect(first.status()).toBe(201);

        // A→B again with a DIFFERENT kind → 409 Conflict: the unique key is the
        // (taskId, relatedTaskId) pair, NOT the kind. This is the load-bearing
        // truth — a relation pair is single-valued regardless of edge type. (The
        // unique-violation is now mapped to a clean 409 instead of an unmapped 500.)
        const sameKindlessDup = await addRelation(request, token, a.id, {
            relatedTaskId: b.id,
            kind: 'duplicates',
        });
        expect(
            sameKindlessDup.status(),
            `kind-agnostic dup body=${await sameKindlessDup.text().catch(() => '')}`,
        ).toBe(409);

        // REVERSE direction B→A is a DISTINCT pair → 201 (the key is ordered).
        const reverse = await addRelation(request, token, b.id, {
            relatedTaskId: a.id,
            kind: 'related',
        });
        expect(reverse.status(), `reverse body=${await reverse.text().catch(() => '')}`).toBe(201);

        // DIFFERENT target A→C → 201 (same source, new pair).
        const otherTarget = await addRelation(request, token, a.id, {
            relatedTaskId: c.id,
            kind: 'related',
        });
        expect(
            otherTarget.status(),
            `other-target body=${await otherTarget.text().catch(() => '')}`,
        ).toBe(201);
    });

    test('relation validation: bad kind 400, missing kind 400, missing relatedTaskId 400, unknown target 400, foreign target 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const a = await createTaskViaAPI(request, token, { title: uniq('Rel val A') });
        const b = await createTaskViaAPI(request, token, { title: uniq('Rel val B') });

        // Invalid kind → 400, class-validator array message (@IsIn fires before
        // the controller's own "Invalid relation kind" string).
        const badKind = await addRelation(request, token, a.id, {
            relatedTaskId: b.id,
            kind: 'bogus',
        });
        expect(badKind.status()).toBe(400);
        expect(String((await badKind.json()).message)).toMatch(/one of the following values/i);

        // Missing kind → 400 (same @IsIn message).
        const missingKind = await addRelation(request, token, a.id, { relatedTaskId: b.id });
        expect(missingKind.status()).toBe(400);

        // Missing relatedTaskId → 400 (@IsUUID).
        const missingTarget = await addRelation(request, token, a.id, { kind: 'related' });
        expect(missingTarget.status()).toBe(400);
        expect(String((await missingTarget.json()).message)).toMatch(/uuid/i);

        // Unknown (well-formed) relatedTaskId → 400 "Related Task <id> not found."
        const unknownTarget = await addRelation(request, token, a.id, {
            relatedTaskId: NIL_UUID,
            kind: 'related',
        });
        expect(unknownTarget.status()).toBe(400);
        expect((await unknownTarget.json()).message).toMatch(/related task .*not found/i);

        // A FOREIGN user's task as the target is the SAME 400 not-found — the
        // related target is FK + ownership enforced (no existence leak via it).
        const other = await registerUserViaAPI(request);
        const foreign = await createTaskViaAPI(request, other.access_token, {
            title: uniq('Rel foreign'),
        });
        const foreignTarget = await addRelation(request, token, a.id, {
            relatedTaskId: foreign.id,
            kind: 'related',
        });
        expect(
            foreignTarget.status(),
            `foreign-target body=${await foreignTarget.text().catch(() => '')}`,
        ).toBe(400);
        expect((await foreignTarget.json()).message).toMatch(/related task .*not found/i);
    });

    test('relation closure: cross-user add → 404 (no existence leak), no auth → 401, no DELETE-relation route (404)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const a = await createTaskViaAPI(request, owner.access_token, {
            title: uniq('Rel close A'),
        });
        const b = await createTaskViaAPI(request, owner.access_token, {
            title: uniq('Rel close B'),
        });

        // Stranger relating ON my task → 404 "Task <id> not found." (the SOURCE
        // task ownership is checked first; the foreign source is invisible).
        const crossUser = await addRelation(request, stranger.access_token, a.id, {
            relatedTaskId: b.id,
            kind: 'related',
        });
        expect(crossUser.status(), 'cross-user relation → 404 not-found').toBe(404);
        expect((await crossUser.json()).message).toMatch(/not found/i);

        // No auth → 401.
        const anon = await request.post(`${API_BASE}/api/tasks/${a.id}/relations`, {
            data: { relatedTaskId: b.id, kind: 'related' },
        });
        expect(anon.status(), 'unauth relation → 401').toBe(401);

        // There is NO remove-relation route — relations are append-only here.
        const removeRoute = await request.delete(
            `${API_BASE}/api/tasks/${a.id}/relations/${NIL_UUID}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(removeRoute.status(), 'remove-relation route absent').toBe(404);
    });
});

// ── Spend ─────────────────────────────────────────────────────────────────────

test.describe('Task spend rollup — GET /api/tasks/:id/spend (env-adaptive zero)', () => {
    test('fresh task reports a well-formed zero spend rollup with the default usd currency', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Spend zero') });

        const res = await getSpend(request, token, task.id);
        expect(res.status(), `spend body=${await res.text().catch(() => '')}`).toBe(200);
        const spend = await res.json();
        expect(spend.taskId, 'rollup echoes the task id').toBe(task.id);
        // Keyless CI has no plugin-usage ingestion + no billing → spend is the
        // well-formed observable ZERO-state (the rollup MECHANISM, not a billed
        // number we could never produce here).
        expect(spend.totalCents, 'no billed spend in CI → 0').toBe(0);
        expect(typeof spend.totalCents).toBe('number');
        expect(spend.currency, 'default rollup currency is usd').toBe('usd');
    });

    test('spend echoes the currency query param verbatim and honors since/until without changing the (empty) result', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Spend params') });

        // The `currency` query param is echoed verbatim onto the rollup.
        const eur = await getSpend(request, token, task.id, '?currency=eur');
        expect(eur.status()).toBe(200);
        const eurBody = await eur.json();
        expect(eurBody.currency, 'currency param is echoed back').toBe('eur');
        expect(eurBody.totalCents).toBe(0);

        // since/until narrow the (empty) usage window — still a clean 0, no 4xx.
        const windowed = await getSpend(
            request,
            token,
            task.id,
            '?since=2020-01-01T00:00:00Z&until=2020-02-01T00:00:00Z',
        );
        expect(windowed.status(), `windowed body=${await windowed.text().catch(() => '')}`).toBe(
            200,
        );
        const windowedBody = await windowed.json();
        expect(windowedBody.totalCents, 'narrowed window over an empty ledger → 0').toBe(0);
        expect(windowedBody.taskId).toBe(task.id);
    });

    test('spend is orthogonal to side-rows: attaching reviewers/approvers and a blocker never moves the rollup off 0 (only billed plugin usage would)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Spend orthog') });
        const blocker = await createTaskViaAPI(request, token, { title: uniq('Spend orthog up') });

        // Baseline zero.
        expect((await (await getSpend(request, token, task.id)).json()).totalCents).toBe(0);

        // Attach a reviewer, an approver, and a blocker — none is billed usage, so
        // the spend rollup must stay 0 (spend accrues only from PluginUsageEvent
        // rows attributed to the task, of which there are none in keyless CI).
        await addReviewer(request, token, task.id, { reviewerType: 'user', reviewerId: u.user.id });
        await request.post(`${API_BASE}/api/tasks/${task.id}/approvers`, {
            headers: authedHeaders(token),
            data: { approverType: 'user', approverId: u.user.id },
        });
        await request.post(`${API_BASE}/api/tasks/${task.id}/blocks`, {
            headers: authedHeaders(token),
            data: { blockedByTaskId: blocker.id },
        });

        const after = await (await getSpend(request, token, task.id)).json();
        expect(after.totalCents, 'side-rows are not spend → rollup stays 0').toBe(0);
        expect(after.currency).toBe('usd');
        expect(after.taskId).toBe(task.id);
    });

    test('spend closure: cross-user → 404 (ownership checked via getOne), unknown uuid → 404, bad uuid → 400, no auth → 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: uniq('Spend close'),
        });

        // Cross-user read → 404 (the endpoint runs service.getOne FIRST, so a
        // foreign task is invisible — no existence leak via 403).
        const crossUser = await getSpend(request, stranger.access_token, task.id);
        expect(crossUser.status(), 'cross-user spend → 404 not-found').toBe(404);
        expect((await crossUser.json()).message).toMatch(/not found/i);

        // Well-formed but non-existent task → 404.
        const unknown = await getSpend(request, owner.access_token, NIL_UUID);
        expect(unknown.status(), 'unknown task spend → 404').toBe(404);

        // Malformed id → 400 (ParseUUIDPipe).
        const badUuid = await getSpend(request, owner.access_token, 'not-a-uuid');
        expect(badUuid.status(), 'bad uuid spend → 400').toBe(400);

        // No auth → 401.
        const anon = await request.get(`${API_BASE}/api/tasks/${task.id}/spend`);
        expect(anon.status(), 'unauth spend → 401').toBe(401);
    });
});

// ── Blocks (add → reflect → DELETE verb pair; cascade lives in full-lattice) ──

test.describe('Task blocks — add reflects on the gate, DELETE returns {deleted:true} and reopens it (API)', () => {
    test('add a block (A blocks B) gates B→in_progress (409); DELETE the block → {deleted:true} and the gate reopens (200); unknown blockId → 404', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        // `dependent` is blocked BY `blocker`. Park dependent at todo so the only
        // thing standing between it and in_progress is the blocker gate.
        const dependent = await createTaskViaAPI(request, token, { title: uniq('Block dep') });
        const blocker = await createTaskViaAPI(request, token, { title: uniq('Block up') });
        await transitionTaskViaAPI(request, token, dependent.id, 'todo');

        // POST the block → 201, the documented edge row.
        const addRes = await request.post(`${API_BASE}/api/tasks/${dependent.id}/blocks`, {
            headers: authedHeaders(token),
            data: { blockedByTaskId: blocker.id },
            timeout: REQ_TIMEOUT,
        });
        expect(addRes.status(), `add block body=${await addRes.text().catch(() => '')}`).toBe(201);
        const blockRow = await addRes.json();
        expect(blockRow.taskId).toBe(dependent.id);
        expect(blockRow.blockedByTaskId).toBe(blocker.id);
        const blockId = blockRow.id;
        expect(blockId).toBeTruthy();

        // The block is REFLECTED on the gate: dependent → in_progress is 409
        // "has 1 open blocker(s)." (this is the observable side-effect of the add).
        const gated = await request.post(`${API_BASE}/api/tasks/${dependent.id}/transition`, {
            headers: authedHeaders(token),
            data: { to: 'in_progress' },
            timeout: REQ_TIMEOUT,
        });
        expect(gated.status(), `gated body=${await gated.text().catch(() => '')}`).toBe(409);
        expect((await gated.json()).message).toMatch(/open blocker/i);

        // Unknown blockId on DELETE → 404 "Blocker <id> not found." (the DELETE
        // is FK-checked, not a silent no-op).
        const ghostDelete = await request.delete(
            `${API_BASE}/api/tasks/${dependent.id}/blocks/${NIL_UUID}`,
            { headers: authedHeaders(token), timeout: REQ_TIMEOUT },
        );
        expect(ghostDelete.status(), 'unknown blockId delete → 404').toBe(404);
        expect((await ghostDelete.json()).message).toMatch(/not found/i);

        // DELETE the real block → 200 { deleted:true }.
        const delRes = await request.delete(
            `${API_BASE}/api/tasks/${dependent.id}/blocks/${blockId}`,
            { headers: authedHeaders(token), timeout: REQ_TIMEOUT },
        );
        expect(delRes.status(), `delete block body=${await delRes.text().catch(() => '')}`).toBe(
            200,
        );
        expect((await delRes.json()).deleted, 'DELETE block returns {deleted:true}').toBe(true);

        // With the only blocker removed, the gate REOPENS: dependent → in_progress
        // now succeeds (200) and stamps startedAt. (The cascade/auto-restore
        // mechanics are owned by flow-task-full-lattice; here we pin the verb pair
        // + the reopen.)
        const reopened = await transitionTaskViaAPI(request, token, dependent.id, 'in_progress');
        expect(reopened.status).toBe('in_progress');
        // `startedAt` is a live response field not modeled on the helper's Task
        // type — widen the access to keep the (probed) stamp assertion.
        const reopenedStartedAt = (reopened as unknown as { startedAt?: string | null }).startedAt;
        expect(reopenedStartedAt, 'reopened gate lets in_progress stamp startedAt').toBeTruthy();
    });
});
