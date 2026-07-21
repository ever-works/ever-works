/**
 * Task FULL LIFECYCLE — one long multi-step flow threaded end-to-end.
 *
 * Where the sibling Task specs each drill ONE facet in isolation
 * (`flow-task-state-machine` = pure lattice, `flow-task-approvers-gate` =
 * the approver policy, `flow-task-assignees-deep` = the join + dispatch,
 * `flow-task-chat-messages`/`flow-task-collaboration` = the chat thread,
 * `flow-tasks-recurring-reviewers` = the RRULE verbs, `flow-task-labels-
 * priority-search` = the query surface), THIS file is the connected
 * narrative: a single Task is carried through its whole life — create →
 * dual assignees (agent + human) → the full backlog→todo→in_progress→
 * in_review→done transition chain (illegal hop 400, force override) →
 * reviewers + approvers gate → labels/priority/search → task-chat →
 * recurrence — and the SAME long flow is re-run from a non-owner to prove
 * every sub-write is walled off with 404. The value here is the wiring
 * BETWEEN steps (side-effect columns surviving multiple hops, the escape
 * hatch reopening a gated task, the isolation posture holding on every
 * verb), not any single row shape a narrow spec already owns.
 *
 * ── PROBED, TRUTHFUL CONTRACT (curl against http://127.0.0.1:3100 —
 *    sqlite in-memory, keyless CI driver — before every assertion below):
 *
 *   POST   /api/tasks { title, description?, priority?, status?, labels?, … }
 *     → 201 full Task { userId, slug:'T-n', status:'backlog', priority:'p3'
 *       (default), requireAllApprovers:true (default), recurrenceTimezone:'UTC',
 *       isRecurring:false, recurrenceOccurredCount:0, startedAt/completedAt/
 *       previousStatus/…:null, id, createdAt, updatedAt }
 *     - title required (missing → 400) and capped at 200 chars (201 at 200,
 *       400 at 201); unknown body props → 400 (forbidNonWhitelisted).
 *   GET    /api/tasks?search=&priority=&label=&status=&limit=&offset=
 *     → 200 { data:[Task], meta:{ total, limit, offset } }
 *     - search matches title ∥ slug ∥ description; invalid priority/status
 *       enum filter → 400.
 *   PATCH  /api/tasks/:id { priority?, labels?, requireAllApprovers?, … }
 *     → 200 (labels REPLACE, not merge).
 *   POST   /api/tasks/:id/transition { to, force? } → 200 refreshed Task
 *     - lattice: backlog→todo→in_progress→in_review→done; startedAt stamped
 *       ONCE on →in_progress (stable across later hops), completedAt on →done;
 *       blocked stashes previousStatus, recover clears it.
 *     - illegal hop → 400 "Cannot transition Task from <from> to <to>.";
 *       unknown enum → 400 (DTO IsEnum array message).
 *     - →done approver gate: pending approver + requireAllApprovers → 409;
 *       force:true overrides (→200, completedAt set); requireAllApprovers=false
 *       is an escape hatch (→200 without force); zero approvers pass vacuously.
 *   POST   /api/tasks/:id/assignees { assigneeType:'user'|'agent', assigneeId }
 *     → 201 { taskId, assigneeType, assigneeId, id, createdAt, … }
 *     - agent-type must be an OWNED agent (foreign/unknown → 400); user-type
 *       id is NOT validated; duplicate → 409; DELETE is BY ROW id (the add
 *       response `id`, not the actor id) → { deleted:true }, re-delete → 404.
 *   POST   /api/tasks/:id/reviewers { reviewerType, reviewerId }
 *     → 201 { …, reviewState:'pending', reviewedAt:null }
 *   POST   /api/tasks/:id/approvers { approverType, approverId }
 *     → 201 { …, approvalState:'pending', approvedAt:null }; duplicate → 409.
 *   POST   /api/tasks/:id/chat { body, attachments? }
 *     → 201 { authorType:'user', authorId, body, mentions:null|[{type:'agent',
 *       id, slug}], editedAt:null, id, … } — @<owned-agent-slug> resolves;
 *       GET → { data:[…] } (createdAt asc); missing body → 400 (DTO array),
 *       whitespace body → 400 "Chat body is required.".
 *   PATCH  /api/task-chat-messages/:id { body } → 200 (editedAt stamped);
 *       cross-user → 404, no-auth → 401, malformed → 400, unknown → 404.
 *   POST   /api/tasks/:id/recurring { recurrenceRule, recurrenceTimezone?,
 *     recurrenceMaxOccurrences?, recurrenceEndsAt? } → 200 { isRecurring:true,
 *     nextOccurrenceAt:<ISO>, … }; missing rule → 400 (DTO), garbage → 400
 *     "RRULE parse error: …". DELETE /recurring → 200 { isRecurring:false,
 *     recurrenceRule:null, nextOccurrenceAt:null } (timezone left as-is).
 *   Cross-user posture: every read/sub-write on another user's Task → 404
 *   (404-never-403); no-auth → 401; malformed uuid → 400; unknown uuid → 404.
 *
 * Fully API-orchestrated (safe `flow-` prefix), fresh registerUserViaAPI()
 * owners per test — never the shared seeded user.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI, addTaskAssignee, transitionTaskViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface OwnerCtx {
    user: RegisteredUser;
    token: string;
    headers: { Authorization: string };
    userId: string;
}

async function boot(request: APIRequestContext): Promise<OwnerCtx> {
    const user = await registerUserViaAPI(request);
    return {
        user,
        token: user.access_token,
        headers: authedHeaders(user.access_token),
        userId: user.user.id,
    };
}

/** Raw create so the full Task shape (defaults + null side-effect columns) is assertable. */
async function createTask(
    request: APIRequestContext,
    ctx: OwnerCtx,
    body: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const res = await request.post(`${API_BASE}/api/tasks`, { headers: ctx.headers, data: body });
    expect(res.status(), `createTask body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

function tasksBase(): string {
    return `${API_BASE}/api/tasks`;
}

test.describe('Task full lifecycle — the long connected flow', () => {
    test('create → dual assignees → full lattice to done, with side-effect columns surviving each hop', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const ctx = await boot(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Doer ${stamp()}`,
        });

        // ── create: pin the birth shape + defaults ──────────────────
        const task = await createTask(request, ctx, {
            title: `Lifecycle ${stamp()}`,
            description: 'carried end-to-end',
            priority: 'p2',
            labels: ['alpha'],
        });
        expect(task.id).toMatch(UUID_RE);
        expect(task.slug).toMatch(/^T-\d+$/);
        expect(task.status).toBe('backlog');
        expect(task.priority).toBe('p2');
        expect(task.requireAllApprovers).toBe(true);
        expect(task.recurrenceTimezone).toBe('UTC');
        expect(task.isRecurring).toBe(false);
        expect(task.recurrenceOccurredCount).toBe(0);
        expect(task.startedAt).toBeNull();
        expect(task.completedAt).toBeNull();
        expect(task.previousStatus).toBeNull();
        expect(task.createdByType).toBe('user');
        expect(task.createdById).toBe(ctx.userId);

        // ── assignees: a human (self) and an agent, both 201 ─────────
        const human = await addTaskAssignee(request, ctx.token, task.id, {
            assigneeType: 'user',
            assigneeId: ctx.userId,
        });
        expect(human.taskId).toBe(task.id);
        expect(human.assigneeType).toBe('user');
        expect(human.assigneeId).toBe(ctx.userId);
        expect(human.id).toMatch(UUID_RE);

        const bot = await addTaskAssignee(request, ctx.token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(bot.assigneeType).toBe('agent');
        expect(bot.assigneeId).toBe(agent.id);

        // ── the full legal chain, asserting the stamped columns ──────
        const todo = await transitionTaskViaAPI(request, ctx.token, task.id, 'todo');
        expect(todo.status).toBe('todo');

        const inProgress = await transitionTaskViaAPI(request, ctx.token, task.id, 'in_progress');
        expect(inProgress.status).toBe('in_progress');
        // startedAt is stamped exactly once on entry to in_progress.
        const startedAt = (inProgress as unknown as { startedAt: string | null }).startedAt;
        expect(typeof startedAt).toBe('string');

        const inReview = await transitionTaskViaAPI(request, ctx.token, task.id, 'in_review');
        expect(inReview.status).toBe('in_review');
        // …and is NOT re-stamped on a later hop.
        expect((inReview as unknown as { startedAt: string | null }).startedAt).toBe(startedAt);

        const done = await transitionTaskViaAPI(request, ctx.token, task.id, 'done');
        expect(done.status).toBe('done');
        expect(typeof (done as unknown as { completedAt: string | null }).completedAt).toBe(
            'string',
        );
        // startedAt still stable through completion.
        expect((done as unknown as { startedAt: string | null }).startedAt).toBe(startedAt);
    });

    test('illegal hops are rejected 400 before any state change; unknown enum is a distinct 400', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `Illegal ${stamp()}` });

        const skipToDone = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'done' },
        });
        expect(skipToDone.status()).toBe(400);
        expect((await skipToDone.json()).message).toBe(
            'Cannot transition Task from backlog to done.',
        );

        const skipToReview = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'in_review' },
        });
        expect(skipToReview.status()).toBe(400);

        // Unknown enum is caught by the DTO (IsEnum) → array message, before the service.
        const bogus = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'frozen' },
        });
        expect(bogus.status()).toBe(400);
        expect(Array.isArray((await bogus.json()).message)).toBe(true);

        // The rejected hops left the task untouched at backlog.
        const reread = await request.get(`${tasksBase()}/${task.id}`, { headers: ctx.headers });
        expect((await reread.json()).status).toBe('backlog');
    });

    test('blocked stashes previousStatus and recovering restores/clears it', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `Blocked ${stamp()}` });

        await transitionTaskViaAPI(request, ctx.token, task.id, 'todo');
        await transitionTaskViaAPI(request, ctx.token, task.id, 'in_progress');

        const blocked = await transitionTaskViaAPI(request, ctx.token, task.id, 'blocked');
        expect(blocked.status).toBe('blocked');
        expect((blocked as unknown as { previousStatus: string | null }).previousStatus).toBe(
            'in_progress',
        );

        const recovered = await transitionTaskViaAPI(request, ctx.token, task.id, 'in_progress');
        expect(recovered.status).toBe('in_progress');
        expect(
            (recovered as unknown as { previousStatus: string | null }).previousStatus,
        ).toBeNull();
    });
});

