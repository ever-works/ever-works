import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, transitionTaskViaAPI } from './helpers/agents-tasks';

/**
 * Task full-lattice INTEGRITY edges — the integrity-rule companion to
 * `flow-task-state-machine.spec.ts`.
 *
 * The existing `flow-task-state-machine.spec.ts` already nails the PURE
 * lattice: the 5-hop legal walk + side-effect columns, the illegal-hop 400,
 * the cancelled terminal sink and the controller's unknown-enum guard. What it
 * deliberately does NOT touch — and what this file covers exhaustively — is the
 * second, harder layer that `TaskTransitionService` runs AFTER the lattice
 * guard: the integrity gates (open blockers, approver gate) and the cascading
 * auto-unblock side effects. These are the rules that distinguish "force is an
 * approver-gate override" from "force is a lattice bypass" — the headline of
 * this theme.
 *
 * Server source of truth (PROBED against http://127.0.0.1:3100 before every
 * assertion below):
 *   `packages/agent/src/tasks-domain/task-transition.service.ts`
 *   `apps/api/src/tasks/tasks.controller.ts`
 *   `packages/agent/src/database/repositories/task-side.repositories.ts`
 *
 * GATE ORDERING inside `transition(task, to, { force })`:
 *   1. lattice guard         — `ALLOWED[from].includes(to)` else 400
 *                              "Cannot transition Task from <from> to <to>."
 *   2. blocker gate          — on `→ in_progress` AND `→ done`, if any blocker
 *                              Task is still open (not done/cancelled): 409
 *                              "Task cannot transition to <to> — has N open
 *                              blocker(s)."  `force` does NOT bypass this — a
 *                              blocker is an integrity rule, not policy.
 *   3. approver gate         — on `→ done` only, when requireAllApprovers=true
 *                              and not all approvers are 'approved': 409
 *                              "Task cannot transition to done — not all
 *                              approvers have approved (pass force=true to
 *                              override)."  `force` DOES bypass this — it is
 *                              the one gate force exists to override.
 *
 * SIDE EFFECTS:
 *   - `→ in_progress`        : stamp startedAt (set-once).
 *   - `→ done`               : stamp completedAt.
 *   - `→ blocked`            : stash `from` into previousStatus.
 *   - leaving blocked        : clear previousStatus → null.
 *   - blocker `→ done|cancelled` : cascades — every dependent still in
 *                              `blocked` with no remaining open blockers is
 *                              auto-restored to its stashed previousStatus
 *                              (best-effort, fire-and-forget).
 *   - removeBlocker (DELETE /blocks/:blockId) : re-checks the DEPENDENT — if it
 *                              now has no open blockers it is auto-restored.
 *
 * BLOCKER-ADD guards (POST /api/tasks/:id/blocks):
 *   - self-block             → 400 "Task cannot block itself."
 *   - duplicate (taskId,blockedByTaskId) → 409 "Task <id> is already blocked by <id>."
 *   - unknown blocker id     → 400 "Blocking Task <id> not found."
 *
 * IMPORTANT TRUTHS we verified and rely on:
 *   - cancelled is NOT blocker-gated — a `blocked` task with an open blocker
 *     can still go `→ cancelled` (200); cancel is a terminal escape hatch.
 *   - `addApprover` accepts the OWNER's own userId as a `user` approver (passes
 *     `assertActorIsValid`); the created row is born `approvalState:'pending'`
 *     and there is NO endpoint to flip it to 'approved' — so the only honest
 *     way past a configured-approver `→ done` gate is `force:true`.
 *   - auto-unblock is async fire-and-forget; we poll the dependent's row with
 *     expect.poll rather than asserting synchronously after the blocker hop.
 *
 * All flows use FRESH `registerUserViaAPI` users for cross-spec isolation; per-
 * user slugs reset to `T-1`, side rows are user-scoped.
 */

const T = 20_000;

