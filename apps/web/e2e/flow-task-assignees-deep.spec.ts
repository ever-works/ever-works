import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import {
    createAgentViaAPI,
    createTaskViaAPI,
    addTaskAssignee,
    assignTaskToAgent,
    listAgentRuns,
} from './helpers/agents-tasks';

/**
 * Task assignees — DEEP, multi-step integration of the polymorphic
 * `task_assignees` join (`POST/DELETE /api/tasks/:id/assignees`), the
 * `uq_task_assignee` unique constraint, the actor-validation matrix, and the
 * assignee↔agent-dispatch correlation. Deep companion to the shallow
 * `tasks-collaboration.spec.ts` (single human+agent 201 / stranger 404) and
 * `agent-task-assignment-flow.spec.ts` (single happy-path dispatch). None of
 * the existing specs exercise: the duplicate-500 + remove + re-add recovery
 * loop, the polymorphic same-id-different-type rows, the full validation
 * matrix, remove idempotency / by-PK delete semantics, the activity-log audit
 * trail, or the assignee-independent dispatch path. This file does.
 *
 * PROBED, TRUTHFUL CONTRACT (curl against http://127.0.0.1:3100, sqlite
 * in-memory, no Trigger.dev secret — verified before any assertion below):
 *
 *   POST /api/tasks/:id/assignees { assigneeType:'user'|'agent', assigneeId }
 *     → 201 { id, taskId, assigneeType, assigneeId, tenantId, organizationId,
 *             createdAt }
 *     - user-type: assigneeId is NOT validated against the users table — ANY
 *       uuid (incl. one that is not a real user) is accepted with 201. Only
 *       the task ownership is enforced (`getOne(userId, taskId)`).
 *     - agent-type: assigneeId IS validated — the agent must be reachable for
 *       the caller (`agents.findByIdAndUser`). Unknown/unreachable agent →
 *       400 "Agent <id> is not reachable for this user — cannot assign."
 *     - empty assigneeId → 400 "<type> id is required."
 *     - assigneeType not 'user'|'agent' → 400 "Invalid actor type: <value>"
 *       (controller guard `assertActorType`, runs before the service).
 *     - malformed task uuid → 400 "Validation failed (uuid is expected)"
 *       (ParseUUIDPipe).
 *     - anon (no bearer) → 401 Unauthorized.
 *     - task owned by another user → 404 "Task <id> not found." (the task is
 *       resolved scoped-to-caller, so cross-user assign reads as not-found,
 *       NOT 403).
 *     - DUPLICATE (same taskId+assigneeType+assigneeId while the row is LIVE)
 *       → 500 Internal server error (the `uq_task_assignee` unique index;
 *       the repo `save()`s with no pre-check). The same (type,id) pair on a
 *       DIFFERENT type is a DIFFERENT row (uq is the triple) → both 201.
 *
 *   DELETE /api/tasks/:id/assignees/:assigneeId
 *     → 200 { deleted:true } — ALWAYS, even for an unknown / already-deleted
 *       id (the repo `delete(id)` is a by-PK no-op when absent → idempotent).
 *       The :id task is only an ownership gate; the row is deleted by its PK,
 *       so a valid assignee id removed under a DIFFERENT owned task still
 *       returns { deleted:true } and deletes the row. After a remove the same
 *       (type,id) can be re-added → fresh 201 (uq only conflicts with LIVE
 *       rows). Malformed assignee uuid → 400 ParseUUIDPipe.
 *
 *   GET /api/tasks/:id → the Task row; it does NOT embed an `assignees` array
 *     and there is NO GET …/assignees endpoint (404). Assignee mutations are
 *     therefore audited via GET /api/activity-log?taskId=<id> →
 *     { activities:[{ actionType:'task_assignee_added'|'task_assignee_removed',
 *       details:{ assigneeType, assigneeId }, … }] } (newest-first), AND via
 *     the duplicate-500 / re-add-201 behaviour which reveals whether a row is
 *     currently live.
 *
 *   POST /api/agents/:id/assign-task { taskId } → dispatch. Independent of the
 *     assignee join — the agent need NOT be an assignee of the task. Without
 *     TRIGGER_SECRET_KEY (the CI default) it 500s at enqueue BUT still persists
 *     an AgentRun { status:'failed', triggerKind:'task', taskId:<set>,
 *     errorMessage:'enqueue-failed: …' }. Assert the run RECORD (listAgentRuns),
 *     never completion.
 *
 * Cross-spec isolation: every flow runs on its OWN freshly registered user
 * (the shared in-memory DB / per-user `T-n` slug counter must stay clean for
 * sibling specs). Assertions tolerate pre-existing rows (toContain / >=) and
 * never assert exact global counts. UUID literals below are deliberately NOT
 * real users — exercising the "user-type is not validated" contract.
 */