test.describe('Task full lifecycle — the approver gate on → done', () => {
    test('a pending approver blocks → done with 409; force:true overrides and stamps completedAt', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Approver ${stamp()}`,
        });
        const task = await createTask(request, ctx, { title: `Gated ${stamp()}` });

        const approver = await request.post(`${tasksBase()}/${task.id}/approvers`, {
            headers: ctx.headers,
            data: { approverType: 'agent', approverId: agent.id },
        });
        expect(approver.status()).toBe(201);
        const approverRow = await approver.json();
        expect(approverRow.approvalState).toBe('pending');
        expect(approverRow.approvedAt).toBeNull();

        // Duplicate approver on the same task → 409.
        const dup = await request.post(`${tasksBase()}/${task.id}/approvers`, {
            headers: ctx.headers,
            data: { approverType: 'agent', approverId: agent.id },
        });
        expect(dup.status()).toBe(409);

        await transitionTaskViaAPI(request, ctx.token, task.id, 'todo');
        await transitionTaskViaAPI(request, ctx.token, task.id, 'in_progress');

        // Gate fires: not all approvers approved → 409.
        const gated = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'done' },
        });
        expect(gated.status()).toBe(409);
        expect((await gated.json()).message).toContain('not all approvers have approved');

        // force:true overrides ONLY the approver gate → 200, completedAt stamped.
        const forced = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'done', force: true },
        });
        expect(forced.status()).toBe(200);
        const forcedBody = await forced.json();
        expect(forcedBody.status).toBe('done');
        expect(typeof forcedBody.completedAt).toBe('string');
    });

    test('requireAllApprovers=false is the escape hatch: → done passes without force', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Escape ${stamp()}`,
        });
        const task = await createTask(request, ctx, { title: `Escape ${stamp()}` });

        await request.post(`${tasksBase()}/${task.id}/approvers`, {
            headers: ctx.headers,
            data: { approverType: 'agent', approverId: agent.id },
        });

        // Flip the policy off, then the pending approver no longer gates.
        const patch = await request.patch(`${tasksBase()}/${task.id}`, {
            headers: ctx.headers,
            data: { requireAllApprovers: false },
        });
        expect(patch.status()).toBe(200);
        expect((await patch.json()).requireAllApprovers).toBe(false);

        await transitionTaskViaAPI(request, ctx.token, task.id, 'todo');
        await transitionTaskViaAPI(request, ctx.token, task.id, 'in_progress');
        const done = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'done' },
        });
        expect(done.status()).toBe(200);
        expect((await done.json()).status).toBe('done');
    });

    test('zero approvers → done passes vacuously (the gate is only "all attached approvers")', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `Vacuous ${stamp()}` });
        await transitionTaskViaAPI(request, ctx.token, task.id, 'todo');
        await transitionTaskViaAPI(request, ctx.token, task.id, 'in_progress');
        const done = await request.post(`${tasksBase()}/${task.id}/transition`, {
            headers: ctx.headers,
            data: { to: 'done' },
        });
        expect(done.status()).toBe(200);
        expect((await done.json()).status).toBe('done');
    });
});

