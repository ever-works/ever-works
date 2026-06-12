import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import {
    createAgentViaAPI,
    createTaskViaAPI,
    addTaskAssignee,
    assignTaskToAgent,
} from './helpers/agents-tasks';

/**
 * Agent task runs + history — multi-step API orchestration of the FU-2 runtime
 * surface on `AgentsController` (`apps/api/src/agents/agents.controller.ts`).
 *
 * Probed live against the e2e stack (sqlite in-memory, no Trigger.dev secret):
 *   - POST /api/agents/:id/assign-task → 202 { runId } when enqueue succeeds.
 *     WITHOUT a TRIGGER_SECRET_KEY (the CI/e2e default) the HTTP call 500s with
 *     "assign-task enqueue failed: You need to set the TRIGGER_SECRET_KEY …",
 *     BUT a row is still persisted: the controller `createQueued()`s an AgentRun,
 *     the enqueue throws, and the catch block `markFailed()`s it. So the run lands
 *     as { status:'failed', triggerKind:'task', taskId:<set>, errorMessage:'enqueue-failed: …' }.
 *     Re-dispatching the SAME (taskId, agentId) is NOT deduped against a *failed*
 *     run (only queued/running runs are "in flight"), so each assign-task call
 *     adds exactly one new run row.
 *   - GET /api/agents/:id/runs → { data:[…newest-first], meta:{ total, limit, offset } }.
 *     Default limit 25 / offset 0. Each run: { id, status, triggerKind, startedAt,
 *     finishedAt, durationMs, summary, errorMessage, taskId, createdAt }.
 *   - GET /api/agents/:id/budget → { currentSpendCents:0, capCents:null, periodStart,
 *     periodEnd, currency:'USD' } — a rolling-30-day window; failed runs never spend.
 *   - POST /api/tasks/:id/assignees → 201 { id, taskId, assigneeType, assigneeId,
 *     tenantId, organizationId, createdAt }. There is NO GET …/assignees endpoint
 *     (it 404s), so the assignee row is verified via the 201 create response.
 *
 * These are API-only orchestration flows, so each test runs on its OWN freshly
 * registered user (cross-spec isolation: never mutate the shared seeded user from
 * API-only specs). Assertions tolerate pre-existing rows via toContain / >= and
 * never assert exact global counts beyond rows we created on a brand-new agent.
 */

/**
 * Full FU-2 run row shape returned by `GET /api/agents/:id/runs` (richer than
 * the helper's narrow `AgentRun` interface — the live response also carries
 * `createdAt`, `startedAt`, etc., per the controller's `listRuns` mapper).
 */
interface RunRow {
    id: string;
    status: string;
    triggerKind: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    summary: string | null;
    errorMessage: string | null;
    taskId: string | null;
    createdAt: string;
}

const RUN_FIELDS: ReadonlyArray<keyof RunRow> = [
    'id',
    'status',
    'triggerKind',
    'startedAt',
    'finishedAt',
    'durationMs',
    'summary',
    'errorMessage',
    'taskId',
    'createdAt',
];

interface RunsPage {
    data: RunRow[];
    meta: { total: number; limit: number; offset: number };
}

