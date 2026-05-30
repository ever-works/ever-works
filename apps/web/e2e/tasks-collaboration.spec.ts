import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Tasks — collaboration sub-resources (assignees / reviewers / approvers)
 * and recurrence (RFC 5545 RRULE). These endpoints had no e2e coverage.
 * Assertions pinned against live API shapes.
 *
 * API surface (`apps/api/src/tasks/*`):
 *   - POST /api/tasks/:id/assignees   { assigneeType: user|agent, assigneeId }
 *   - POST /api/tasks/:id/reviewers   { reviewerType, reviewerId } -> reviewState
 *   - POST /api/tasks/:id/approvers   { approverType, approverId } -> approvalState
 *   - POST/DELETE /api/tasks/:id/recurring   { recurrenceRule }
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

async function makeTask(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    title = 'Collab task',
) {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: { title },
    });
    return res.json();
}

test.describe('Tasks — assignees / reviewers / approvers', () => {
    test('POST /api/tasks/:id/assignees without auth → 401', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/tasks/${UNKNOWN_UUID}/assignees`, {
            data: { assigneeType: 'user', assigneeId: UNKNOWN_UUID },
        });
        expect(res.status()).toBe(401);
    });

    test('assign a human and an agent to a task', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await makeTask(request, u.access_token);

        const human = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers,
            data: { assigneeType: 'user', assigneeId: u.user.id },
        });
        expect(human.status(), `assignee body=${await human.text()}`).toBe(201);
        const ha = await human.json();
        expect(ha.taskId).toBe(task.id);
        expect(ha.assigneeType).toBe('user');
        expect(ha.assigneeId).toBe(u.user.id);

        // Agents are first-class assignees (polymorphic assigneeType).
        const agent = await (
            await request.post(`${API_BASE}/api/agents`, {
                headers,
                data: { scope: 'tenant', name: 'Collab Agent' },
            })
        ).json();
        const agentAssign = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers,
            data: { assigneeType: 'agent', assigneeId: agent.id },
        });
        expect(agentAssign.status()).toBe(201);
        expect((await agentAssign.json()).assigneeType).toBe('agent');
    });

    test('reviewers and approvers start in a pending state', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await makeTask(request, u.access_token);

        const reviewer = await request.post(`${API_BASE}/api/tasks/${task.id}/reviewers`, {
            headers,
            data: { reviewerType: 'user', reviewerId: u.user.id },
        });
        expect(reviewer.status()).toBe(201);
        const rv = await reviewer.json();
        expect(rv.reviewState).toBe('pending');
        expect(rv.reviewedAt).toBeNull();

        const approver = await request.post(`${API_BASE}/api/tasks/${task.id}/approvers`, {
            headers,
            data: { approverType: 'user', approverId: u.user.id },
        });
        expect(approver.status()).toBe(201);
        const ap = await approver.json();
        expect(ap.approvalState).toBe('pending');
        expect(ap.approvedAt).toBeNull();
    });

    test('cross-user isolation: a stranger cannot assign on my task', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const task = await makeTask(request, alice.access_token);

        const res = await request.post(`${API_BASE}/api/tasks/${task.id}/assignees`, {
            headers: authedHeaders(bob.access_token),
            data: { assigneeType: 'user', assigneeId: bob.user.id },
        });
        expect([403, 404]).toContain(res.status());
    });
});

test.describe('Tasks — recurrence (RFC 5545 RRULE)', () => {
    test('set a valid RRULE → task becomes recurring; clear it → not recurring', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await makeTask(request, u.access_token, 'Weekly standup');

        const set = await request.post(`${API_BASE}/api/tasks/${task.id}/recurring`, {
            headers,
            data: { recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO' },
        });
        expect(set.status(), `recurring body=${await set.text()}`).toBe(200);

        const afterSet = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers })
        ).json();
        expect(afterSet.isRecurring).toBe(true);

        const cleared = await request.delete(`${API_BASE}/api/tasks/${task.id}/recurring`, {
            headers,
        });
        expect(cleared.status()).toBe(200);
        const afterClear = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers })
        ).json();
        expect(afterClear.isRecurring).toBe(false);
    });

    test('a malformed RRULE is rejected with a 400 parse error (not a 500)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const task = await makeTask(request, u.access_token);

        const res = await request.post(`${API_BASE}/api/tasks/${task.id}/recurring`, {
            headers,
            data: { recurrenceRule: 'not-a-rule' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toMatch(/rrule/i);
    });
});
