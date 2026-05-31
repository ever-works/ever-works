import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    createAgentViaAPI,
    createTaskViaAPI,
    addTaskAssignee,
    assignTaskToAgent,
    listAgentRuns,
} from './helpers/agents-tasks';

/**
 * Agents + Tasks — real "create an agent for a Work, give it a task" flow.
 *
 * User ask: "create an Agent (e.g. for a given Work), give it a task and check
 * that the Agent did that task."
 *
 * Reality on the e2e stack: an agent run is dispatched through Trigger.dev,
 * which has no worker/secret in CI — so the run can't reach a *completed*
 * terminal state here. What we CAN (and do) verify end-to-end is the whole
 * assignment pipeline: a Work, an agent scoped to that Work, a task, the task
 * → agent assignee record, and a persisted AgentRun bound to that task (the
 * dispatch was attempted and recorded). The agent + task also render in the UI.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Agents + Tasks — assignment pipeline', () => {
    test('agent scoped to a Work receives a task assignment and records a run', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);

        // 1. A Work to scope the agent to.
        const work = await createWorkViaAPI(request, token, { name: `E2E Agent Work ${stamp}` });
        expect(work.id, `work create raw=${JSON.stringify(work.raw)}`).toBeTruthy();

        // 2. An agent scoped to that Work.
        const agent = await createAgentViaAPI(request, token, {
            name: `Work Worker ${stamp}`,
            scope: 'work',
            workId: work.id,
        });
        expect(agent.scope).toBe('work');
        expect(agent.status).toBe('draft');

        // 3. A task in that Work.
        const task = await createTaskViaAPI(request, token, {
            title: `Summarize the Work ${stamp}`,
            workId: work.id,
        });
        expect(task.status).toBe('backlog');

        // 4. Assign the task to the agent (assignee record is clean 201).
        const assignment = await addTaskAssignee(request, token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(assignment.assigneeId).toBe(agent.id);
        expect(assignment.assigneeType).toBe('agent');

        // 5. Dispatch the task to the agent. The enqueue itself may fail when
        //    Trigger.dev isn't configured, but a run row is still created.
        await assignTaskToAgent(request, token, agent.id, task.id);

        // 6. A run bound to this task is recorded in the agent's run history.
        await expect
            .poll(
                async () => {
                    const runs = await listAgentRuns(request, token, agent.id);
                    return runs.filter((r) => r.taskId === task.id).length;
                },
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);

        const runs = await listAgentRuns(request, token, agent.id);
        const run = runs.find((r) => r.taskId === task.id)!;
        expect(run.triggerKind).toBe('task');
    });

    test('UI: the agent and task render in their dashboard lists', async ({ page, request }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);
        const agentName = `UI Agent ${stamp}`;
        const taskTitle = `UI Task ${stamp}`;

        const agent = await createAgentViaAPI(request, token, { name: agentName, scope: 'tenant' });
        await createTaskViaAPI(request, token, { title: taskTitle });

        await page.goto('/agents', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(agentName).first()).toBeVisible({ timeout: 30_000 });

        await page.goto(`/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(agentName).first()).toBeVisible({ timeout: 30_000 });

        await page.goto('/tasks', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(taskTitle).first()).toBeVisible({ timeout: 30_000 });
    });
});