async function rawTransition(
	request: APIRequestContext,
	token: string,
	taskId: string,
	body: { to: string; force?: boolean } | Record<string, unknown>,
) {
	return request.post(`${API_BASE}/api/tasks/${taskId}/transition`, {
		headers: authedHeaders(token),
		data: body,
		timeout: T,
	});
}

async function getTask(request: APIRequestContext, token: string, taskId: string) {
	const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
		headers: authedHeaders(token),
		timeout: T,
	});
	expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
	return res.json();
}

/** Raw POST so we can inspect the non-2xx body shapes of the block guards. */
async function rawAddBlocker(
	request: APIRequestContext,
	token: string,
	taskId: string,
	blockedByTaskId: string,
) {
	return request.post(`${API_BASE}/api/tasks/${taskId}/blocks`, {
		headers: authedHeaders(token),
		data: { blockedByTaskId },
		timeout: T,
	});
}

/** Add a blocker, asserting the 201 happy path, returning the block row id. */
async function addBlocker(
	request: APIRequestContext,
	token: string,
	taskId: string,
	blockedByTaskId: string,
): Promise<string> {
	const res = await rawAddBlocker(request, token, taskId, blockedByTaskId);
	expect(res.status(), `addBlocker body=${await res.text().catch(() => '')}`).toBe(201);
	const body = await res.json();
	expect(body.id).toBeTruthy();
	return body.id;
}

async function removeBlocker(
	request: APIRequestContext,
	token: string,
	taskId: string,
	blockId: string,
) {
	const res = await request.delete(`${API_BASE}/api/tasks/${taskId}/blocks/${blockId}`, {
		headers: authedHeaders(token),
		timeout: T,
	});
	expect(res.status(), `removeBlocker body=${await res.text().catch(() => '')}`).toBe(200);
	expect((await res.json()).deleted).toBe(true);
}

/** Poll the dependent's status until the async auto-unblock cascade lands. */
async function pollStatus(
	request: APIRequestContext,
	token: string,
	taskId: string,
	expected: string,
) {
	await expect
		.poll(async () => (await getTask(request, token, taskId)).status, {
			timeout: T,
			message: `task ${taskId} never reached ${expected}`,
		})
		.toBe(expected);
}

