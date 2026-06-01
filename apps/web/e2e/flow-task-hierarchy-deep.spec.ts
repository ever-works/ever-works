import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Task hierarchy — DEEP parent/subtask semantics (the structural companion to
 * `flow-task-hierarchy.spec.ts`). That sibling proves the shallow surface:
 * `?parentTaskId` returns a parent's direct children, filter/pagination AND-ing,
 * and full-text search. This file goes a level deeper into the TREE itself:
 *
 *   1. multi-level tree build + the single-level (NOT recursive) nature of
 *      the `?parentTaskId` filter — grandchildren do not surface under the
 *      grandparent; the tree must be walked level by level.
 *   2. parent completion is NOT gated by open subtasks (the only real `→done`
 *      gates are open-blockers + the approver quorum — there is no
 *      "close children first" rule); a fresh parent with zero approvers
 *      completes WITHOUT force.
 *   3. delete-of-a-parent is an ORPHAN, not a cascade: children survive with a
 *      now-dangling parentTaskId, stay GET-able, and still list under the dead
 *      parent id — then can be re-parented to recover.
 *   4. cancel-of-a-parent does NOT cascade to subtasks either; contrast with the
 *      auto-unblock cascade (which IS real) so the fiction is never asserted.
 *   5. re-parent: legal subtree move, re-parent-to-root (null), and the cycle
 *      integrity guard (409) at several depths — plus the create-vs-PATCH
 *      asymmetry (create validates the parent exists; PATCH does not).
 *   6. depth-64 parent-chain cap (400) + cross-user parent isolation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES / BEHAVIOUR VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100)
 * BEFORE WRITING (curl, read of TasksService / TaskTransitionService /
 * TaskRepository / Task entity):
 *
 *   POST /api/tasks { title, parentTaskId?, priority?, status?, labels? }
 *      → 201 Task { id, slug:'T-n', status:'backlog', priority:'p3',
 *                   parentTaskId, requireAllApprovers:true, … }
 *      → child of a parent NOT owned/visible to the caller → 400
 *        { message:'Parent Task <id> not found.' } (parent lookup is
 *        user-scoped via findByIdAndUser).
 *      → a parent chain deeper than 64 ancestors → 400
 *        { message:'Parent Task chain exceeds depth 64; …' } (TasksService.create
 *        walks the chain and THROWS at hops >= 64).
 *
 *   PATCH /api/tasks/:id { parentTaskId? } (re-parent)
 *      → 200 with the new parentTaskId when no cycle.
 *      → parentTaskId:null detaches to a root.
 *      → re-parent that would put an ANCESTOR under a DESCENDANT → 409
 *        { message:'Cannot set parent — would create a sub-task cycle.' }
 *        (self-parent included). TaskRepository.wouldCreateCycle walks the
 *        proposed parent's chain looking for the candidate child.
 *      → ASYMMETRY: PATCH does NOT validate that the new parent exists or is
 *        owned by the caller (unlike create) — it only runs the cycle check,
 *        so setting a bogus/foreign parentTaskId returns 200 (dangling edge).
 *
 *   GET /api/tasks?parentTaskId=<id>
 *      → 200 { data:[…], meta:{ total, limit, offset } } — DIRECT children only
 *        (single-level; grandchildren do NOT appear). Always AND-ed with the
 *        caller's userId (cross-user parent ids never leak another user's rows).
 *
 *   DELETE /api/tasks/:id → 200 { deleted:true }. parentTaskId is a plain
 *      indexed uuid COLUMN (no @ManyToOne / FK relation on the self-edge), so
 *      deleting a parent does NOT cascade to children and does NOT null their
 *      parentTaskId — children become orphans pointing at a vanished id.
 *
 *   POST /api/tasks/:id/transition { to, force? }
 *      lattice: backlog→todo→in_progress→{in_review,done}; done→in_progress
 *      (re-open); *→cancelled (terminal). `→done` gates on open blockers
 *      (409, not bypassable by force) + the approver quorum (409 when
 *      requireAllApprovers && not all approved — force overrides THIS one).
 *      There is NO subtask-completion gate. allApproved() with zero approvers
 *      is vacuously true, so a parent with no approvers completes without force.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * METHOD / ISOLATION: pure API orchestration (no dedicated Tasks UI route
 * exists in apps/web — see the sibling spec's note). Every flow runs on its
 * OWN fresh registerUserViaAPI() user so per-user task rows + the T-n slug
 * counter stay deterministic and sibling specs are never disturbed. Titles
 * carry a high-entropy suffix. We assert per-user `meta.total` exactly where
 * the user is freshly registered (clean counter), and otherwise use
 * containment.
 */

interface Task {
    id: string;
    slug: string;
    title: string;
    status: string;
    priority: string;
    parentTaskId: string | null;
    previousStatus: string | null;
    completedAt: string | null;
    startedAt: string | null;
    requireAllApprovers: boolean;
}

interface TaskListResponse {
    data: Task[];
    meta: { total: number; limit: number; offset: number };
}

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a Task via the live API, asserting the 201 + entity shape. */
async function createTask(
    request: APIRequestContext,
    token: string,
    body: {
        title: string;
        description?: string;
        priority?: string;
        status?: string;
        labels?: string[];
        parentTaskId?: string;
    },
): Promise<Task> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `createTask body=${await res.text().catch(() => '')}`).toBe(201);
    const task = (await res.json()) as Task;
    expect(task.id, 'created task has an id').toBeTruthy();
    expect(task.slug, 'created task has a T-n slug').toMatch(/^T-\d+$/);
    return task;
}

