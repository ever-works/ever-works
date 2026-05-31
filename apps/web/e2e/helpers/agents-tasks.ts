import { type APIRequestContext, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * Agents + Tasks helpers.
 *
 * Verified against a live stack (sqlite in-memory):
 *   - POST /api/agents { scope:'tenant'|'mission'|'idea'|'work', name, … }
 *       → 201 { id, status:'draft', slug, permissions:{…}, … }
 *   - POST /api/tasks { title, … }
 *       → 201 { id, slug:'T-n', status:'backlog', priority:'p3', … }
 *   - POST /api/tasks/:id/assignees { assigneeType:'agent'|'user', assigneeId }
 *       → 201 { taskId, assigneeType, assigneeId, id, createdAt }
 *   - POST /api/tasks/:id/transition { to, force? }
 *   - POST /api/agents/:id/assign-task { taskId }
 *       → enqueues an AgentRun via Trigger.dev. WITHOUT a TRIGGER_SECRET_KEY
 *         (the e2e default) the HTTP call returns 500 BUT an AgentRun row is
 *         still created with status 'failed' (errorMessage 'enqueue-failed…').
 *         So in CI assert the *run record*, not successful completion.
 *   - GET  /api/agents/:id/runs → { data:[{ id, status, triggerKind:'task', taskId, … }], meta }
 *
 * Task status state machine: backlog → todo → in_progress → in_review → done
 * (plus blocked / cancelled). Use { force:true } to skip illegal hops.
 */

export interface Agent {
    id: string;
    slug: string;
    name: string;
    scope: string;
    status: string;
}

export interface Task {
    id: string;
    slug: string;
    title: string;
    status: string;
    priority: string;
}

export interface AgentRun {
    id: string;
    status: string;
    triggerKind: string;
    taskId: string | null;
    errorMessage?: string | null;
}

export async function createAgentViaAPI(
    request: APIRequestContext,
    token: string,
    body: { name: string; scope?: string; missionId?: string; ideaId?: string; workId?: string },
): Promise<Agent> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', ...body },
    });
    expect(res.status(), `createAgent body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

export async function createTaskViaAPI(
    request: APIRequestContext,
    token: string,
    body: {
        title: string;
        description?: string;
        priority?: string;
        status?: string;
        workId?: string;
        missionId?: string;
        ideaId?: string;
    },
): Promise<Task> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `createTask body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Attach an assignee (agent or user) to a task. Returns the assignment row. */
export async function addTaskAssignee(
    request: APIRequestContext,
    token: string,
    taskId: string,
    assignee: { assigneeType: 'agent' | 'user'; assigneeId: string },
): Promise<{ id: string; taskId: string; assigneeType: string; assigneeId: string }> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/assignees`, {
        headers: authedHeaders(token),
        data: assignee,
    });
    expect(res.status(), `addAssignee body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

export async function transitionTaskViaAPI(
    request: APIRequestContext,
    token: string,
    taskId: string,
    to: string,
    force = false,
): Promise<Task> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/transition`, {
        headers: authedHeaders(token),
        data: { to, force },
    });
    expect(res.status(), `transition body=${await res.text().catch(() => '')}`).toBeLessThan(300);
    return res.json();
}

/**
 * Trigger an agent run for a task. The HTTP layer 500s when Trigger.dev
 * isn't configured (the e2e default), but a run row is still persisted — so
 * callers should tolerate the non-2xx and assert via {@link listAgentRuns}.
 * Returns the parsed body on success or null on the expected enqueue failure.
 */
export async function assignTaskToAgent(
    request: APIRequestContext,
    token: string,
    agentId: string,
    taskId: string,
): Promise<{ runId?: string } | null> {
    const res = await request.post(`${API_BASE}/api/agents/${agentId}/assign-task`, {
        headers: authedHeaders(token),
        data: { taskId },
    });
    if (res.ok()) return res.json();
    return null;
}

export async function listAgentRuns(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<AgentRun[]> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return body.data ?? [];
}
