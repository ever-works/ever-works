import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI, assignTaskToAgent } from './helpers/agents-tasks';

/**
 * Agent run-history PAGINATION + run-record shape — complex API orchestration of
 * the FU-2 runtime surface on `AgentsController`
 * (`apps/api/src/agents/agents.controller.ts`).
 *
 * This file is intentionally DISJOINT from `flow-agent-runs-history.spec.ts`
 * (which covers 3-task accumulation, the budget rollup, a single page-of-2
 * walk, and the assignee+run coexistence). Here we go deeper on the PAGINATION
 * envelope invariants, the FAILED-run record shape, the client-side
 * filter-by-task semantics (there is NO server-side task/status filter param —
 * confirmed from the DTO), the cancel-on-terminal no-op, and run-history
 * access isolation.
 *
 * Probed LIVE against the e2e stack (sqlite in-memory, NO TRIGGER_SECRET_KEY,
 * NO Trigger.dev worker) on 2026-06-01:
 *
 *   POST /api/agents/:id/assign-task { taskId }
 *     - On a configured stack → 202 { runId } (in-flight dedup reuses the run).
 *     - In CI (no TRIGGER_SECRET_KEY) → HTTP 500
 *         { message:"assign-task enqueue failed: You need to set the
 *           TRIGGER_SECRET_KEY …", error:"Internal Server Error", statusCode:500 }
 *       BUT a run row IS still persisted: createQueued() → enqueue throws →
 *       catch markFailed(). The row lands:
 *         { status:'failed', triggerKind:'task', taskId:<set>,
 *           startedAt:null, finishedAt:<set>, durationMs:null, summary:null,
 *           errorMessage:'enqueue-failed: You need to set the TRIGGER_SECRET_KEY …',
 *           createdAt:<set> }
 *     - DEDUP: `findInFlightForTaskAgent` only treats queued/running as in-flight.
 *       A *failed* run is NOT in-flight, so re-dispatching the SAME (taskId,agentId)
 *       in CI records a BRAND-NEW run each time (probed: 2 dispatches → 2 failed
 *       rows for the same taskId). assertion: never assert dedup-to-one in CI.
 *     - taskId is @IsUUID() → a non-UUID body → 400 ["taskId must be a UUID"];
 *       a well-formed-but-unknown task → 404 "Task <id> not found.".
 *
 *   GET /api/agents/:id/runs?limit&offset → 200
 *       { data:[ …NEWEST-FIRST… ], meta:{ total, limit, offset } }
 *     - ListAgentRunsQueryDto accepts ONLY { limit (1..200, default 25),
 *       offset (>=0, default 0) }. THERE IS NO task / status / triggerKind
 *       FILTER PARAM — filtering by task is a CLIENT-SIDE .filter() on data[].
 *     - Validation (probed): limit=201 → 400 "limit must not be greater than 200";
 *       limit=0 → 400 "limit must not be less than 1"; offset=-1 → 400
 *       "offset must not be less than 0"; limit=abc → 400 (not an integer).
 *     - The `meta` echoes the *requested* limit/offset (even past the end);
 *       `meta.total` is the unbounded count, stable across pages.
 *     - Each row: { id, status, triggerKind, startedAt, finishedAt, durationMs,
 *       summary, errorMessage, taskId, createdAt } — ISO strings or null.
 *
 *   POST /api/agents/:id/runs/:runId/cancel → 200 { cancelled, previousStatus }
 *     - For an ALREADY-TERMINAL (failed) run → 200 { cancelled:false,
 *       previousStatus:'failed' } (no-op). Unknown runId → 404
 *       "AgentRun <id> not found.".
 *
 *   POST /api/agents/:id/run-now → in CI 500 "AGENT_HEARTBEAT_TRIGGER not
 *     bound …" (dispatcher unbound). It throws BEFORE persisting → NO heartbeat
 *     run row is created → the runs list stays task-only.
 *
 *   ISOLATION: GET …/runs with a *different* user's bearer → 404 (agent not
 *     visible cross-user, surfaced by service.getOne); with NO bearer → 401;
 *     a non-UUID :id → 400 (ParseUUIDPipe); an unknown valid-UUID agent → 404.
 *
 * All flows run API-only on a FRESH registerUserViaAPI() user per test
 * (cross-spec isolation: never mutate the shared seeded user from API-only
 * specs). Assertions tolerate pre-existing behaviour via >= / toContain and
 * never assert exact GLOBAL counts beyond rows we created on a brand-new agent.
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
	'createdAt'
];

/** GET a runs page, asserting the 200 envelope. */
async function getRunsPage(
	request: APIRequestContext,
	token: string,
	agentId: string,
	query: { limit?: number; offset?: number } = {}
): Promise<RunsPage> {
	const params = new URLSearchParams();
	if (query.limit != null) params.set('limit', String(query.limit));
	if (query.offset != null) params.set('offset', String(query.offset));
	const qs = params.toString();
	const res = await request.get(
		`${API_BASE}/api/agents/${agentId}/runs${qs ? `?${qs}` : ''}`,
		{ headers: authedHeaders(token) }
	);
	expect(res.status(), `runs body=${await res.text().catch(() => '')}`).toBe(200);
	return res.json();
}