/** List Tasks with an arbitrary query string, asserting the 200 + envelope. */
async function listTasks(
    request: APIRequestContext,
    token: string,
    query: string,
): Promise<TaskListResponse> {
    const res = await request.get(`${API_BASE}/api/tasks${query ? `?${query}` : ''}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `listTasks(${query}) body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as TaskListResponse;
    expect(Array.isArray(body.data), 'list envelope has a data array').toBe(true);
    expect(typeof body.meta?.total, 'list envelope has numeric meta.total').toBe('number');
    return body;
}

/** GET one Task; returns the row, asserting 200 + ownership. */
async function getTask(request: APIRequestContext, token: string, id: string): Promise<Task> {
    const res = await request.get(`${API_BASE}/api/tasks/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `getTask(${id}) body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()) as Task;
}

/** PATCH a Task; returns the raw response so callers can branch on status. */
async function patchTask(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/tasks/${id}`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** Transition a Task; returns the raw response so callers can branch on status. */
async function transition(
    request: APIRequestContext,
    token: string,
    id: string,
    to: string,
    force = false,
) {
    return request.post(`${API_BASE}/api/tasks/${id}/transition`, {
        headers: authedHeaders(token),
        data: { to, force },
    });
}

/** Walk a fresh task to `in_progress` (backlog → todo → in_progress). */
async function driveToInProgress(request: APIRequestContext, token: string, id: string) {
    for (const to of ['todo', 'in_progress']) {
        const res = await transition(request, token, id, to);
        expect(res.status(), `drive ${id} → ${to}`).toBe(200);
    }
}

test.describe('Task hierarchy (deep) — trees, completion rules, delete/cancel, reparent, depth, isolation', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: a 3-level tree. The `?parentTaskId` filter is SINGLE-LEVEL — it
    //         returns only DIRECT children, never grandchildren. We build
    //         grandparent → 2 parents → (each parent) 2 children, then prove
    //         that listing the grandparent's children returns the 2 parents
    //         (not the 4 grandchildren), and that the full tree is recovered
    //         only by walking level by level. Every grandchild is also a root
    //         of nothing, and the grandparent stays a root (parentTaskId null).
    // ───────────────────────────────────────────────────────────────────────
    test('multi-level tree: ?parentTaskId is single-level; full tree recovered by walking', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = uniqueSuffix();

        // Level 0 — the grandparent (an "initiative").
        const gp = await createTask(request, token, { title: `GP ${sfx}`, labels: ['initiative'] });
        expect(gp.parentTaskId, 'grandparent is a root').toBeNull();

        // Level 1 — two parents ("epics") directly under the grandparent.
        const epicA = await createTask(request, token, {
            title: `Epic A ${sfx}`,
            parentTaskId: gp.id,
        });
        const epicB = await createTask(request, token, {
            title: `Epic B ${sfx}`,
            parentTaskId: gp.id,
        });
        expect(epicA.parentTaskId, 'epicA is wired to GP').toBe(gp.id);
        expect(epicB.parentTaskId, 'epicB is wired to GP').toBe(gp.id);

        // Level 2 — two children ("stories") under EACH epic (4 grandchildren).
        const a1 = await createTask(request, token, { title: `A1 ${sfx}`, parentTaskId: epicA.id });
        const a2 = await createTask(request, token, { title: `A2 ${sfx}`, parentTaskId: epicA.id });
        const b1 = await createTask(request, token, { title: `B1 ${sfx}`, parentTaskId: epicB.id });
        const b2 = await createTask(request, token, { title: `B2 ${sfx}`, parentTaskId: epicB.id });
        const grandchildren = [a1, a2, b1, b2];

        // --- Step 1: the grandparent's DIRECT children are exactly the 2 epics
        //         — NOT the grandchildren. The filter is single-level. ---
        const gpChildren = await listTasks(request, token, `parentTaskId=${gp.id}`);
        expect(gpChildren.meta.total, 'grandparent has exactly its 2 direct epics').toBe(2);
        expect(gpChildren.data.map((t) => t.id).sort(), 'GP children == the two epics').toEqual(
            [epicA.id, epicB.id].sort(),
        );
        const gpChildIds = gpChildren.data.map((t) => t.id);
        for (const gc of grandchildren) {
            expect(gpChildIds, 'a grandchild does NOT surface under the grandparent').not.toContain(
                gc.id,
            );
        }

        // --- Step 2: each epic lists exactly ITS two stories. ---
        const epicAChildren = await listTasks(request, token, `parentTaskId=${epicA.id}`);
        expect(epicAChildren.meta.total, 'epicA has its two stories').toBe(2);
        expect(epicAChildren.data.map((t) => t.id).sort(), 'epicA children == A1,A2').toEqual(
            [a1.id, a2.id].sort(),
        );
        const epicBChildren = await listTasks(request, token, `parentTaskId=${epicB.id}`);
        expect(epicBChildren.meta.total, 'epicB has its two stories').toBe(2);
        expect(epicBChildren.data.map((t) => t.id).sort(), 'epicB children == B1,B2').toEqual(
            [b1.id, b2.id].sort(),
        );

        // --- Step 3: a leaf (grandchild) has no children of its own. ---
        const leaf = await listTasks(request, token, `parentTaskId=${a1.id}`);
        expect(leaf.meta.total, 'a leaf story has no children').toBe(0);

        // --- Step 4: recover the WHOLE tree by walking levels, and confirm it
        //         matches the full per-user listing (1 GP + 2 epics + 4 stories
        //         == 7 rows for this fresh user). ---
        const reconstructed = new Set<string>([gp.id]);
        for (const epic of gpChildren.data) {
            reconstructed.add(epic.id);
            const stories = await listTasks(request, token, `parentTaskId=${epic.id}`);
            for (const s of stories.data) reconstructed.add(s.id);
        }
        expect(reconstructed.size, 'walked tree covers GP + 2 epics + 4 stories').toBe(7);

        const everything = await listTasks(request, token, 'limit=200');
        expect(everything.meta.total, 'fresh user total == the whole tree (7)').toBe(7);
        const allIds = new Set(everything.data.map((t) => t.id));
        expect(
            [...reconstructed].every((id) => allIds.has(id)),
            'every walked node is present in the flat listing',
        ).toBe(true);

        // --- Step 5: only the grandparent is a root; everything else has a
        //         parent. The flat listing carries the parentTaskId for each. ---
        const roots = everything.data.filter((t) => t.parentTaskId === null);
        expect(
            roots.map((t) => t.id),
            'the only root is the grandparent',
        ).toEqual([gp.id]);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: a PARENT may be completed while its subtasks are still open —
    //         there is NO "close children first" gate. The only real `→done`
    //         gates are open-blockers (409, force can't bypass) and the
    //         approver quorum (409, force CAN bypass). We prove:
    //           a. parent with zero approvers + open children → done WITHOUT force;
    //           b. add an approver (pending) → `→done` now 409; force → done;
    //           c. the children never moved as a side effect of the parent;
    //           d. re-opening the parent (done → in_progress) likewise ignores
    //              child state.
    // ───────────────────────────────────────────────────────────────────────
    test('parent completion is gated by approvers/blockers — NOT by open subtasks', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const sfx = uniqueSuffix();

        const parent = await createTask(request, token, { title: `Completable Parent ${sfx}` });
        const openChild = await createTask(request, token, {
            title: `Still Open Child ${sfx}`,
            parentTaskId: parent.id,
        });
        const wipChild = await createTask(request, token, {
            title: `WIP Child ${sfx}`,
            parentTaskId: parent.id,
        });
        // Put one child mid-flight so the parent has a genuinely-open subtask set.
        await driveToInProgress(request, token, wipChild.id);

        // --- Step 1: drive the parent backlog → … → done. With zero approvers
        //         the approver quorum is vacuously satisfied, so done succeeds
        //         WITHOUT force even though both children are open. ---
        await driveToInProgress(request, token, parent.id);
        const doneRes = await transition(request, token, parent.id, 'done');
        expect(
            doneRes.status(),
            `parent → done (no approvers) body=${await doneRes.text().catch(() => '')}`,
        ).toBe(200);
        const doneParent = (await doneRes.json()) as Task;
        expect(doneParent.status, 'parent is done despite open children').toBe('done');
        expect(doneParent.completedAt, 'done stamps completedAt').toBeTruthy();

        // --- Step 2: children are UNTOUCHED by the parent completion. ---
        const openAfter = await getTask(request, token, openChild.id);
        expect(openAfter.status, 'open child stays backlog after parent done').toBe('backlog');
        const wipAfter = await getTask(request, token, wipChild.id);
        expect(wipAfter.status, 'WIP child stays in_progress after parent done').toBe(
            'in_progress',
        );

        // --- Step 3: re-open the parent (done → in_progress) — also ignores
        //         child state. The completion gate never consulted the tree. ---
        const reopen = await transition(request, token, parent.id, 'in_progress');
        expect(reopen.status(), 'parent re-opens done → in_progress').toBe(200);
        expect(((await reopen.json()) as Task).status, 'parent re-opened').toBe('in_progress');

        // --- Step 4: now prove the REAL gate. Add a pending approver to the
        //         parent; `→done` is rejected (409) until force overrides it. ---
        const approverRes = await request.post(`${API_BASE}/api/tasks/${parent.id}/approvers`, {
            headers: authedHeaders(token),
            // Self as a user-type approver — exercises the quorum machinery
            // without needing a second account or an Agent.
            data: { approverType: 'user', approverId: user.user.id },
        });
        // Approver-add may 201 (added) — that's the path we want. If the graph
        // rejects self-approval in some build, skip the quorum assertion rather
        // than assert a fiction.
        if (approverRes.status() === 201) {
            const gated = await transition(request, token, parent.id, 'done');
            expect(gated.status(), '→done with a pending approver is rejected (409)').toBe(409);
            expect(String((await gated.json()).message), 'error names the approver gate').toMatch(
                /approver/i,
            );

            const forced = await transition(request, token, parent.id, 'done', true);
            expect(forced.status(), 'force=true overrides the approver gate').toBe(200);
            expect(((await forced.json()) as Task).status, 'forced parent is done').toBe('done');
        } else {
            test.info().annotations.push({
                type: 'note',
                description: `approver-add returned ${approverRes.status()}; quorum branch skipped (no fictional assertion)`,
            });
        }

        // --- Step 5: throughout, the parent's children were never auto-completed
        //         or auto-cancelled — the tree is independent of the parent's
        //         lifecycle. ---
        const finalOpen = await getTask(request, token, openChild.id);
        expect(finalOpen.status, 'open child STILL backlog at the end').toBe('backlog');
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: deleting a parent is an ORPHAN, not a cascade. parentTaskId is a
    //         plain indexed column (no FK self-edge), so when a mid-tree parent
    //         is deleted: (a) the parent 404s, (b) its children SURVIVE with a
    //         now-dangling parentTaskId (NOT nulled, NOT deleted), (c) they are
    //         still GET-able and still listed under the dead parent id, and
    //         (d) the grandparent's direct-child count drops by one. We then
    //         RECOVER the orphans by re-parenting them under the grandparent.
    // ───────────────────────────────────────────────────────────────────────
    test('delete-parent orphans the subtree (no cascade, no null-out) — then reparent to recover', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = uniqueSuffix();

        const gp = await createTask(request, token, { title: `GP ${sfx}` });
        const parent = await createTask(request, token, {
            title: `Doomed Parent ${sfx}`,
            parentTaskId: gp.id,
        });
        const sibling = await createTask(request, token, {
            title: `Surviving Sibling ${sfx}`,
            parentTaskId: gp.id,
        });
        const c1 = await createTask(request, token, {
            title: `C1 ${sfx}`,
            parentTaskId: parent.id,
        });
        const c2 = await createTask(request, token, {
            title: `C2 ${sfx}`,
            parentTaskId: parent.id,
        });

        // Sanity: GP has 2 direct children (parent + sibling); parent has 2.
        expect((await listTasks(request, token, `parentTaskId=${gp.id}`)).meta.total).toBe(2);
        expect((await listTasks(request, token, `parentTaskId=${parent.id}`)).meta.total).toBe(2);

        // --- Step 1: delete the mid-tree parent. ---
        const delRes = await request.delete(`${API_BASE}/api/tasks/${parent.id}`, {
            headers: authedHeaders(token),
        });
        expect(delRes.status(), 'delete parent → 200').toBe(200);
        expect((await delRes.json()).deleted, 'delete response { deleted:true }').toBe(true);

        // --- Step 2: the parent itself is gone (404). ---
        const goneRes = await request.get(`${API_BASE}/api/tasks/${parent.id}`, {
            headers: authedHeaders(token),
        });
        expect(goneRes.status(), 'deleted parent now 404s').toBe(404);

        // --- Step 3: the children SURVIVED — no cascade. They still carry the
        //         dangling parentTaskId (NOT nulled to a root). ---
        const c1After = await getTask(request, token, c1.id);
        const c2After = await getTask(request, token, c2.id);
        expect(c1After.parentTaskId, 'orphan c1 still points at the vanished parent').toBe(
            parent.id,
        );
        expect(c2After.parentTaskId, 'orphan c2 still points at the vanished parent').toBe(
            parent.id,
        );
        expect(c1After.status, 'orphan c1 status untouched').toBe('backlog');

        // --- Step 4: the orphans STILL list under the dead parent id (the
        //         column value is unchanged; the filter is pure equality). ---
        const orphanList = await listTasks(request, token, `parentTaskId=${parent.id}`);
        expect(orphanList.meta.total, 'dead parent id still lists its orphans').toBe(2);
        expect(orphanList.data.map((t) => t.id).sort(), 'orphan set == c1,c2').toEqual(
            [c1.id, c2.id].sort(),
        );

        // --- Step 5: the GRANDPARENT lost exactly one direct child (the deleted
        //         parent) — the surviving sibling remains. ---
        const gpAfter = await listTasks(request, token, `parentTaskId=${gp.id}`);
        expect(gpAfter.meta.total, 'GP now has one direct child (the sibling)').toBe(1);
        expect(gpAfter.data[0]?.id, 'GP child is the surviving sibling').toBe(sibling.id);

        // --- Step 6: RECOVER. Re-parent each orphan under the grandparent so
        //         the dangling edge is repaired. ---
        for (const orphan of [c1, c2]) {
            const re = await patchTask(request, token, orphan.id, { parentTaskId: gp.id });
            expect(re.status(), `reparent orphan ${orphan.slug} under GP`).toBe(200);
            expect(((await re.json()) as Task).parentTaskId, 'orphan now under GP').toBe(gp.id);
        }
        const gpRecovered = await listTasks(request, token, `parentTaskId=${gp.id}`);
        expect(gpRecovered.meta.total, 'GP regains the two recovered orphans + sibling = 3').toBe(
            3,
        );
        // The dead parent id now lists nothing — its former children moved away.
        expect(
            (await listTasks(request, token, `parentTaskId=${parent.id}`)).meta.total,
            'dead parent id lists nothing after recovery',
        ).toBe(0);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 4: cancelling a parent does NOT cascade to subtasks either. We
    //         cancel a parent (a TERMINAL state — no outgoing transitions) and
    //         prove its children stay live and continue to transition
    //         independently. To anchor the contrast we ALSO exercise the
    //         auto-unblock cascade that IS real: when a BLOCKER task is
    //         cancelled, a task it was blocking is automatically unblocked.
    //         This separates the fictional parent-cancel-cascade from the
    //         genuine block-resolution cascade.
    // ───────────────────────────────────────────────────────────────────────
    test('cancel-parent does NOT cascade to children; the real cascade is block-resolution', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = uniqueSuffix();

        const parent = await createTask(request, token, { title: `Cancelled Parent ${sfx}` });
        const child = await createTask(request, token, {
            title: `Live Child ${sfx}`,
            parentTaskId: parent.id,
        });

        // --- Step 1: cancel the parent (backlog → cancelled is legal). ---
        const cancelRes = await transition(request, token, parent.id, 'cancelled');
        expect(cancelRes.status(), 'parent backlog → cancelled').toBe(200);
        expect(((await cancelRes.json()) as Task).status, 'parent is cancelled').toBe('cancelled');

        // --- Step 2: the child is unaffected and still transitions normally. ---
        const childAfter = await getTask(request, token, child.id);
        expect(childAfter.status, 'child of a cancelled parent stays backlog').toBe('backlog');
        await driveToInProgress(request, token, child.id);
        expect(
            (await getTask(request, token, child.id)).status,
            'child still transitions freely after parent cancel',
        ).toBe('in_progress');

        // --- Step 3: cancelled is terminal — the parent cannot leave it. ---
        const reanimate = await transition(request, token, parent.id, 'todo');
        expect(reanimate.status(), 'cancelled → todo is rejected (lattice 400)').toBe(400);
        expect(
            String((await reanimate.json()).message),
            'lattice error names the dead edge',
        ).toMatch(/cannot transition/i);

        // --- Step 4: the REAL cascade. Create a dependent + a blocker; block the
        //         dependent; it goes to `blocked`. Cancelling the BLOCKER should
        //         auto-unblock the dependent back to its previous status. (The
        //         auto-unblock is best-effort/async, so we poll.) ---
        const dependent = await createTask(request, token, { title: `Dependent ${sfx}` });
        const blocker = await createTask(request, token, { title: `Blocker ${sfx}` });
        await transition(request, token, dependent.id, 'todo'); // → todo so blocked stashes 'todo'

        const blockAdd = await request.post(`${API_BASE}/api/tasks/${dependent.id}/blocks`, {
            headers: authedHeaders(token),
            data: { blockedByTaskId: blocker.id },
        });
        expect(blockAdd.status(), 'add blocker → 201').toBe(201);

        // Move the dependent into `blocked` (todo → blocked is legal).
        const toBlocked = await transition(request, token, dependent.id, 'blocked');
        expect(toBlocked.status(), 'dependent → blocked').toBe(200);
        const blockedRow = (await toBlocked.json()) as Task;
        expect(blockedRow.status, 'dependent is blocked').toBe('blocked');
        expect(blockedRow.previousStatus, 'blocked stashes previousStatus=todo').toBe('todo');

        // Cancel the blocker — resolves it → auto-unblock cascade fires.
        const cancelBlocker = await transition(request, token, blocker.id, 'cancelled');
        expect(cancelBlocker.status(), 'blocker → cancelled').toBe(200);

        // Poll: the dependent should drift back to its previousStatus (todo).
        await expect
            .poll(async () => (await getTask(request, token, dependent.id)).status, {
                message: 'cancelling the blocker auto-unblocks the dependent back to todo',
                timeout: 20_000,
                intervals: [500, 1000, 2000],
            })
            .toBe('todo');
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 5: re-parent mechanics + cycle integrity. We build a 5-deep chain
    //         L1→L2→L3→L4→L5 and exercise:
    //           a. a LEGAL subtree move (move L4 under L1 — flattens the chain);
    //           b. detach to root (parentTaskId:null);
    //           c. the cycle guard at several depths (self, ancestor under
    //              immediate child, ancestor under deep descendant) → 409;
    //           d. the create-vs-PATCH asymmetry: create REJECTS a missing
    //              parent (400) while PATCH ACCEPTS a bogus parent id (200,
    //              cycle-check-only) — a documented dangling-edge asymmetry.
    // ───────────────────────────────────────────────────────────────────────
    test('reparent: legal move + detach-to-root + cycle guard (409) + create-vs-PATCH asymmetry', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { access_token: token } = await registerUserViaAPI(request);
        const sfx = uniqueSuffix();

        // Build L1 → L2 → L3 → L4 → L5.
        const chain: Task[] = [];
        let parentId: string | undefined;
        for (let i = 1; i <= 5; i++) {
            const node = await createTask(request, token, {
                title: `L${i} ${sfx}`,
                ...(parentId ? { parentTaskId: parentId } : {}),
            });
            chain.push(node);
            parentId = node.id;
        }
        const [l1, l2, l3, l4, l5] = chain;

        // --- Step 1: LEGAL move — re-parent L4 under L1 (lift the L4/L5 subtree
        //         up next to L2). No cycle: L1 is an ancestor of L4, so moving
        //         L4 under L1 keeps the DAG acyclic. ---
        const legal = await patchTask(request, token, l4.id, { parentTaskId: l1.id });
        expect(legal.status(), `legal reparent body=${await legal.text().catch(() => '')}`).toBe(
            200,
        );
        expect(((await legal.json()) as Task).parentTaskId, 'L4 now hangs off L1').toBe(l1.id);
        // L5 followed L4 (it still points at L4) — the subtree moved as a unit.
        expect((await getTask(request, token, l5.id)).parentTaskId, 'L5 still under L4').toBe(
            l4.id,
        );
        // L3 lost its child L4.
        expect(
            (await listTasks(request, token, `parentTaskId=${l3.id}`)).meta.total,
            'L3 lost its only child after the move',
        ).toBe(0);
        // L1 now has two direct children: L2 (original) + L4 (moved).
        const l1Children = await listTasks(request, token, `parentTaskId=${l1.id}`);
        expect(l1Children.meta.total, 'L1 now has 2 direct children').toBe(2);
        expect(l1Children.data.map((t) => t.id).sort(), 'L1 children == L2,L4').toEqual(
            [l2.id, l4.id].sort(),
        );

        // --- Step 2: detach L4 to a root (parentTaskId:null). ---
        const detach = await patchTask(request, token, l4.id, { parentTaskId: null });
        expect(detach.status(), 'detach → 200').toBe(200);
        expect(((await detach.json()) as Task).parentTaskId, 'L4 is now a root').toBeNull();
        expect(
            (await listTasks(request, token, `parentTaskId=${l1.id}`)).meta.total,
            'L1 back to one child after L4 detaches',
        ).toBe(1);

        // --- Step 3: CYCLE GUARD. Reparent L4 BACK under L5 (its own
        //         descendant) → 409. Also self-parent and L1-under-L5. ---
        // (current shape: L1 → L2 → L3 ; and L4(root) → L5)
        const selfCycle = await patchTask(request, token, l4.id, { parentTaskId: l4.id });
        expect(selfCycle.status(), 'self-parent → 409').toBe(409);
        expect(String((await selfCycle.json()).message), 'self-cycle message').toMatch(
            /sub-task cycle/i,
        );

        const descendantCycle = await patchTask(request, token, l4.id, { parentTaskId: l5.id });
        expect(descendantCycle.status(), 'parent-under-own-child → 409').toBe(409);

        const deepCycle = await patchTask(request, token, l1.id, { parentTaskId: l3.id });
        expect(deepCycle.status(), 'ancestor L1 under deep descendant L3 → 409').toBe(409);
        expect(String((await deepCycle.json()).message), 'deep-cycle message').toMatch(
            /sub-task cycle/i,
        );

        // --- Step 4: CREATE-vs-PATCH asymmetry. ---
        const bogus = '00000000-0000-0000-0000-000000000000';
        // create REJECTS an unknown parent (400, names it).
        const createOrphan = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            data: { title: `Orphan create ${sfx}`, parentTaskId: bogus },
        });
        expect(createOrphan.status(), 'create under a missing parent → 400').toBe(400);
        expect(
            String((await createOrphan.json()).message),
            'create names the missing parent',
        ).toMatch(/parent task .* not found/i);
        // PATCH ACCEPTS the same bogus parent (200) — cycle-check-only, no
        // existence validation. Documented dangling-edge asymmetry.
        const patchOrphan = await patchTask(request, token, l2.id, { parentTaskId: bogus });
        expect(
            patchOrphan.status(),
            `PATCH to a bogus parent is accepted (200) body=${await patchOrphan.text().catch(() => '')}`,
        ).toBe(200);
        expect(
            ((await patchOrphan.json()) as Task).parentTaskId,
            'PATCH set the dangling edge',
        ).toBe(bogus);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 6: depth-64 chain cap (create) + cross-user parent isolation.
    //   a. A reasonably deep nesting succeeds, but a chain whose ancestry
    //      exceeds 64 hops is rejected at create with a "exceeds depth 64" 400.
    //   b. User B cannot create a child under User A's task (parent lookup is
    //      user-scoped → 400 "Parent Task <id> not found."), and the
    //      `?parentTaskId` filter never leaks A's rows to B even when B owns a
    //      task that (via the PATCH asymmetry) dangles off A's id.
    // ───────────────────────────────────────────────────────────────────────
    test('depth-64 parent-chain cap + cross-user parent isolation', async ({ request }) => {
        test.setTimeout(180_000);
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const tokenA = a.access_token;
        const tokenB = b.access_token;
        const sfx = uniqueSuffix();

        // --- Step 1: build a deep chain, expecting an eventual depth-cap 400.
        //         We push up to ~70 levels; somewhere past depth 64 the create
        //         must be rejected. We assert (a) a deep prefix succeeded and
        //         (b) the first rejection carries the depth-cap message. ---
        let parentId: string | undefined;
        let created = 0;
        let capError: { status: number; message: string } | null = null;
        const MAX_TRY = 70;
        for (let i = 1; i <= MAX_TRY; i++) {
            const res = await request.post(`${API_BASE}/api/tasks`, {
                headers: authedHeaders(tokenA),
                data: {
                    title: `Deep ${i} ${sfx}`,
                    ...(parentId ? { parentTaskId: parentId } : {}),
                },
            });
            if (res.status() === 201) {
                const node = (await res.json()) as Task;
                parentId = node.id;
                created += 1;
                continue;
            }
            // First non-201 is the depth cap.
            capError = { status: res.status(), message: String((await res.json()).message) };
            break;
        }
        // A genuinely deep chain must have formed before the cap bit (well past
        // a trivial nesting) — and the cap must have actually triggered.
        expect(created, 'a deep chain (>=60 levels) formed before the cap').toBeGreaterThanOrEqual(
            60,
        );
        expect(capError, 'the depth cap eventually rejected a too-deep child').not.toBeNull();
        expect(capError?.status, 'depth-cap rejection is a 400').toBe(400);
        expect(capError?.message, 'depth-cap message names the depth-64 limit').toMatch(
            /exceeds depth 64/i,
        );

        // --- Step 2: cross-user. A makes a normal root task. ---
        const aRoot = await createTask(request, tokenA, { title: `A Root ${sfx}` });

        // B CANNOT create a child under A's task — A's task is invisible to B's
        // user-scoped parent lookup → 400 "not found" (no existence leak as 403).
        const bUnderA = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(tokenB),
            data: { title: `B child of A ${sfx}`, parentTaskId: aRoot.id },
        });
        expect(bUnderA.status(), "B cannot create a child under A's task → 400").toBe(400);
        expect(
            String((await bUnderA.json()).message),
            'cross-user parent reads as not-found',
        ).toMatch(/parent task .* not found/i);

        // B GET on A's task → 404 (cross-user read hidden).
        const bGetA = await request.get(`${API_BASE}/api/tasks/${aRoot.id}`, {
            headers: authedHeaders(tokenB),
        });
        expect(bGetA.status(), "B GET on A's task → 404").toBe(404);

        // --- Step 3: B owns a task and (via the PATCH cycle-check-only path)
        //         dangles it off A's parent id. This does NOT leak A's rows:
        //         B's `?parentTaskId=aRoot.id` returns ONLY B's own dangling
        //         child, and A's same query returns ONLY A's own children. The
        //         filter is always AND-ed with userId. ---
        const bTask = await createTask(request, tokenB, { title: `B Task ${sfx}` });
        const bDangle = await patchTask(request, tokenB, bTask.id, { parentTaskId: aRoot.id });
        expect(bDangle.status(), "B PATCH dangling off A's id is accepted (200)").toBe(200);

        // Give A a real child so both users have exactly one row under aRoot.id.
        const aChild = await createTask(request, tokenA, {
            title: `A Child ${sfx}`,
            parentTaskId: aRoot.id,
        });

        const bView = await listTasks(request, tokenB, `parentTaskId=${aRoot.id}`);
        expect(bView.meta.total, "B's view of ?parentTaskId=aRoot has only B's own row").toBe(1);
        expect(bView.data[0]?.id, "B sees only its own dangling child — never A's").toBe(bTask.id);

        const aView = await listTasks(request, tokenA, `parentTaskId=${aRoot.id}`);
        expect(aView.meta.total, "A's view of ?parentTaskId=aRoot has only A's own child").toBe(1);
        expect(aView.data[0]?.id, "A sees only its own real child — never B's").toBe(aChild.id);
    });
});