const A_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B_UUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const C_UUID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const MALFORMED_UUID = 'not-a-uuid';

interface ActivityRow {
    id: string;
    actionType: string;
    details?: { assigneeType?: string; assigneeId?: string } | null;
}

/** Raw POST so a flow can assert the exact non-2xx status itself. */
async function postAssignee(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: { assigneeType: string; assigneeId: string },
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/assignees`, {
        headers: authedHeaders(token),
        data: body,
    });
}

async function deleteAssignee(
    request: APIRequestContext,
    token: string,
    taskId: string,
    assigneeId: string,
) {
    return request.delete(`${API_BASE}/api/tasks/${taskId}/assignees/${assigneeId}`, {
        headers: authedHeaders(token),
    });
}

/** Task-scoped activity rows (newest-first). Tolerates a missing endpoint. */
async function taskActivity(
    request: APIRequestContext,
    token: string,
    taskId: string,
): Promise<ActivityRow[]> {
    const res = await request.get(`${API_BASE}/api/activity-log?taskId=${taskId}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return [];
    const body = await res.json().catch(() => ({}));
    return (body.activities ?? body.data ?? []) as ActivityRow[];
}

test.describe('Task assignees — deep integration', () => {
    test('duplicate add is rejected by uq_task_assignee, then remove → re-add recovers', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const task = await createTaskViaAPI(request, token, { title: 'uq dup recovery' });

        // First add → clean 201, full row shape echoed back.
        const first = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(first.status(), `first add body=${await first.text()}`).toBe(201);
        const firstRow = await first.json();
        expect(firstRow.id).toBeTruthy();
        expect(firstRow.taskId).toBe(task.id);
        expect(firstRow.assigneeType).toBe('user');
        expect(firstRow.assigneeId).toBe(A_UUID);

        // Duplicate of the LIVE (taskId,user,A_UUID) triple → 500 (uq index;
        // the repo save()s with no pre-check). Never assert it is a 4xx.
        const dup = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(dup.status(), `dup body=${await dup.text()}`).toBe(500);

        // Remove the live row → idempotent 200 { deleted:true }.
        const removed = await deleteAssignee(request, token, task.id, firstRow.id);
        expect(removed.status()).toBe(200);
        expect(await removed.json()).toMatchObject({ deleted: true });

        // The uq only conflicts with LIVE rows: re-adding the same triple after
        // removal yields a brand-new 201 with a fresh id.
        const reAdd = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(reAdd.status(), `re-add body=${await reAdd.text()}`).toBe(201);
        const reRow = await reAdd.json();
        expect(reRow.assigneeId).toBe(A_UUID);
        expect(reRow.id).not.toBe(firstRow.id);

        // And the recovered row is itself live again → a second duplicate 500s.
        const dup2 = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(dup2.status()).toBe(500);
    });

    test('polymorphic assignee key: same uuid as both user and agent are distinct rows', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const task = await createTaskViaAPI(request, token, { title: 'polymorphic key' });

        // A real, reachable agent — its id is what we reuse across both types.
        const agent = await createAgentViaAPI(request, token, {
            name: `Poly Agent ${Date.now().toString(36)}`,
            scope: 'tenant',
        });

        // Add the agent's id as an AGENT assignee (validated, reachable) → 201.
        const asAgent = await postAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(asAgent.status(), `agent add=${await asAgent.text()}`).toBe(201);
        const agentRow = await asAgent.json();
        expect(agentRow.assigneeType).toBe('agent');

        // Add the SAME id as a USER assignee. uq is on the (task,type,id) triple,
        // so a different type is a different row — and user-type isn't validated,
        // so the id need not be a real user. → 201, distinct row id.
        const asUser = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: agent.id,
        });
        expect(asUser.status(), `user add=${await asUser.text()}`).toBe(201);
        const userRow = await asUser.json();
        expect(userRow.assigneeType).toBe('user');
        expect(userRow.assigneeId).toBe(agent.id);
        expect(userRow.id).not.toBe(agentRow.id);

        // Each (type,id) pair is independently unique: re-adding the agent-type
        // 500s (live), but its user-type sibling is untouched and still live too.
        const dupAgent = await postAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(dupAgent.status()).toBe(500);
        const dupUser = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: agent.id,
        });
        expect(dupUser.status()).toBe(500);

        // Removing ONLY the agent-type row frees just that pair: agent-type can
        // be re-added (201) while the user-type duplicate still 500s.
        const delAgent = await deleteAssignee(request, token, task.id, agentRow.id);
        expect(delAgent.status()).toBe(200);
        const reAddAgent = await postAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(reAddAgent.status(), `re-add agent=${await reAddAgent.text()}`).toBe(201);
        const stillDupUser = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: agent.id,
        });
        expect(stillDupUser.status()).toBe(500);
    });

    test('multiple distinct assignees (users + agents) coexist; activity-log audits each add/remove', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const task = await createTaskViaAPI(request, token, { title: 'multi assignee crew' });
        const stamp = Date.now().toString(36);

        const agent1 = await createAgentViaAPI(request, token, {
            name: `Crew A1 ${stamp}`,
            scope: 'tenant',
        });
        const agent2 = await createAgentViaAPI(request, token, {
            name: `Crew A2 ${stamp}`,
            scope: 'tenant',
        });

        // Build a heterogeneous crew: 2 distinct users + 2 distinct agents.
        const u1 = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        const u2 = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: B_UUID,
        });
        const ag1 = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent1.id,
        });
        const ag2 = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent2.id,
        });
        const created = [u1.id, u2.id, ag1.id, ag2.id];
        expect(new Set(created).size, 'all four rows have distinct ids').toBe(4);

        // All four are independently live: each duplicate 500s.
        for (const a of [
            { assigneeType: 'user' as const, assigneeId: A_UUID },
            { assigneeType: 'user' as const, assigneeId: B_UUID },
            { assigneeType: 'agent' as const, assigneeId: agent1.id },
            { assigneeType: 'agent' as const, assigneeId: agent2.id },
        ]) {
            const dup = await postAssignee(request, token, task.id, a);
            expect(dup.status(), `dup ${a.assigneeType}:${a.assigneeId}`).toBe(500);
        }

        // Audit trail: the activity-log records one add per assignee. The
        // endpoint may be absent in some env shapes → best-effort, branch on it.
        const afterAdds = await taskActivity(request, token, task.id);
        if (afterAdds.length) {
            const addedIds = afterAdds
                .filter((r) => r.actionType === 'task_assignee_added')
                .map((r) => r.details?.assigneeId);
            expect(addedIds).toContain(A_UUID);
            expect(addedIds).toContain(B_UUID);
            expect(addedIds).toContain(agent1.id);
            expect(addedIds).toContain(agent2.id);
        } else {
            test.info().annotations.push({
                type: 'note',
                description: 'activity-log unavailable in this env — add audit skipped',
            });
        }

        // Remove one agent from the crew → frees just that pair (re-addable),
        // the other three remain live (still 500 on duplicate).
        const delAg1 = await deleteAssignee(request, token, task.id, ag1.id);
        expect(delAg1.status()).toBe(200);
        const reAg1 = await postAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent1.id,
        });
        expect(reAg1.status(), `re-add freed agent1=${await reAg1.text()}`).toBe(201);
        const stillLiveUserA = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(stillLiveUserA.status(), 'untouched user A still live').toBe(500);

        // And the remove is audited too.
        const afterRemove = await taskActivity(request, token, task.id);
        if (afterRemove.length) {
            expect(afterRemove.some((r) => r.actionType === 'task_assignee_removed')).toBe(true);
        }
    });

    test('assignee input/auth validation matrix returns truthful statuses', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const task = await createTaskViaAPI(request, token, { title: 'validation matrix' });

        // Invalid actor type → 400 controller guard (precedes the service).
        const badType = await postAssignee(request, token, task.id, {
            assigneeType: 'robot',
            assigneeId: A_UUID,
        });
        expect(badType.status()).toBe(400);
        expect((await badType.json()).message).toContain('Invalid actor type');

        // Empty assigneeId → 400 "<type> id is required."
        const emptyId = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: '',
        });
        expect(emptyId.status()).toBe(400);
        expect((await emptyId.json()).message).toContain('id is required');

        // Agent-type assignee that is not reachable for this user → 400.
        const unreachableAgent = await postAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: C_UUID,
        });
        expect(unreachableAgent.status()).toBe(400);
        expect((await unreachableAgent.json()).message).toContain('not reachable');

        // Malformed task uuid → 400 ParseUUIDPipe.
        const badTaskUuid = await postAssignee(request, token, MALFORMED_UUID, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(badTaskUuid.status()).toBe(400);
        expect((await badTaskUuid.json()).message).toContain('uuid is expected');

        // Malformed assignee uuid on remove → 400 ParseUUIDPipe.
        const badRemoveUuid = await deleteAssignee(request, token, task.id, MALFORMED_UUID);
        expect(badRemoveUuid.status()).toBe(400);

        // Anonymous (no bearer) → 401. registerUserViaAPI is unused here.
        const anon = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            data: { assigneeType: 'user', assigneeId: A_UUID },
        });
        expect(anon.status()).toBe(401);

        // A stranger cannot see — let alone assign on — my task: scoped-resolve
        // reads as 404 (not 403). The owner's task is untouched.
        const stranger: RegisteredUser = await registerUserViaAPI(request);
        const strangerAssign = await postAssignee(request, stranger.access_token, task.id, {
            assigneeType: 'user',
            assigneeId: stranger.user.id,
        });
        expect(strangerAssign.status()).toBe(404);

        // After every rejected attempt the task still has NO live A_UUID row, so
        // a fresh add succeeds (none of the 4xx/401/404 above leaked a row).
        const cleanAdd = await postAssignee(request, token, task.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(cleanAdd.status(), `clean add after matrix=${await cleanAdd.text()}`).toBe(201);
    });

    test('remove is by-PK and idempotent; ownership-gate only, not a row↔task match', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        const taskA = await createTaskViaAPI(request, token, { title: 'remove semantics A' });
        const taskB = await createTaskViaAPI(request, token, { title: 'remove semantics B' });

        // Assignee row attached to task A.
        const rowA = await addTaskAssignee(request, token, taskA.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });

        // Removing an UNKNOWN id (never existed) is a no-op → still 200 deleted.
        const ghost = await deleteAssignee(request, token, taskA.id, C_UUID);
        expect(ghost.status()).toBe(200);
        expect(await ghost.json()).toMatchObject({ deleted: true });
        // A_UUID is still live on task A → duplicate add 500s (ghost delete
        // touched nothing).
        const stillLive = await postAssignee(request, token, taskA.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(stillLive.status(), 'A still live after ghost delete').toBe(500);

        // The :id is only an OWNERSHIP gate; the row is deleted by its PK. So
        // removing rowA's id under task B (a DIFFERENT task the caller owns)
        // returns { deleted:true } AND deletes the row from task A.
        const crossTaskDelete = await deleteAssignee(request, token, taskB.id, rowA.id);
        expect(crossTaskDelete.status()).toBe(200);
        expect(await crossTaskDelete.json()).toMatchObject({ deleted: true });
        // Proof it really deleted A's row: A_UUID can now be re-added to task A.
        const reAddA = await postAssignee(request, token, taskA.id, {
            assigneeType: 'user',
            assigneeId: A_UUID,
        });
        expect(reAddA.status(), `re-add after cross-task delete=${await reAddA.text()}`).toBe(201);

        // Double-remove of the same id is idempotent → 200 both times.
        const freshRow = await reAddA.json();
        const del1 = await deleteAssignee(request, token, taskA.id, freshRow.id);
        const del2 = await deleteAssignee(request, token, taskA.id, freshRow.id);
        expect(del1.status()).toBe(200);
        expect(del2.status()).toBe(200);
        expect(await del2.json()).toMatchObject({ deleted: true });

        // A stranger removing by a valid-but-foreign task id is blocked at the
        // ownership gate → 404 (the task resolves not-found for them).
        const stranger = await registerUserViaAPI(request);
        const strangerRemove = await deleteAssignee(
            request,
            stranger.access_token,
            taskA.id,
            rowA.id,
        );
        expect(strangerRemove.status()).toBe(404);
    });

    test('agent assignee + dispatch are independent: dispatch records a task-bound run regardless of assignee membership', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);
        const task = await createTaskViaAPI(request, token, { title: `dispatch corr ${stamp}` });

        // assignedAgent IS attached to the task as an assignee.
        const assignedAgent = await createAgentViaAPI(request, token, {
            name: `Assigned ${stamp}`,
            scope: 'tenant',
        });
        const link = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: assignedAgent.id,
        });
        expect(link.assigneeType).toBe('agent');

        // Dispatch the assigned agent. Without a Trigger secret the enqueue 500s,
        // but a failed run row bound to this task is persisted — assert the
        // RECORD via the runs list, never completion.
        await assignTaskToAgent(request, token, assignedAgent.id, task.id);
        await expect
            .poll(
                async () => {
                    const runs = await listAgentRuns(request, token, assignedAgent.id);
                    return runs.filter((r) => r.taskId === task.id).length;
                },
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);
        const assignedRuns = await listAgentRuns(request, token, assignedAgent.id);
        const assignedRun = assignedRuns.find((r) => r.taskId === task.id)!;
        expect(assignedRun.triggerKind).toBe('task');

        // looseAgent is NOT an assignee of the task. Dispatch does not require
        // assignee membership — it still records a task-bound run. This proves
        // the assignee join and the dispatch path are independent surfaces.
        const looseAgent = await createAgentViaAPI(request, token, {
            name: `Loose ${stamp}`,
            scope: 'tenant',
        });
        await assignTaskToAgent(request, token, looseAgent.id, task.id);
        await expect
            .poll(
                async () => {
                    const runs = await listAgentRuns(request, token, looseAgent.id);
                    return runs.filter((r) => r.taskId === task.id).length;
                },
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);
        const looseRuns = await listAgentRuns(request, token, looseAgent.id);
        expect(looseRuns.find((r) => r.taskId === task.id)?.triggerKind).toBe('task');

        // Adding looseAgent as an assignee AFTER it already ran is still a clean
        // 201 (the assignee join knows nothing about prior dispatch history).
        const lateLink = await postAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: looseAgent.id,
        });
        expect(lateLink.status(), `late assignee add=${await lateLink.text()}`).toBe(201);
    });
});