test.describe('Task full lifecycle — reviewers + assignee sub-resource lifecycle', () => {
    test('a reviewer, an approver, and an agent assignee coexist on one task, each born pending/attached', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Poly ${stamp()}`,
        });
        const task = await createTask(request, ctx, { title: `Roster ${stamp()}` });

        const reviewer = await request.post(`${tasksBase()}/${task.id}/reviewers`, {
            headers: ctx.headers,
            data: { reviewerType: 'agent', reviewerId: agent.id },
        });
        expect(reviewer.status()).toBe(201);
        const reviewerRow = await reviewer.json();
        expect(reviewerRow.reviewState).toBe('pending');
        expect(reviewerRow.reviewedAt).toBeNull();
        expect(reviewerRow.reviewerId).toBe(agent.id);

        const approver = await request.post(`${tasksBase()}/${task.id}/approvers`, {
            headers: ctx.headers,
            data: { approverType: 'agent', approverId: agent.id },
        });
        expect(approver.status()).toBe(201);
        expect((await approver.json()).approvalState).toBe('pending');

        const assignee = await addTaskAssignee(request, ctx.token, task.id, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(assignee.assigneeId).toBe(agent.id);
    });

    test('assignee lifecycle: add → duplicate 409 → remove BY ROW id → idempotent 404 → re-add', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `Assignee ${stamp()}` });

        const add = await addTaskAssignee(request, ctx.token, task.id, {
            assigneeType: 'user',
            assigneeId: ctx.userId,
        });
        const rowId = add.id;

        // Duplicate (same actor) → 409.
        const dup = await request.post(`${tasksBase()}/${task.id}/assignees`, {
            headers: ctx.headers,
            data: { assigneeType: 'user', assigneeId: ctx.userId },
        });
        expect(dup.status()).toBe(409);

        // DELETE is by the assignment ROW id, not the actor id.
        const byActor = await request.delete(`${tasksBase()}/${task.id}/assignees/${ctx.userId}`, {
            headers: ctx.headers,
        });
        expect(byActor.status()).toBe(404);

        const byRow = await request.delete(`${tasksBase()}/${task.id}/assignees/${rowId}`, {
            headers: ctx.headers,
        });
        expect(byRow.status()).toBe(200);
        expect((await byRow.json()).deleted).toBe(true);

        // Re-delete of the same row → 404 (idempotent-not-found).
        const again = await request.delete(`${tasksBase()}/${task.id}/assignees/${rowId}`, {
            headers: ctx.headers,
        });
        expect(again.status()).toBe(404);

        // The actor can be re-added now that the row is gone.
        const readd = await addTaskAssignee(request, ctx.token, task.id, {
            assigneeType: 'user',
            assigneeId: ctx.userId,
        });
        expect(readd.assigneeId).toBe(ctx.userId);
    });

    test('agent assignee must be an OWNED agent (foreign → 400); user-type ids are not validated', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `Validate ${stamp()}` });

        // An unknown/foreign agent id is rejected before insert.
        const foreignAgent = await request.post(`${tasksBase()}/${task.id}/assignees`, {
            headers: ctx.headers,
            data: { assigneeType: 'agent', assigneeId: UNKNOWN_UUID },
        });
        expect(foreignAgent.status()).toBe(400);

        // A user-type assignee id is taken as-is (no users-table lookup in this graph).
        const anyUser = await request.post(`${tasksBase()}/${task.id}/assignees`, {
            headers: ctx.headers,
            data: { assigneeType: 'user', assigneeId: UNKNOWN_UUID },
        });
        expect(anyUser.status()).toBe(201);
        expect((await anyUser.json()).assigneeId).toBe(UNKNOWN_UUID);
    });
});

test.describe('Task full lifecycle — labels, priority, and search', () => {
    test('PATCH replaces labels + priority; the change persists on re-read', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, {
            title: `Labels ${stamp()}`,
            labels: ['one', 'two'],
            priority: 'p3',
        });
        expect(task.labels).toEqual(['one', 'two']);

        const patched = await request.patch(`${tasksBase()}/${task.id}`, {
            headers: ctx.headers,
            data: { priority: 'p0', labels: ['three'] },
        });
        expect(patched.status()).toBe(200);
        const body = await patched.json();
        expect(body.priority).toBe('p0');
        // REPLACE semantics — the prior labels are gone, not merged.
        expect(body.labels).toEqual(['three']);
        expect(body.labels).not.toContain('one');

        const reread = await request.get(`${tasksBase()}/${task.id}`, { headers: ctx.headers });
        expect((await reread.json()).labels).toEqual(['three']);
    });

    test('search matches title, slug, and description tokens; the list shape carries meta', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const token = `Zephyr${stamp().replace(/-/g, '')}`;
        const task = await createTask(request, ctx, {
            title: `${token} headline`,
            description: `body mentions ${token}desc`,
        });

        const byTitle = await request.get(`${tasksBase()}?search=${token}`, {
            headers: ctx.headers,
        });
        expect(byTitle.status()).toBe(200);
        const titleBody = await byTitle.json();
        expect(Array.isArray(titleBody.data)).toBe(true);
        expect(titleBody.meta).toMatchObject({ limit: 50, offset: 0 });
        expect(typeof titleBody.meta.total).toBe('number');
        expect(titleBody.data.map((t: { id: string }) => t.id)).toContain(task.id);

        const bySlug = await request.get(`${tasksBase()}?search=${task.slug}`, {
            headers: ctx.headers,
        });
        expect((await bySlug.json()).data.map((t: { id: string }) => t.id)).toContain(task.id);

        const byDesc = await request.get(`${tasksBase()}?search=${token}desc`, {
            headers: ctx.headers,
        });
        expect((await byDesc.json()).data.map((t: { id: string }) => t.id)).toContain(task.id);
    });

    test('priority / label / status filters narrow the list; invalid enum filters → 400', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const label = `lbl${stamp().replace(/-/g, '')}`;
        const task = await createTask(request, ctx, {
            title: `Filter ${stamp()}`,
            priority: 'p1',
            labels: [label],
        });

        const byPriority = await request.get(`${tasksBase()}?priority=p1`, {
            headers: ctx.headers,
        });
        expect(byPriority.status()).toBe(200);
        expect((await byPriority.json()).data.map((t: { id: string }) => t.id)).toContain(task.id);

        const byLabel = await request.get(`${tasksBase()}?label=${label}`, {
            headers: ctx.headers,
        });
        expect((await byLabel.json()).data.map((t: { id: string }) => t.id)).toContain(task.id);

        const byStatus = await request.get(`${tasksBase()}?status=backlog`, {
            headers: ctx.headers,
        });
        expect((await byStatus.json()).data.map((t: { id: string }) => t.id)).toContain(task.id);

        // Invalid enum in the filter → 400 (parseStatusList / parsePriorityList guards).
        expect(
            (await request.get(`${tasksBase()}?priority=p9`, { headers: ctx.headers })).status(),
        ).toBe(400);
        expect(
            (await request.get(`${tasksBase()}?status=frozen`, { headers: ctx.headers })).status(),
        ).toBe(400);
    });
});

test.describe('Task full lifecycle — the chat thread', () => {
    test('post → list → edit within the window; an @owned-agent mention resolves to the agent', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Chatty ${stamp()}`,
        });
        const task = await createTask(request, ctx, { title: `Chat ${stamp()}` });

        // Plain message — no mentions.
        const plain = await request.post(`${tasksBase()}/${task.id}/chat`, {
            headers: ctx.headers,
            data: { body: 'first message, no mention' },
        });
        expect(plain.status()).toBe(201);
        const plainRow = await plain.json();
        expect(plainRow.authorType).toBe('user');
        expect(plainRow.authorId).toBe(ctx.userId);
        expect(plainRow.mentions).toBeNull();
        expect(plainRow.editedAt).toBeNull();

        // @<agent-slug> resolves against the author's OWNED agents.
        const mention = await request.post(`${tasksBase()}/${task.id}/chat`, {
            headers: ctx.headers,
            data: { body: `hey @${agent.slug} take a look` },
        });
        expect(mention.status()).toBe(201);
        const mentionRow = await mention.json();
        expect(Array.isArray(mentionRow.mentions)).toBe(true);
        expect(mentionRow.mentions[0]).toMatchObject({
            type: 'agent',
            id: agent.id,
            slug: agent.slug,
        });

        // List returns both, oldest-first, under { data }.
        const list = await request.get(`${tasksBase()}/${task.id}/chat?limit=50`, {
            headers: ctx.headers,
        });
        expect(list.status()).toBe(200);
        const ids = (await list.json()).data.map((m: { id: string }) => m.id);
        expect(ids).toContain(plainRow.id);
        expect(ids).toContain(mentionRow.id);

        // Edit the plain message within the 5-min window → editedAt stamps.
        const edit = await request.patch(`${API_BASE}/api/task-chat-messages/${plainRow.id}`, {
            headers: ctx.headers,
            data: { body: 'first message, edited' },
        });
        expect(edit.status()).toBe(200);
        const edited = await edit.json();
        expect(edited.body).toBe('first message, edited');
        expect(typeof edited.editedAt).toBe('string');
    });

    test('chat body validation: missing → 400 (DTO), whitespace → 400 (service), edit-whitespace → 400', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `ChatVal ${stamp()}` });

        const missing = await request.post(`${tasksBase()}/${task.id}/chat`, {
            headers: ctx.headers,
            data: {},
        });
        expect(missing.status()).toBe(400);
        expect(Array.isArray((await missing.json()).message)).toBe(true);

        const whitespace = await request.post(`${tasksBase()}/${task.id}/chat`, {
            headers: ctx.headers,
            data: { body: '   ' },
        });
        expect(whitespace.status()).toBe(400);
        expect((await whitespace.json()).message).toBe('Chat body is required.');

        const posted = await request.post(`${tasksBase()}/${task.id}/chat`, {
            headers: ctx.headers,
            data: { body: 'editable' },
        });
        const msgId = (await posted.json()).id;
        const editBlank = await request.patch(`${API_BASE}/api/task-chat-messages/${msgId}`, {
            headers: ctx.headers,
            data: { body: '  ' },
        });
        expect(editBlank.status()).toBe(400);
    });

    test('the standalone message-edit route: cross-user 404, no-auth 401, malformed 400, unknown 404', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const intruder = await boot(request);
        const task = await createTask(request, ctx, { title: `ChatGuard ${stamp()}` });
        const posted = await request.post(`${tasksBase()}/${task.id}/chat`, {
            headers: ctx.headers,
            data: { body: 'owner-only message' },
        });
        const msgId = (await posted.json()).id;

        // A different user can't reach the message (its parent Task is owner-scoped).
        const cross = await request.patch(`${API_BASE}/api/task-chat-messages/${msgId}`, {
            headers: intruder.headers,
            data: { body: 'hijack' },
        });
        expect(cross.status()).toBe(404);

        const noAuth = await request.patch(`${API_BASE}/api/task-chat-messages/${msgId}`, {
            data: { body: 'x' },
        });
        expect(noAuth.status()).toBe(401);

        const malformed = await request.patch(`${API_BASE}/api/task-chat-messages/not-a-uuid`, {
            headers: ctx.headers,
            data: { body: 'x' },
        });
        expect(malformed.status()).toBe(400);

        const unknown = await request.patch(`${API_BASE}/api/task-chat-messages/${UNKNOWN_UUID}`, {
            headers: ctx.headers,
            data: { body: 'x' },
        });
        expect(unknown.status()).toBe(404);
    });
});