test.describe('Task full lattice — blocker/approver integrity gates + auto-unblock cascade (API)', () => {
	test('open-blocker gate 409s on →in_progress AND →done, and {force:true} does NOT bypass it (blockers are an integrity rule, not the approver policy)', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const stamp = Date.now().toString(36);

		const dep = await createTaskViaAPI(request, token, { title: `Dep ${stamp}` });
		const blocker = await createTaskViaAPI(request, token, { title: `Blocker ${stamp}` });
		await transitionTaskViaAPI(request, token, dep.id, 'todo');

		// Wire dep ← blocker. The blocker is born `backlog` (open).
		await addBlocker(request, token, dep.id, blocker.id);

		// ── →in_progress is blocker-gated: 409 ConflictException. ──────
		const inProg = await rawTransition(request, token, dep.id, { to: 'in_progress' });
		expect(
			inProg.status(),
			`blocked in_progress body=${await inProg.text().catch(() => '')}`,
		).toBe(409);
		const inProgBody = await inProg.json();
		expect(inProgBody.message).toMatch(/open blocker/i);
		expect(inProgBody.message).toContain('in_progress');
		expect(inProgBody.statusCode).toBe(409);

		// force=true STILL 409 — force overrides the approver gate, never the
		// blocker gate. This is the load-bearing assertion of the theme.
		const inProgForced = await rawTransition(request, token, dep.id, {
			to: 'in_progress',
			force: true,
		});
		expect(
			inProgForced.status(),
			`forced blocked in_progress body=${await inProgForced.text().catch(() => '')}`,
		).toBe(409);
		expect((await inProgForced.json()).message).toMatch(/open blocker/i);

		// Non-mutating: still todo, no startedAt leaked by the rejected hops.
		const afterRejected = await getTask(request, token, dep.id);
		expect(afterRejected.status).toBe('todo');
		expect(afterRejected.startedAt, 'rejected blocker hop did not stamp startedAt').toBeNull();

		// ── The →done blocker gate is the SAME rule. Drive a second task all
		// the way to in_review (legally, before any blocker exists) then add a
		// blocker and prove `→ done` (even with force) is 409 for the BLOCKER
		// reason, not the approver reason. ────────────────────────────────
		const reviewed = await createTaskViaAPI(request, token, { title: `Reviewed ${stamp}` });
		await transitionTaskViaAPI(request, token, reviewed.id, 'todo');
		await transitionTaskViaAPI(request, token, reviewed.id, 'in_progress');
		await transitionTaskViaAPI(request, token, reviewed.id, 'in_review');
		const lateBlocker = await createTaskViaAPI(request, token, {
			title: `Late blocker ${stamp}`,
		});
		await addBlocker(request, token, reviewed.id, lateBlocker.id);

		const doneForced = await rawTransition(request, token, reviewed.id, {
			to: 'done',
			force: true,
		});
		expect(
			doneForced.status(),
			`forced blocked done body=${await doneForced.text().catch(() => '')}`,
		).toBe(409);
		const doneBody = await doneForced.json();
		// The blocker gate runs BEFORE the approver gate, so the message is the
		// blocker one even though force would have satisfied the approver gate.
		expect(doneBody.message).toMatch(/open blocker/i);
		expect(doneBody.message, 'blocker gate precedes approver gate').not.toMatch(
			/approvers have approved/i,
		);
		expect((await getTask(request, token, reviewed.id)).status).toBe('in_review');
	});

	test('approver gate 409s on →done with a pending approver, and {force:true} DOES bypass it (force is the approver-gate override) — completedAt then stamps', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const ownerId = u.user.id;
		const stamp = Date.now().toString(36);

		const task = await createTaskViaAPI(request, token, { title: `Approver gate ${stamp}` });
		// Read the full row (the typed helper `Task` is a narrow subset that
		// omits requireAllApprovers; getTask returns the raw JSON).
		const born = await getTask(request, token, task.id);
		expect(born.requireAllApprovers, 'tasks default requireAllApprovers=true').toBe(true);

		// Attach the owner as a `user` approver — born `approvalState:'pending'`.
		// (There is no endpoint to flip it to 'approved', so this approver stays
		// pending for the life of the test — exactly the gate we want to hit.)
		const addApprover = await request.post(`${API_BASE}/api/tasks/${task.id}/approvers`, {
			headers: authedHeaders(token),
			data: { approverType: 'user', approverId: ownerId },
			timeout: T,
		});
		expect(
			addApprover.status(),
			`addApprover body=${await addApprover.text().catch(() => '')}`,
		).toBe(201);
		const approverRow = await addApprover.json();
		expect(approverRow.approvalState).toBe('pending');

		// Walk legally to in_progress (no blockers, so this is clean).
		await transitionTaskViaAPI(request, token, task.id, 'todo');
		await transitionTaskViaAPI(request, token, task.id, 'in_progress');
		const beforeDone = await getTask(request, token, task.id);
		expect(beforeDone.startedAt, 'startedAt stamped at in_progress').toBeTruthy();
		expect(beforeDone.completedAt, 'no completedAt before done').toBeNull();

		// ── →done WITHOUT force: approver gate 409 (a real ConflictException —
		// NOT the lattice 400; in_progress→done is a LEGAL hop). ───────────
		const denied = await rawTransition(request, token, task.id, { to: 'done' });
		expect(denied.status(), `approver denied body=${await denied.text().catch(() => '')}`).toBe(
			409,
		);
		const deniedBody = await denied.json();
		expect(deniedBody.message).toMatch(/approvers have approved/i);
		expect(deniedBody.message, 'approver gate copy advertises the force override').toMatch(
			/force=true/i,
		);
		expect(deniedBody.statusCode).toBe(409);
		// Gate did not mutate: still in_progress, no completedAt.
		const stillInProg = await getTask(request, token, task.id);
		expect(stillInProg.status).toBe('in_progress');
		expect(stillInProg.completedAt, 'denied done did not stamp completedAt').toBeNull();

		// ── →done WITH force: bypasses the approver gate → 200, completedAt
		// stamps. This is the ONE thing force is for. ──────────────────────
		const forced = await transitionTaskViaAPI(request, token, task.id, 'done', true);
		expect(forced.status).toBe('done');
		const doneRow = await getTask(request, token, task.id);
		expect(doneRow.status).toBe('done');
		expect(doneRow.completedAt, 'forced done stamps completedAt').toBeTruthy();
		// startedAt is set-once: not re-stamped by the forced done.
		expect(doneRow.startedAt).toBe(beforeDone.startedAt);
	});

	test('blocker resolution cascades: a blocked dependent auto-restores to its stashed previousStatus when the blocker transitions to done', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const stamp = Date.now().toString(36);

		const dep = await createTaskViaAPI(request, token, { title: `Cascade dep ${stamp}` });
		const blocker = await createTaskViaAPI(request, token, {
			title: `Cascade blocker ${stamp}`,
		});

		// Drive dep to in_progress FIRST (no blocker yet — clean hop), so the
		// previousStatus stash on `→ blocked` will be `in_progress`. This is the
		// non-trivial restore target (not the default todo).
		await transitionTaskViaAPI(request, token, dep.id, 'todo');
		await transitionTaskViaAPI(request, token, dep.id, 'in_progress');
		const startedSnapshot = (await getTask(request, token, dep.id)).startedAt;
		expect(startedSnapshot).toBeTruthy();

		// Now add the blocker and move dep → blocked. `→ blocked` is NOT gated,
		// so it succeeds even though the blocker is open. It stashes in_progress.
		await addBlocker(request, token, dep.id, blocker.id);
		const blockedRow = await transitionTaskViaAPI(request, token, dep.id, 'blocked');
		expect(blockedRow.status).toBe('blocked');
		const stashed = await getTask(request, token, dep.id);
		expect(stashed.previousStatus, 'blocked stashes the in_progress source status').toBe(
			'in_progress',
		);

		// Resolve the blocker: walk it to done. The transition service fires the
		// best-effort auto-unblock cascade (fire-and-forget), which restores the
		// dependent to its stashed previousStatus (in_progress).
		await transitionTaskViaAPI(request, token, blocker.id, 'todo');
		await transitionTaskViaAPI(request, token, blocker.id, 'in_progress');
		await transitionTaskViaAPI(request, token, blocker.id, 'done');

		// Cascade is async — poll for the restore.
		await pollStatus(request, token, dep.id, 'in_progress');
		const restored = await getTask(request, token, dep.id);
		expect(restored.status).toBe('in_progress');
		expect(restored.previousStatus, 'restore clears the stashed previousStatus').toBeNull();
		// The restore re-enters transition() with restoreTo=in_progress; startedAt
		// is set-once so it must NOT be re-stamped by the auto-restore.
		expect(restored.startedAt, 'auto-restore does not re-stamp set-once startedAt').toBe(
			startedSnapshot,
		);
	});

	test('cancelling a blocker also unblocks dependents, and a multi-blocker dependent only restores once EVERY blocker is resolved', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const stamp = Date.now().toString(36);

		const dep = await createTaskViaAPI(request, token, { title: `Multi dep ${stamp}` });
		const b1 = await createTaskViaAPI(request, token, { title: `Multi b1 ${stamp}` });
		const b2 = await createTaskViaAPI(request, token, { title: `Multi b2 ${stamp}` });

		// dep at todo with TWO open blockers, then blocked (stash = todo).
		await transitionTaskViaAPI(request, token, dep.id, 'todo');
		await addBlocker(request, token, dep.id, b1.id);
		await addBlocker(request, token, dep.id, b2.id);
		await transitionTaskViaAPI(request, token, dep.id, 'blocked');
		expect((await getTask(request, token, dep.id)).previousStatus).toBe('todo');

		// Resolve b1 via the CANCELLED path (cancelled counts as resolved, just
		// like done — `findOpenBlockers` treats done/cancelled blockers as gone).
		// backlog → cancelled is a single legal hop.
		await transitionTaskViaAPI(request, token, b1.id, 'cancelled');

		// dep must STILL be blocked — b2 is open. Give the (async) cascade a beat,
		// then assert it has NOT moved. expect.poll with a short window proves the
		// status holds at 'blocked' rather than racing a premature restore.
		await expect
			.poll(async () => (await getTask(request, token, dep.id)).status, { timeout: 4_000 })
			.toBe('blocked');
		const stillBlocked = await getTask(request, token, dep.id);
		expect(stillBlocked.previousStatus, 'still stashed while one blocker remains').toBe('todo');

		// Resolve the last blocker (b2) — also via cancel. Now zero open blockers
		// → the dependent auto-restores to its stashed previousStatus (todo).
		await transitionTaskViaAPI(request, token, b2.id, 'cancelled');
		await pollStatus(request, token, dep.id, 'todo');
		const restored = await getTask(request, token, dep.id);
		expect(restored.status).toBe('todo');
		expect(restored.previousStatus, 'restore clears previousStatus').toBeNull();
	});

	test('removeBlocker (DELETE /blocks/:id) rechecks the dependent and auto-restores it; cancelled is a non-gated escape hatch out of blocked even with an open blocker', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const stamp = Date.now().toString(36);

		// ── Branch A: removeBlocker triggers the recheck-restore. ─────────
		const dep = await createTaskViaAPI(request, token, { title: `Remove dep ${stamp}` });
		const blocker = await createTaskViaAPI(request, token, {
			title: `Remove blocker ${stamp}`,
		});
		await transitionTaskViaAPI(request, token, dep.id, 'todo');
		const blockId = await addBlocker(request, token, dep.id, blocker.id);
		await transitionTaskViaAPI(request, token, dep.id, 'blocked');
		expect((await getTask(request, token, dep.id)).previousStatus).toBe('todo');

		// Removing the block row (the blocker Task stays open!) rechecks the
		// DEPENDENT: it now has zero open blockers → restored to previousStatus.
		// This is a different code path (`recheckUnblockFor`) from the blocker-
		// resolution cascade (`autoUnblockResolvedTasks`).
		await removeBlocker(request, token, dep.id, blockId);
		await pollStatus(request, token, dep.id, 'todo');
		const restored = await getTask(request, token, dep.id);
		expect(restored.status).toBe('todo');
		expect(restored.previousStatus).toBeNull();
		// The blocker Task itself was never touched — still backlog.
		expect((await getTask(request, token, blocker.id)).status).toBe('backlog');

		// ── Branch B: cancelled escapes a still-blocked task. ─────────────
		// A blocked task with an OPEN blocker cannot go →in_progress/→done (409),
		// but →cancelled is NOT gated — cancel is the terminal escape hatch.
		const stuck = await createTaskViaAPI(request, token, { title: `Stuck ${stamp}` });
		const hardBlocker = await createTaskViaAPI(request, token, {
			title: `Hard blocker ${stamp}`,
		});
		await transitionTaskViaAPI(request, token, stuck.id, 'todo');
		await addBlocker(request, token, stuck.id, hardBlocker.id);
		await transitionTaskViaAPI(request, token, stuck.id, 'blocked');

		// Sanity: in_progress is still blocker-gated 409 from blocked.
		const gated = await rawTransition(request, token, stuck.id, { to: 'in_progress' });
		expect(gated.status()).toBe(409);
		expect((await gated.json()).message).toMatch(/open blocker/i);

		// cancel succeeds (200) despite the open blocker; leaving blocked clears
		// the stashed previousStatus.
		const cancelled = await transitionTaskViaAPI(request, token, stuck.id, 'cancelled');
		expect(cancelled.status).toBe('cancelled');
		const cancelledRow = await getTask(request, token, stuck.id);
		expect(cancelledRow.status).toBe('cancelled');
		expect(cancelledRow.previousStatus, 'leaving blocked clears previousStatus').toBeNull();
	});

	test('blocker-add guards: self-block 400, duplicate (taskId,blockedByTaskId) 409, unknown blocker id 400 — none mutate task state', async ({
		request,
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const stamp = Date.now().toString(36);

		const a = await createTaskViaAPI(request, token, { title: `Guard A ${stamp}` });
		const b = await createTaskViaAPI(request, token, { title: `Guard B ${stamp}` });

		// ── Self-block → 400 "Task cannot block itself." ──────────────────
		const selfBlock = await rawAddBlocker(request, token, a.id, a.id);
		expect(selfBlock.status(), `self-block body=${await selfBlock.text().catch(() => '')}`).toBe(
			400,
		);
		const selfBody = await selfBlock.json();
		expect(selfBody.message).toMatch(/cannot block itself/i);
		expect(selfBody.statusCode).toBe(400);

		// ── First real block A ← B → 201. ────────────────────────────────
		await addBlocker(request, token, a.id, b.id);

		// ── Duplicate (same taskId + blockedByTaskId) → 409. ──────────────
		const dup = await rawAddBlocker(request, token, a.id, b.id);
		expect(dup.status(), `dup-block body=${await dup.text().catch(() => '')}`).toBe(409);
		const dupBody = await dup.json();
		expect(dupBody.message).toMatch(/already blocked by/i);
		expect(dupBody.message).toContain(a.id);
		expect(dupBody.message).toContain(b.id);
		expect(dupBody.statusCode).toBe(409);

		// ── Unknown blocker id (well-formed UUID, no such Task for this user)
		// → 400 "Blocking Task <id> not found." ───────────────────────────
		const ghostId = '00000000-0000-0000-0000-000000000000';
		const ghost = await rawAddBlocker(request, token, a.id, ghostId);
		expect(ghost.status(), `ghost-block body=${await ghost.text().catch(() => '')}`).toBe(400);
		const ghostBody = await ghost.json();
		expect(ghostBody.message).toMatch(/not found/i);
		expect(ghostBody.message).toContain(ghostId);

		// ── A foreign user's Task is invisible: blocking by it is also 400
		// "not found" (no existence leak via 403). ─────────────────────────
		const other = await registerUserViaAPI(request);
		const foreign = await createTaskViaAPI(request, other.access_token, {
			title: `Foreign ${stamp}`,
		});
		const foreignBlock = await rawAddBlocker(request, token, a.id, foreign.id);
		expect(
			foreignBlock.status(),
			`foreign-block body=${await foreignBlock.text().catch(() => '')}`,
		).toBe(400);
		expect((await foreignBlock.json()).message).toMatch(/not found/i);

		// None of the rejected adds changed A's status — still backlog, and it
		// carries exactly the one legitimate open blocker (B). The single open
		// blocker means →in_progress is gated 409 (cross-check of the guards).
		expect((await getTask(request, token, a.id)).status).toBe('backlog');
		await transitionTaskViaAPI(request, token, a.id, 'todo');
		const gated = await rawTransition(request, token, a.id, { to: 'in_progress' });
		expect(gated.status(), 'the one real blocker still gates in_progress').toBe(409);
		expect((await gated.json()).message).toMatch(/has 1 open blocker/i);
	});
});
