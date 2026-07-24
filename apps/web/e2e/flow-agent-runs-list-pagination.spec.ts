import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI, assignTaskToAgent } from './helpers/agents-tasks';

/**
 * flow-agent-runs-list-pagination — DEEP, ASSERTIVE coverage of the LIST endpoint
 * `GET /api/agents/:id/runs` on `AgentsController` (FU-2 runtime surface,
 * `apps/api/src/agents/agents.controller.ts` → `AgentRunRepository.findByAgentAndUser`
 * in `packages/agent/src/database/repositories/agent-run.repository.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-agent-runs-pagination.spec.ts already walks a 5-run history in size-2
 *   windows, checks the four limit/offset RANGE 400s (limit=201/0, offset=-1,
 *   limit=abc), the FAILED-run field shape, the re-dispatch fan + client-side
 *   filter-by-task, cancel-on-terminal, and cross-USER isolation.
 *   flow-agent-runs-history.spec.ts covers 3-task accumulation + budget rollup.
 *
 *   THIS file is deliberately DISJOINT and pins the angles those DON'T:
 *     • the STRICT non-whitelisted query rejection — `ListAgentRunsQueryDto` runs
 *       under `forbidNonWhitelisted`, so ANY param other than {limit,offset}
 *       (sort / status / triggerKind / q / cursor / page / order / …) 400s with
 *       "property <name> should not exist" — there is NO server-side sort/filter;
 *     • FRACTIONAL / negative limit & offset (IsInt / Min) beyond the abc case;
 *     • the DEFAULT-limit-25 CAP actually clamping data[] to 25 over a 26-run
 *       history (the sibling only asserts meta.limit=25 on an EMPTY agent);
 *     • deep multi-size window partition over a ~9-run history + a limit=1
 *       single-step full walk (set coverage, zero overlap, meta.total stable);
 *     • boundary offsets: offset==total (empty) and offset==total-1 (the single
 *       OLDEST row);
 *     • TWO-AGENT SAME-USER isolation (each agent's history is private to that
 *       agentId — not just cross-user);
 *     • CONCURRENCY: N parallel identical reads are byte-identical (read
 *       consistency), N parallel distinct-offset reads partition cleanly, and an
 *       N-way parallel assign-task burst of the SAME task records 1..N distinct
 *       persisted runs without corrupting the list (no 5xx on the read).
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver,
 * NO TRIGGER_SECRET_KEY, NO Trigger.dev worker) on 2026-07-21:
 *
 *   GET /api/agents/:id/runs?limit&offset → 200
 *     { data:[ …NEWEST-FIRST… ], meta:{ total, limit, offset } }
 *     - Ordering is `createdAt DESC`. @CreateDateColumn is SECOND-precision on
 *       this driver (createdAt lands as "…:14.000Z"), so runs minted in the same
 *       second TIE — ordering is asserted as NON-INCREASING (>=), never as a
 *       strict per-id sequence.
 *     - meta echoes the REQUESTED limit/offset (even past the end); meta.total is
 *       the unbounded count, stable across every page.
 *     - Defaults: limit=25, offset=0. limit range 1..200, offset >= 0.
 *     - Validation 400s: limit=0 / 201 / -5 / 1.5 / abc; offset=-1 / 1.5 / abc.
 *     - forbidNonWhitelisted: `?sort=createdAt` → 400
 *       {message:["property sort should not exist"],error:"Bad Request",statusCode:400};
 *       a VALID limit alongside an unknown param STILL 400s (whole-request reject).
 *     - offset past end → 200 { data:[], meta:{ total:<n>, limit, offset } }.
 *
 *   RUN CREATION (persist-despite-unbound): POST /api/agents/:id/assign-task
 *     { taskId } — in CI (no TRIGGER_SECRET_KEY) 500s at enqueue BUT still
 *     persists a run: { status:'failed', triggerKind:'task', taskId:<set>,
 *     startedAt:null, finishedAt:<set>, durationMs:null, summary:null,
 *     errorMessage:'enqueue-failed: You need to set the TRIGGER_SECRET_KEY …' }.
 *     Failed runs are NOT "in flight", so re-dispatch records a NEW row each time.
 *     A parallel SAME-task burst may collapse SOME via the queued-window dedup —
 *     so a burst of N yields 1..N runs (asserted tolerantly).
 *
 *   ISOLATION: cross-user bearer → 404 (agent invisible, no existence leak); no
 *     bearer → 401; non-UUID :id → 400 (ParseUUIDPipe); unknown valid-UUID → 404.
 *
 * Every test builds a FRESH registerUserViaAPI() owner + a FRESH agent, so
 * per-agent totals are exact (never the shared seeded user; never a global list
 * count). Unique Date.now()/random suffixes throughout.
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

interface RunsPage {
    data: RunRow[];
    meta: { total: number; limit: number; offset: number };
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

const suffix = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** GET a runs page, asserting the 200 envelope + meta echo. */
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
    const page = (await res.json()) as RunsPage;
    // Envelope contract: meta echoes exactly what we requested (or the defaults).
    expect(page.meta.limit).toBe(query.limit ?? 25);
    expect(page.meta.offset).toBe(query.offset ?? 0);
    return page;
}

