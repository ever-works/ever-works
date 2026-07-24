/**
 * Inbound Trigger → fire (HMAC) → spawned Task → target Agent → AGENT-RUN chain.
 *
 * The sibling inbound-trigger specs each stop at the Task boundary:
 *   • flow-inbound-triggers-deep.spec.ts            → CRUD + the public HMAC fire path.
 *   • flow-inbound-triggers-security-deep.spec.ts   → signature / timestamp / content-type / ordering
 *                                                     + "the spawned Task carries the agent" (re-add 409).
 *   • flow-inbound-triggers-validation-matrix.spec.ts → per-field DTO + authz + lifecycle idempotency.
 * NONE of them walk the last hop — from the trigger-spawned Task INTO the agent
 * runtime. THIS file drives the full cross-feature chain end-to-end:
 *
 *     create Agent → create Trigger { targetAgentId, taskTitleTemplate }
 *       → fire (HMAC)            → 200 { ok, taskId, taskSlug:'T-n' }
 *       → the spawned Task       → title from the {name} template, status 'backlog',
 *                                  description embeds the fired JSON, owned by the trigger OWNER
 *       → assign-task            → 500 (Trigger.dev unbound in the CI driver) BUT an AgentRun row
 *                                  persists: { status:'failed', triggerKind:'task',
 *                                  taskId === the spawned Task, errorMessage 'enqueue-failed: …' }
 *       → the run history        → links the trigger-spawned Task back to its agent by UUID.
 *
 * Distinct cross-feature angles pinned here (never covered by the siblings):
 *   • the assign-task → /runs linkage for a TRIGGER-spawned Task (not a hand-made one);
 *   • routing isolation — two triggers → two agents, each fired Task lands ONLY in its own
 *     agent's runs;
 *   • the target-agent assignment tracks the trigger's CURRENT state (PATCH set / clear);
 *   • the chain tolerates a since-archived / hard-deleted target agent (best-effort assign,
 *     Task still spawns, fire still 200);
 *   • Task provenance + authz through the PUBLIC (anonymous) fire — the Task and the agent
 *     runs belong to the owner, a stranger is 404 everywhere;
 *   • fireCount tracks the spawned-Task count; a paused trigger produces NO Task (409, no side
 *     effect); the spawned Task is a first-class Task you can transition and re-run.
 *
 * ── Probed LIVE against http://127.0.0.1:3100 (sqlite in-memory, all flags ON, NO
 *    TRIGGER_SECRET_KEY) before every assertion. Observed on the CI driver:
 *      fire → { ok:true, taskId:<uuid>, taskSlug:'T-n' }
 *      Task → { userId:<owner>, slug:'T-n', title:'Handle: <name>', status:'backlog',
 *               priority:'p3', description contains the fired payload }
 *      assign-task → 500 "assign-task enqueue failed: …TRIGGER_SECRET_KEY…"
 *      /runs → { data:[{ status:'failed', triggerKind:'task', errorMessage:'enqueue-failed: …',
 *               taskId:<spawned>, finishedAt:<set> }], meta:{ total, limit:25, offset:0 } }
 *      re-add the pre-attached agent → 409; a cross-user Task/agent → 404; assign unknown agent
 *      → 404 / malformed → 400. env-adaptive: assign is asserted [202,500] and the run RECORD is
 *      the source of truth (never successful completion).
 *
 * Fully API-orchestrated; a FRESH registerUserViaAPI() owner per test. The `flow-` prefix runs
 * it in the authed chromium project and keeps it out of the no-auth testIgnore regex.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    createAgentViaAPI,
    addTaskAssignee,
    transitionTaskViaAPI,
    listAgentRuns,
    type AgentRun,
} from './helpers/agents-tasks';
import { createTriggerViaAPI, fireTrigger, TRIGGERS_BASE } from './helpers/triggers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_SLUG_RE = /^T-\d+$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const AGENTS = `${API_BASE}/api/agents`;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SpawnedTask {
    id: string;
    userId: string;
    slug: string;
    title: string;
    description: string;
    status: string;
    priority: string;
}

/** GET one Task by id as its owner (the fire endpoint hands back taskId). */
async function getTask(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<SpawnedTask> {
    const res = await request.get(`${API_BASE}/api/tasks/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/**
 * Fire an assign-task at an agent. Trigger.dev is unbound on the CI driver, so the HTTP layer
 * 500s — but a run row is persisted either way (202 only if Trigger.dev were wired). Returns the
 * observed status so callers assert the run RECORD env-adaptively.
 */
async function assign(
    request: APIRequestContext,
    token: string,
    agentId: string,
    taskId: string,
): Promise<number> {
    const res = await request.post(`${AGENTS}/${agentId}/assign-task`, {
        headers: authedHeaders(token),
        data: { taskId },
    });
    expect([202, 500], `assign-task status body=${await res.text().catch(() => '')}`).toContain(
        res.status(),
    );
    return res.status();
}

/** Fire a trigger and return the parsed spawned-Task pointer (asserts the fire 200 shape). */
async function fireAndSpawn(
    request: APIRequestContext,
    triggerId: string,
    secret: string,
    rawBody: string,
): Promise<{ taskId: string; taskSlug: string }> {
    const res = await fireTrigger(request, triggerId, secret, rawBody);
    expect(res.status(), `fire body=${await res.text().catch(() => '')}`).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.taskId).toMatch(UUID_RE);
    expect(json.taskSlug).toMatch(TASK_SLUG_RE);
    return { taskId: json.taskId, taskSlug: json.taskSlug };
}

/** Assert a persisted AgentRun row exists for `taskId`, env-adaptively on the enqueue outcome. */
function expectTaskRun(runs: AgentRun[], taskId: string, assignStatus: number): AgentRun {
    const run = runs.find((r) => r.taskId === taskId);
    expect(run, `an AgentRun row must persist for task ${taskId}`).toBeTruthy();
    expect(run!.id).toMatch(UUID_RE);
    expect(run!.triggerKind).toBe('task');
    // The run points back at the spawned Task by its UUID (never the T-n slug).
    expect(run!.taskId).toBe(taskId);
    if (assignStatus === 500) {
        expect(run!.status).toBe('failed');
        expect(String(run!.errorMessage)).toContain('enqueue-failed');
    } else {
        expect(['queued', 'running', 'succeeded', 'failed']).toContain(run!.status);
    }
    return run!;
}

// ───────────────────────────────────────────────────────────────────────────
// A — the core chain: Trigger → fire → Task → target Agent → agent run
// ───────────────────────────────────────────────────────────────────────────
test.describe('Inbound Trigger → fire → Task → agent-run chain', () => {
    test('full chain: a fired trigger spawns a Task that drives a real agent run linked back to it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Handler ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Chain ${stamp()}`,
            taskTitleTemplate: 'Handle: {name}',
            targetAgentId: agent.id,
        });

        const { taskId } = await fireAndSpawn(
            request,
            trigger.id,
            secret,
            '{"event":"chain","n":1}',
        );

        // The spawned Task is real, owned by the trigger owner, titled from the template.
        const task = await getTask(request, token, taskId);
        expect(task.userId).toBe(user.user.id);
        expect(task.title).toBe(`Handle: ${trigger.name}`);
        expect(task.status).toBe('backlog');
        expect(task.priority).toBe('p3');

        // Drive the last hop: assign the spawned Task to the agent → an AgentRun persists.
        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        const run = expectTaskRun(runs, taskId, status);
        expect(run.taskId).toBe(taskId);
    });

    test('the fire PRE-attaches the target agent (re-add → 409); assign-task enqueues an INDEPENDENT run', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Pre ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Attach ${stamp()}`,
            targetAgentId: agent.id,
        });

        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');

        // The fire already attached the agent as a Task assignee — a second add of the same
        // (task, agent) pair conflicts. Proves the spawned Task carries the target agent.
        const readd = await request.post(`${API_BASE}/api/tasks/${taskId}/assignees`, {
            headers: authedHeaders(token),
            data: { assigneeType: 'agent', assigneeId: agent.id },
        });
        expect(readd.status()).toBe(409);

        // The assignee row and the AgentRun are DIFFERENT mechanisms: assign-task enqueues a run
        // regardless of the pre-existing assignee (no 409 on the run path).
        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        expectTaskRun(runs, taskId, status);
    });

    test('multi-fire spawns DISTINCT Tasks; each assigns to the agent and the run set covers them all', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Fanout ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Multi ${stamp()}`,
            targetAgentId: agent.id,
        });

        const spawned: { taskId: string; taskSlug: string }[] = [];
        for (let i = 0; i < 3; i++) {
            spawned.push(await fireAndSpawn(request, trigger.id, secret, `{"i":${i}}`));
        }
        // Every fire is a fresh Task with a distinct id AND a distinct slug.
        expect(new Set(spawned.map((s) => s.taskId)).size).toBe(3);
        expect(new Set(spawned.map((s) => s.taskSlug)).size).toBe(3);

        for (const s of spawned) {
            await assign(request, token, agent.id, s.taskId);
        }
        const runs = await listAgentRuns(request, token, agent.id);
        const runTaskIds = runs.map((r) => r.taskId);
        for (const s of spawned) {
            expect(runTaskIds).toContain(s.taskId);
        }
    });

    test('run detail (/:id/runs/:runId) for a trigger-spawned Task carries logs[]; a foreign agent runId → 404', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const a = await createAgentViaAPI(request, token, { name: `DetailA ${stamp()}` });
        const b = await createAgentViaAPI(request, token, { name: `DetailB ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Detail ${stamp()}`,
            targetAgentId: a.id,
        });

        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        const status = await assign(request, token, a.id, taskId);
        const runs = await listAgentRuns(request, token, a.id);
        const run = expectTaskRun(runs, taskId, status);

        const detail = await request.get(`${AGENTS}/${a.id}/runs/${run.id}`, { headers: H });
        expect(detail.status()).toBe(200);
        const d = await detail.json();
        expect(d.id).toBe(run.id);
        expect(d.triggerKind).toBe('task');
        expect(d.taskId).toBe(taskId);
        expect(Array.isArray(d.logs)).toBe(true);

        // A's runId requested under B (same user, different agent) → 404.
        const crossAgent = await request.get(`${AGENTS}/${b.id}/runs/${run.id}`, { headers: H });
        expect(crossAgent.status()).toBe(404);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// B — the target-agent assignment tracks the trigger's CURRENT state
// ───────────────────────────────────────────────────────────────────────────
test.describe('Trigger → Task → Agent: routing tracks the trigger state', () => {
    test('PATCH sets targetAgentId AFTER creation → the next fire pre-assigns that agent → run', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `LateAgent ${stamp()}` });
        // Created WITHOUT a target agent.
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `SetLater ${stamp()}`,
        });

        const patch = await request.patch(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
            data: { targetAgentId: agent.id },
        });
        expect(patch.status()).toBe(200);
        expect((await patch.json()).targetAgentId).toBe(agent.id);

        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        // Now the spawned Task carries the newly-set agent.
        const readd = await request.post(`${API_BASE}/api/tasks/${taskId}/assignees`, {
            headers: authedHeaders(token),
            data: { assigneeType: 'agent', assigneeId: agent.id },
        });
        expect(readd.status()).toBe(409);

        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        expectTaskRun(runs, taskId, status);
    });

    test('PATCH clears targetAgentId (null) → the next fire spawns an UNassigned Task (a fresh add is a clean 201)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Cleared ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `ClearMe ${stamp()}`,
            targetAgentId: agent.id,
        });

        const cleared = await request.patch(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
            data: { targetAgentId: null },
        });
        expect(cleared.status()).toBe(200);
        expect((await cleared.json()).targetAgentId).toBeNull();

        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        // No agent was pre-attached, so adding one now is a clean 201 (not 409).
        const added = await addTaskAssignee(request, token, taskId, {
            assigneeType: 'agent',
            assigneeId: agent.id,
        });
        expect(added.taskId).toBe(taskId);
        expect(added.assigneeId).toBe(agent.id);
    });

    test('two triggers → two agents: each fired Task lands ONLY in its own agent runs', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agentA = await createAgentViaAPI(request, token, { name: `RouteA ${stamp()}` });
        const agentB = await createAgentViaAPI(request, token, { name: `RouteB ${stamp()}` });
        const trigA = await createTriggerViaAPI(request, token, {
            name: `TrigA ${stamp()}`,
            targetAgentId: agentA.id,
        });
        const trigB = await createTriggerViaAPI(request, token, {
            name: `TrigB ${stamp()}`,
            targetAgentId: agentB.id,
        });

        const spawnA = await fireAndSpawn(request, trigA.trigger.id, trigA.secret, '{"r":"a"}');
        const spawnB = await fireAndSpawn(request, trigB.trigger.id, trigB.secret, '{"r":"b"}');
        expect(spawnA.taskId).not.toBe(spawnB.taskId);

        await assign(request, token, agentA.id, spawnA.taskId);
        await assign(request, token, agentB.id, spawnB.taskId);

        const runsA = (await listAgentRuns(request, token, agentA.id)).map((r) => r.taskId);
        const runsB = (await listAgentRuns(request, token, agentB.id)).map((r) => r.taskId);
        expect(runsA).toContain(spawnA.taskId);
        expect(runsA).not.toContain(spawnB.taskId);
        expect(runsB).toContain(spawnB.taskId);
        expect(runsB).not.toContain(spawnA.taskId);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C — the chain tolerates a since-gone target agent (best-effort assignment)
// ───────────────────────────────────────────────────────────────────────────
test.describe('Trigger fire tolerates a missing target agent', () => {
    test('an ARCHIVED target agent: fire still 200 and spawns a readable Task; fireCount advances', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Arch ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `ArchTrig ${stamp()}`,
            targetAgentId: agent.id,
        });

        // Soft-archive the target agent.
        const arch = await request.delete(`${AGENTS}/${agent.id}`, {
            headers: authedHeaders(token),
        });
        expect(arch.status()).toBe(200);
        expect((await arch.json()).archived).toBe(true);

        // The Task must spawn regardless — only the (best-effort) assignment may be skipped.
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        const task = await getTask(request, token, taskId);
        expect(task.id).toBe(taskId);

        const view = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
        });
        expect((await view.json()).fireCount).toBeGreaterThanOrEqual(1);
    });

    test('a HARD-DELETED target agent: the raw-uuid FK is dangling, yet fire still 200 and spawns a Task', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Hard ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `HardTrig ${stamp()}`,
            targetAgentId: agent.id,
        });

        const del = await request.delete(`${AGENTS}/${agent.id}?hard=true`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect((await del.json()).deleted).toBe(true);

        // targetAgentId now points at a dead row (no cascade — it is a raw uuid column). The
        // best-effort assign is caught, so the Task still spawns and the fire is still 200.
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":2}');
        const task = await getTask(request, token, taskId);
        expect(task.id).toBe(taskId);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// D — Task/run provenance + authz through the PUBLIC (anonymous) fire
// ───────────────────────────────────────────────────────────────────────────
test.describe('Trigger chain provenance + authz through the public fire', () => {
    test('the spawned Task belongs to the trigger OWNER (not the anonymous firer); a stranger → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Owned ${stamp()}`,
        });

        // fireTrigger sends NO auth (public HMAC path) — the Task still lands under the owner.
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        const task = await getTask(request, owner.access_token, taskId);
        expect(task.userId).toBe(owner.user.id);

        // The stranger cannot read the owner's spawned Task.
        const strangerGet = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status()).toBe(404);
    });

    test("a stranger cannot drive the owner's trigger-spawned Task into their OWN agent run → 404", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Guarded ${stamp()}`,
        });
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');

        const strangerAgent = await createAgentViaAPI(request, stranger.access_token, {
            name: `Intruder ${stamp()}`,
        });
        // The owner's Task is not reachable for the stranger → assign-task 404 (never 202/500).
        const assignAttempt = await request.post(`${AGENTS}/${strangerAgent.id}/assign-task`, {
            headers: authedHeaders(stranger.access_token),
            data: { taskId },
        });
        expect(assignAttempt.status()).toBe(404);
    });

    test("the owner's agent runs are owner-scoped: a stranger listing them → 404", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `Scoped ${stamp()}`,
        });
        const { trigger, secret } = await createTriggerViaAPI(request, owner.access_token, {
            name: `ScopedTrig ${stamp()}`,
            targetAgentId: agent.id,
        });
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        await assign(request, owner.access_token, agent.id, taskId);

        // Owner sees the run; the stranger gets 404 on the owner's agent runs.
        const ownerRuns = await listAgentRuns(request, owner.access_token, agent.id);
        expect(ownerRuns.map((r) => r.taskId)).toContain(taskId);
        const strangerRuns = await request.get(`${AGENTS}/${agent.id}/runs`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerRuns.status()).toBe(404);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// E — fire counters + spawned-Task lifecycle
// ───────────────────────────────────────────────────────────────────────────
test.describe('Trigger fire counters + spawned-Task lifecycle', () => {
    test('fireCount tracks spawned Tasks; the owner task list gains one templated Task per fire; lastFiredAt advances', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Counter ${stamp()}`,
        });

        const first = await fireAndSpawn(request, trigger.id, secret, '{"i":1}');
        const afterFirst = await (
            await request.get(`${TRIGGERS_BASE}/${trigger.id}`, { headers: authedHeaders(token) })
        ).json();
        expect(afterFirst.fireCount).toBe(1);
        expect(afterFirst.lastFiredAt).not.toBeNull();

        const second = await fireAndSpawn(request, trigger.id, secret, '{"i":2}');
        const third = await fireAndSpawn(request, trigger.id, secret, '{"i":3}');
        const afterAll = await (
            await request.get(`${TRIGGERS_BASE}/${trigger.id}`, { headers: authedHeaders(token) })
        ).json();
        expect(afterAll.fireCount).toBe(3);
        // lastFiredAt is monotonic non-decreasing across fires.
        expect(new Date(afterAll.lastFiredAt).getTime()).toBeGreaterThanOrEqual(
            new Date(afterFirst.lastFiredAt).getTime(),
        );

        // The owner's task list holds exactly the three spawned Tasks (fresh user).
        const list = await request.get(`${API_BASE}/api/tasks?limit=200`, {
            headers: authedHeaders(token),
        });
        expect(list.status()).toBe(200);
        const ids = ((await list.json()).data as { id: string }[]).map((t) => t.id);
        for (const s of [first, second, third]) {
            expect(ids).toContain(s.taskId);
        }
    });

    test('the spawned Task is first-class: starts backlog, transitions to todo, then still drives a run', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Lifecycle ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Live ${stamp()}`,
            targetAgentId: agent.id,
        });

        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        const task = await getTask(request, token, taskId);
        expect(task.status).toBe('backlog');

        const moved = await transitionTaskViaAPI(request, token, taskId, 'todo');
        expect(moved.status).toBe('todo');

        // A transitioned Task is still runnable against the agent.
        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        expectTaskRun(runs, taskId, status);
    });

    test('a PAUSED trigger spawns NO Task (409) and leaves the owner task set empty; resume → fire spawns one', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Pausable ${stamp()}`,
        });

        const pause = await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(pause.status()).toBe(200);

        // A fire against a paused trigger is a 409 with NO spawned Task.
        const paused = await fireTrigger(request, trigger.id, secret, '{"e":1}');
        expect(paused.status()).toBe(409);
        const emptyList = await request.get(`${API_BASE}/api/tasks?limit=200`, {
            headers: authedHeaders(token),
        });
        expect((await emptyList.json()).data.length).toBe(0);

        // Resume, then the fire spawns a Task that appears in the owner's list.
        expect(
            (
                await request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(200);
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":2}');
        const afterList = await request.get(`${API_BASE}/api/tasks?limit=200`, {
            headers: authedHeaders(token),
        });
        const ids = ((await afterList.json()).data as { id: string }[]).map((t) => t.id);
        expect(ids).toContain(taskId);
        expect(ids.length).toBe(1);
    });

    test("a kind:'api' trigger drives the identical Task → agent-run chain as a webhook trigger", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `ApiAgent ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `ApiKind ${stamp()}`,
            kind: 'api',
            targetAgentId: agent.id,
        });
        expect(trigger.kind).toBe('api');

        // kind is informational — both kinds fire the same endpoint and drive the same chain.
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        expectTaskRun(runs, taskId, status);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// F — run-chain edges + baseline
// ───────────────────────────────────────────────────────────────────────────
test.describe('Trigger chain — run-chain edges + baseline', () => {
    test('a fresh agent has an EMPTY run history until a trigger-spawned Task is assigned', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Baseline ${stamp()}` });

        // No runs before anything is assigned.
        expect((await listAgentRuns(request, token, agent.id)).length).toBe(0);

        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `BaseTrig ${stamp()}`,
            targetAgentId: agent.id,
        });
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');
        const status = await assign(request, token, agent.id, taskId);

        const runs = await listAgentRuns(request, token, agent.id);
        expect(runs.length).toBeGreaterThanOrEqual(1);
        expectTaskRun(runs, taskId, status);
    });

    test('assigning the SAME trigger-spawned Task twice yields two DISTINCT runs (no dedup once terminal)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `NoDedup ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Dedup ${stamp()}`,
            targetAgentId: agent.id,
        });
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');

        await assign(request, token, agent.id, taskId);
        await assign(request, token, agent.id, taskId);

        const runs = await listAgentRuns(request, token, agent.id);
        const forTask = runs.filter((r) => r.taskId === taskId);
        // Both prior runs went terminal (failed), so the second assign could not reuse an
        // in-flight row → two rows for this (task, agent) pair with distinct ids.
        expect(forTask.length).toBeGreaterThanOrEqual(2);
        expect(new Set(forTask.map((r) => r.id)).size).toBe(forTask.length);
    });

    test('assign-task on a trigger-spawned Task: unknown agent → 404, malformed agent id → 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `Negatives ${stamp()}`,
        });
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, '{"e":1}');

        const unknown = await request.post(`${AGENTS}/${UNKNOWN_UUID}/assign-task`, {
            headers: authedHeaders(token),
            data: { taskId },
        });
        expect(unknown.status()).toBe(404);

        const malformed = await request.post(`${AGENTS}/not-a-uuid/assign-task`, {
            headers: authedHeaders(token),
            data: { taskId },
        });
        expect(malformed.status()).toBe(400);
    });

    test('rotate-secret mid-stream → a fire under the NEW secret still spawns a Task that drives the run', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Rotator ${stamp()}` });
        const { trigger, secret: oldSecret } = await createTriggerViaAPI(request, token, {
            name: `Rotate ${stamp()}`,
            targetAgentId: agent.id,
        });

        const rotate = await request.post(`${TRIGGERS_BASE}/${trigger.id}/rotate-secret`, {
            headers: authedHeaders(token),
        });
        expect(rotate.status()).toBe(200);
        const newSecret = (await rotate.json()).secret as string;
        expect(newSecret).not.toBe(oldSecret);

        const { taskId } = await fireAndSpawn(request, trigger.id, newSecret, '{"e":1}');
        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        expectTaskRun(runs, taskId, status);
    });

    test('the spawned Task description embeds the fired JSON payload, and the linked run points at that same Task', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Payload ${stamp()}` });
        const { trigger, secret } = await createTriggerViaAPI(request, token, {
            name: `PayloadTrig ${stamp()}`,
            targetAgentId: agent.id,
        });

        const marker = `chain-${stamp()}`;
        const payload = `{"event":"${marker}","amount":4200}`;
        const { taskId } = await fireAndSpawn(request, trigger.id, secret, payload);

        // The service records the raw payload in the Task description.
        const task = await getTask(request, token, taskId);
        expect(task.description).toContain(marker);
        expect(task.description).toContain('4200');
        expect(task.description).toContain(trigger.id);

        // And the agent run for that Task points back at it by UUID.
        const status = await assign(request, token, agent.id, taskId);
        const runs = await listAgentRuns(request, token, agent.id);
        const run = expectTaskRun(runs, taskId, status);
        expect(run.taskId).toBe(task.id);
        expect(run.taskId).not.toBe(task.slug);
    });
});
