import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

/**
 * AgentRun TERMINAL-TRANSITION ATOMICITY — the #1727 compare-and-set (CAS)
 * guard + the #1733 orphaned-queued-run reconciliation, probed end-to-end
 * against the live CI driver (http://127.0.0.1:3100, sqlite in-memory, NO
 * TRIGGER_SECRET_KEY, NO Trigger.dev worker).
 *
 * The AgentRun repository (`packages/agent/src/database/repositories/
 * agent-run.repository.ts`) makes EVERY terminal write CAS-guarded — `cancel`,
 * `markStarted`, `markCompleted`, `markFailed`, `markDispatchFailed` all pin a
 * `WHERE status IN (allowedFrom)` clause so a row that is already terminal
 * (`failed` / `completed` / `cancelled`) can never be double-transitioned,
 * and a queued row that lost its dispatch is reconciled to `failed` rather
 * than stranded (there is NO agent_runs sweeper). This file drives the two
 * terminal transitions that ARE reachable over HTTP on the keyless stack —
 * the dispatch-failure reconcile (assign-task / run-now) and the cancel
 * no-op — and pins their atomicity + convergence + field-invariance.
 *
 * ── PROBED LIVE (2026-07-21, every assertion observed via curl first) ──────
 *   • POST /:id/assign-task {taskId} — pre-creates a `queued` AgentRun
 *     (triggerKind 'task', taskId set) then enqueues. Keyless → the enqueue
 *     THROWS, the controller rolls the row back via markDispatchFailed
 *     (queued→failed CAS) and returns HTTP 500, but a DURABLE terminal row
 *     survives: { status:'failed', triggerKind:'task', taskId:<set>,
 *     startedAt:null, finishedAt:<set>, durationMs:null, summary:null,
 *     errorMessage:'enqueue-failed: You need to set the TRIGGER_SECRET_KEY …' }.
 *   • POST /:id/run-now on an ACTIVE agent — dispatchOne() pre-creates a
 *     `queued` run (triggerKind 'manual', taskId NULL) then enqueues. Keyless
 *     → HTTP 500, and the SAME reconcile fires: the row lands terminal with
 *     errorMessage prefix 'dispatch-failed: …' (a DISTINCT prefix from the
 *     assign path). The agent's manual claim is released → it recovers to
 *     'active' (never stranded RUNNING). #1733: the queued row is NEVER left
 *     orphaned in queued/running.
 *   • POST /:id/run-now on a NON-active agent (draft/paused) → 409 "Agent is
 *     not in an ACTIVE state — pause / resume it first." — gated BEFORE
 *     createQueued, so NO run row is recorded (contrast assign-task, which is
 *     not status-gated and records a run even on a draft agent).
 *   • POST /:id/runs/:runId/cancel on an already-terminal (failed) run → 200
 *     { cancelled:false, previousStatus:'failed' } — the CAS `WHERE status IN
 *     (queued,running)` matches nothing, so ZERO columns mutate (finishedAt /
 *     durationMs / errorMessage all stay put). Idempotent under repeat + burst.
 *   • Cancel scoping ASYMMETRY (a genuine, pinned quirk): cancel resolves the
 *     run by (runId, userId) only — so a same-user cancel routed through a
 *     DIFFERENT agent's :id still reaches the run and 200s, whereas GET
 *     /:id/runs/:runId is agent-scoped and 404s on the same cross-agent id.
 *   • Cancel errors: unknown runId → 404 "AgentRun <id> not found."; malformed
 *     runId/agentId → 400 (ParseUUIDPipe); anonymous → 401; cross-USER (agent
 *     gate) → 404 with the victim's row provably untouched.
 *
 * ── NON-DUPLICATION (distinct from the three closest siblings) ─────────────
 *   • flow-agent-lifecycle-runs-multistep.spec.ts — the cradle-to-grave story,
 *     assign persistence, one cancel-on-terminal no-op, state machine.
 *   • flow-concurrency-agents-matrix.spec.ts — parallel STATUS transitions
 *     (pause/resume/archive CAS) + parallel ASSIGN-TASK bursts + run-now agent
 *     recovery. It never races the CANCEL CAS, never pins the run-now MANUAL
 *     run RECORD (+ its dispatch-failed prefix), never asserts cancel
 *     field-invariance, and never pins the cancel-vs-getRun scoping asymmetry.
 *   • flow-agent-runs-pagination.spec.ts — pagination envelope, one terminal
 *     cancel no-op (status/total only). Its 2026-06-01 note that run-now
 *     "throws BEFORE persisting → NO row" is STALE for the ACTIVE path (the
 *     heartbeat trigger is now bound and reconciles a MANUAL row) — pinned here.
 *   This file owns: the cancel-CAS convergence (parallel + serial), the
 *   BYTE-LEVEL field-invariance of the terminal row across cancels/redispatch,
 *   the run-now MANUAL reconcile record + prefix, the mixed-path no-orphan
 *   invariant, and the cancel/getRun scoping asymmetry — none pinned elsewhere.
 *
 * Every test registers a FRESH registerUserViaAPI() owner (never the shared
 * seeded user), uses unique suffixes, asserts ids via toContain/not.toContain,
 * and never asserts a global count. Fully API-orchestrated (safe `flow-`
 * prefix). Parallelism is used ONLY for the cancel-CAS convergence (cancels
 * are cheap DB CAS ops); dispatch calls stay serial.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const AGENTS = `${API_BASE}/api/agents`;

/** Terminal-run error prefixes for the two distinct reconcile callers. */
const ENQUEUE_PREFIX = 'enqueue-failed:'; // assign-task path
const DISPATCH_PREFIX = 'dispatch-failed:'; // run-now (manual) path

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

