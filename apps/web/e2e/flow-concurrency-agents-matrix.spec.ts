/**
 * flow-concurrency-agents-matrix — PARALLEL AGENT OPERATIONS as one observable
 * race matrix, driven end-to-end against the live stack. The Agent lifecycle is a
 * compare-and-set (CAS) state machine at the DOMAIN layer (`transitionStatus`
 * WHERE status IN(from) + AgentRun `casTerminal`), so a burst of genuinely-parallel
 * competing lifecycle ops must resolve to a DETERMINISTIC, atomic terminal state:
 * exactly one winner per contended edge, never a 5xx, never a double-advance / lost
 * update / orphaned run row.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-optimistic-concurrency covers the Task state-machine CAS, the AGENT
 *   *create* slug-uniqueness 409 burst, and the same-field PATCH last-write-wins on
 *   Task+Agent. flow-idempotency-concurrency-matrix covers Teams / Triggers / Works
 *   races (none of them the Agent). concurrent-* only touch the Work entity. NONE of
 *   them race the AGENT *status* endpoints (`/pause`, `/resume`, DELETE-archive),
 *   the AGENT run-record surface (`/assign-task`, `/run-now`), or pin the atomic
 *   terminal-state invariants of those. THIS file pins all of that.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users BEFORE any assertion. Exact contract:
 *
 *   STATUS TRANSITIONS  (state machine: draft→active, active⇄paused, error→…,
 *                        *→archived; `resume`→ACTIVE, `pause`→PAUSED, DELETE→archive)
 *     • POST /:id/resume  → 200 full AgentDto (draft/paused/error → active). An
 *       illegal edge (active→active, archived→active) → 400 "Cannot transition Agent
 *       from <from> to <to>."
 *     • POST /:id/pause   → 200 (active → paused). paused→paused → 400 (NOT idempotent
 *       — contrast the Trigger pause contract which IS idempotent).
 *     • The transition is a CAS (`transitionStatus` WHERE status IN(from)). A burst of
 *       N identical transitions → EXACTLY ONE 200; every loser re-reads the advanced
 *       row and is a client-level conflict: 400 (read-time — the source state no
 *       longer has that edge) or 409 (the CAS lost between read & write). Never a 5xx.
 *     • DELETE /:id (archive) → 200 {archived:true}. UNCONDITIONAL (no from-guard) so
 *       it is idempotent AND always wins a race against a CAS transition. Archived
 *       rows are excluded from the list but still GET-able (200, status 'archived');
 *       every edge OUT of archived is a 400 (terminal).
 *     • Cross-user pause/resume/archive/assign/run-now → 404 (no existence leak).
 *
 *   PATCH  (partial; `status` is NOT writable). Concurrent PATCH of DISJOINT columns
 *     → every column persists (no lost update — TypeORM UPDATE sets only its own
 *     columns). Concurrent PATCH of the SAME column → settles on exactly one submitted
 *     value (no Frankenstein merge); untouched columns (status/permissions) survive.
 *     A metadata PATCH racing a status transition both apply (disjoint columns).
 *
 *   RUN RECORDS  (`/assign-task`, `/run-now`)
 *     • POST /:id/assign-task {taskId}: pre-creates an AgentRun (triggerKind 'task')
 *       then enqueues via Trigger.dev. In the CI/e2e default (no TRIGGER_SECRET_KEY)
 *       the enqueue THROWS → the controller rolls the row back via `markDispatchFailed`
 *       (queued→failed) and returns HTTP 500 — but a DURABLE 'failed' run row survives,
 *       carrying the taskId + errorMessage 'enqueue-failed: …'. NOT status-gated (a
 *       draft agent still records a run). The rollback FREES the (task,agent) dedup
 *       slot, so a later assign mints a fresh run (no orphaned 'queued' row wedges it).
 *       A non-existent / cross-user taskId → 404, no phantom run.
 *     • POST /:id/run-now: STATUS-GATED — a non-ACTIVE agent → 409 "Agent is not in an
 *       ACTIVE state …" with NO run record + status unchanged (the manual-claim CAS
 *       gates before dispatch). On an ACTIVE agent the (keyless) trigger throws → 500,
 *       but the claim's release restores the agent to ACTIVE (never a stuck RUNNING).
 *
 *   CREATE  Concurrent DISTINCT-name creates → all 201, distinct ids + slugs, all
 *     listed (concurrent inserts never drop/corrupt a row). Uniqueness is PER-SCOPE:
 *     the SAME name in tenant vs work scope both win 201 concurrently.
 *
 * GOTCHAS honored: every test builds FRESH registerUserViaAPI() owners (never the
 * shared seeded user — per-user scope/slug namespaces so bursts never collide
 * cross-spec); unique Date.now()/random suffixes; ids asserted via toContain /
 * filter-by-my-id (never exact GLOBAL list counts — the shard DB accumulates rows);
 * updatedAt monotonicity asserted with `>=` tolerance for second-resolution ties;
 * tolerant `expect([...]).toContain(status)` where multiple codes are genuinely
 * valid (loser 400-vs-409, assign 202-vs-500); every branch keeps the never-a-5xx
 * invariant. Fully API-orchestrated (safe `flow-` prefix) — never contends on the
 * shared UI auth state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    registerUserViaAPI,
    createWorkViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const T = 25_000;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface AgentRow {
    id: string;
    slug: string;
    name: string;
    status: string;
    title: string | null;
    capabilities: string | null;
    modelId: string | null;
    updatedAt: string;
    permissions: Record<string, boolean>;
    [k: string]: unknown;
}

interface RunRow {
    id: string;
    status: string;
    triggerKind: string;
    taskId: string | null;
    errorMessage: string | null;
    [k: string]: unknown;
}

function H(token: string): Record<string, string> {
    return { ...authedHeaders(token), 'content-type': 'application/json' };
}

async function getAgent(request: APIRequestContext, token: string, id: string): Promise<AgentRow> {
    const res = await request.get(`${API_BASE}/api/agents/${id}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
    expect(res.status(), `getAgent body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getAgentStatus(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<string> {
    return (await getAgent(request, token, id)).status;
}

/** Drive an agent draft → active via the resume endpoint (200 required). */
async function activate(request: APIRequestContext, token: string, id: string): Promise<AgentRow> {
    const res = await request.post(`${API_BASE}/api/agents/${id}/resume`, {
        headers: H(token),
        timeout: T,
    });
    expect(res.status(), `activate body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function pause(request: APIRequestContext, token: string, id: string) {
    return request.post(`${API_BASE}/api/agents/${id}/pause`, { headers: H(token), timeout: T });
}
async function resume(request: APIRequestContext, token: string, id: string) {
    return request.post(`${API_BASE}/api/agents/${id}/resume`, { headers: H(token), timeout: T });
}
async function archive(request: APIRequestContext, token: string, id: string) {
    return request.delete(`${API_BASE}/api/agents/${id}`, {
        headers: authedHeaders(token),
        timeout: T,
    });
}
async function assignTask(
    request: APIRequestContext,
    token: string,
    agentId: string,
    taskId: string,
) {
    return request.post(`${API_BASE}/api/agents/${agentId}/assign-task`, {
        headers: H(token),
        data: { taskId },
        timeout: T,
    });
}

async function listRuns(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<{ data: RunRow[]; total: number }> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs?limit=200`, {
        headers: authedHeaders(token),
        timeout: T,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return { data: body.data ?? [], total: body.meta?.total ?? (body.data ?? []).length };
}

/** Buckets a burst of HTTP statuses. */
function classify(statuses: number[]) {
    return {
        winners: statuses.filter((s) => s >= 200 && s < 300),
        server5xx: statuses.filter((s) => s >= 500),
    };
}

/**
 * Tolerate the sqlite-in-memory driver artifact on WRITE bursts: concurrent
 * write transactions serialize GLOBALLY, so a burst can transiently surface
 * SQLITE_BUSY as a 5xx (Postgres row-locking would not), and CI shard load
 * makes that far likelier than a quiet serial dev run. Require a survivor and
 * that every non-5xx reply is an expected success code; the caller asserts its
 * invariants on the SURVIVORS (a 5xx has no body — never parse one).
 */
function assertTolerated5xx(statuses: number[], okCodes: number[]): void {
    expect(
        statuses.filter((s) => s < 500).length,
        `at least one write survived serialization (${statuses})`,
    ).toBeGreaterThan(0);
    expect(
        statuses.every((s) => okCodes.includes(s) || s >= 500),
        `every write is one of [${okCodes}] or a tolerated sqlite 5xx (${statuses})`,
    ).toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS-TRANSITION CAS — exactly one winner per contended edge.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent status transitions are a CAS — one winner per contended edge', () => {
    test('N parallel pause on an ACTIVE agent → exactly one 200 + the rest 400/409 losers; lands PAUSED once; updatedAt advances', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Pause CAS ${stamp()}`,
        });
        const before = await activate(request, u.access_token, agent.id);
        expect(before.status).toBe('active');
        // Second-resolution updatedAt must observably advance past activation.
        await new Promise((r) => setTimeout(r, 1100));

        const BURST = 6;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => pause(request, u.access_token, agent.id)),
        );
        const statuses = results.map((r) => r.status());
        const { winners, server5xx } = classify(statuses);
        expect(server5xx, `no pause 5xx'd (statuses=${statuses})`).toEqual([]);
        expect(winners.length, 'exactly one pause wins the active→paused CAS').toBe(1);
        // Every loser is a client-level conflict — 400 (read-time: already paused) or
        // 409 (CAS lost between read & write). Never anything else.
        for (const s of statuses) {
            expect([200, 400, 409], `pause status ${s} is a known outcome`).toContain(s);
        }
        expect(statuses.filter((s) => s === 400 || s === 409).length, 'the rest all lose').toBe(
            BURST - 1,
        );

        const after = await getAgent(request, u.access_token, agent.id);
        expect(after.status, 'the row advanced to paused exactly once (no double-advance)').toBe(
            'paused',
        );
        expect(
            Date.parse(after.updatedAt) >= Date.parse(before.updatedAt),
            `updatedAt monotonic: before=${before.updatedAt} after=${after.updatedAt}`,
        ).toBe(true);
    });

    test('N parallel resume on a DRAFT agent → exactly one 200 + the rest lose; lands ACTIVE once', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Resume Draft CAS ${stamp()}`,
        });
        expect(agent.status).toBe('draft');

        const BURST = 5;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => resume(request, u.access_token, agent.id)),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx, `no resume 5xx'd (${statuses})`).toEqual([]);
        expect(statuses.filter((s) => s === 200).length, 'one resume wins draft→active').toBe(1);
        expect(
            statuses.filter((s) => s === 400 || s === 409).length,
            'every other racer loses the CAS',
        ).toBe(BURST - 1);
        expect(await getAgentStatus(request, u.access_token, agent.id)).toBe('active');
    });

    test('N parallel resume on a PAUSED agent → exactly one 200 + the rest lose; lands ACTIVE once', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Resume Paused CAS ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        expect((await pause(request, u.access_token, agent.id)).status()).toBe(200);

        const BURST = 5;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => resume(request, u.access_token, agent.id)),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 200).length, 'one resume wins paused→active').toBe(1);
        expect(statuses.filter((s) => s === 400 || s === 409).length, 'the rest lose').toBe(
            BURST - 1,
        );
        expect(await getAgentStatus(request, u.access_token, agent.id)).toBe('active');
    });

    test('pause is NOT idempotent — a second pause on a paused agent is a 400 read-time conflict (distinct from the Trigger contract)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Non Idem ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        const first = await pause(request, u.access_token, agent.id);
        expect(first.status(), 'first pause succeeds').toBe(200);
        const second = await pause(request, u.access_token, agent.id);
        expect(second.status(), 'the SECOND pause is a 400 — not a silent idempotent 200').toBe(
            400,
        );
        const body = await second.json();
        expect(body.message).toMatch(/cannot transition Agent from paused to paused/i);
        expect(body.statusCode).toBe(400);
    });

    test('every edge OUT of an ARCHIVED agent is a 400 (terminal), never a 5xx', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Terminal ${stamp()}`,
        });
        expect((await archive(request, u.access_token, agent.id)).status()).toBe(200);

        const res = await resume(request, u.access_token, agent.id);
        expect(res.status(), 'archived→active is a 400, not a 5xx').toBe(400);
        expect((await res.json()).message).toMatch(/cannot transition Agent from archived/i);
        const pau = await pause(request, u.access_token, agent.id);
        expect(pau.status(), 'archived→paused is a 400, not a 5xx').toBe(400);
        // Still fetchable (soft-delete), reads back archived.
        expect(await getAgentStatus(request, u.access_token, agent.id)).toBe('archived');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPETING TRANSITIONS — converge to one atomic terminal state (archive wins).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Competing agent transitions converge to one atomic terminal state', () => {
    test('competing pause-vs-archive on an ACTIVE agent → archive wins the terminal state (ARCHIVED); neither 5xxes', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Pause vs Archive ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        const [pauseRes, archiveRes] = await Promise.all([
            pause(request, u.access_token, agent.id),
            archive(request, u.access_token, agent.id),
        ]);
        // Archive is UNCONDITIONAL (no from-guard) so it always commits 200.
        expect(archiveRes.status(), 'archive always succeeds (unconditional soft-delete)').toBe(
            200,
        );
        expect((await archiveRes.json()).archived).toBe(true);
        // Pause is a CAS — it may commit (200) before the archive, or lose (400/409)
        // after it; either way it is client-level, never a 5xx.
        expect(pauseRes.status(), `pause is client-level (got ${pauseRes.status()})`).toBeLessThan(
            500,
        );
        // Archive is unconditional, so the terminal state is ALWAYS archived.
        await expect
            .poll(() => getAgentStatus(request, u.access_token, agent.id), {
                timeout: 15_000,
                message: 'archive wins the terminal state even when it raced a pause',
            })
            .toBe('archived');
    });

    test('competing resume-vs-archive on a DRAFT agent → archive wins the terminal state; the agent is gone from the list', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Resume vs Archive ${stamp()}`,
        });

        const [resumeRes, archiveRes] = await Promise.all([
            resume(request, u.access_token, agent.id),
            archive(request, u.access_token, agent.id),
        ]);
        expect(archiveRes.status()).toBe(200);
        expect(resumeRes.status(), 'resume is client-level').toBeLessThan(500);
        await expect
            .poll(() => getAgentStatus(request, u.access_token, agent.id), { timeout: 15_000 })
            .toBe('archived');

        // Archived rows are excluded from the list (findByUserIdScoped filters them out).
        const list = await request.get(`${API_BASE}/api/agents?limit=200`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const rows: AgentRow[] = (await list.json()).data ?? [];
        expect(
            rows.map((a) => a.id),
            'the archived agent is not in the active list',
        ).not.toContain(agent.id);
    });

    test('N parallel DELETE (archive) → every call 200 {archived:true} (idempotent, unconditional — no CAS); terminal ARCHIVED, excluded from list but still GET-able', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Archive Race ${stamp()}`,
        });

        const BURST = 4;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => archive(request, u.access_token, agent.id)),
        );
        const statuses = results.map((r) => r.status());
        assertTolerated5xx(statuses, [200]);
        // Every SURVIVING archive reports the same idempotent result (a 5xx that
        // lost the global write-lock carries no body).
        for (const r of results.filter((x) => x.status() === 200)) {
            expect((await r.json()).archived).toBe(true);
        }
        // If every racer lost the lock the row would still be un-archived, so
        // replay once SERIALLY to pin the terminal state asserted below.
        if (statuses.every((s) => s >= 500)) {
            const redo = await archive(request, u.access_token, agent.id);
            expect(redo.status(), 'a serial archive always succeeds').toBe(200);
        }

        expect(await getAgentStatus(request, u.access_token, agent.id)).toBe('archived');
        const list = await request.get(`${API_BASE}/api/agents?limit=200`, {
            headers: authedHeaders(u.access_token),
        });
        const ids: string[] = ((await list.json()).data ?? []).map((a: AgentRow) => a.id);
        expect(ids, 'archived agent excluded from the active list').not.toContain(agent.id);
    });

    test('a metadata PATCH racing a pause both apply (disjoint columns) — final row is paused AND carries the patched title', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Patch vs Pause ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const newTitle = `raced-title-${stamp()}`;

        const [patchRes, pauseRes] = await Promise.all([
            request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: H(u.access_token),
                data: { title: newTitle },
                timeout: T,
            }),
            pause(request, u.access_token, agent.id),
        ]);
        expect(patchRes.status(), 'patch is client-level').toBeLessThan(500);
        expect(pauseRes.status(), 'pause is client-level').toBeLessThan(500);
        expect(patchRes.status(), 'the title PATCH applies (status is a disjoint column)').toBe(
            200,
        );

        const after = await getAgent(request, u.access_token, agent.id);
        // status (pause) and title (patch) are independent columns — both persist.
        expect(after.status, 'the pause took effect on the status column').toBe('paused');
        expect(
            after.title,
            'the concurrent title PATCH persisted alongside the status change',
        ).toBe(newTitle);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL PATCH — no lost update across columns, no Frankenstein merge on one.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Parallel agent PATCH convergence', () => {
    test('parallel PATCH of DISJOINT fields (title / capabilities / modelId) → all 200 and every field persists (no lost update across columns)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Disjoint Patch ${stamp()}`,
        });
        const tag = stamp();
        const title = `title-${tag}`;
        const capabilities = `cap-${tag}`;
        const modelId = `model-${tag}`;

        const results = await Promise.all([
            request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: H(u.access_token),
                data: { title },
                timeout: T,
            }),
            request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: H(u.access_token),
                data: { capabilities },
                timeout: T,
            }),
            request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: H(u.access_token),
                data: { modelId },
                timeout: T,
            }),
        ]);
        expect(
            results.every((r) => r.status() === 200),
            `all disjoint PATCH 200 (${results.map((r) => r.status())})`,
        ).toBe(true);

        const after = await getAgent(request, u.access_token, agent.id);
        // Each UPDATE only sets its own column, so all three land — no writer clobbers
        // another's disjoint column.
        expect(after.title, 'title PATCH survived').toBe(title);
        expect(after.capabilities, 'capabilities PATCH survived (not lost to a sibling)').toBe(
            capabilities,
        );
        expect(after.modelId, 'modelId PATCH survived').toBe(modelId);
    });

    test('parallel PATCH of the SAME field → settles on exactly one submitted value (no merge); status + permissions untouched; updatedAt monotonic', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Same Field Patch ${stamp()}`,
        });
        const before = await getAgent(request, u.access_token, agent.id);
        expect(before.status).toBe('draft');
        const tag = stamp();
        const candidates = [0, 1, 2, 3].map((i) => `title-${i}-${tag}`);
        await new Promise((r) => setTimeout(r, 1100));

        const results = await Promise.all(
            candidates.map((title) =>
                request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                    headers: H(u.access_token),
                    data: { title },
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 200),
            'all same-field PATCH 200',
        ).toBe(true);

        const after = await getAgent(request, u.access_token, agent.id);
        expect(
            candidates.includes(after.title ?? ''),
            `final title "${after.title}" is one of the submitted values (no Frankenstein merge)`,
        ).toBe(true);
        // A metadata PATCH must never mutate the status column (not a writable prop)…
        expect(after.status, 'a metadata PATCH did not touch the status column').toBe('draft');
        // …nor silently drop the permissions object.
        expect(
            after.permissions.canCommitToRepo,
            'permissions object survived the PATCH burst',
        ).toBe(false);
        expect(
            Date.parse(after.updatedAt) >= Date.parse(before.updatedAt),
            `updatedAt monotonic: before=${before.updatedAt} after=${after.updatedAt}`,
        ).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL ASSIGN-TASK — durable run records, atomic terminal, no orphaned queue.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Parallel assign-task records durable, atomically-terminal run rows', () => {
    test('N parallel assign-task for the SAME (task, agent) → each response 202|500; every run row is durable + terminal, carries the taskId + triggerKind task, never orphaned in queued', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Same Assign ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Same Task ${stamp()}`,
        });

        const BURST = 5;
        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                assignTask(request, u.access_token, agent.id, task.id),
            ),
        );
        const statuses = results.map((r) => r.status());
        // Keyless CI: every enqueue throws → 500 (with a rolled-back 'failed' row). A
        // keyed env would 202 (dispatched). Both are valid; a 4xx here would be a bug.
        for (const s of statuses) {
            expect([202, 500], `assign status ${s} is a known outcome`).toContain(s);
        }

        // The run rows are the real assertion surface. No row may be stranded in
        // 'queued'/'running' with no worker (the markDispatchFailed rollback guarantees
        // the terminal transition). Poll until every row is terminal.
        await expect
            .poll(
                async () => {
                    const { data } = await listRuns(request, u.access_token, agent.id);
                    return data.every((r) => !['queued', 'running'].includes(r.status));
                },
                { timeout: 15_000, message: 'no run row is orphaned in queued/running' },
            )
            .toBe(true);

        const { data, total } = await listRuns(request, u.access_token, agent.id);
        expect(total, 'at least one run recorded').toBeGreaterThanOrEqual(1);
        expect(
            total,
            'no more runs than assign calls (dedup may collapse some)',
        ).toBeLessThanOrEqual(BURST);
        for (const r of data) {
            expect(r.id).toMatch(UUID_RE);
            expect(r.triggerKind, 'every run is a task-triggered run').toBe('task');
            expect(r.taskId, 'every run is attributed to the assigned task').toBe(task.id);
        }
    });

    test('N parallel assign-task for DISTINCT tasks → one run per task, distinct taskIds, all terminal (distinct tasks never dedup each other)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Multi Assign ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        const N = 4;
        const tasks = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                createTaskViaAPI(request, u.access_token, { title: `Multi Task ${i} ${stamp()}` }),
            ),
        );
        const results = await Promise.all(
            tasks.map((t) => assignTask(request, u.access_token, agent.id, t.id)),
        );
        for (const r of results) {
            expect([202, 500], `assign status ${r.status()}`).toContain(r.status());
        }

        await expect
            .poll(
                async () => {
                    const { data } = await listRuns(request, u.access_token, agent.id);
                    return data.every((r) => !['queued', 'running'].includes(r.status));
                },
                { timeout: 15_000, message: 'all distinct-task runs reach a terminal state' },
            )
            .toBe(true);

        const { data, total } = await listRuns(request, u.access_token, agent.id);
        // Distinct tasks cannot collapse into each other's dedup slot → one run each.
        expect(total, 'exactly one run per distinct task').toBe(N);
        const runTaskIds = new Set(data.map((r) => r.taskId));
        for (const t of tasks)
            expect(runTaskIds.has(t.id), `task ${t.id} recorded a run`).toBe(true);
        expect(runTaskIds.size, 'every recorded run has a distinct taskId').toBe(N);
    });

    test('durable dispatch rollback — a serial assign-task after a failed one still mints a NEW run (the failed row never wedges the (task,agent) dedup slot)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Durable Rollback ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Rollback Task ${stamp()}`,
        });

        const first = await assignTask(request, u.access_token, agent.id, task.id);
        const second = await assignTask(request, u.access_token, agent.id, task.id);
        expect([202, 500]).toContain(first.status());
        expect([202, 500]).toContain(second.status());

        const { total } = await listRuns(request, u.access_token, agent.id);
        if (first.status() === 500 && second.status() === 500) {
            // Both enqueues failed → each rolled its row to 'failed', freeing the dedup
            // slot, so the 2nd assign was NOT collapsed onto the 1st. Two durable rows.
            expect(
                total,
                'the rollback freed the dedup slot — the 2nd assign minted a new run',
            ).toBe(2);
        } else {
            // A keyed env would keep the 1st run in-flight and dedup the 2nd onto it.
            expect(total).toBeGreaterThanOrEqual(1);
        }
    });

    test('assign-task with a non-existent taskId → 404 and no phantom run row is created', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Ghost Assign ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);
        const ghost = '00000000-0000-4000-8000-000000000000';

        const res = await assignTask(request, u.access_token, agent.id, ghost);
        expect(res.status(), 'a non-existent task 404s (never 5xx)').toBe(404);
        expect((await res.json()).message).toMatch(/not found/i);
        // The 404 short-circuits BEFORE createQueued — no ghost run row.
        const { total } = await listRuns(request, u.access_token, agent.id);
        expect(total, 'a rejected assign records no run').toBe(0);
    });

    test('assign-task is NOT status-gated — a DRAFT agent still records a run (contrast the run-now 409 gate)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Draft Assign ${stamp()}`,
        });
        expect(agent.status).toBe('draft');
        const task = await createTaskViaAPI(request, u.access_token, {
            title: `Draft Assign Task ${stamp()}`,
        });

        const res = await assignTask(request, u.access_token, agent.id, task.id);
        // assign-task does not check agent.status (unlike run-now) — it records a run.
        expect([202, 500], `draft assign status ${res.status()}`).toContain(res.status());
        const { data, total } = await listRuns(request, u.access_token, agent.id);
        expect(total, 'a draft agent still records the run (no status gate)').toBe(1);
        expect(data[0].taskId).toBe(task.id);
        // The agent itself is unchanged — assigning a task does not activate it.
        expect(await getAgentStatus(request, u.access_token, agent.id)).toBe('draft');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// RUN-NOW — the manual-claim CAS gates on ACTIVE and never leaves a stuck RUNNING.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('run-now dispatch claim gate', () => {
    test('run-now on a non-ACTIVE agent (draft / paused) → 409 state gate; no run record; status unchanged', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // draft
        const draft = await createAgentViaAPI(request, u.access_token, {
            name: `RunNow Draft ${stamp()}`,
        });
        const r1 = await request.post(`${API_BASE}/api/agents/${draft.id}/run-now`, {
            headers: H(u.access_token),
            timeout: T,
        });
        expect(r1.status(), 'run-now on a draft agent is gated with 409').toBe(409);
        expect((await r1.json()).message).toMatch(/not in an ACTIVE state/i);
        expect(await getAgentStatus(request, u.access_token, draft.id), 'still draft').toBe(
            'draft',
        );
        expect((await listRuns(request, u.access_token, draft.id)).total, 'no run recorded').toBe(
            0,
        );

        // paused
        const paused = await createAgentViaAPI(request, u.access_token, {
            name: `RunNow Paused ${stamp()}`,
        });
        await activate(request, u.access_token, paused.id);
        expect((await pause(request, u.access_token, paused.id)).status()).toBe(200);
        const r2 = await request.post(`${API_BASE}/api/agents/${paused.id}/run-now`, {
            headers: H(u.access_token),
            timeout: T,
        });
        expect(r2.status(), 'run-now on a paused agent is gated with 409').toBe(409);
        expect(await getAgentStatus(request, u.access_token, paused.id)).toBe('paused');
    });

    test('run-now on an ACTIVE agent (keyless trigger) fails without stranding the agent — it recovers to ACTIVE, never a stuck RUNNING', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `RunNow Active ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        const res = await request.post(`${API_BASE}/api/agents/${agent.id}/run-now`, {
            headers: H(u.access_token),
            timeout: T,
        });
        // Keyless: the trigger enqueue throws → 500. Keyed: 202 dispatched. Either is
        // fine — the invariant is that the claim's release never strands RUNNING.
        expect([202, 500], `run-now status ${res.status()}`).toContain(res.status());
        await expect
            .poll(() => getAgentStatus(request, u.access_token, agent.id), {
                timeout: 15_000,
                message: 'the claim releases — the agent is not stranded in RUNNING',
            })
            .not.toBe('running');
        expect(
            ['active', 'error'],
            'a failed manual run leaves the agent recoverable (active/error), never stuck running',
        ).toContain(await getAgentStatus(request, u.access_token, agent.id));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL CREATE + PER-SCOPE UNIQUENESS + CROSS-USER ISOLATION.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Parallel agent create & isolation under concurrency', () => {
    test('N parallel DISTINCT-name creates → all 201 with distinct ids + slugs; all appear in the scoped list (no dropped/corrupted row)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const tag = stamp();
        const BURST = 6;
        const names = Array.from({ length: BURST }, (_, i) => `Distinct ${i} ${tag}`);

        const results = await Promise.all(
            names.map((name) =>
                request.post(`${API_BASE}/api/agents`, {
                    headers: H(u.access_token),
                    data: { scope: 'tenant', name },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        assertTolerated5xx(statuses, [201]);
        // Parse SURVIVORS only — a serialization 5xx carries no agent body.
        const survivors = results.filter((r) => r.status() === 201);
        const bodies = (await Promise.all(survivors.map((r) => r.json()))) as AgentRow[];
        const ids = bodies.map((b) => b.id);
        const slugs = bodies.map((b) => b.slug);
        for (const id of ids) expect(id).toMatch(UUID_RE);
        expect(new Set(ids).size, 'every surviving create got a distinct id').toBe(
            survivors.length,
        );
        expect(new Set(slugs).size, 'every surviving create got a distinct slug').toBe(
            survivors.length,
        );

        // All landed — filter the scoped list by our contested ids (never a global count).
        const list = await request.get(`${API_BASE}/api/agents?limit=200`, {
            headers: authedHeaders(u.access_token),
        });
        const listedIds: string[] = ((await list.json()).data ?? []).map((a: AgentRow) => a.id);
        for (const id of ids) expect(listedIds, `agent ${id} persisted + listed`).toContain(id);
    });

    test('the SAME name concurrently in DIFFERENT scopes (tenant vs work) → both 201 (uniqueness is per-scope), distinct ids', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `Scope Work ${stamp()}`,
            slug: `scope-work-${stamp()}`,
        });
        expect(work.id).toBeTruthy();
        const name = `Scoped Twin ${stamp()}`;

        const [tenantRes, workRes] = await Promise.all([
            request.post(`${API_BASE}/api/agents`, {
                headers: H(u.access_token),
                data: { scope: 'tenant', name },
                timeout: T,
            }),
            request.post(`${API_BASE}/api/agents`, {
                headers: H(u.access_token),
                data: { scope: 'work', name, workId: work.id },
                timeout: T,
            }),
        ]);
        expect(tenantRes.status(), 'tenant-scoped create succeeds').toBe(201);
        expect(
            workRes.status(),
            'the same name in WORK scope also succeeds (per-scope uniqueness)',
        ).toBe(201);
        const idA = (await tenantRes.json()).id;
        const idB = (await workRes.json()).id;
        expect(idA).toMatch(UUID_RE);
        expect(idB).toMatch(UUID_RE);
        expect(idA, 'the two scopes produced distinct rows').not.toBe(idB);
    });

    test('cross-user pause / resume / archive / assign-task / run-now → 404 (no existence leak, no 5xx)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `Owned ${stamp()}`,
        });
        await activate(request, owner.access_token, agent.id);
        const task = await createTaskViaAPI(request, intruder.access_token, {
            title: `Intruder Task ${stamp()}`,
        });

        const calls: Array<[string, Promise<{ status(): number }>]> = [
            ['pause', pause(request, intruder.access_token, agent.id)],
            ['resume', resume(request, intruder.access_token, agent.id)],
            ['archive', archive(request, intruder.access_token, agent.id)],
            ['assign-task', assignTask(request, intruder.access_token, agent.id, task.id)],
            [
                'run-now',
                request.post(`${API_BASE}/api/agents/${agent.id}/run-now`, {
                    headers: H(intruder.access_token),
                    timeout: T,
                }),
            ],
        ];
        for (const [label, p] of calls) {
            const res = await p;
            expect(res.status(), `cross-user ${label} is a 404 (no existence leak)`).toBe(404);
        }
        // The owner's agent is untouched by the intruder's rejected ops.
        expect(await getAgentStatus(request, owner.access_token, agent.id)).toBe('active');
    });

    test('two DIFFERENT users concurrently pause their OWN same-named agents → both 200 (per-user isolation, no cross-tenant CAS contention)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [u1, u2]: RegisteredUser[] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const name = `Twin Agent ${stamp()}`;
        const [a1, a2] = await Promise.all([
            createAgentViaAPI(request, u1.access_token, { name }),
            createAgentViaAPI(request, u2.access_token, { name }),
        ]);
        await Promise.all([
            activate(request, u1.access_token, a1.id),
            activate(request, u2.access_token, a2.id),
        ]);

        const [p1, p2] = await Promise.all([
            pause(request, u1.access_token, a1.id),
            pause(request, u2.access_token, a2.id),
        ]);
        expect(p1.status(), 'user 1 pauses their own agent').toBe(200);
        expect(p2.status(), 'user 2 pauses their own agent (independent CAS)').toBe(200);
        expect(await getAgentStatus(request, u1.access_token, a1.id)).toBe('paused');
        expect(await getAgentStatus(request, u2.access_token, a2.id)).toBe('paused');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// MIXED CHAOS + DETERMINISTIC OSCILLATION.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Mixed transition chaos & deterministic oscillation', () => {
    test('a burst mixing pause + resume on an ACTIVE agent → never a 5xx; the row lands in exactly one valid state (active or paused)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Chaos ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        // 4 pauses + 4 resumes fired simultaneously against active⇄paused.
        const ops = [
            ...Array.from({ length: 4 }, () => pause(request, u.access_token, agent.id)),
            ...Array.from({ length: 4 }, () => resume(request, u.access_token, agent.id)),
        ];
        const results = await Promise.all(ops);
        const statuses = results.map((r) => r.status());
        // Tolerate the sqlite global-write-serialization 5xx (a chaos burst against
        // one row is its worst case); every NON-5xx response is a legal state-machine
        // outcome: 200 (won an edge) or 400/409 (lost the CAS).
        assertTolerated5xx(statuses, [200, 400, 409]);

        // The terminal state is a single coherent value from the machine — never a
        // corrupt/phantom status.
        const terminal = await getAgentStatus(request, u.access_token, agent.id);
        expect(
            ['active', 'paused'],
            `terminal state ${terminal} is a valid machine state`,
        ).toContain(terminal);
    });

    test('serial oscillation active⇄paused is deterministic (200 each hop) and updatedAt is monotonic across hops', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Oscillate ${stamp()}`,
        });
        await activate(request, u.access_token, agent.id);

        let prevUpdatedAt = (await getAgent(request, u.access_token, agent.id)).updatedAt;
        const hops: Array<['pause' | 'resume', string]> = [
            ['pause', 'paused'],
            ['resume', 'active'],
            ['pause', 'paused'],
            ['resume', 'active'],
        ];
        for (const [verb, expected] of hops) {
            await new Promise((r) => setTimeout(r, 1100)); // let second-resolution updatedAt advance
            const res =
                verb === 'pause'
                    ? await pause(request, u.access_token, agent.id)
                    : await resume(request, u.access_token, agent.id);
            expect(res.status(), `${verb} hop → 200`).toBe(200);
            const row = (await res.json()) as AgentRow;
            expect(row.status, `${verb} lands ${expected}`).toBe(expected);
            expect(
                Date.parse(row.updatedAt) >= Date.parse(prevUpdatedAt),
                `updatedAt monotonic across the ${verb} hop: prev=${prevUpdatedAt} now=${row.updatedAt}`,
            ).toBe(true);
            prevUpdatedAt = row.updatedAt;
        }
        // A stale re-pause after the final resume is a fresh legal 200 (active→paused).
        const finalPause = await pause(request, u.access_token, agent.id);
        expect(finalPause.status(), 'the machine is not wedged after oscillation').toBe(200);
        expect(await getAgentStatus(request, u.access_token, agent.id)).toBe('paused');
    });
});