/**
 * Dispatch `count` distinct tasks to the agent and wait until the run history
 * shows exactly `count` records. Returns the created taskIds (dispatch order).
 */
async function dispatchDistinctTasks(
	request: APIRequestContext,
	token: string,
	agentId: string,
	count: number,
	stamp: string
): Promise<string[]> {
	const taskIds: string[] = [];
	for (let i = 1; i <= count; i++) {
		const task = await createTaskViaAPI(request, token, {
			title: `Run Task ${i} ${stamp}`
		});
		taskIds.push(task.id);
		await assignTaskToAgent(request, token, agentId, task.id);
	}
	await expect
		.poll(async () => (await getRunsPage(request, token, agentId)).meta.total, {
			timeout: 30_000,
			message: `expected ${count} runs to be recorded`
		})
		.toBe(count);
	return taskIds;
}

test.describe('Agent run-history pagination + record shape', () => {
	let user: RegisteredUser;
	let token: string;

	test.beforeEach(async ({ request }) => {
		user = await registerUserViaAPI(request);
		token = user.access_token;
		expect(token, 'fresh user should have a bearer token').toBeTruthy();
	});

	test('paging a 5-run history in size-2 windows reconstructs the full list, newest-first, with zero overlap', async ({
		request
	}) => {
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Paginate5 Agent ${stamp}`,
			scope: 'tenant'
		});

		const taskIds = await dispatchDistinctTasks(request, token, agent.id, 5, stamp);

		// The full, unpaged view (newest-first) is our oracle.
		const full = await getRunsPage(request, token, agent.id, { limit: 100, offset: 0 });
		expect(full.meta.total).toBe(5);
		expect(full.data).toHaveLength(5);
		const oracleIds = full.data.map((r) => r.id);
		expect(new Set(oracleIds).size, 'the full page has 5 distinct run ids').toBe(5);

		// createdAt is non-increasing across the WHOLE list (newest-first).
		const createdMs = full.data.map((r) => new Date(r.createdAt).getTime());
		for (let i = 1; i < createdMs.length; i++) {
			expect(createdMs[i - 1]).toBeGreaterThanOrEqual(createdMs[i]);
		}

		// Walk the history in 3 windows of 2 (rows 0-1, 2-3, 4) and concatenate.
		const windows: RunRow[][] = [];
		for (let offset = 0; offset < 6; offset += 2) {
			const page = await getRunsPage(request, token, agent.id, { limit: 2, offset });
			// meta.total is stable + the requested limit/offset are echoed back.
			expect(page.meta).toMatchObject({ total: 5, limit: 2, offset });
			windows.push(page.data);
		}
		// Window lengths: 2, 2, 1.
		expect(windows.map((w) => w.length)).toEqual([2, 2, 1]);

		const walked = windows.flat();
		const walkedIds = walked.map((r) => r.id);

		// No run id appears on two pages.
		expect(new Set(walkedIds).size, 'no run id appears on two windows').toBe(5);
		// The concatenated windows EXACTLY equal the oracle order (stable sort).
		expect(walkedIds).toEqual(oracleIds);
		// Every dispatched task is represented exactly once across the walk.
		const walkedTaskIds = walked.map((r) => r.taskId);
		for (const taskId of taskIds) {
			expect(walkedTaskIds.filter((t) => t === taskId)).toHaveLength(1);
		}
	});

	test('the runs query DTO rejects out-of-range limit/offset with field-specific 400s', async ({
		request
	}) => {
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `BadQuery Agent ${stamp}`,
			scope: 'tenant'
		});

		// A clean baseline: the defaults page is a valid 200 with limit 25 / offset 0.
		const defaults = await getRunsPage(request, token, agent.id);
		expect(defaults.meta).toMatchObject({ total: 0, limit: 25, offset: 0 });

		const cases: Array<{ query: string; needle: string }> = [
			{ query: 'limit=201', needle: 'limit must not be greater than 200' },
			{ query: 'limit=0', needle: 'limit must not be less than 1' },
			{ query: 'offset=-1', needle: 'offset must not be less than 0' },
			{ query: 'limit=abc', needle: 'limit must be an integer number' }
		];

		for (const { query, needle } of cases) {
			const res = await request.get(`${API_BASE}/api/agents/${agent.id}/runs?${query}`, {
				headers: authedHeaders(token)
			});
			expect(res.status(), `query "${query}" should be a 400`).toBe(400);
			const body = await res.json();
			const messages = Array.isArray(body.message) ? body.message : [body.message];
			expect(
				messages.some((m: string) => typeof m === 'string' && m.includes(needle)),
				`400 for "${query}" should mention "${needle}" (got ${JSON.stringify(messages)})`
			).toBeTruthy();
		}

		// A high-but-valid limit (200, the max) is accepted and echoed.
		const maxed = await getRunsPage(request, token, agent.id, { limit: 200, offset: 0 });
		expect(maxed.meta).toMatchObject({ limit: 200, offset: 0 });
	});

	test('re-dispatching the SAME task fans into multiple failed runs; client-side filter-by-task partitions the page', async ({
		request
	}) => {
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `FilterByTask Agent ${stamp}`,
			scope: 'tenant'
		});

		// Two distinct tasks; task A is dispatched THREE times, task B once.
		// (Failed runs are not "in flight", so each dispatch records a new row —
		//  there is NO dedup-to-one against a failed run in CI.)
		const taskA = await createTaskViaAPI(request, token, { title: `Hot Task ${stamp}` });
		const taskB = await createTaskViaAPI(request, token, { title: `Cold Task ${stamp}` });

		await assignTaskToAgent(request, token, agent.id, taskA.id);
		await assignTaskToAgent(request, token, agent.id, taskA.id);
		await assignTaskToAgent(request, token, agent.id, taskA.id);
		await assignTaskToAgent(request, token, agent.id, taskB.id);

		await expect
			.poll(async () => (await getRunsPage(request, token, agent.id, { limit: 100 })).meta.total, {
				timeout: 30_000,
				message: 'expected 4 task-bound runs (3 for A, 1 for B)'
			})
			.toBe(4);

		const page = await getRunsPage(request, token, agent.id, { limit: 100 });

		// There is NO server filter param — partition the page CLIENT-SIDE by taskId.
		const runsForA = page.data.filter((r) => r.taskId === taskA.id);
		const runsForB = page.data.filter((r) => r.taskId === taskB.id);
		expect(runsForA, 'task A fanned into 3 run records').toHaveLength(3);
		expect(runsForB, 'task B has exactly 1 run record').toHaveLength(1);

		// Every run is task-triggered and bound to one of our two tasks.
		const ourTaskIds = new Set([taskA.id, taskB.id]);
		for (const run of page.data) {
			expect(run.triggerKind).toBe('task');
			expect(run.taskId).toBeTruthy();
			expect(ourTaskIds.has(run.taskId as string)).toBeTruthy();
		}

		// The 3 A-runs have DISTINCT ids (genuine separate records, not a reused one).
		expect(new Set(runsForA.map((r) => r.id)).size).toBe(3);

		// Within task A's runs, newest-first ordering still holds.
		const aCreated = runsForA.map((r) => new Date(r.createdAt).getTime());
		for (let i = 1; i < aCreated.length; i++) {
			expect(aCreated[i - 1]).toBeGreaterThanOrEqual(aCreated[i]);
		}
	});

	test('a CI-failed task dispatch records a run whose field shape is fully populated and self-consistent', async ({
		request
	}) => {
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Shape Agent ${stamp}`,
			scope: 'tenant'
		});
		const task = await createTaskViaAPI(request, token, { title: `Shape Task ${stamp}` });

		// Dispatch. In CI this 500s at enqueue, but we never assert on the HTTP
		// result — `assignTaskToAgent` tolerates the non-2xx and returns null.
		const dispatched = await assignTaskToAgent(request, token, agent.id, task.id);
		expect(dispatched === null || typeof dispatched?.runId === 'string').toBeTruthy();

		await expect
			.poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
				timeout: 20_000
			})
			.toBe(1);

		const page = await getRunsPage(request, token, agent.id);
		const run = page.data[0];

		// Every documented field is present (typed shape contract).
		for (const field of RUN_FIELDS) {
			expect(run, `run should expose field "${field}"`).toHaveProperty(field);
		}

		// Identity + binding.
		expect(run.id).toBeTruthy();
		expect(run.triggerKind).toBe('task');
		expect(run.taskId).toBe(task.id);

		// createdAt is always a valid ISO timestamp.
		expect(Number.isNaN(new Date(run.createdAt).getTime())).toBeFalsy();

		// A model never ran here, so there is no duration and no successful summary.
		expect(run.durationMs).toBeNull();
		expect(run.summary).toBeNull();
		// It is NEVER a successful completion without a worker.
		expect(run.status).not.toBe('completed');

		// CI-specific (no TRIGGER_SECRET_KEY): the run is FAILED with a populated,
		// prefixed errorMessage, finishedAt SET, startedAt null (it never started).
		// A configured local stack could leave it queued/running instead — so we
		// branch and only deep-assert the failure shape when it is failed.
		if (run.status === 'failed') {
			expect(run.errorMessage, 'failed run carries an enqueue-failed message').toBeTruthy();
			expect(run.errorMessage as string).toContain('enqueue-failed');
			expect(run.startedAt, 'a never-started run has no startedAt').toBeNull();
			expect(run.finishedAt, 'a terminal run has a finishedAt').toBeTruthy();
			expect(
				Number.isNaN(new Date(run.finishedAt as string).getTime()),
				'finishedAt is a valid ISO timestamp'
			).toBeFalsy();
			// finishedAt is at or after createdAt.
			expect(new Date(run.finishedAt as string).getTime()).toBeGreaterThanOrEqual(
				new Date(run.createdAt).getTime()
			);
		} else {
			// Configured stack: an in-flight run has no finish/error yet.
			expect(['queued', 'running']).toContain(run.status);
		}
	});

	test('cancelling an already-terminal run is an idempotent no-op; unknown runs 404; total is unchanged', async ({
		request
	}) => {
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Cancel Agent ${stamp}`,
			scope: 'tenant'
		});
		const task = await createTaskViaAPI(request, token, { title: `Cancel Task ${stamp}` });

		await assignTaskToAgent(request, token, agent.id, task.id);
		await expect
			.poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
				timeout: 20_000
			})
			.toBe(1);

		const before = await getRunsPage(request, token, agent.id);
		const run = before.data[0];
		const previousStatus = run.status;

		// Cancelling. In CI the run is already 'failed' (terminal) → no-op:
		// { cancelled:false, previousStatus:'failed' }. On a configured stack a
		// queued/running run WOULD be cancellable (cancelled:true) — tolerate both,
		// but the response must echo the run's prior status either way.
		const cancelRes = await request.post(
			`${API_BASE}/api/agents/${agent.id}/runs/${run.id}/cancel`,
			{ headers: authedHeaders(token) }
		);
		expect(cancelRes.status()).toBe(200);
		const cancelBody = await cancelRes.json();
		expect(cancelBody).toHaveProperty('cancelled');
		expect(typeof cancelBody.cancelled).toBe('boolean');
		expect(cancelBody.previousStatus).toBe(previousStatus);
		if (previousStatus === 'failed') {
			// Terminal → no-op.
			expect(cancelBody.cancelled).toBe(false);
		}

		// Cancelling a terminal run again is still a 200 no-op (idempotent).
		const cancelAgain = await request.post(
			`${API_BASE}/api/agents/${agent.id}/runs/${run.id}/cancel`,
			{ headers: authedHeaders(token) }
		);
		expect(cancelAgain.status()).toBe(200);

		// An unknown (well-formed) runId under our agent → 404.
		const unknownRes = await request.post(
			`${API_BASE}/api/agents/${agent.id}/runs/11111111-1111-1111-1111-111111111111/cancel`,
			{ headers: authedHeaders(token) }
		);
		expect(unknownRes.status()).toBe(404);

		// Cancellation never deletes the run row — total is unchanged.
		const after = await getRunsPage(request, token, agent.id);
		expect(after.meta.total).toBe(1);
		expect(after.data[0].id).toBe(run.id);
	});

	test('run-now leaves the task-only history untouched, and run history is private per owner', async ({
		request
	}) => {
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Private Runs Agent ${stamp}`,
			scope: 'tenant'
		});

		// Seed exactly one task-triggered run.
		const task = await createTaskViaAPI(request, token, { title: `Private Task ${stamp}` });
		await assignTaskToAgent(request, token, agent.id, task.id);
		await expect
			.poll(async () => (await getRunsPage(request, token, agent.id)).meta.total, {
				timeout: 20_000
			})
			.toBe(1);

		// run-now: in CI the heartbeat dispatcher is unbound → 500 and NO row is
		// persisted (it throws before createQueued). On a configured stack it
		// could 202-dispatch a heartbeat run. Either way, exercise it and then
		// assert the recorded history's triggerKind composition.
		const runNowRes = await request.post(`${API_BASE}/api/agents/${agent.id}/run-now`, {
			headers: authedHeaders(token)
		});
		expect([202, 409, 500]).toContain(runNowRes.status());

		const afterRunNow = await getRunsPage(request, token, agent.id, { limit: 100 });
		// The original task run is still present and remains task-triggered.
		const taskRun = afterRunNow.data.find((r) => r.taskId === task.id);
		expect(taskRun, 'the task run survives a run-now attempt').toBeTruthy();
		expect(taskRun!.triggerKind).toBe('task');
		// Any extra rows (if a configured stack added a heartbeat) are heartbeat,
		// never task-bound; in CI there are no extra rows at all.
		const total = afterRunNow.meta.total;
		expect(total).toBeGreaterThanOrEqual(1);
		for (const r of afterRunNow.data) {
			if (r.taskId == null) {
				expect(r.triggerKind).not.toBe('task');
			}
		}

		// ── Run history is OWNER-PRIVATE ───────────────────────────────────
		// A different authenticated user cannot see this agent's runs at all —
		// the agent itself is not visible cross-user → 404 (NOT an empty 200).
		const other = await registerUserViaAPI(request);
		const crossRes = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`, {
			headers: authedHeaders(other.access_token)
		});
		expect(crossRes.status(), 'cross-user run history is 404').toBe(404);

		// No bearer at all → 401.
		const anonRes = await request.get(`${API_BASE}/api/agents/${agent.id}/runs`);
		expect(anonRes.status(), 'unauthenticated run history is 401').toBe(401);

		// A non-UUID agent id is rejected by ParseUUIDPipe before any lookup → 400.
		const badIdRes = await request.get(`${API_BASE}/api/agents/not-a-uuid/runs`, {
			headers: authedHeaders(token)
		});
		expect(badIdRes.status(), 'non-uuid agent id is 400').toBe(400);

		// A well-formed but unknown agent id → 404 (service.getOne access check).
		const unknownAgentRes = await request.get(
			`${API_BASE}/api/agents/22222222-2222-2222-2222-222222222222/runs`,
			{ headers: authedHeaders(token) }
		);
		expect(unknownAgentRes.status(), 'unknown agent run history is 404').toBe(404);
	});
});
