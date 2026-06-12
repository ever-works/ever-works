import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, transitionTaskViaAPI, createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Task approver gate — the `requireAllApprovers` policy on `→ done`.
 *
 * This is the deep companion to `flow-task-state-machine.spec.ts` (which
 * walks the lattice with ZERO approvers, where `allApproved()` is vacuously
 * true) and `tasks-collaboration.spec.ts` (which only asserts an approver is
 * BORN `pending`). Neither exercises the gate actually FIRING, the
 * force-override-vs-blocker-gate interaction, partial multi-approver state,
 * the policy-toggle escape hatch, or the (intentionally) missing approve /
 * remove-approver endpoints. That is this file.
 *
 * Server-authoritative gate (`packages/agent/src/tasks-domain/
 * task-transition.service.ts` → `transition()`):
 *   - `→ done` first runs the BLOCKER gate (open blockers → 409
 *     "has N open blocker(s)."), which `force` does NOT bypass — blockers
 *     are an integrity rule, not policy.
 *   - then the APPROVER gate: when `task.requireAllApprovers === true` AND
 *     `force !== true`, it calls `TaskApproverRepository.allApproved(taskId)`.
 *       · zero approvers attached → vacuously `true` (gate passes).
 *       · ≥1 approver attached, not ALL in `approved` state → 409
 *         "Task cannot transition to done — not all approvers have approved
 *          (pass force=true to override)."
 *   - `force: true` overrides ONLY the approver gate (409 → 200, sets
 *     completedAt). `force: false` is identical to omitting force.
 *
 * PROBED, TRUTHFUL endpoint behaviour (curl against http://127.0.0.1:3100
 * before any assertion below):
 *   - POST /api/tasks { title }  → 201, `requireAllApprovers: true` by default;
 *     { title, requireAllApprovers:false } → 201 with the gate disabled.
 *   - POST /api/tasks/:id/approvers { approverType:'user'|'agent', approverId }
 *       → 201 { id, taskId, approverType, approverId, approvalState:'pending',
 *               approvedAt:null, createdAt }. ALWAYS born 'pending'.
 *       · invalid approverType → 400. `AddApproverDto.approverType` is
 *         `@IsIn(['user','agent'])`, so the global ValidationPipe rejects it
 *         first with the class-validator array message "approverType must be
 *         one of the following values: user, agent" (NOT the controller's
 *         "Invalid actor type" string, which the pipe never reaches).
 *       · approverType:'agent' with a non-owned/unknown agent id → 400
 *         "Agent <id> is not reachable for this user — cannot assign."
 *       · DUPLICATE (same taskId+type+id) → 409 (uq_task_approver unique idx,
 *         mapped to a clean Conflict instead of an unmapped 500).
 *       · cross-user (stranger adds approver to my task) → 404
 *         "Task <id> not found." (no existence leak via 403).
 *       · adding an approver to an ALREADY-`done` task → 201 (still 'pending'),
 *         the gate is evaluated only at transition time, never retroactively.
 *   - There is NO endpoint to APPROVE an approver (no PATCH/POST that flips
 *     approvalState → 'approved'); `TaskApproverRepository.setState` is never
 *     wired to a route in `TasksController`. Consequence: once ≥1 approver is
 *     attached under `requireAllApprovers:true`, the ONLY ways to reach `done`
 *     are (a) `force:true` or (b) flipping `requireAllApprovers:false`.
 *   - There is NO DELETE approver route: DELETE /api/tasks/:id/approvers/:id
 *     → 404 "Cannot DELETE …". The realistic "remove the gate" lever is
 *     PATCH /api/tasks/:id { requireAllApprovers:false } (→ 200) — or deleting
 *     the whole Task (cascade).
 *   - POST /api/tasks/:id/transition { to:'done', force? }
 *       gated (≥1 pending approver, force≠true) → 409 (Conflict).
 *       force:true → 200, status 'done', completedAt set, requireAllApprovers
 *                    UNCHANGED (force is a per-transition override, not a
 *                    persisted policy edit).
 *
 * All flows run on FRESH `registerUserViaAPI` users (cross-spec isolation;
 * per-user `T-n` slugs reset per user). Register DTO uses `username` (handled
 * by the helper). Unique titles via Date.now suffix.
 */