/** Create one task and dispatch it — persists exactly one run. Returns the taskId. */
async function dispatchTaskRun(
    request: APIRequestContext,
    token: string,
    agentId: string,
    title: string,
): Promise<string> {
    const task = await createTaskViaAPI(request, token, { title });
    await assignTaskToAgent(request, token, agentId, task.id);
    return task.id;
}

/**
 * Dispatch `n` DISTINCT tasks to a FRESH agent and wait until the run history
 * shows exactly `n` records. Returns the created taskIds in dispatch order.
 */
async function dispatchN(
    request: APIRequestContext,
    token: string,
    agentId: string,
    n: number,
    stamp: string,
): Promise<string[]> {
    const taskIds: string[] = [];
    for (let i = 1; i <= n; i++) {
        taskIds.push(await dispatchTaskRun(request, token, agentId, `Run ${i} ${stamp}`));
    }
    await expect
        .poll(async () => (await getRunsPage(request, token, agentId, { limit: 200 })).meta.total, {
            timeout: 30_000,
            message: `expected ${n} runs recorded on the fresh agent`,
        })
        .toBe(n);
    return taskIds;
}

/** Assert an array of epoch-ms values is non-increasing (newest-first, ties allowed). */
function assertNonIncreasing(msValues: number[]): void {
    for (let i = 1; i < msValues.length; i++) {
        expect(
            msValues[i - 1],
            `createdAt must be non-increasing at index ${i}`,
        ).toBeGreaterThanOrEqual(msValues[i]);
    }
}

test.describe('Agent runs list — envelope & persistence', () => {
    let user: RegisteredUser;
    let token: string;

    test.beforeEach(async ({ request }) => {
        user = await registerUserViaAPI(request);
        token = user.access_token;
        expect(token, 'fresh user should have a bearer token').toBeTruthy();
    });

    test('a fresh agent returns the empty envelope with default limit=25 / offset=0', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Empty Runs ${suffix()}`,
            scope: 'tenant',
        });
        const page = await getRunsPage(request, token, agent.id);
        expect(page.data).toEqual([]);
        expect(page.meta).toEqual({ total: 0, limit: 25, offset: 0 });
    });

    test('a run record PERSISTS and is listable even though Trigger.dev is unbound (assign-task 500)', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Persist Runs ${suffix()}`,
            scope: 'tenant',
        });
        const task = await createTaskViaAPI(request, token, { title: `Persist Task ${suffix()}` });

        // Dispatch directly so we can observe the HTTP status of the enqueue.
        const dispatchRes = await request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
            headers: authedHeaders(token),
            data: { taskId: task.id },
        });
        // CI (no TRIGGER_SECRET_KEY) → 500; a configured stack → 202. Either way a
        // run row must land in the history.
        expect([202, 500]).toContain(dispatchRes.status());

        await expect
            .poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
                timeout: 20_000,
            })
            .toBe(1);

        const run = (await getRunsPage(request, token, agent.id)).data[0];
        expect(run.triggerKind).toBe('task');
        expect(run.taskId).toBe(task.id);
        // The unbound-Trigger.dev branch: FAILED with an enqueue-failed message.
        // A configured stack could leave it queued/running instead — tolerate both.
        if (run.status === 'failed') {
            expect(run.errorMessage, 'failed run carries an enqueue error').toBeTruthy();
            expect(run.errorMessage as string).toMatch(/enqueue-failed|TRIGGER_SECRET_KEY/);
            expect(run.startedAt, 'a never-started run has no startedAt').toBeNull();
            expect(run.finishedAt, 'a terminal run has a finishedAt').toBeTruthy();
        } else {
            expect(['queued', 'running']).toContain(run.status);
        }
        // It is NEVER a spurious success without a worker.
        expect(run.status).not.toBe('completed');
    });

    test('every listed run row exposes the full documented field shape (ISO strings or null)', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Shape Runs ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 3, suffix());

        const page = await getRunsPage(request, token, agent.id, { limit: 100 });
        expect(page.data).toHaveLength(3);
        for (const run of page.data) {
            for (const field of RUN_FIELDS) {
                expect(run, `run should expose "${field}"`).toHaveProperty(field);
            }
            // Non-null timestamps must parse as valid dates.
            expect(Number.isNaN(new Date(run.createdAt).getTime())).toBeFalsy();
            if (run.finishedAt != null) {
                expect(Number.isNaN(new Date(run.finishedAt).getTime())).toBeFalsy();
            }
            // durationMs is a number-or-null contract (no model ran here → null).
            expect(run.durationMs === null || typeof run.durationMs === 'number').toBeTruthy();
            expect(run.triggerKind).toBe('task');
        }
    });
});