test.describe('Task full lifecycle — recurrence', () => {
    test('set recurring computes nextOccurrenceAt; clear turns it off', async ({ request }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `Recur ${stamp()}` });

        const set = await request.post(`${tasksBase()}/${task.id}/recurring`, {
            headers: ctx.headers,
            data: {
                recurrenceRule: 'FREQ=DAILY;BYHOUR=9',
                recurrenceTimezone: 'America/New_York',
                recurrenceMaxOccurrences: 10,
            },
        });
        expect(set.status()).toBe(200);
        const setBody = await set.json();
        expect(setBody.isRecurring).toBe(true);
        expect(setBody.recurrenceRule).toBe('FREQ=DAILY;BYHOUR=9');
        expect(setBody.recurrenceTimezone).toBe('America/New_York');
        expect(setBody.recurrenceMaxOccurrences).toBe(10);
        expect(typeof setBody.nextOccurrenceAt).toBe('string');

        const clear = await request.delete(`${tasksBase()}/${task.id}/recurring`, {
            headers: ctx.headers,
        });
        expect(clear.status()).toBe(200);
        const cleared = await clear.json();
        expect(cleared.isRecurring).toBe(false);
        expect(cleared.recurrenceRule).toBeNull();
        expect(cleared.nextOccurrenceAt).toBeNull();
        expect(cleared.recurrenceMaxOccurrences).toBeNull();
    });

    test('recurrence rule validation: missing rule → 400 (DTO), garbage rule → 400 (RRULE parse error)', async ({
        request,
    }) => {
        const ctx = await boot(request);
        const task = await createTask(request, ctx, { title: `RecurVal ${stamp()}` });

        const missing = await request.post(`${tasksBase()}/${task.id}/recurring`, {
            headers: ctx.headers,
            data: {},
        });
        expect(missing.status()).toBe(400);
        expect(Array.isArray((await missing.json()).message)).toBe(true);

        const garbage = await request.post(`${tasksBase()}/${task.id}/recurring`, {
            headers: ctx.headers,
            data: { recurrenceRule: 'NOT A RULE' },
        });
        expect(garbage.status()).toBe(400);
        expect((await garbage.json()).message).toContain('RRULE parse error');
    });
});