const TRANSITION_TIMEOUT = 20_000;

/** Raw transition POST so we can inspect non-2xx bodies (the helper asserts < 300). */
async function rawTransition(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: { to: string; force?: boolean },
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/transition`, {
        headers: authedHeaders(token),
        data: body,
        timeout: TRANSITION_TIMEOUT,
    });
}

async function getTask(request: APIRequestContext, token: string, taskId: string) {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
        headers: authedHeaders(token),
        timeout: TRANSITION_TIMEOUT,
    });
    expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Add an approver and return the raw APIResponse (callers inspect status/body). */
async function rawAddApprover(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: { approverType: string; approverId: string },
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/approvers`, {
        headers: authedHeaders(token),
        data: body,
        timeout: TRANSITION_TIMEOUT,
    });
}

/** Walk a backlog task → in_review (the only legal pre-`done` parking state). */
async function walkToInReview(request: APIRequestContext, token: string, taskId: string) {
    for (const to of ['todo', 'in_progress', 'in_review']) {
        await transitionTaskViaAPI(request, token, taskId, to);
    }
    const row = await getTask(request, token, taskId);
    expect(row.status, 'parked at in_review before testing the done gate').toBe('in_review');
    return row;
}

test.describe('Task approver gate — requireAllApprovers on → done (API)', () => {
    test('one pending approver gates in_review→done (409), force:true overrides it (200) without mutating requireAllApprovers', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        const task = await createTaskViaAPI(request, token, { title: `Gate single ${stamp}` });
        // `createTaskViaAPI`'s typed Task omits `requireAllApprovers`; read the
        // runtime field off the untyped GET response (it IS present — proven by
        // the sibling state-machine spec).
        const born = await getTask(request, token, task.id);
        expect(born.requireAllApprovers, 'tasks default to requireAllApprovers=true').toBe(true);

        // Attach a single (pending) approver — the user themselves.
        const addRes = await rawAddApprover(request, token, task.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        expect(addRes.status(), `add approver body=${await addRes.text().catch(() => '')}`).toBe(
            201,
        );
        const approver = await addRes.json();
        expect(approver.taskId).toBe(task.id);
        expect(approver.approverType).toBe('user');
        expect(approver.approverId).toBe(u.user.id);
        expect(approver.approvalState, 'approvers are born pending').toBe('pending');
        expect(approver.approvedAt, 'no approvedAt until approved').toBeNull();

        await walkToInReview(request, token, task.id);

        // ── Gated: in_review → done with a single pending approver → 409. ──
        const gated = await rawTransition(request, token, task.id, { to: 'done' });
        expect(gated.status(), `gated done body=${await gated.text().catch(() => '')}`).toBe(409);
        const gatedBody = await gated.json();
        // PROBED wording (ConflictException).
        expect(gatedBody.message).toMatch(/not all approvers have approved/i);
        expect(gatedBody.message).toMatch(/force=true/i);
        expect(gatedBody.statusCode).toBe(409);

        // Non-mutating: the gate rejection left the task at in_review with no
        // leaked completedAt.
        const afterGate = await getTask(request, token, task.id);
        expect(afterGate.status, 'gated rejection does not move the task').toBe('in_review');
        expect(afterGate.completedAt, 'gated rejection does not stamp completedAt').toBeNull();

        // `force:false` is identical to omitting force — still 409.
        const explicitFalse = await rawTransition(request, token, task.id, {
            to: 'done',
            force: false,
        });
        expect(explicitFalse.status(), 'force:false == no force, still gated').toBe(409);
        expect((await explicitFalse.json()).message).toMatch(/not all approvers/i);

        // ── force:true overrides the approver gate → 200, completedAt set. ──
        const forced = await rawTransition(request, token, task.id, { to: 'done', force: true });
        expect(forced.status(), `forced done body=${await forced.text().catch(() => '')}`).toBe(
            200,
        );
        const forcedRow = await forced.json();
        expect(forcedRow.status).toBe('done');
        expect(forcedRow.completedAt, 'force-done stamps completedAt').toBeTruthy();
        // force is a per-transition override — the persisted policy is untouched.
        expect(forcedRow.requireAllApprovers, 'force does not flip the policy off').toBe(true);

        // The approver row itself is also untouched — still pending (force did
        // not silently auto-approve anyone).
        const reread = await getTask(request, token, task.id);
        expect(reread.status).toBe('done');
        expect(reread.requireAllApprovers).toBe(true);
    });

    test('requireAllApprovers=false disables the gate end-to-end even with a pending approver attached', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        // Born with the gate OFF. createTaskViaAPI's typed body doesn't list
        // `requireAllApprovers`, so POST directly to keep the field explicit.
        const createRes = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            data: { title: `Gate disabled ${stamp}`, requireAllApprovers: false },
        });
        expect(createRes.status(), `create body=${await createRes.text().catch(() => '')}`).toBe(
            201,
        );
        const task = await createRes.json();
        expect(task.requireAllApprovers, 'gate disabled at create').toBe(false);

        // A pending approver is still attached, but with the gate off it is
        // purely advisory — it must NOT block done.
        const addRes = await rawAddApprover(request, token, task.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        expect(addRes.status()).toBe(201);
        expect((await addRes.json()).approvalState).toBe('pending');

        await walkToInReview(request, token, task.id);

        // No force needed — gate is disabled.
        const done = await rawTransition(request, token, task.id, { to: 'done' });
        expect(done.status(), `done body=${await done.text().catch(() => '')}`).toBe(200);
        const doneRow = await done.json();
        expect(doneRow.status).toBe('done');
        expect(doneRow.completedAt, 'completedAt stamped on the ungated done').toBeTruthy();
        expect(doneRow.requireAllApprovers).toBe(false);
    });

    test('PATCH requireAllApprovers true→false unlocks an in_review task previously held by the approver gate', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        // Default gate ON + a pending approver.
        const task = await createTaskViaAPI(request, token, { title: `Toggle unlock ${stamp}` });
        expect(
            (await getTask(request, token, task.id)).requireAllApprovers,
            'default gate ON',
        ).toBe(true);
        await rawAddApprover(request, token, task.id, {
            approverType: 'user',
            approverId: u.user.id,
        });

        await walkToInReview(request, token, task.id);

        // Gate held closed.
        const blocked = await rawTransition(request, token, task.id, { to: 'done' });
        expect(blocked.status(), 'gate held before toggle').toBe(409);
        expect((await blocked.json()).message).toMatch(/not all approvers/i);

        // Flip the policy off via PATCH — the realistic "remove the gate"
        // lever (there is no remove-approver endpoint; see the dedicated flow).
        const patch = await request.patch(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(token),
            data: { requireAllApprovers: false },
        });
        expect(patch.status(), `patch body=${await patch.text().catch(() => '')}`).toBe(200);
        expect((await patch.json()).requireAllApprovers, 'PATCH persisted the policy off').toBe(
            false,
        );

        // Same hop now succeeds — no force, gate disabled, approver still
        // pending but advisory.
        const done = await rawTransition(request, token, task.id, { to: 'done' });
        expect(done.status(), `done after toggle body=${await done.text().catch(() => '')}`).toBe(
            200,
        );
        const doneRow = await done.json();
        expect(doneRow.status).toBe('done');
        expect(doneRow.completedAt).toBeTruthy();
        expect(doneRow.requireAllApprovers).toBe(false);
    });

    test('partial approval: multiple (user + agent) approvers, all pending → done stays gated until force overrides ALL of them at once', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        const task = await createTaskViaAPI(request, token, { title: `Partial approve ${stamp}` });

        // Approver #1: the user.
        const a1 = await rawAddApprover(request, token, task.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        expect(a1.status()).toBe(201);
        expect((await a1.json()).approvalState).toBe('pending');

        // Approver #2: a freshly-created (owned) agent — polymorphic actor.
        const agent = await createAgentViaAPI(request, token, { name: `Approver Bot ${stamp}` });
        const a2 = await rawAddApprover(request, token, task.id, {
            approverType: 'agent',
            approverId: agent.id,
        });
        expect(a2.status(), `agent approver body=${await a2.text().catch(() => '')}`).toBe(201);
        const agentApprover = await a2.json();
        expect(agentApprover.approverType).toBe('agent');
        expect(agentApprover.approverId).toBe(agent.id);
        expect(agentApprover.approvalState, 'agent approver also born pending').toBe('pending');

        await walkToInReview(request, token, task.id);

        // `allApproved()` requires EVERY approver in 'approved' state. With two
        // pending approvers and no approve-endpoint, the gate is closed — this
        // is the "partial approval" reality: there is no way to satisfy a
        // subset, so any non-empty set of pending approvers blocks `done`.
        const gated = await rawTransition(request, token, task.id, { to: 'done' });
        expect(gated.status(), `gated body=${await gated.text().catch(() => '')}`).toBe(409);
        expect((await gated.json()).message).toMatch(/not all approvers have approved/i);
        expect((await getTask(request, token, task.id)).status).toBe('in_review');

        // A single force:true clears the WHOLE gate in one shot (it is a gate
        // bypass, not a per-approver approval) → 200.
        const forced = await rawTransition(request, token, task.id, { to: 'done', force: true });
        expect(forced.status(), `forced body=${await forced.text().catch(() => '')}`).toBe(200);
        expect((await forced.json()).status).toBe('done');
    });

    test('force overrides the APPROVER gate but is powerless against the BLOCKER gate (both stacked on → done)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        // Dependent task: pending approver AND an open blocker. Park it at
        // in_review BEFORE adding the blocker (the blocker gate also fires on
        // `→ in_progress`, so adding it first would stall the walk).
        const dependent = await createTaskViaAPI(request, token, {
            title: `Force vs blocker dep ${stamp}`,
        });
        await rawAddApprover(request, token, dependent.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        await walkToInReview(request, token, dependent.id);

        // Now wire an open blocker (a brand-new backlog task, not done/cancelled).
        const blocker = await createTaskViaAPI(request, token, {
            title: `Force vs blocker upstream ${stamp}`,
        });
        const block = await request.post(`${API_BASE}/api/tasks/${dependent.id}/blocks`, {
            headers: authedHeaders(token),
            data: { blockedByTaskId: blocker.id },
        });
        expect(block.status(), `add blocker body=${await block.text().catch(() => '')}`).toBe(201);

        // With BOTH gates closed, `force:true` overrides ONLY the approver gate;
        // the blocker gate still wins → 409 with the BLOCKER message (proving
        // the blocker gate runs first and is force-immune).
        const forced = await rawTransition(request, token, dependent.id, {
            to: 'done',
            force: true,
        });
        expect(forced.status(), `forced+blocked body=${await forced.text().catch(() => '')}`).toBe(
            409,
        );
        const forcedBody = await forced.json();
        expect(forcedBody.message, 'blocker message, NOT the approver message').toMatch(
            /open blocker/i,
        );
        expect(forcedBody.message).not.toMatch(/not all approvers/i);
        expect((await getTask(request, token, dependent.id)).status).toBe('in_review');

        // Resolve the blocker (cancel it → no longer "open"); now force:true
        // clears the remaining approver gate → 200. This proves the two gates
        // are independent layers, each cleared by its own mechanism.
        await transitionTaskViaAPI(request, token, blocker.id, 'cancelled');
        await expect
            .poll(
                async () => {
                    const res = await rawTransition(request, token, dependent.id, {
                        to: 'done',
                        force: true,
                    });
                    return res.status();
                },
                { timeout: 15_000, intervals: [500, 1000, 2000] },
            )
            .toBe(200);
        expect((await getTask(request, token, dependent.id)).status).toBe('done');
    });

    test('approver lifecycle edges: no approve/remove endpoints, duplicate→409, bad actor→400, cross-user→404, add-on-done is non-retroactive', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        const task = await createTaskViaAPI(request, token, { title: `Approver edges ${stamp}` });

        // (a) Invalid actor type → 400. The `AddApproverDto.approverType`
        // field is constrained with `@IsIn(['user', 'agent'])`, so the
        // global ValidationPipe (whitelist + forbidNonWhitelisted) rejects
        // `'robot'` BEFORE the controller's `assertActorType` runs. The
        // resulting body is the class-validator default — an array message
        // "approverType must be one of the following values: user, agent"
        // (not the controller's "Invalid actor type" string). The hardening
        // intent is identical: an unknown actor type is refused with 400.
        const badType = await rawAddApprover(request, token, task.id, {
            approverType: 'robot',
            approverId: u.user.id,
        });
        expect(badType.status()).toBe(400);
        // class-validator returns `message` as a string[]; coerce before matching.
        expect(String((await badType.json()).message)).toMatch(/one of the following values/i);

        // (b) Agent approver pointing at an unknown / non-owned agent → 400
        // "Agent <id> is not reachable for this user — cannot assign."
        const unownedAgent = await rawAddApprover(request, token, task.id, {
            approverType: 'agent',
            approverId: '00000000-0000-0000-0000-000000000000',
        });
        expect(unownedAgent.status()).toBe(400);
        expect((await unownedAgent.json()).message).toMatch(/not reachable for this user/i);

        // (c) First valid add → 201, pending.
        const first = await rawAddApprover(request, token, task.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        expect(first.status()).toBe(201);
        const approverId = (await first.json()).id;
        expect(approverId).toBeTruthy();

        // (d) DUPLICATE add (same task+type+id) → 409 Conflict (uq_task_approver
        // unique-violation, now mapped to a clean 409 instead of an unmapped 500).
        const dup = await rawAddApprover(request, token, task.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        expect(dup.status(), `dup body=${await dup.text().catch(() => '')}`).toBe(409);

        // (e) There is NO approve endpoint and NO remove-approver endpoint —
        // document the real contract so the gate's permanence is explicit.
        // Probe a couple of plausible shapes; all must 404 (route absent).
        const removeById = await request.delete(
            `${API_BASE}/api/tasks/${task.id}/approvers/${approverId}`,
            { headers: authedHeaders(token) },
        );
        expect(removeById.status(), 'remove-approver-by-id route is not implemented').toBe(404);

        // (f) Cross-user isolation — a stranger adding an approver to my task
        // gets a 404 (no existence leak), not a 403.
        const bob = await registerUserViaAPI(request);
        const stranger = await rawAddApprover(request, bob.access_token, task.id, {
            approverType: 'user',
            approverId: bob.user.id,
        });
        expect(stranger.status(), 'cross-user add-approver → 404 not-found').toBe(404);
        expect((await stranger.json()).message).toMatch(/not found/i);

        // (g) Adding an approver to an ALREADY-done task is allowed (201,
        // pending) and is NOT retroactive — the gate is only evaluated at
        // transition time, so a task that already reached `done` (here with the
        // gate vacuously satisfied — zero approvers) stays done.
        const doneTask = await createTaskViaAPI(request, token, {
            title: `Done then appr ${stamp}`,
        });
        for (const to of ['todo', 'in_progress', 'in_review', 'done']) {
            await transitionTaskViaAPI(request, token, doneTask.id, to);
        }
        expect((await getTask(request, token, doneTask.id)).status).toBe('done');
        const lateAdd = await rawAddApprover(request, token, doneTask.id, {
            approverType: 'user',
            approverId: u.user.id,
        });
        expect(lateAdd.status(), 'approver can be attached to a done task').toBe(201);
        expect((await lateAdd.json()).approvalState).toBe('pending');
        // The late approver does NOT retroactively re-open or invalidate `done`.
        expect((await getTask(request, token, doneTask.id)).status).toBe('done');
    });
});