test.describe('Agent runs list — strict query whitelist', () => {
    let token: string;
    let agentId: string;

    test.beforeEach(async ({ request }) => {
        const user = await registerUserViaAPI(request);
        token = user.access_token;
        const agent = await createAgentViaAPI(request, token, {
            name: `Whitelist ${suffix()}`,
            scope: 'tenant',
        });
        agentId = agent.id;
    });

    test('an unknown query param `sort` is rejected 400 "property sort should not exist"', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs?sort=createdAt`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        const messages: string[] = Array.isArray(body.message) ? body.message : [body.message];
        expect(
            messages.some(
                (m) => typeof m === 'string' && m.includes('property sort should not exist'),
            ),
            `expected "property sort should not exist", got ${JSON.stringify(messages)}`,
        ).toBeTruthy();
    });

    test('NO server-side sort/filter param exists — every non-{limit,offset} query 400s', async ({
        request,
    }) => {
        // There is deliberately no status / triggerKind / task / search / cursor
        // filter on the runs list: filtering is a client concern over data[].
        const unknownParams = [
            'status=failed',
            'triggerKind=task',
            'taskId=11111111-1111-1111-1111-111111111111',
            'q=hello',
            'search=hello',
            'cursor=abc',
            'page=2',
            'order=asc',
            'sortBy=createdAt',
            'foo=bar',
        ];
        for (const q of unknownParams) {
            const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs?${q}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `?${q} should be rejected 400`).toBe(400);
        }
    });

    test('a VALID limit alongside an unknown param still fails the whole request (400)', async ({
        request,
    }) => {
        const res = await request.get(
            `${API_BASE}/api/agents/${agentId}/runs?limit=5&status=failed`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(res.status(), 'forbidNonWhitelisted rejects the whole request').toBe(400);
    });
});

test.describe('Agent runs list — limit/offset validation', () => {
    let token: string;
    let agentId: string;

    test.beforeEach(async ({ request }) => {
        const user = await registerUserViaAPI(request);
        token = user.access_token;
        const agent = await createAgentViaAPI(request, token, {
            name: `Validate ${suffix()}`,
            scope: 'tenant',
        });
        agentId = agent.id;
    });

    test('FRACTIONAL limit / offset are rejected by @IsInt (400)', async ({ request }) => {
        for (const q of ['limit=1.5', 'offset=1.5', 'limit=2.0001', 'offset=0.5']) {
            const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs?${q}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `?${q} must be an integer 400`).toBe(400);
        }
    });

    test('negative / zero limit and negative offset are rejected by @Min (400)', async ({
        request,
    }) => {
        const cases: Array<{ query: string; needle: string }> = [
            { query: 'limit=0', needle: 'limit must not be less than 1' },
            { query: 'limit=-5', needle: 'limit must not be less than 1' },
            { query: 'offset=-1', needle: 'offset must not be less than 0' },
        ];
        for (const { query, needle } of cases) {
            const res = await request.get(`${API_BASE}/api/agents/${agentId}/runs?${query}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `?${query} should be a 400`).toBe(400);
            const body = await res.json();
            const messages: string[] = Array.isArray(body.message) ? body.message : [body.message];
            expect(
                messages.some((m) => typeof m === 'string' && m.includes(needle)),
                `400 for "${query}" should mention "${needle}" (got ${JSON.stringify(messages)})`,
            ).toBeTruthy();
        }
    });

    test('limit=200 (the max) is accepted; limit=201 crosses the @Max boundary → 400', async ({
        request,
    }) => {
        // Max accepted + echoed on a real (small) history.
        await dispatchN(request, token, agentId, 2, suffix());
        const maxed = await getRunsPage(request, token, agentId, { limit: 200, offset: 0 });
        expect(maxed.meta.limit).toBe(200);
        expect(maxed.data.length).toBe(2);

        const over = await request.get(`${API_BASE}/api/agents/${agentId}/runs?limit=201`, {
            headers: authedHeaders(token),
        });
        expect(over.status()).toBe(400);
        const body = await over.json();
        const messages: string[] = Array.isArray(body.message) ? body.message : [body.message];
        expect(
            messages.some(
                (m) => typeof m === 'string' && m.includes('limit must not be greater than 200'),
            ),
        ).toBeTruthy();
    });
});

