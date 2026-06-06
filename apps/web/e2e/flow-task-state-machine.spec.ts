import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI, transitionTaskViaAPI } from './helpers/agents-tasks';

/**
 * Task state machine — exhaustive lattice walk + every illegal/terminal edge.
 *
 * This is the deep companion to `task-board-lifecycle.spec.ts`: rather than the
 * 4-hop backlog→todo→in_progress→done smoke, it walks the FULL legal lattice
 * (5 hops, including the in_review stage) and then exercises every guard branch
 * of `TaskTransitionService` — the force-is-not-a-lattice-bypass rule, the
 * blocked stash/recover side effect, the cancelled terminal sink, and the
 * controller-level unknown-enum guard's precedence over the lattice guard.
 *
 * Server-authoritative lattice (`packages/agent/src/tasks-domain/
 * task-transition.service.ts` → ALLOWED):
 *   backlog   → todo, cancelled
 *   todo      → in_progress, blocked, cancelled
 *   in_progress → in_review, blocked, done, cancelled
 *   in_review → in_progress, blocked, done, cancelled
 *   blocked   → todo, in_progress, cancelled   (restores previousStatus)
 *   done      → in_progress (re-open)
 *   cancelled → (terminal — empty target set)
 *
 * Side-effect columns (probed against the live stack before asserting):
 *   - any → in_progress : stamps `startedAt` (only if null).
 *   - any → done        : stamps `completedAt`.
 *   - any → blocked     : stashes the source status into `previousStatus`.
 *   - blocked → *       : clears `previousStatus` back to null.
 *
 * PROBED, TRUTHFUL endpoint behaviour (verified via curl against
 * http://127.0.0.1:3100 before writing any assertion):
 *   - POST /api/tasks { title } → 201, born `status:'backlog'`, slug `T-n`,
 *     `requireAllApprovers:true` by default, startedAt/completedAt/previousStatus null.
 *   - POST /api/tasks/:id/transition { to, force? }
 *       legal hop      → 200, returns the refreshed Task row.
 *       illegal hop    → 400 "Cannot transition Task from <from> to <to>."
 *                        (ConflictException is NOT reached for lattice misses —
 *                         the lattice guard runs first.)
 *       force on illegal → STILL 400 with the same message. `force` only
 *                          overrides the `→ done` approver gate; it is NOT a
 *                          lattice bypass (blockers/cycle are integrity rules).
 *       unknown enum   → 400 with a class-validator constraint message array
 *                        ("to must be one of the following values: …"). This is
 *                        the DTO-level `@IsEnum(TaskStatus)` guard, enforced by
 *                        the global ValidationPipe BEFORE the request reaches the
 *                        service lattice guard, so even from a terminal
 *                        `cancelled` state an unknown enum yields the validation
 *                        message, never "Cannot transition".
 *   - `in_review → done` succeeds WITHOUT force despite requireAllApprovers=true,
 *     because `allApproved()` is vacuously true when zero approvers are attached
 *     (probed: HTTP 200, completedAt set).
 *
 * All flows run on FRESH `registerUserViaAPI` users (cross-spec isolation: the
 * shared in-memory DB must stay clean for sibling specs; per-user task slugs
 * `T-n` reset per user so we never collide). Username length >= 3 is enforced
 * by the helper's generated name.
 */

const TRANSITION_TIMEOUT = 20_000;

