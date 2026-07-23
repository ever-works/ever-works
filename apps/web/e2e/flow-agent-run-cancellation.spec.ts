/**
 * Agent RUN CANCELLATION — the POST /api/agents/:id/runs/:runId/cancel contract (#1741).
 *
 * #1741 gave cancellation teeth: cancelling an AgentRun now also cancels the
 * external Trigger.dev run behind it (via the AGENT_RUN_CANCELLER port). The
 * controller is deliberately layered so the DB transition is AUTHORITATIVE and
 * the remote cancel is best-effort:
 *   - `service.getOne(userId, agentId)` — agent-ownership gate (cross-user 404,
 *     no existence leak), fires BEFORE any run lookup.
 *   - `agentRuns.cancel(runId, userId)` — atomic CAS keyed on (id, userId): only
 *     a queued/running row flips to `cancelled`; an already-terminal row is left
 *     byte-for-byte untouched and reported as a no-op. Scoped by userId, NOT by
 *     the agentId in the path.
 *   - the AGENT_RUN_CANCELLER is only reached when the run WAS open AND carries a
 *     triggerRunId, and its port MUST NOT throw — so the endpoint returns 200
 *     deterministically even when Trigger.dev is unbound (unlike run-now /
 *     assign-task, which 500 on the same unbound adapter).
 *
 * This file drills the cancel route EXCLUSIVELY and deeply. It stays clear of
 * what siblings already pin:
 *   - flow-agent-runs-pagination.spec.ts: the single terminal-no-op cancel +
 *     re-cancel + unknown-runId 404 under the owner's agent.
 *   - sec-pin-agent-run-scoping.spec.ts: cross-user cancel 404 (via the list) +
 *     per-owner run-count disjointness.
 *   - flow-agent-lifecycle-runs-multistep.spec.ts: one cancel-on-failed no-op
 *     inside the cradle-to-grave journey.
 * The NEW, un-pinned angles here: the Trigger.dev-independence contrast
 * (cancel 200 while assign/run-now 500), CAS terminal-row INTEGRITY proved via
 * the getRun detail before/after, guard-ORDERING (agent-gate 404 vs run 404
 * carry different messages), the 'manual' (run-now) trigger-kind cancel, the
 * same-user CROSS-AGENT-path asymmetry (cancel is not agentId-scoped whereas
 * getRun is), cancel ISOLATION across sibling runs + sibling agents, the events
 * feed staying inert on a no-op cancel, and the exact 2-key response envelope.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory, NO LLM key, NO
 * TRIGGER_SECRET_KEY) before a single assertion was written:
 *   - POST :id/assign-task  → 500 "assign-task enqueue failed: …TRIGGER_SECRET_KEY…",
 *     BUT a run row persists: status 'failed', triggerKind 'task', errorMessage
 *     'enqueue-failed: …', startedAt null, finishedAt stamped, durationMs null.
 *   - POST :id/run-now (active) → 500 (TRIGGER_SECRET_KEY unset) BUT a run row
 *     persists: triggerKind 'manual', status 'failed'.
 *   - POST :id/runs/:runId/cancel (owner, terminal failed) → 200
 *     { cancelled:false, previousStatus:'failed' } — deterministic, never 500;
 *     the row STAYS 'failed' (getRun detail unchanged: status/errorMessage/
 *     finishedAt/durationMs identical), and re-cancel repeats verbatim.
 *   - cross-user cancel (real ids) → 404 { message:"Agent <id> not found.", … }.
 *   - real agent + unknown runId → 404 { message:"AgentRun <id> not found.", … }.
 *   - unknown agentId + real runId → 404 "Agent <id> not found." (gate first).
 *   - malformed run/agent id → 400 "Validation failed (uuid is expected)".
 *   - same-user cross-agent path (A's run under agent B) → 200 no-op (cancel is
 *     userId-scoped, not agentId-scoped) — while GET :B/runs/:runIdOfA → 404.
 *   - anonymous cancel → 401 { message:"Unauthorized", statusCode:401 }.
 *
 * Isolation: every test registers a FRESH owner via registerUserViaAPI() with a
 * unique timestamp suffix; nothing touches the seeded storageState user. Pure
 * API-contract assertions. The `flow-` prefix runs it in the authed chromium
 * project and keeps it out of the no-auth testIgnore regex.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTS = `${API_BASE}/api/agents`;
/** Well-formed RFC-4122 v4 UUIDs that exist nowhere in the DB. */
const UNKNOWN_AGENT_UUID = '9e8d7c6b-5a4f-4321-9876-fedcba987654';
const UNKNOWN_RUN_UUID = '11111111-2222-4333-8444-555566667777';
/** Terminal statuses a run can settle into (env-dependent — see below). */
const TERMINAL: string[] = ['completed', 'failed', 'cancelled'];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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