test.describe('Agent runs list — default limit & deep pagination', () => {
    let token: string;

    test.beforeEach(async ({ request }) => {
        const user = await registerUserViaAPI(request);
        token = user.access_token;
    });

    test('the DEFAULT page caps data[] at 25 across a 26-run history; offset=25 returns the remainder', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Cap25 ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 26, suffix());

        // Default page (no query): 25 rows even though 26 exist.
        const first = await getRunsPage(request, token, agent.id);
        expect(first.meta).toEqual({ total: 26, limit: 25, offset: 0 });
        expect(first.data, 'default limit clamps to 25 rows').toHaveLength(25);

        // The 26th row is reachable on the next page.
        const second = await getRunsPage(request, token, agent.id, { offset: 25 });
        expect(second.meta).toEqual({ total: 26, limit: 25, offset: 25 });
        expect(second.data).toHaveLength(1);

        // The two default-sized pages reconstruct the full 26-run set with no overlap.
        const oracle = await getRunsPage(request, token, agent.id, { limit: 100 });
        const oracleIds = new Set(oracle.data.map((r) => r.id));
        expect(oracleIds.size).toBe(26);
        const paged = [...first.data, ...second.data].map((r) => r.id);
        expect(new Set(paged).size, 'no id appears on both default pages').toBe(26);
        for (const id of paged) expect(oracleIds).toContain(id);
    });

    test('a size-3 window walk over a 9-run history reconstructs the full set, newest-first, zero overlap', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Walk9 ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 9, suffix());

        const oracle = await getRunsPage(request, token, agent.id, { limit: 100 });
        expect(oracle.meta.total).toBe(9);
        const oracleIds = oracle.data.map((r) => r.id);
        expect(new Set(oracleIds).size).toBe(9);
        assertNonIncreasing(oracle.data.map((r) => new Date(r.createdAt).getTime()));

        const walked: RunRow[] = [];
        for (let offset = 0; offset < 12; offset += 3) {
            const page = await getRunsPage(request, token, agent.id, { limit: 3, offset });
            // meta.total is invariant + the offset is echoed on EVERY page.
            expect(page.meta.total).toBe(9);
            expect(page.meta.offset).toBe(offset);
            // Each window is internally newest-first.
            assertNonIncreasing(page.data.map((r) => new Date(r.createdAt).getTime()));
            walked.push(...page.data);
        }
        // Windows of 3,3,3,0 → exactly 9 rows, all distinct, covering the oracle.
        expect(walked).toHaveLength(9);
        const walkedIds = walked.map((r) => r.id);
        expect(new Set(walkedIds).size, 'no run id appears on two windows').toBe(9);
        for (const id of oracleIds) expect(walkedIds).toContain(id);
        // The full concatenation is still non-increasing end-to-end.
        assertNonIncreasing(walked.map((r) => new Date(r.createdAt).getTime()));
    });

    test('a limit=1 single-step walk visits every run exactly once', async ({ request }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Step1 ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 6, suffix());

        const oracle = await getRunsPage(request, token, agent.id, { limit: 100 });
        const oracleIds = new Set(oracle.data.map((r) => r.id));
        expect(oracleIds.size).toBe(6);

        const seen: string[] = [];
        const createdMs: number[] = [];
        for (let offset = 0; offset < 6; offset++) {
            const page = await getRunsPage(request, token, agent.id, { limit: 1, offset });
            expect(page.data, `offset=${offset} yields exactly one row`).toHaveLength(1);
            expect(page.meta.total).toBe(6);
            seen.push(page.data[0].id);
            createdMs.push(new Date(page.data[0].createdAt).getTime());
        }
        // One step past the end → empty, total preserved.
        const past = await getRunsPage(request, token, agent.id, { limit: 1, offset: 6 });
        expect(past.data).toEqual([]);
        expect(past.meta.total).toBe(6);

        expect(new Set(seen).size, 'each single-step page is a distinct run').toBe(6);
        for (const id of seen) expect(oracleIds).toContain(id);
        assertNonIncreasing(createdMs);
    });

    test('a limit far larger than total returns ALL rows and echoes the requested limit', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `BigLimit ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 4, suffix());

        const page = await getRunsPage(request, token, agent.id, { limit: 200, offset: 0 });
        expect(page.meta.limit).toBe(200);
        expect(page.meta.total).toBe(4);
        expect(page.data, 'data length is bounded by total, not by limit').toHaveLength(4);
    });

    test('meta.total is invariant across every (limit, offset) combination', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `TotalInvariant ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 5, suffix());

        const combos: Array<{ limit?: number; offset?: number }> = [
            {},
            { limit: 1 },
            { limit: 2, offset: 1 },
            { limit: 5, offset: 0 },
            { limit: 3, offset: 3 },
            { limit: 100, offset: 4 },
            { limit: 10, offset: 100 },
        ];
        for (const combo of combos) {
            const page = await getRunsPage(request, token, agent.id, combo);
            expect(page.meta.total, `total must be 5 for ${JSON.stringify(combo)}`).toBe(5);
        }
    });
});