interface RunDetail extends RunRow {
    chatMessageId: string | null;
    memorySessionId: string | null;
    logs: Array<Record<string, unknown>>;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function H(token: string): Record<string, string> {
    return { ...authedHeaders(token), 'content-type': 'application/json' };
}

/** Drive a fresh draft agent → active via /resume (200 required). */
async function activate(request: APIRequestContext, token: string, id: string): Promise<void> {
    const res = await request.post(`${AGENTS}/${id}/resume`, { headers: H(token) });
    expect(res.status(), `activate body=${await res.text().catch(() => '')}`).toBe(200);
    expect((await res.json()).status).toBe('active');
}

async function getRunsPage(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<{ data: RunRow[]; meta: { total: number; limit: number; offset: number } }> {
    const res = await request.get(`${AGENTS}/${agentId}/runs?limit=200`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `runs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getRunDetail(
    request: APIRequestContext,
    token: string,
    agentId: string,
    runId: string,
): Promise<RunDetail> {
    const res = await request.get(`${AGENTS}/${agentId}/runs/${runId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `run detail body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** POST cancel and return the parsed { status, body }. */
async function cancel(
    request: APIRequestContext,
    token: string,
    agentId: string,
    runId: string,
): Promise<{ status: number; body: { cancelled?: boolean; previousStatus?: string } }> {
    const res = await request.post(`${AGENTS}/${agentId}/runs/${runId}/cancel`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/**
 * Fire assign-task and wait until the (task,agent) run has reconciled to a
 * TERMINAL state, returning it. Keyless CI → the row lands 'failed'. The HTTP
 * result is tolerated ([202,500]) — the durable run record is the contract.
 */
/**
 * Fire assign-task and wait for its run row to reconcile to a terminal status.
 *
 * `excludeRunIds` MUST be passed when re-assigning a (task,agent) pair that
 * already has runs: the row is written asynchronously after the request
 * returns, so a poll that accepts ANY terminal row for the task is satisfied
 * immediately by the PREVIOUS assign's row and returns the stale id before the
 * new one lands. Excluding the known ids makes the poll wait for the genuinely
 * new record.
 */
async function assignAndSettle(
    request: APIRequestContext,
    token: string,
    agentId: string,
    taskId: string,
    excludeRunIds: readonly string[] = [],
): Promise<RunRow> {
    const res = await request.post(`${AGENTS}/${agentId}/assign-task`, {
        headers: H(token),
        data: { taskId },
    });
    expect([202, 500], `assign status ${res.status()}`).toContain(res.status());
    let found: RunRow | undefined;
    await expect
        .poll(
            async () => {
                const page = await getRunsPage(request, token, agentId);
                // Newest-first: pick the most recent NON-terminal-free run for this
                // task, ignoring rows the caller already knows about.
                const rows = page.data.filter(
                    (r) => r.taskId === taskId && !excludeRunIds.includes(r.id),
                );
                found = rows.find((r) => !['queued', 'running'].includes(r.status)) ?? rows[0];
                return found ? !['queued', 'running'].includes(found.status) : false;
            },
            { timeout: 15_000, message: `assign-task run for ${taskId} must reconcile terminal` },
        )
        .toBe(true);
    return found!;
}

/**
 * Fire run-now on an ACTIVE agent and wait until the resulting MANUAL run has
 * reconciled terminal, returning it. Keyless CI → 500 + a 'failed' manual row.
 */
async function runNowAndSettle(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<RunRow> {
    const before = (await getRunsPage(request, token, agentId)).data.map((r) => r.id);
    const res = await request.post(`${AGENTS}/${agentId}/run-now`, { headers: H(token) });
    expect([202, 500], `run-now status ${res.status()}`).toContain(res.status());
    let fresh: RunRow | undefined;
    await expect
        .poll(
            async () => {
                const page = await getRunsPage(request, token, agentId);
                fresh = page.data.find((r) => !before.includes(r.id));
                return fresh ? !['queued', 'running'].includes(fresh.status) : false;
            },
            { timeout: 15_000, message: 'run-now must record a terminal manual run' },
        )
        .toBe(true);
    return fresh!;
}

/** The stable columns that a CAS no-op must leave byte-for-byte identical. */
function terminalFingerprint(r: RunRow | RunDetail): string {
    return JSON.stringify({
        id: r.id,
        status: r.status,
        triggerKind: r.triggerKind,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        summary: r.summary,
        errorMessage: r.errorMessage,
        taskId: r.taskId,
        createdAt: r.createdAt,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel CAS — a terminal AgentRun is an immutable no-op.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Cancel CAS — a terminal AgentRun is an immutable no-op', () => {
    test('cancelling a failed task-run mutates NOTHING (byte-identical row) and returns {cancelled:false, previousStatus:failed}', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, { name: `Noop ${stamp()}` });
        const task = await createTaskViaAPI(request, u.access_token, { title: `NoopT ${stamp()}` });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);
        expect(run.status).toBe('failed');

        const before = await getRunDetail(request, u.access_token, agent.id, run.id);
        const fpBefore = terminalFingerprint(before);

        const c = await cancel(request, u.access_token, agent.id, run.id);
        expect(c.status).toBe(200);
        expect(c.body.cancelled, 'a terminal run cannot be cancelled').toBe(false);
        expect(c.body.previousStatus, 'the response echoes the stored terminal status').toBe(
            'failed',
        );

        const after = await getRunDetail(request, u.access_token, agent.id, run.id);
        // The CAS `WHERE status IN (queued,running)` matched zero rows → no UPDATE.
        expect(terminalFingerprint(after), 'the terminal row is byte-identical after cancel').toBe(
            fpBefore,
        );
        expect(after.finishedAt, 'finishedAt was NOT reset to a fresh timestamp').toBe(
            before.finishedAt,
        );
    });

    test('N parallel cancels of the SAME failed run converge to ONE terminal — all 200 no-ops, finishedAt invariant, row never deleted', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, { name: `Race ${stamp()}` });
        const task = await createTaskViaAPI(request, u.access_token, { title: `RaceT ${stamp()}` });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);
        const before = await getRunDetail(request, u.access_token, agent.id, run.id);

        const BURST = 6;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => cancel(request, u.access_token, agent.id, run.id)),
        );
        // No racer wins the CAS against an already-terminal row, and none 5xx.
        for (const r of results) {
            expect(r.status, `every parallel cancel is a clean 200 (got ${r.status})`).toBe(200);
            expect(r.body.cancelled, 'no cancel flips a terminal run').toBe(false);
            expect(r.body.previousStatus).toBe('failed');
        }

        const after = await getRunDetail(request, u.access_token, agent.id, run.id);
        expect(after.status, 'the run stayed in its single terminal state').toBe('failed');
        expect(terminalFingerprint(after), 'no racer mutated the row').toBe(
            terminalFingerprint(before),
        );
        // The row still exists exactly once — cancel never inserts/deletes.
        const page = await getRunsPage(request, u.access_token, agent.id);
        expect(page.data.filter((r) => r.id === run.id)).toHaveLength(1);
        expect(page.meta.total).toBe(1);
    });

    test('repeated SERIAL cancels are idempotent — status + finishedAt stable across every call', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, { name: `Idem ${stamp()}` });
        const task = await createTaskViaAPI(request, u.access_token, { title: `IdemT ${stamp()}` });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);
        const finishedAt0 = run.finishedAt;
        expect(finishedAt0, 'a terminal run carries a finishedAt').toBeTruthy();

        for (let i = 0; i < 5; i++) {
            const c = await cancel(request, u.access_token, agent.id, run.id);
            expect(c.status, `cancel #${i + 1} is a 200 no-op`).toBe(200);
            expect(c.body.cancelled).toBe(false);
            expect(c.body.previousStatus).toBe('failed');
            const detail = await getRunDetail(request, u.access_token, agent.id, run.id);
            expect(detail.status, `still failed after cancel #${i + 1}`).toBe('failed');
            expect(detail.finishedAt, `finishedAt stable after cancel #${i + 1}`).toBe(finishedAt0);
        }
        // The row was never deleted by the cancel storm.
        expect((await getRunsPage(request, u.access_token, agent.id)).meta.total).toBe(1);
    });

    test('cancel guards: unknown runId → 404 exact body; malformed runId → 400; anonymous → 401', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Guard ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `GuardT ${stamp()}`,
        });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);

        // Well-formed but unknown runId under the owner's agent → scoped 404.
        const unknown = await request.post(`${AGENTS}/${agent.id}/runs/${UNKNOWN_UUID}/cancel`, {
            headers: authedHeaders(u.access_token),
        });
        expect(unknown.status()).toBe(404);
        expect(await unknown.json()).toEqual({
            message: `AgentRun ${UNKNOWN_UUID} not found.`,
            error: 'Not Found',
            statusCode: 404,
        });

        // Malformed runId → ParseUUIDPipe 400 (before any lookup).
        const badRun = await request.post(`${AGENTS}/${agent.id}/runs/not-a-uuid/cancel`, {
            headers: authedHeaders(u.access_token),
        });
        expect(badRun.status()).toBe(400);
        // Malformed agentId → ParseUUIDPipe 400 too.
        const badAgent = await request.post(`${AGENTS}/not-a-uuid/runs/${run.id}/cancel`, {
            headers: authedHeaders(u.access_token),
        });
        expect(badAgent.status()).toBe(400);

        // No bearer at all → 401 (the route is not @Public).
        const anon = await request.post(`${AGENTS}/${agent.id}/runs/${run.id}/cancel`);
        expect(anon.status()).toBe(401);

        // None of the rejected cancels touched the run.
        const detail = await getRunDetail(request, u.access_token, agent.id, run.id);
        expect(detail.status).toBe('failed');
    });

    test('a cancel-noop run remains fully queryable via getRun with an identical detail shape (no resurrection)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, { name: `Live ${stamp()}` });
        const task = await createTaskViaAPI(request, u.access_token, { title: `LiveT ${stamp()}` });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);

        const before = await getRunDetail(request, u.access_token, agent.id, run.id);
        await cancel(request, u.access_token, agent.id, run.id);
        const after = await getRunDetail(request, u.access_token, agent.id, run.id);

        expect(after.id).toBe(run.id);
        expect(Array.isArray(after.logs), 'logs[] is still present').toBe(true);
        expect(after.logs, 'a failed-at-dispatch run never emitted logs').toHaveLength(0);
        expect(after.chatMessageId).toBeNull();
        expect(after.memorySessionId).toBeNull();
        expect(terminalFingerprint(after)).toBe(terminalFingerprint(before));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch-failure reconciliation — no orphaned queued run (#1733).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Dispatch-failure reconciliation — no orphaned queued run (#1733)', () => {
    test('assign-task reconciles the queued row to a terminal FAILED run (enqueue-failed prefix, finishedAt set, never orphaned)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `AsgRec ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `AsgRecT ${stamp()}`,
        });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);

        expect(run.status, 'markDispatchFailed reconciled queued → failed').toBe('failed');
        expect(run.triggerKind).toBe('task');
        expect(run.taskId).toBe(task.id);
        // A run that failed AT dispatch never started and has no duration.
        expect(run.startedAt).toBeNull();
        expect(run.durationMs).toBeNull();
        expect(run.summary).toBeNull();
        // …but it IS terminal: finishedAt is stamped at reconciliation time.
        expect(run.finishedAt, 'a reconciled terminal run carries a finishedAt').toBeTruthy();
        expect(String(run.errorMessage)).toContain(ENQUEUE_PREFIX);
        // The orphan invariant: nothing is left in queued/running.
        const page = await getRunsPage(request, u.access_token, agent.id);
        expect(page.data.filter((r) => ['queued', 'running'].includes(r.status))).toHaveLength(0);
    });

    test('run-now on an ACTIVE agent reconciles a terminal MANUAL run (dispatch-failed prefix, taskId null); the agent is released, not stranded RUNNING', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `RnRec ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        const run = await runNowAndSettle(request, u.access_token, agent.id);
        expect(run.status, 'the manual run reconciled to failed').toBe('failed');
        expect(run.triggerKind, 'run-now records a manual-kind run').toBe('manual');
        expect(run.taskId, 'a heartbeat/manual run is not bound to a task').toBeNull();
        expect(run.startedAt).toBeNull();
        expect(run.durationMs).toBeNull();
        expect(run.finishedAt, 'the manual run is terminal (finishedAt stamped)').toBeTruthy();
        // The DISTINCT reconcile caller (dispatchOne) uses a 'dispatch-failed:' prefix.
        expect(String(run.errorMessage)).toContain(DISPATCH_PREFIX);

        // #1733 orphan invariant + the manual claim released the agent to ACTIVE
        // (never left stuck in RUNNING with no worker).
        const page = await getRunsPage(request, u.access_token, agent.id);
        expect(page.data.filter((r) => ['queued', 'running'].includes(r.status))).toHaveLength(0);
        const agentRes = await request.get(`${AGENTS}/${agent.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(agentRes.status()).toBe(200);
        expect(['active', 'error'], 'a failed manual run leaves the agent recoverable').toContain(
            (await agentRes.json()).status,
        );
    });

    test('the two reconcile paths carry DISTINCT error prefixes on one agent (task=enqueue-failed, manual=dispatch-failed)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `TwoRec ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `TwoRecT ${stamp()}`,
        });

        const taskRun = await assignAndSettle(request, u.access_token, agent.id, task.id);
        const manualRun = await runNowAndSettle(request, u.access_token, agent.id);

        // Partition the history by triggerKind and pin each caller's prefix.
        const page = await getRunsPage(request, u.access_token, agent.id);
        const taskRows = page.data.filter((r) => r.triggerKind === 'task');
        const manualRows = page.data.filter((r) => r.triggerKind === 'manual');
        expect(taskRows.map((r) => r.id)).toContain(taskRun.id);
        expect(manualRows.map((r) => r.id)).toContain(manualRun.id);
        for (const r of taskRows) {
            expect(String(r.errorMessage), 'task rows use the assign-path prefix').toContain(
                ENQUEUE_PREFIX,
            );
            expect(r.taskId, 'task rows carry a taskId').toBeTruthy();
        }
        for (const r of manualRows) {
            expect(String(r.errorMessage), 'manual rows use the run-now-path prefix').toContain(
                DISPATCH_PREFIX,
            );
            expect(r.taskId, 'manual rows carry no taskId').toBeNull();
        }
        // The two prefixes are genuinely different strings.
        expect(ENQUEUE_PREFIX).not.toBe(DISPATCH_PREFIX);
    });

    test('after several mixed dispatch failures, EVERY run is terminal (zero orphans) and each carries a finishedAt', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Mixed ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        // 3 distinct task assigns + 2 run-nows → 5 reconciled rows.
        for (let i = 0; i < 3; i++) {
            const t = await createTaskViaAPI(request, u.access_token, {
                title: `Mixed T${i} ${stamp()}`,
            });
            await assignAndSettle(request, u.access_token, agent.id, t.id);
        }
        await runNowAndSettle(request, u.access_token, agent.id);
        await runNowAndSettle(request, u.access_token, agent.id);

        const page = await getRunsPage(request, u.access_token, agent.id);
        expect(page.meta.total, 'every dispatch recorded exactly one run').toBe(5);
        for (const r of page.data) {
            expect(
                ['queued', 'running'].includes(r.status),
                `run ${r.id} must not be orphaned in ${r.status}`,
            ).toBe(false);
            expect(r.status, 'keyless CI reconciles all rows to failed').toBe('failed');
            expect(r.finishedAt, `terminal run ${r.id} has a finishedAt`).toBeTruthy();
        }
        // 3 task-triggered + 2 manual, by construction.
        expect(page.data.filter((r) => r.triggerKind === 'task')).toHaveLength(3);
        expect(page.data.filter((r) => r.triggerKind === 'manual')).toHaveLength(2);
    });

    test('run-now is status-gated (409) BEFORE createQueued — a non-active agent records NO run, unlike assign-task', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        // draft agent: run-now → 409, and NO run row (the gate precedes createQueued).
        const draft = await createAgentViaAPI(request, u.access_token, {
            name: `Gate Draft ${stamp()}`,
        });
        const r1 = await request.post(`${AGENTS}/${draft.id}/run-now`, {
            headers: H(u.access_token),
        });
        expect(r1.status()).toBe(409);
        expect((await r1.json()).message).toMatch(/not in an ACTIVE state/i);
        expect((await getRunsPage(request, u.access_token, draft.id)).meta.total).toBe(0);

        // paused agent: same 409 gate, still no run.
        const paused = await createAgentViaAPI(request, u.access_token, {
            name: `Gate Paused ${stamp()}`,
        });
        await activate(request, u.access_token, paused.id);
        expect(
            (
                await request.post(`${AGENTS}/${paused.id}/pause`, { headers: H(u.access_token) })
            ).status(),
        ).toBe(200);
        const r2 = await request.post(`${AGENTS}/${paused.id}/run-now`, {
            headers: H(u.access_token),
        });
        expect(r2.status()).toBe(409);
        expect((await getRunsPage(request, u.access_token, paused.id)).meta.total).toBe(0);

        // CONTRAST: assign-task is NOT status-gated — a draft agent DOES record a run.
        const draft2 = await createAgentViaAPI(request, u.access_token, {
            name: `Gate Assign ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Gate T ${stamp()}`,
        });
        const run = await assignAndSettle(request, u.access_token, draft2.id, task.id);
        expect(run.taskId).toBe(task.id);
        expect((await getRunsPage(request, u.access_token, draft2.id)).meta.total).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-dispatch after terminal never mutates the prior terminal row.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Re-dispatch after terminal never mutates the prior terminal row', () => {
    test('re-assigning the SAME (task,agent) after a failure mints a NEW distinct run; the prior terminal row is byte-invariant', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Redisp ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `RedispT ${stamp()}`,
        });

        const first = await assignAndSettle(request, u.access_token, agent.id, task.id);
        const firstDetail = await getRunDetail(request, u.access_token, agent.id, first.id);
        const firstFp = terminalFingerprint(firstDetail);

        // The prior run is terminal → NOT in-flight → the dedup slot is free, so
        // a re-assign creates a brand-new row rather than reusing/overwriting.
        const second = await assignAndSettle(request, u.access_token, agent.id, task.id, [
            first.id,
        ]);
        expect(second.id, 'the re-assign minted a DISTINCT run id').not.toBe(first.id);
        expect(second.taskId).toBe(task.id);

        // The append of a new row left the first row completely untouched (the
        // new createQueued+markDispatchFailed is keyed on the NEW id only).
        const firstAfter = await getRunDetail(request, u.access_token, agent.id, first.id);
        expect(terminalFingerprint(firstAfter), 'the original terminal row is byte-invariant').toBe(
            firstFp,
        );
        const page = await getRunsPage(request, u.access_token, agent.id);
        expect(page.meta.total, 'exactly two durable rows for the (task,agent) pair').toBe(2);
    });

    test('a failed run frees the (task,agent) dedup slot — 3 serial assigns of one task → 3 DISTINCT terminal rows, no orphan', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Slot ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, { title: `SlotT ${stamp()}` });

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            // Exclude the ids already minted so the poll waits for THIS assign's row
            // instead of settling on a previous (already terminal) one.
            const run = await assignAndSettle(request, u.access_token, agent.id, task.id, ids);
            ids.push(run.id);
        }
        // Three genuinely separate records — no dedup-to-one against a failed run.
        expect(new Set(ids).size, 'each assign minted a distinct run').toBe(3);

        const page = await getRunsPage(request, u.access_token, agent.id);
        const forTask = page.data.filter((r) => r.taskId === task.id);
        expect(forTask, 'all three rows are attributed to the one task').toHaveLength(3);
        for (const r of forTask) {
            expect(r.status, 'every re-dispatch reconciled terminal').toBe('failed');
            expect(r.triggerKind).toBe('task');
        }
        expect(page.data.filter((r) => ['queued', 'running'].includes(r.status))).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconciled-run detail shape.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Reconciled-run detail shape', () => {
    test('getRun on a manual dispatch-failed run exposes the full detail envelope (manual, taskId null, logs [], no chat/memory ids)', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `MDetail ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const run = await runNowAndSettle(request, u.access_token, agent.id);

        const d = await getRunDetail(request, u.access_token, agent.id, run.id);
        expect(d.id).toBe(run.id);
        expect(d.id).toMatch(UUID_RE);
        expect(d.triggerKind).toBe('manual');
        expect(d.status).toBe('failed');
        expect(d.taskId).toBeNull();
        expect(d.startedAt).toBeNull();
        expect(d.durationMs).toBeNull();
        expect(d.summary).toBeNull();
        expect(d.finishedAt).toBeTruthy();
        expect(String(d.errorMessage)).toContain(DISPATCH_PREFIX);
        // Detail-only fields.
        expect(d).toHaveProperty('chatMessageId', null);
        expect(d).toHaveProperty('memorySessionId', null);
        expect(Array.isArray(d.logs)).toBe(true);
        expect(d.logs).toHaveLength(0);
    });

    test('getRun on a task enqueue-failed run carries the taskId + enqueue-failed message + empty logs', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `TDetail ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `TDetailT ${stamp()}`,
        });
        const run = await assignAndSettle(request, u.access_token, agent.id, task.id);

        const d = await getRunDetail(request, u.access_token, agent.id, run.id);
        expect(d.triggerKind).toBe('task');
        expect(d.taskId).toBe(task.id);
        expect(d.startedAt).toBeNull();
        expect(d.finishedAt).toBeTruthy();
        expect(String(d.errorMessage)).toContain(ENQUEUE_PREFIX);
        expect(d.logs).toHaveLength(0);
        expect(d).toHaveProperty('memorySessionId', null);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Run scoping asymmetry: cancel is user-scoped, run-read is agent-scoped.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Run scoping asymmetry — cancel is user-scoped, run-read is agent-scoped', () => {
    test("same user, cross-agent: getRun 404s (agent-scoped) but cancel 200-no-ops (user-scoped); the run's own agent is untouched", async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const owner = await createAgentViaAPI(request, u.access_token, {
            name: `AsymA ${stamp()}`,
        });
        const other = await createAgentViaAPI(request, u.access_token, {
            name: `AsymB ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `AsymT ${stamp()}`,
        });
        const run = await assignAndSettle(request, u.access_token, owner.id, task.id);

        // getRun is agent-scoped (`run.agentId !== id` → 404): the run does NOT
        // belong to `other`, so reading it under `other`'s :id is a 404.
        const crossRead = await request.get(`${AGENTS}/${other.id}/runs/${run.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(crossRead.status(), 'cross-agent run READ is agent-scoped 404').toBe(404);

        // cancel resolves the run by (runId, userId) ONLY — the :id agent is not
        // matched — so the same cross-agent cancel REACHES the run and 200-no-ops.
        const crossCancel = await cancel(request, u.access_token, other.id, run.id);
        expect(crossCancel.status, 'cross-agent (same-user) cancel is user-scoped 200').toBe(200);
        expect(crossCancel.body.cancelled).toBe(false);
        expect(crossCancel.body.previousStatus).toBe('failed');

        // The run is still readable + terminal under its OWN agent, untouched.
        const readBack = await getRunDetail(request, u.access_token, owner.id, run.id);
        expect(readBack.status).toBe('failed');
        // The `other` agent recorded nothing of its own.
        expect((await getRunsPage(request, u.access_token, other.id)).meta.total).toBe(0);
    });

    test("cross-USER cancel of a real run → 404 at the agent gate; the victim's terminal row is provably untouched", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `Victim ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: `VictimT ${stamp()}`,
        });
        const run = await assignAndSettle(request, owner.access_token, agent.id, task.id);
        const before = terminalFingerprint(
            await getRunDetail(request, owner.access_token, agent.id, run.id),
        );

        // The intruder holds BOTH real ids but the service.getOne agent gate fires
        // first → 404 "Agent <id> not found." (no existence leak).
        const res = await request.post(`${AGENTS}/${agent.id}/runs/${run.id}/cancel`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).message).toBe(`Agent ${agent.id} not found.`);

        // Cross-user run READ is likewise a 404 (never an empty 200).
        const read = await request.get(`${AGENTS}/${agent.id}/runs/${run.id}`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(read.status()).toBe(404);

        // The owner's row is byte-identical: the intruder mutated nothing.
        const after = terminalFingerprint(
            await getRunDetail(request, owner.access_token, agent.id, run.id),
        );
        expect(after, "the victim's terminal row is untouched by the cross-user cancel").toBe(
            before,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal convergence under interleaved cancel + re-dispatch, and independence.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Terminal convergence under interleaved ops', () => {
    test('a cancel racing a re-assign: cancel is a 200 no-op, the re-assign mints a fresh terminal run, the original row is invariant, no orphan', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Interleave ${stamp()}`,
        });
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `InterT ${stamp()}`,
        });
        const first = await assignAndSettle(request, u.access_token, agent.id, task.id);
        const firstFp = terminalFingerprint(
            await getRunDetail(request, u.access_token, agent.id, first.id),
        );

        // Race a cancel of the terminal `first` against a fresh assign of the same
        // task. Neither may 5xx; the cancel is a no-op, the assign appends a row.
        const [cancelRes, assignRes] = await Promise.all([
            cancel(request, u.access_token, agent.id, first.id),
            request.post(`${AGENTS}/${agent.id}/assign-task`, {
                headers: H(u.access_token),
                data: { taskId: task.id },
            }),
        ]);
        expect(cancelRes.status).toBe(200);
        expect(cancelRes.body.cancelled).toBe(false);
        expect([202, 500], `assign status ${assignRes.status()}`).toContain(assignRes.status());

        // Settle + assert the invariants: the original row unchanged, all terminal.
        await expect
            .poll(async () => (await getRunsPage(request, u.access_token, agent.id)).meta.total, {
                timeout: 15_000,
            })
            .toBe(2);
        const page = await getRunsPage(request, u.access_token, agent.id);
        expect(page.data.filter((r) => ['queued', 'running'].includes(r.status))).toHaveLength(0);
        const firstAfter = terminalFingerprint(
            await getRunDetail(request, u.access_token, agent.id, first.id),
        );
        expect(firstAfter, 'the interleaved cancel did not mutate the original row').toBe(firstFp);
    });

    test('two DISTINCT failed runs on one agent are independently cancel-noop — cancelling one never touches the other', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Indep ${stamp()}`,
        });
        const tA = await createTaskViaAPI(request, u.access_token, { title: `IndepA ${stamp()}` });
        const tB = await createTaskViaAPI(request, u.access_token, { title: `IndepB ${stamp()}` });
        const runA = await assignAndSettle(request, u.access_token, agent.id, tA.id);
        const runB = await assignAndSettle(request, u.access_token, agent.id, tB.id);
        expect(runA.id).not.toBe(runB.id);
        const fpB = terminalFingerprint(
            await getRunDetail(request, u.access_token, agent.id, runB.id),
        );

        // 6 parallel cancels aimed at A only. B must be byte-invariant throughout.
        const results = await Promise.all(
            Array.from({ length: 6 }, () => cancel(request, u.access_token, agent.id, runA.id)),
        );
        for (const r of results) {
            expect(r.status).toBe(200);
            expect(r.body.cancelled).toBe(false);
        }
        const fpBAfter = terminalFingerprint(
            await getRunDetail(request, u.access_token, agent.id, runB.id),
        );
        expect(fpBAfter, 'cancelling run A left run B completely untouched').toBe(fpB);
        // Both rows survive; the cancel storm inserted/deleted nothing.
        expect((await getRunsPage(request, u.access_token, agent.id)).meta.total).toBe(2);
    });

    test('the cancel response contract is stable: {cancelled:boolean, previousStatus} echoing the stored status for every terminal run', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Contract ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `ContractT ${stamp()}`,
        });
        const taskRun = await assignAndSettle(request, u.access_token, agent.id, task.id);
        const manualRun = await runNowAndSettle(request, u.access_token, agent.id);

        for (const run of [taskRun, manualRun]) {
            const c = await cancel(request, u.access_token, agent.id, run.id);
            expect(c.status).toBe(200);
            expect(typeof c.body.cancelled, 'cancelled is always a boolean').toBe('boolean');
            expect(c.body.cancelled, 'a terminal run cannot be cancelled').toBe(false);
            // previousStatus echoes the run's stored terminal status.
            expect(c.body.previousStatus).toBe('failed');
        }
    });
});