/** Raw runs page (keeps `meta` so we can assert the pagination envelope shape). */
async function getRunsPage(
    request: APIRequestContext,
    token: string,
    agentId: string,
    query: { limit?: number; offset?: number } = {},
): Promise<RunsPage> {
    const params = new URLSearchParams();
    if (query.limit != null) params.set('limit', String(query.limit));
    if (query.offset != null) params.set('offset', String(query.offset));
    const qs = params.toString();
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs${qs ? `?${qs}` : ''}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `runs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getAgentBudget(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<{
    currentSpendCents: number;
    capCents: number | null;
    periodStart: string;
    periodEnd: string;
    currency: string;
}> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/budget`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `budget body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Agent task runs + history', () => {
    let user: RegisteredUser;
    let token: string;

    test.beforeEach(async ({ request }) => {
        // Fresh user per test → clean run/budget state on the shared in-memory DB.
        user = await registerUserViaAPI(request);
        token = user.access_token;
        expect(token, 'fresh user should have a bearer token').toBeTruthy();
    });

    test('3 tasks assigned to one agent accumulate 3 task-bound run records', async ({
        request,
    }) => {
        const stamp = Date.now().toString(36);

        // 1. An agent, plus 3 distinct tasks.
        const agent = await createAgentViaAPI(request, token, {
            name: `Runs Agent ${stamp}`,
            scope: 'tenant',
        });
        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe('draft');

        // A brand-new agent starts with an empty run history.
        const initial = await getRunsPage(request, token, agent.id);
        expect(initial.data).toHaveLength(0);
        expect(initial.meta.total).toBe(0);

        const tasks = [];
        for (let i = 1; i <= 3; i++) {
            const task = await createTaskViaAPI(request, token, {
                title: `Runs Task ${i} ${stamp}`,
            });
            expect(task.status).toBe('backlog');
            tasks.push(task);
        }
        const taskIds = tasks.map((t) => t.id);
        expect(new Set(taskIds).size).toBe(3);

        // 2. Dispatch each task to the agent. The enqueue 500s without a
        //    TRIGGER_SECRET_KEY, but a run row is still persisted per call.
        //    `assignTaskToAgent` tolerates the non-2xx and returns null.
        for (const task of tasks) {
            const result = await assignTaskToAgent(request, token, agent.id, task.id);
            // No Trigger secret in CI → enqueue fails → helper returns null.
            // (Locally with a secret it would return { runId } — either is fine;
            //  the durable assertion is the recorded run below.)
            expect(result === null || typeof result?.runId === 'string').toBeTruthy();
        }

        // 3. The run history accumulates exactly one record per dispatch, each
        //    bound to its originating task with triggerKind 'task'.
        await expect
            .poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
                timeout: 20_000,
                message: 'expected 3 runs to be recorded',
            })
            .toBe(3);

        const page = await getRunsPage(request, token, agent.id);
        expect(page.data).toHaveLength(3);
        expect(page.meta.total).toBe(3);

        // Each task we dispatched has exactly one matching run.
        for (const taskId of taskIds) {
            const matching = page.data.filter((r) => r.taskId === taskId);
            expect(matching, `exactly one run for task ${taskId}`).toHaveLength(1);
            const run = matching[0];
            expect(run.triggerKind).toBe('task');
            expect(run.id).toBeTruthy();
            // Without a worker the run can't complete; in CI it lands 'failed'
            // (enqueue rejected) and never 'completed'. Tolerate either a
            // recorded failure or — if a secret IS present locally — a non-failed
            // dispatched state, but it must NEVER be a successful completion here.
            expect(run.status).not.toBe('completed');
        }

        // The set of taskIds across the runs equals the set we dispatched.
        const runTaskIds = new Set(page.data.map((r) => r.taskId));
        for (const taskId of taskIds) {
            expect(runTaskIds.has(taskId)).toBeTruthy();
        }
    });

    test('agent budget starts at zero spend and runs page exposes a typed pagination meta', async ({
        request,
    }) => {
        const stamp = Date.now().toString(36);
        const agent = await createAgentViaAPI(request, token, {
            name: `Budget Agent ${stamp}`,
            scope: 'tenant',
        });

        // 1. Budget BEFORE any spend: zero cents, USD, null cap, rolling-30d window.
        const budget = await getAgentBudget(request, token, agent.id);
        expect(budget.currentSpendCents).toBe(0);
        expect(budget.capCents).toBeNull();
        expect(budget.currency).toBe('USD');

        const periodStart = new Date(budget.periodStart);
        const periodEnd = new Date(budget.periodEnd);
        expect(Number.isNaN(periodStart.getTime())).toBeFalsy();
        expect(Number.isNaN(periodEnd.getTime())).toBeFalsy();
        // periodEnd is "now"; periodStart is ~30 days earlier (the budgets-tab window).
        expect(periodEnd.getTime()).toBeGreaterThan(periodStart.getTime());
        const windowDays = (periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000);
        expect(windowDays).toBeGreaterThan(27);
        expect(windowDays).toBeLessThan(33);

        // 2. Drive one failed task dispatch — a run is recorded but failed runs
        //    never execute a model, so spend must stay at zero.
        const task = await createTaskViaAPI(request, token, { title: `Budget Task ${stamp}` });
        await assignTaskToAgent(request, token, agent.id, task.id);
        await expect
            .poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
                timeout: 20_000,
            })
            .toBe(1);

        const budgetAfter = await getAgentBudget(request, token, agent.id);
        expect(budgetAfter.currentSpendCents).toBe(0);
        expect(budgetAfter.capCents).toBeNull();
        expect(budgetAfter.currency).toBe('USD');

        // 3. The runs list pagination envelope: { data, meta:{ total, limit, offset } }.
        //    Default limit 25 / offset 0 when unspecified.
        const defaults = await getRunsPage(request, token, agent.id);
        expect(defaults.meta).toMatchObject({ total: 1, limit: 25, offset: 0 });
        expect(Array.isArray(defaults.data)).toBeTruthy();

        // Each run row carries the full FU-2 field set (typed shape).
        const run = defaults.data[0];
        for (const field of RUN_FIELDS) {
            expect(run, `run should expose field "${field}"`).toHaveProperty(field);
        }
        expect(run.taskId).toBe(task.id);
        expect(run.triggerKind).toBe('task');

        // Explicit pagination params are echoed back in meta and bound the page.
        const limited = await getRunsPage(request, token, agent.id, { limit: 1, offset: 0 });
        expect(limited.meta).toMatchObject({ total: 1, limit: 1, offset: 0 });
        expect(limited.data.length).toBeLessThanOrEqual(1);

        // Offset past the end yields an empty page but preserves total + echoed offset.
        const past = await getRunsPage(request, token, agent.id, { limit: 5, offset: 50 });
        expect(past.meta).toMatchObject({ total: 1, limit: 5, offset: 50 });
        expect(past.data).toHaveLength(0);
    });

    test('paginating the run history walks newest-first across pages without overlap', async ({
        request,
    }) => {
        const stamp = Date.now().toString(36);
        const agent = await createAgentViaAPI(request, token, {
            name: `Paginate Agent ${stamp}`,
            scope: 'tenant',
        });

        // Create 4 task dispatches → 4 recorded runs.
        const taskIds: string[] = [];
        for (let i = 1; i <= 4; i++) {
            const task = await createTaskViaAPI(request, token, {
                title: `Paginate Task ${i} ${stamp}`,
            });
            taskIds.push(task.id);
            await assignTaskToAgent(request, token, agent.id, task.id);
        }

        await expect
            .poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
                timeout: 25_000,
            })
            .toBe(4);

        // Walk in pages of 2; concatenated pages must equal the full list with
        // no duplicate ids, and each task we dispatched appears exactly once.
        const pageA = await getRunsPage(request, token, agent.id, { limit: 2, offset: 0 });
        const pageB = await getRunsPage(request, token, agent.id, { limit: 2, offset: 2 });
        expect(pageA.data).toHaveLength(2);
        expect(pageB.data).toHaveLength(2);
        expect(pageA.meta.total).toBe(4);
        expect(pageB.meta.total).toBe(4);

        const walkedIds = [...pageA.data, ...pageB.data].map((r) => r.id);
        expect(new Set(walkedIds).size, 'no run id should appear on two pages').toBe(4);

        const walkedTaskIds = new Set([...pageA.data, ...pageB.data].map((r) => r.taskId));
        for (const taskId of taskIds) {
            expect(
                walkedTaskIds.has(taskId),
                `task ${taskId} present in walked pages`,
            ).toBeTruthy();
        }

        // Newest-first ordering: createdAt is non-increasing within a page.
        const created = pageA.data.map((r) => new Date(r.createdAt).getTime());
        expect(created[0]).toBeGreaterThanOrEqual(created[1]);
    });

    test('task<->agent assignee row and a dispatched run record both exist for the same pair', async ({
        request,
    }) => {
        const stamp = Date.now().toString(36);
        const agent = await createAgentViaAPI(request, token, {
            name: `Assignee Agent ${stamp}`,
            scope: 'tenant',
        });
        const task = await createTaskViaAPI(request, token, { title: `Assignee Task ${stamp}` });

        // 1. The declarative assignment: agent as a task assignee → clean 201.
        const assignment = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(assignment.id).toBeTruthy();
        expect(assignment.taskId).toBe(task.id);
        expect(assignment.assigneeType).toBe('agent');
        expect(assignment.assigneeId).toBe(agent.id);

        // Re-adding the SAME (task, agent) pair violates the `uq_task_assignee`
        // unique index (taskId, assigneeType, assigneeId). The repository does a
        // raw `save()` with no pre-check or catch, so the driver's unique-constraint
        // error is unmapped and surfaces as a 500 (probed live: HTTP 500
        // {"statusCode":500,"message":"Internal server error"}). We exercise the
        // duplicate path to confirm the edge is genuinely unique-constrained, and
        // the durable assertion is that exactly ONE assignee row exists for the pair.
        const dupRes = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers: authedHeaders(token),
            data: { assigneeType: 'agent', assigneeId: agent.id },
        });
        // Duplicate-assignee → 409 Conflict (unique-constraint, mapped from the
        // previously-unmapped 500).
        expect(dupRes.status()).toBe(409);

        // 2. The imperative dispatch: assign-task records a run for the pair.
        await assignTaskToAgent(request, token, agent.id, task.id);

        await expect
            .poll(
                async () => {
                    const page = await getRunsPage(request, token, agent.id);
                    return page.data.filter((r) => r.taskId === task.id).length;
                },
                { timeout: 20_000, message: 'a run bound to the assigned task should be recorded' },
            )
            .toBeGreaterThanOrEqual(1);

        const page = await getRunsPage(request, token, agent.id);
        const run = page.data.find((r) => r.taskId === task.id);
        expect(run, 'a run record bound to the task exists').toBeTruthy();
        expect(run!.triggerKind).toBe('task');
        expect(run!.taskId).toBe(task.id);

        // 3. Both surfaces coexist for the (task, agent) pair: the assignee row
        //    (verified above via its 201 body) and the run record (here). They
        //    are independent — the assignee edge is declarative, the run is the
        //    dispatch attempt — and the run is NOT a successful completion here
        //    because Trigger.dev has no worker/secret in CI.
        expect(run!.status).not.toBe('completed');
    });
});