test.describe('Agent runs list — ordering & boundary offsets', () => {
    let token: string;

    test.beforeEach(async ({ request }) => {
        const user = await registerUserViaAPI(request);
        token = user.access_token;
    });

    test('the full history is newest-first (createdAt non-increasing, tie-tolerant)', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Ordering ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 7, suffix());
        const page = await getRunsPage(request, token, agent.id, { limit: 100 });
        expect(page.data).toHaveLength(7);
        assertNonIncreasing(page.data.map((r) => new Date(r.createdAt).getTime()));
    });

    test('each newly dispatched run lands at the FRONT: total increments, front createdAt is monotonic', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Incremental ${suffix()}`,
            scope: 'tenant',
        });
        const stamp = suffix();
        let previousIds = new Set<string>();
        let previousFrontMs = 0;

        for (let n = 1; n <= 3; n++) {
            await dispatchTaskRun(request, token, agent.id, `Incr ${n} ${stamp}`);
            await expect
                .poll(
                    async () =>
                        (await getRunsPage(request, token, agent.id, { limit: 100 })).meta.total,
                    {
                        timeout: 20_000,
                    },
                )
                .toBe(n);

            const page = await getRunsPage(request, token, agent.id, { limit: 100 });
            expect(page.meta.total).toBe(n);
            const ids = page.data.map((r) => r.id);
            expect(new Set(ids).size).toBe(n);
            // Every previously-seen run is still present (append-only history).
            for (const id of previousIds) expect(ids).toContain(id);
            // The page is newest-first and the front never moves BACKWARD in time.
            assertNonIncreasing(page.data.map((r) => new Date(r.createdAt).getTime()));
            const frontMs = new Date(page.data[0].createdAt).getTime();
            expect(frontMs).toBeGreaterThanOrEqual(previousFrontMs);

            previousIds = new Set(ids);
            previousFrontMs = frontMs;
        }
    });

    test('offset==total yields an empty page; offset==total-1 yields the single OLDEST run', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Boundary ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 5, suffix());
        const oracle = await getRunsPage(request, token, agent.id, { limit: 100 });
        const oldest = oracle.data[oracle.data.length - 1];
        const oldestMs = new Date(oldest.createdAt).getTime();
        // The oldest row really is the minimum createdAt of the set.
        for (const r of oracle.data) {
            expect(new Date(r.createdAt).getTime()).toBeGreaterThanOrEqual(oldestMs);
        }

        // offset exactly at total → empty, total preserved.
        const atEnd = await getRunsPage(request, token, agent.id, { limit: 5, offset: 5 });
        expect(atEnd.data).toEqual([]);
        expect(atEnd.meta).toEqual({ total: 5, limit: 5, offset: 5 });

        // offset one before the end → exactly the oldest row (tie-tolerant on id:
        // its createdAt must equal the minimum).
        const lastRow = await getRunsPage(request, token, agent.id, { limit: 5, offset: 4 });
        expect(lastRow.data).toHaveLength(1);
        expect(lastRow.meta.total).toBe(5);
        expect(new Date(lastRow.data[0].createdAt).getTime()).toBe(oldestMs);
    });
});

test.describe('Agent runs list — isolation', () => {
    let token: string;

    test.beforeEach(async ({ request }) => {
        const user = await registerUserViaAPI(request);
        token = user.access_token;
    });

    test('two agents of the SAME user keep independent, non-overlapping run histories', async ({
        request,
    }) => {
        const stamp = suffix();
        const agentA = await createAgentViaAPI(request, token, {
            name: `Iso A ${stamp}`,
            scope: 'tenant',
        });
        const agentB = await createAgentViaAPI(request, token, {
            name: `Iso B ${stamp}`,
            scope: 'tenant',
        });
        const tasksA = await dispatchN(request, token, agentA.id, 4, `A-${stamp}`);
        const tasksB = await dispatchN(request, token, agentB.id, 2, `B-${stamp}`);

        const pageA = await getRunsPage(request, token, agentA.id, { limit: 100 });
        const pageB = await getRunsPage(request, token, agentB.id, { limit: 100 });

        expect(pageA.meta.total).toBe(4);
        expect(pageB.meta.total).toBe(2);

        const taskSetA = new Set(tasksA);
        const taskSetB = new Set(tasksB);
        // Agent A's runs bind ONLY to A's tasks, and vice versa.
        for (const r of pageA.data) expect(taskSetA.has(r.taskId as string)).toBeTruthy();
        for (const r of pageB.data) expect(taskSetB.has(r.taskId as string)).toBeTruthy();

        // Run ids never bleed across the two agents.
        const idsA = new Set(pageA.data.map((r) => r.id));
        for (const r of pageB.data) expect(idsA.has(r.id)).toBeFalsy();
    });

    test('a populated agent history is private: cross-user 404, anon 401, non-uuid 400, unknown 404', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `Private ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 2, suffix());

        // A DIFFERENT authenticated user cannot see the agent at all → 404 (no
        // existence leak), NOT an empty 200.
        const other = await registerUserViaAPI(request);
        const crossRes = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`, {
            headers: authedHeaders(other.access_token),
        });
        expect(crossRes.status(), 'cross-user run history is 404').toBe(404);

        // No bearer → 401.
        const anonRes = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`);
        expect(anonRes.status(), 'unauthenticated run history is 401').toBe(401);

        // Non-UUID :id → 400 (ParseUUIDPipe, before any lookup).
        const badIdRes = await request.get(`${API_BASE}/api/agents/not-a-uuid/runs`, {
            headers: authedHeaders(token),
        });
        expect(badIdRes.status(), 'non-uuid agent id is 400').toBe(400);

        // Well-formed but unknown agent id → 404 (service.getOne access check).
        const unknownRes = await request.get(
            `${API_BASE}/api/agents/22222222-2222-2222-2222-222222222222/runs`,
            { headers: authedHeaders(token) },
        );
        expect(unknownRes.status(), 'unknown agent run history is 404').toBe(404);
    });
});