interface RunsPage {
    data: RunRow[];
    meta: { total: number; limit: number; offset: number };
}

interface CancelBody {
    cancelled: boolean;
    previousStatus?: string;
}

interface ErrorBody {
    message: string | string[];
    error?: string;
    statusCode: number;
}

async function listRunsPage(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<RunsPage> {
    const res = await request.get(`${AGENTS}/${agentId}/runs?limit=50`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `runs body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/**
 * Fire assign-task. Trigger.dev is unbound on the CI driver, so the HTTP layer
 * 500s at enqueue — but the pre-created run row IS persisted (marked failed).
 * A configured stack would 202. Tolerate both and let callers assert the row.
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
    expect([202, 500]).toContain(res.status());
    return res.status();
}

/** Poll until the agent's run total reaches `n` (rows persist synchronously
 *  today, but poll defensively against any dispatch-timing skew). */
async function waitForRunTotal(
    request: APIRequestContext,
    token: string,
    agentId: string,
    n: number,
): Promise<void> {
    await expect
        .poll(async () => (await listRunsPage(request, token, agentId)).meta.total, {
            timeout: 20_000,
            message: `expected >= ${n} run row(s) for agent ${agentId}`,
        })
        .toBeGreaterThanOrEqual(n);
}

/** Register a fresh owner, mint an agent + task, dispatch it, and return the
 *  single persisted run (terminal 'failed' on the key-less CI driver). */
async function seedAgentWithTaskRun(
    request: APIRequestContext,
    label: string,
): Promise<{
    token: string;
    userId: string;
    agentId: string;
    taskId: string;
    run: RunRow;
    assignStatus: number;
}> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const agent = await createAgentViaAPI(request, token, { name: `${label} ${stamp()}` });
    const task = await createTaskViaAPI(request, token, { title: `${label} task ${stamp()}` });
    const assignStatus = await assign(request, token, agent.id, task.id);
    await waitForRunTotal(request, token, agent.id, 1);
    const page = await listRunsPage(request, token, agent.id);
    const run = page.data.find((r) => r.taskId === task.id);
    expect(run, 'a run row for the assigned task must persist').toBeTruthy();
    return {
        token,
        userId: user.user.id,
        agentId: agent.id,
        taskId: task.id,
        run: run!,
        assignStatus,
    };
}

/** GET one run's full detail envelope. */
async function getRun(
    request: APIRequestContext,
    token: string,
    agentId: string,
    runId: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${AGENTS}/${agentId}/runs/${runId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `getRun body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function cancel(
    request: APIRequestContext,
    token: string,
    agentId: string,
    runId: string,
): Promise<{ status: number; body: CancelBody }> {
    const res = await request.post(`${AGENTS}/${agentId}/runs/${runId}/cancel`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as CancelBody };
}

// ───────────────────────────────────────────────────────────────────────────
test.describe('agent-run cancellation — the terminal no-op + #1741 degrade contract', () => {
    test('cancelling a terminal run is a deterministic 200 no-op { cancelled:false, previousStatus }', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'NoopCancel');
        // On the key-less CI driver the dispatched run settled to 'failed'.
        if (s.assignStatus === 500) expect(s.run.status).toBe('failed');
        expect(TERMINAL).toContain(s.run.status);

        const { status, body } = await cancel(request, s.token, s.agentId, s.run.id);
        expect(status).toBe(200);
        // A terminal run cannot be cancelled — the CAS left it alone.
        expect(body.cancelled).toBe(false);
        expect(body.previousStatus).toBe(s.run.status);
    });

    test('cancel returns 200 even though Trigger.dev is unbound — while assign-task/run-now 500 on the same adapter', async ({
        request,
    }) => {
        // The #1741 layering: assign-task + run-now surface the enqueue failure
        // as a 500, but cancel degrades gracefully because the DB transition is
        // authoritative and the AGENT_RUN_CANCELLER port must never throw.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, { name: `Degrade ${stamp()}` });
        const task = await createTaskViaAPI(request, token, { title: `Degrade task ${stamp()}` });

        // assign-task → 500 (or 202 if a real adapter were wired).
        const assignStatus = await assign(request, token, agent.id, task.id);

        // run-now on an ACTIVE agent also reaches the unbound dispatcher → 500.
        expect((await request.post(`${AGENTS}/${agent.id}/resume`, { headers: H })).status()).toBe(
            200,
        );
        const runNow = await request.post(`${AGENTS}/${agent.id}/run-now`, { headers: H });
        expect([202, 500]).toContain(runNow.status());

        // cancel of the persisted run → a hard 200, no 5xx leakage.
        await waitForRunTotal(request, token, agent.id, 1);
        const page = await listRunsPage(request, token, agent.id);
        const runId = page.data[0].id;
        const res = await request.post(`${AGENTS}/${agent.id}/runs/${runId}/cancel`, {
            headers: H,
        });
        expect(res.status(), 'cancel must not 500 even with Trigger.dev unbound').toBe(200);
        // Sanity: the two write paths really did fail on this key-less driver.
        if (assignStatus === 500) expect(page.data.every((r) => r.status === 'failed')).toBe(true);
    });

    test('cancel does NOT corrupt the terminal row — status/errorMessage/finishedAt/durationMs survive verbatim', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'CasIntegrity');
        const before = await getRun(request, s.token, s.agentId, s.run.id);

        const { status, body } = await cancel(request, s.token, s.agentId, s.run.id);
        expect(status).toBe(200);
        expect(body.cancelled).toBe(false);

        const after = await getRun(request, s.token, s.agentId, s.run.id);
        // The CAS returned early WITHOUT an UPDATE: every field is unchanged and
        // the status was NOT overwritten from 'failed' to 'cancelled'.
        expect(after.status).toBe(before.status);
        expect(after.status).not.toBe('cancelled');
        expect(after.errorMessage).toBe(before.errorMessage);
        expect(after.finishedAt).toBe(before.finishedAt);
        expect(after.durationMs).toBe(before.durationMs);
        expect(after.startedAt).toBe(before.startedAt);
        expect(after.createdAt).toBe(before.createdAt);
        if (s.assignStatus === 500) {
            expect(String(after.errorMessage)).toContain('enqueue-failed');
        }
    });

    test('cancel is idempotent under repetition: three cancels return the identical body and never mutate the run', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'Idempotent');
        const bodies: CancelBody[] = [];
        for (let i = 0; i < 3; i++) {
            const { status, body } = await cancel(request, s.token, s.agentId, s.run.id);
            expect(status, `cancel #${i + 1}`).toBe(200);
            bodies.push(body);
        }
        // Every response is byte-identical.
        for (const b of bodies) {
            expect(b.cancelled).toBe(false);
            expect(b.previousStatus).toBe(s.run.status);
        }
        // The run is still the same terminal row, and the total never grew.
        const after = await getRun(request, s.token, s.agentId, s.run.id);
        expect(after.status).toBe(s.run.status);
        expect((await listRunsPage(request, s.token, s.agentId)).meta.total).toBe(1);
    });

    test("a 'manual' (run-now) run cancels with the same terminal no-op as a 'task' run", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const H = authedHeaders(token);
        const agent = await createAgentViaAPI(request, token, { name: `Manual ${stamp()}` });

        // Activate then run-now → a 'manual' run persists (enqueue 500 on CI).
        expect((await request.post(`${AGENTS}/${agent.id}/resume`, { headers: H })).status()).toBe(
            200,
        );
        const rn = await request.post(`${AGENTS}/${agent.id}/run-now`, { headers: H });
        expect([202, 500]).toContain(rn.status());
        await waitForRunTotal(request, token, agent.id, 1);

        const page = await listRunsPage(request, token, agent.id);
        const manual = page.data.find((r) => r.triggerKind === 'manual');
        expect(manual, "a 'manual' run row must exist after run-now").toBeTruthy();
        expect(manual!.taskId).toBeNull();

        const { status, body } = await cancel(request, token, agent.id, manual!.id);
        expect(status).toBe(200);
        expect(body.cancelled).toBe(false);
        expect(body.previousStatus).toBe(manual!.status);
        if (rn.status() === 500) expect(manual!.status).toBe('failed');
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('agent-run cancellation — guard ordering + id validation matrix', () => {
    test('malformed runId and malformed agentId both hit ParseUUIDPipe 400', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'BadId');

        const badRun = await request.post(`${AGENTS}/${s.agentId}/runs/not-a-uuid/cancel`, {
            headers: authedHeaders(s.token),
        });
        expect(badRun.status()).toBe(400);
        expect((await badRun.json()).message).toBe('Validation failed (uuid is expected)');

        const badAgent = await request.post(`${AGENTS}/not-a-uuid/runs/${s.run.id}/cancel`, {
            headers: authedHeaders(s.token),
        });
        expect(badAgent.status()).toBe(400);
        expect((await badAgent.json()).message).toBe('Validation failed (uuid is expected)');
    });

    test('the agent-ownership gate fires BEFORE the run lookup — the two 404s carry DIFFERENT messages', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'GuardOrder');

        // Unknown AGENT + a real run id → the gate answers "Agent … not found."
        const unknownAgent = await cancel(request, s.token, UNKNOWN_AGENT_UUID, s.run.id);
        expect(unknownAgent.status).toBe(404);
        const uaBody = unknownAgent.body as unknown as ErrorBody;
        expect(uaBody.message).toBe(`Agent ${UNKNOWN_AGENT_UUID} not found.`);

        // Real agent + unknown RUN id → the gate passes; the run lookup answers.
        const unknownRun = await cancel(request, s.token, s.agentId, UNKNOWN_RUN_UUID);
        expect(unknownRun.status).toBe(404);
        const urBody = unknownRun.body as unknown as ErrorBody;
        expect(urBody.message).toBe(`AgentRun ${UNKNOWN_RUN_UUID} not found.`);

        // The distinct messages prove the ordering (agent gate → run CAS).
        expect(uaBody.message).not.toBe(urBody.message);
    });

    test('unknown runId under the OWNER agent returns the AgentRun-scoped 404 body', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'UnknownRun');
        const res = await request.post(`${AGENTS}/${s.agentId}/runs/${UNKNOWN_RUN_UUID}/cancel`, {
            headers: authedHeaders(s.token),
        });
        expect(res.status()).toBe(404);
        const body = (await res.json()) as ErrorBody;
        expect(body).toEqual({
            message: `AgentRun ${UNKNOWN_RUN_UUID} not found.`,
            error: 'Not Found',
            statusCode: 404,
        });
        // The real run is provably still there and unchanged.
        expect((await listRunsPage(request, s.token, s.agentId)).meta.total).toBe(1);
    });

    test('anonymous cancel is a 401 that never reaches the ownership gate', async ({ request }) => {
        const s = await seedAgentWithTaskRun(request, 'Anon');
        const res = await request.post(`${AGENTS}/${s.agentId}/runs/${s.run.id}/cancel`);
        expect(res.status()).toBe(401);
        expect((await res.json()) as ErrorBody).toEqual({
            message: 'Unauthorized',
            statusCode: 401,
        });
        // The run survives the unauthenticated probe untouched.
        const after = await getRun(request, s.token, s.agentId, s.run.id);
        expect(after.status).toBe(s.run.status);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('agent-run cancellation — cross-user vs cross-agent scoping', () => {
    test('a stranger holding BOTH real ids still 404s at the agent gate and cannot mutate the run', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'CrossUser');
        const intruder = await registerUserViaAPI(request);

        // Cancel with the victim's real agent + run ids → agent-gate 404.
        const res = await request.post(`${AGENTS}/${s.agentId}/runs/${s.run.id}/cancel`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).message).toBe(`Agent ${s.agentId} not found.`);

        // The intruder cannot even read the run detail (same 404 gate).
        const peek = await request.get(`${AGENTS}/${s.agentId}/runs/${s.run.id}`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(peek.status()).toBe(404);

        // The owner still sees an intact, unchanged run.
        const after = await getRun(request, s.token, s.agentId, s.run.id);
        expect(after.status).toBe(s.run.status);
        expect(after.id).toBe(s.run.id);
    });

    test('cancel is userId-scoped, NOT agentId-scoped: an owner may cancel their run through a DIFFERENT owned agent path', async ({
        request,
    }) => {
        // NOVEL: agentRuns.cancel(runId, userId) is not keyed on the path agentId,
        // so run-of-A cancelled via agent-B's path succeeds (as a no-op) — unlike
        // GET :id/runs/:runId which enforces run.agentId === id. Both agents are
        // owned by the SAME user, so no cross-user boundary is crossed.
        const s = await seedAgentWithTaskRun(request, 'CrossAgent');
        const agentB = await createAgentViaAPI(request, s.token, {
            name: `CrossAgentB ${stamp()}`,
        });

        // getRun IS agentId-scoped → A's run under B's path is a 404.
        const detailUnderB = await request.get(`${AGENTS}/${agentB.id}/runs/${s.run.id}`, {
            headers: authedHeaders(s.token),
        });
        expect(detailUnderB.status()).toBe(404);

        // cancel is NOT agentId-scoped → observed 200 no-op. Tolerate a future
        // hardening to 404; assert the exact shape in whichever branch is live.
        const viaB = await request.post(`${AGENTS}/${agentB.id}/runs/${s.run.id}/cancel`, {
            headers: authedHeaders(s.token),
        });
        expect([200, 404]).toContain(viaB.status());
        if (viaB.status() === 200) {
            const body = (await viaB.json()) as CancelBody;
            expect(body.cancelled).toBe(false);
            expect(body.previousStatus).toBe(s.run.status);
        } else {
            expect((await viaB.json()).message).toContain('not found');
        }

        // Either way the run is unchanged and still lives under agent A.
        const underA = await getRun(request, s.token, s.agentId, s.run.id);
        expect(underA.status).toBe(s.run.status);
        // Agent B never acquired the run.
        expect((await listRunsPage(request, s.token, agentB.id)).meta.total).toBe(0);
    });

    test('an unknown (well-formed) agentId with a real run id resolves at the agent gate, not the run lookup', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'PhantomAgent');
        const res = await cancel(request, s.token, UNKNOWN_AGENT_UUID, s.run.id);
        expect(res.status).toBe(404);
        const body = res.body as unknown as ErrorBody;
        // Names the AGENT (gate), never the run — no cross-agent existence leak.
        expect(body.message).toBe(`Agent ${UNKNOWN_AGENT_UUID} not found.`);
        expect(String(body.message)).not.toContain('AgentRun');
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('agent-run cancellation — isolation across runs, agents + the events feed', () => {
    test('cancelling one run of an agent leaves its SIBLING run untouched', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Siblings ${stamp()}` });
        const task = await createTaskViaAPI(request, token, { title: `Siblings task ${stamp()}` });

        // Two dispatches of the same task go terminal, so no dedup → two rows.
        await assign(request, token, agent.id, task.id);
        await assign(request, token, agent.id, task.id);
        await waitForRunTotal(request, token, agent.id, 2);

        const page = await listRunsPage(request, token, agent.id);
        const [first, second] = page.data;
        expect(first.id).not.toBe(second.id);

        // Cancel only the first.
        const res = await cancel(request, token, agent.id, first.id);
        expect(res.status).toBe(200);

        // The sibling's row is byte-identical to before, and the total is stable.
        const sibling = await getRun(request, token, agent.id, second.id);
        expect(sibling.status).toBe(second.status);
        expect(sibling.finishedAt).toBe(second.finishedAt);
        expect(sibling.errorMessage).toBe(second.errorMessage);
        expect((await listRunsPage(request, token, agent.id)).meta.total).toBe(2);
    });

    test("cancelling one agent's run leaves a SECOND agent's run of the same owner untouched", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const a = await createAgentViaAPI(request, token, { name: `IsoA ${stamp()}` });
        const b = await createAgentViaAPI(request, token, { name: `IsoB ${stamp()}` });
        const ta = await createTaskViaAPI(request, token, { title: `IsoA task ${stamp()}` });
        const tb = await createTaskViaAPI(request, token, { title: `IsoB task ${stamp()}` });
        await assign(request, token, a.id, ta.id);
        await assign(request, token, b.id, tb.id);
        await waitForRunTotal(request, token, a.id, 1);
        await waitForRunTotal(request, token, b.id, 1);

        const runA = (await listRunsPage(request, token, a.id)).data[0];
        const runBefore = (await listRunsPage(request, token, b.id)).data[0];

        // Cancel A's run.
        expect((await cancel(request, token, a.id, runA.id)).status).toBe(200);

        // B's agent + run are entirely unaffected.
        const runAfter = (await listRunsPage(request, token, b.id)).data[0];
        expect(runAfter.id).toBe(runBefore.id);
        expect(runAfter.status).toBe(runBefore.status);
        expect((await listRunsPage(request, token, b.id)).meta.total).toBe(1);
        // A and B never share a run id.
        expect(runA.id).not.toBe(runBefore.id);
    });

    test('a no-op cancel of a terminal run adds NO lifecycle event to the feed', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'EventsInert');

        const eventsBefore = await request.get(`${AGENTS}/${s.agentId}/events`, {
            headers: authedHeaders(s.token),
        });
        expect(eventsBefore.status()).toBe(200);
        const totalBefore = (await eventsBefore.json()).meta.total as number;

        expect((await cancel(request, s.token, s.agentId, s.run.id)).status).toBe(200);

        const eventsAfter = await request.get(`${AGENTS}/${s.agentId}/events`, {
            headers: authedHeaders(s.token),
        });
        const afterBody = await eventsAfter.json();
        // wasOpen was false → the controller skips tryLog entirely; and the feed
        // filters to lifecycle types, which never include a run-cancel row.
        expect(afterBody.meta.total).toBe(totalBefore);
        const types = (afterBody.data as Array<{ actionType: string }>).map((e) => e.actionType);
        expect(types).not.toContain('agent_run_cancelled');
    });

    test('after a no-op cancel the run still appears in the list with an unchanged status and stable total', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'ListStable');
        expect((await cancel(request, s.token, s.agentId, s.run.id)).status).toBe(200);

        const page = await listRunsPage(request, s.token, s.agentId);
        expect(page.meta.total).toBe(1);
        const listed = page.data.find((r) => r.id === s.run.id);
        expect(listed, 'the cancelled-attempt run is still listed').toBeTruthy();
        expect(listed!.status).toBe(s.run.status);
        expect(listed!.triggerKind).toBe('task');
        expect(listed!.taskId).toBe(s.taskId);
    });
});

// ───────────────────────────────────────────────────────────────────────────
test.describe('agent-run cancellation — the response envelope', () => {
    test('the cancel body is EXACTLY { cancelled, previousStatus } and leaks no run internals', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'Envelope');
        const res = await request.post(`${AGENTS}/${s.agentId}/runs/${s.run.id}/cancel`, {
            headers: authedHeaders(s.token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(new Set(Object.keys(body))).toEqual(new Set(['cancelled', 'previousStatus']));
        expect(typeof body.cancelled).toBe('boolean');
        expect(typeof body.previousStatus).toBe('string');
        // Never surface the Trigger.dev run id or the error text on this route.
        expect(body).not.toHaveProperty('triggerRunId');
        expect(body).not.toHaveProperty('errorMessage');
        expect(body).not.toHaveProperty('id');
    });

    test("previousStatus echoes the run's REAL status (cross-checked against getRun) and is a terminal value", async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'EchoStatus');
        const detail = await getRun(request, s.token, s.agentId, s.run.id);

        const { status, body } = await cancel(request, s.token, s.agentId, s.run.id);
        expect(status).toBe(200);
        expect(body.previousStatus).toBe(detail.status);
        expect(TERMINAL).toContain(String(body.previousStatus));
        // For a terminal run cancelled must be false (nothing was open to cancel).
        expect(body.cancelled).toBe(false);
    });

    test('the run id shape stays a v4 UUID and previousStatus mirrors the persisted enum', async ({
        request,
    }) => {
        const s = await seedAgentWithTaskRun(request, 'ShapeCheck');
        expect(s.run.id).toMatch(UUID_RE);
        const { body } = await cancel(request, s.token, s.agentId, s.run.id);
        // The env-adaptive truth: on the key-less driver it is 'failed'; a
        // configured stack could report a different terminal value.
        if (s.assignStatus === 500) {
            expect(body.previousStatus).toBe('failed');
        } else {
            expect(TERMINAL).toContain(String(body.previousStatus));
        }
    });
});