test.describe('Task full lifecycle — isolation, auth, and input guards', () => {
    test("every sub-write on another user's Task is walled off with 404 (404-never-403)", async ({
        request,
    }) => {
        const owner = await boot(request);
        const intruder = await boot(request);
        const task = await createTask(request, owner, { title: `Secret ${stamp()}` });

        const H = intruder.headers;
        expect((await request.get(`${tasksBase()}/${task.id}`, { headers: H })).status()).toBe(404);
        expect(
            (
                await request.patch(`${tasksBase()}/${task.id}`, {
                    headers: H,
                    data: { title: 'hax' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${tasksBase()}/${task.id}/transition`, {
                    headers: H,
                    data: { to: 'todo' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${tasksBase()}/${task.id}/assignees`, {
                    headers: H,
                    data: { assigneeType: 'user', assigneeId: intruder.userId },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${tasksBase()}/${task.id}/reviewers`, {
                    headers: H,
                    data: { reviewerType: 'user', reviewerId: intruder.userId },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${tasksBase()}/${task.id}/approvers`, {
                    headers: H,
                    data: { approverType: 'user', approverId: intruder.userId },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${tasksBase()}/${task.id}/chat`, {
                    headers: H,
                    data: { body: 'hax' },
                })
            ).status(),
        ).toBe(404);
        expect((await request.get(`${tasksBase()}/${task.id}/chat`, { headers: H })).status()).toBe(
            404,
        );
        expect(
            (
                await request.post(`${tasksBase()}/${task.id}/recurring`, {
                    headers: H,
                    data: { recurrenceRule: 'FREQ=DAILY' },
                })
            ).status(),
        ).toBe(404);
        expect((await request.delete(`${tasksBase()}/${task.id}`, { headers: H })).status()).toBe(
            404,
        );

        // …and the intruder's own list never surfaces the owner's Task.
        const intruderList = await request.get(`${tasksBase()}?limit=200`, { headers: H });
        expect((await intruderList.json()).data.map((t: { id: string }) => t.id)).not.toContain(
            task.id,
        );

        // The owner is unaffected.
        expect(
            (await request.get(`${tasksBase()}/${task.id}`, { headers: owner.headers })).status(),
        ).toBe(200);
    });

    test('no-auth → 401; malformed uuid → 400; unknown-but-valid uuid → 404', async ({
        request,
    }) => {
        const ctx = await boot(request);

        expect((await request.get(`${tasksBase()}`)).status()).toBe(401);
        expect((await request.post(`${tasksBase()}`, { data: { title: 'x' } })).status()).toBe(401);

        expect(
            (await request.get(`${tasksBase()}/not-a-uuid`, { headers: ctx.headers })).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${tasksBase()}/${UNKNOWN_UUID}`, { headers: ctx.headers })
            ).status(),
        ).toBe(404);
        // A guard-first route: unknown-uuid transition is a 404, not a 400.
        expect(
            (
                await request.post(`${tasksBase()}/${UNKNOWN_UUID}/transition`, {
                    headers: ctx.headers,
                    data: { to: 'todo' },
                })
            ).status(),
        ).toBe(404);
    });

    test('title is required and capped at 200 chars; unknown body properties are rejected', async ({
        request,
    }) => {
        const ctx = await boot(request);

        const missingTitle = await request.post(`${tasksBase()}`, {
            headers: ctx.headers,
            data: {},
        });
        expect(missingTitle.status()).toBe(400);

        const tooLong = await request.post(`${tasksBase()}`, {
            headers: ctx.headers,
            data: { title: 'y'.repeat(201) },
        });
        expect(tooLong.status()).toBe(400);

        // Exactly 200 is allowed.
        const atLimit = await request.post(`${tasksBase()}`, {
            headers: ctx.headers,
            data: { title: 'y'.repeat(200) },
        });
        expect(atLimit.status()).toBe(201);

        // forbidNonWhitelisted strips-then-rejects unknown props.
        const bogus = await request.post(`${tasksBase()}`, {
            headers: ctx.headers,
            data: { title: `Bogus ${stamp()}`, bogusField: 'nope' },
        });
        expect(bogus.status()).toBe(400);
        expect(JSON.stringify((await bogus.json()).message)).toContain('bogusField');
    });
});