test.describe('Agent runs list — concurrency', () => {
    let token: string;

    test.beforeEach(async ({ request }) => {
        const user = await registerUserViaAPI(request);
        token = user.access_token;
    });

    test('N parallel identical reads are byte-identical (read consistency, no 5xx)', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `ConcRead ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 6, suffix());

        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                request.get(`${API_BASE}/api/agents/${agent.id}/runs?limit=100`, {
                    headers: authedHeaders(token),
                }),
            ),
        );
        // Every concurrent read is a clean 200.
        for (const res of results) expect(res.status()).toBe(200);
        const pages = (await Promise.all(results.map((r) => r.json()))) as RunsPage[];
        // Identical total + identical id ordering across all readers (static dataset).
        const firstIds = JSON.stringify(pages[0].data.map((r) => r.id));
        for (const page of pages) {
            expect(page.meta.total).toBe(6);
            expect(JSON.stringify(page.data.map((r) => r.id))).toBe(firstIds);
        }
    });

    test('N parallel distinct-offset reads partition the history cleanly', async ({ request }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `ConcPartition ${suffix()}`,
            scope: 'tenant',
        });
        await dispatchN(request, token, agent.id, 8, suffix());
        const oracle = await getRunsPage(request, token, agent.id, { limit: 100 });
        const oracleIds = new Set(oracle.data.map((r) => r.id));
        expect(oracleIds.size).toBe(8);

        const offsets = [0, 2, 4, 6];
        const results = await Promise.all(
            offsets.map((offset) =>
                request.get(`${API_BASE}/api/agents/${agent.id}/runs?limit=2&offset=${offset}`, {
                    headers: authedHeaders(token),
                }),
            ),
        );
        for (const res of results) expect(res.status()).toBe(200);
        const pages = (await Promise.all(results.map((r) => r.json()))) as RunsPage[];
        const collected: string[] = [];
        for (const page of pages) {
            expect(page.meta.total).toBe(8);
            collected.push(...page.data.map((r) => r.id));
        }
        // The four concurrent windows together cover the full set with no overlap.
        expect(new Set(collected).size, 'concurrent windows do not overlap').toBe(8);
        for (const id of collected) expect(oracleIds).toContain(id);
    });

    test('an N-way parallel assign-task burst of the SAME task records 1..N distinct runs without corrupting the list', async ({
        request,
    }) => {
        const agent = await createAgentViaAPI(request, token, {
            name: `ConcBurst ${suffix()}`,
            scope: 'tenant',
        });
        const task = await createTaskViaAPI(request, token, { title: `Burst Task ${suffix()}` });

        const BURST = 6;
        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${API_BASE}/api/agents/${agent.id}/assign-task`, {
                    headers: authedHeaders(token),
                    data: { taskId: task.id },
                }),
            ),
        );
        // Each dispatch is a deterministic 202 (configured) or 500 (unbound) — never
        // some other 5xx; the queued-window dedup may collapse a few of them.
        for (const res of results) expect([202, 500]).toContain(res.status());

        // The list read after the burst is a clean 200 and the history is coherent.
        const page = await getRunsPage(request, token, agent.id, { limit: 100 });
        expect(page.meta.total).toBeGreaterThanOrEqual(1);
        expect(page.meta.total).toBeLessThanOrEqual(BURST);
        expect(page.data.length).toBe(page.meta.total);

        // No duplicate run ids; every recorded run is bound to the one task.
        const ids = page.data.map((r) => r.id);
        expect(new Set(ids).size, 'run ids are distinct — no Frankenstein rows').toBe(ids.length);
        for (const r of page.data) {
            expect(r.taskId).toBe(task.id);
            expect(r.triggerKind).toBe('task');
        }
        // Newest-first ordering survives the concurrent writes.
        assertNonIncreasing(page.data.map((r) => new Date(r.createdAt).getTime()));
    });
});