/** Raw transition POST so we can inspect non-2xx bodies (the helper asserts < 300). */
async function rawTransition(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: { to: string; force?: boolean } | Record<string, unknown>,
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

/**
 * Normalise a Nest error `message` to a single string. The service-level
 * lattice guard throws `BadRequestException(string)` (→ `message: string`),
 * but the DTO-level `@IsEnum` rejection comes from the global ValidationPipe
 * (→ `message: string[]`, one entry per failed constraint). Joining lets the
 * same regex assertions cover both shapes.
 */
function errorText(message: unknown): string {
    return Array.isArray(message) ? message.join(' | ') : String(message ?? '');
}

test.describe('Task state machine — exhaustive lattice + guard branches (API)', () => {
    test('walks the full legal lattice backlog→todo→in_progress→in_review→done with truthful side-effects after every hop', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        const task = await createTaskViaAPI(request, token, { title: `Full lattice ${stamp}` });
        expect(task.status).toBe('backlog');
        expect(task.slug).toMatch(/^T-\d+$/);

        // Born clean: no started/completed timestamps, no stashed previousStatus.
        const born = await getTask(request, token, task.id);
        expect(born.status).toBe('backlog');
        expect(born.startedAt, 'fresh task has no startedAt').toBeNull();
        expect(born.completedAt, 'fresh task has no completedAt').toBeNull();
        expect(born.previousStatus, 'fresh task has no stashed previousStatus').toBeNull();
        expect(born.requireAllApprovers, 'tasks default to requireAllApprovers=true').toBe(true);

        // ── Hop 1: backlog → todo (no side effects). ───────────────────
        const afterTodo = await transitionTaskViaAPI(request, token, task.id, 'todo');
        expect(afterTodo.status).toBe('todo');
        const todoRow = await getTask(request, token, task.id);
        expect(todoRow.status).toBe('todo');
        expect(todoRow.startedAt, 'todo does not stamp startedAt').toBeNull();
        expect(todoRow.completedAt).toBeNull();

        // ── Hop 2: todo → in_progress (stamps startedAt). ──────────────
        const afterInProgress = await transitionTaskViaAPI(request, token, task.id, 'in_progress');
        expect(afterInProgress.status).toBe('in_progress');
        const inProgressRow = await getTask(request, token, task.id);
        expect(inProgressRow.status).toBe('in_progress');
        expect(inProgressRow.startedAt, 'in_progress stamps startedAt').toBeTruthy();
        expect(inProgressRow.completedAt, 'still no completedAt at in_progress').toBeNull();
        const startedAtSnapshot = inProgressRow.startedAt;

        // ── Hop 3: in_progress → in_review (the stage the smoke skips). ─
        const afterInReview = await transitionTaskViaAPI(request, token, task.id, 'in_review');
        expect(afterInReview.status).toBe('in_review');
        const inReviewRow = await getTask(request, token, task.id);
        expect(inReviewRow.status).toBe('in_review');
        // startedAt is set-once: it must NOT be re-stamped by later hops.
        expect(inReviewRow.startedAt, 'startedAt is preserved across in_review').toBe(
            startedAtSnapshot,
        );
        expect(inReviewRow.completedAt, 'no completedAt until done').toBeNull();

        // ── Hop 4: in_review → done (stamps completedAt). requireAllApprovers
        // is true but zero approvers are attached → allApproved() vacuously
        // true → no force needed (PROBED HTTP 200). ───────────────────────
        const afterDone = await transitionTaskViaAPI(request, token, task.id, 'done');
        expect(afterDone.status).toBe('done');
        const doneRow = await getTask(request, token, task.id);
        expect(doneRow.status).toBe('done');
        expect(doneRow.completedAt, 'done stamps completedAt').toBeTruthy();
        expect(doneRow.startedAt, 'startedAt survives the walk to done').toBe(startedAtSnapshot);

        // ── Hop 5 (the soft re-open path): done → in_progress is the ONLY
        // legal exit from done. startedAt is already set, so it is NOT
        // re-stamped; completedAt is left as-is (only `→ done` writes it). ─
        const afterReopen = await transitionTaskViaAPI(request, token, task.id, 'in_progress');
        expect(afterReopen.status).toBe('in_progress');
        const reopenedRow = await getTask(request, token, task.id);
        expect(reopenedRow.status).toBe('in_progress');
        expect(reopenedRow.startedAt, 'startedAt not re-stamped on re-open').toBe(
            startedAtSnapshot,
        );
    });

    test('illegal hop backlog→done is rejected 400 "cannot transition" — and {force:true} still 400s (force is an approver-gate override, not a lattice bypass)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, {
            title: `Illegal+force ${Date.now().toString(36)}`,
        });
        expect(task.status).toBe('backlog');

        // (a) Plain illegal hop: backlog is NOT adjacent to done in the lattice.
        const plain = await rawTransition(request, token, task.id, { to: 'done' });
        expect(plain.status(), `plain illegal body=${await plain.text().catch(() => '')}`).toBe(
            400,
        );
        const plainBody = await plain.json();
        expect(plainBody.message).toMatch(/cannot transition/i);
        // PROBED exact wording: "Cannot transition Task from backlog to done."
        expect(plainBody.message).toContain('backlog');
        expect(plainBody.message).toContain('done');
        expect(plainBody.statusCode).toBe(400);

        // Non-mutating: still backlog.
        expect((await getTask(request, token, task.id)).status).toBe('backlog');

        // (b) Same hop WITH force:true → STILL 400, same message. `force` only
        // overrides the `→ done` approver gate; the lattice guard runs first
        // and is unconditional. This is the load-bearing assertion of this flow.
        const forced = await rawTransition(request, token, task.id, { to: 'done', force: true });
        expect(forced.status(), `forced illegal body=${await forced.text().catch(() => '')}`).toBe(
            400,
        );
        const forcedBody = await forced.json();
        expect(forcedBody.message).toMatch(/cannot transition/i);
        expect(forcedBody.message).toContain('backlog');
        expect(forcedBody.message).toContain('done');

        // The forced attempt also changed nothing — task is still backlog,
        // with no leaked startedAt/completedAt side effects.
        const after = await getTask(request, token, task.id);
        expect(after.status).toBe('backlog');
        expect(after.startedAt, 'rejected force did not stamp startedAt').toBeNull();
        expect(after.completedAt, 'rejected force did not stamp completedAt').toBeNull();
    });

    test('blocked stash/recover + cancelled terminal sink + unknown-enum guard precedence', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now().toString(36);

        // ── Branch 1: todo → blocked → todo recovery. ─────────────────
        const t1 = await createTaskViaAPI(request, token, { title: `Blocked branch ${stamp}` });
        await transitionTaskViaAPI(request, token, t1.id, 'todo');

        // todo → blocked stashes the source status into previousStatus.
        const afterBlocked = await transitionTaskViaAPI(request, token, t1.id, 'blocked');
        expect(afterBlocked.status).toBe('blocked');
        const blockedRow = await getTask(request, token, t1.id);
        expect(blockedRow.status).toBe('blocked');
        expect(blockedRow.previousStatus, 'blocked stashes the prior status').toBe('todo');

        // blocked → todo recovery clears previousStatus back to null.
        const afterRecover = await transitionTaskViaAPI(request, token, t1.id, 'todo');
        expect(afterRecover.status).toBe('todo');
        const recoveredRow = await getTask(request, token, t1.id);
        expect(recoveredRow.status).toBe('todo');
        expect(recoveredRow.previousStatus, 'leaving blocked clears previousStatus').toBeNull();

        // ── Branch 2: cancelled is a terminal sink. ───────────────────
        const t2 = await createTaskViaAPI(request, token, { title: `Cancelled branch ${stamp}` });
        await transitionTaskViaAPI(request, token, t2.id, 'todo');
        const afterCancel = await transitionTaskViaAPI(request, token, t2.id, 'cancelled');
        expect(afterCancel.status).toBe('cancelled');
        expect((await getTask(request, token, t2.id)).status).toBe('cancelled');

        // Every legal-looking forward move out of cancelled is rejected 400 —
        // the cancelled adjacency set is empty.
        for (const dest of ['todo', 'in_progress', 'done', 'cancelled', 'backlog']) {
            const res = await rawTransition(request, token, t2.id, { to: dest });
            expect(
                res.status(),
                `cancelled→${dest} should be 400, body=${await res.text().catch(() => '')}`,
            ).toBe(400);
            const body = await res.json();
            expect(body.message, `cancelled→${dest} message`).toMatch(/cannot transition/i);
            expect(body.message).toContain('cancelled');
        }
        // force does not resurrect a cancelled task either.
        const forcedOutOfCancel = await rawTransition(request, token, t2.id, {
            to: 'in_progress',
            force: true,
        });
        expect(forcedOutOfCancel.status()).toBe(400);
        expect((await forcedOutOfCancel.json()).message).toMatch(/cannot transition/i);
        // Still cancelled after all the rejected attempts.
        expect((await getTask(request, token, t2.id)).status).toBe('cancelled');

        // ── Branch 3: unknown status enum → 400, rejected by the DTO-level
        // `@IsEnum(TaskStatus)` guard. This validation fires in the global
        // ValidationPipe BEFORE the request ever reaches the service lattice
        // guard, so an invalid enum NEVER produces the "cannot transition"
        // lattice message — the load-bearing precedence assertion of this
        // branch. The ValidationPipe emits a `message` ARRAY listing the
        // failed constraint(s) ("to must be one of the following values: …"),
        // distinct from the service guard's plain-string message. Prove the
        // precedence on a fresh task (from backlog) AND on the terminal
        // cancelled task: in both cases the enum-validation message wins.
        // (PROBED against the live stack: HTTP 400, body.message is a
        // string[] of class-validator constraint messages.) ───────────────
        const t3 = await createTaskViaAPI(request, token, { title: `Bad enum ${stamp}` });
        const unknownFromBacklog = await rawTransition(request, token, t3.id, {
            to: 'frobnicate',
        });
        expect(unknownFromBacklog.status()).toBe(400);
        const unkBody = await unknownFromBacklog.json();
        // PROBED wording: "to must be one of the following values: …".
        expect(errorText(unkBody.message)).toMatch(/must be one of the following values/i);
        expect(
            errorText(unkBody.message),
            'enum validation fires before the lattice guard',
        ).not.toMatch(/cannot transition/i);

        // Same precedence even from the terminal cancelled state (where a
        // VALID enum would have produced the lattice "cannot transition").
        const unknownFromCancelled = await rawTransition(request, token, t2.id, { to: 'bogus' });
        expect(unknownFromCancelled.status()).toBe(400);
        const unkCancelBody = await unknownFromCancelled.json();
        expect(errorText(unkCancelBody.message)).toMatch(/must be one of the following values/i);
        expect(
            errorText(unkCancelBody.message),
            'enum validation precedes the lattice guard even on terminal tasks',
        ).not.toMatch(/cannot transition/i);

        // A missing `to` (empty body) is an `undefined` enum value, caught by
        // the same DTO-level `@IsEnum` constraint as an unknown string.
        const missingTo = await rawTransition(request, token, t3.id, {});
        expect(missingTo.status()).toBe(400);
        expect(errorText((await missingTo.json()).message)).toMatch(
            /must be one of the following values/i,
        );

        // t3 was never legally moved — still backlog after all bad-input attempts.
        expect((await getTask(request, token, t3.id)).status).toBe('backlog');
    });
});
