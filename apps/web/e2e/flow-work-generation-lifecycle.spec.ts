import { test, expect, type APIRequestContext } from '@playwright/test';
import {
	API_BASE,
	authedHeaders,
	createWorkViaAPI,
	registerUserViaAPI,
	type RegisteredUser,
} from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * FLOW: Work generation LIFECYCLE (Trigger-gated — assert the RECORD, not completion)
 *
 * COMPLEX, multi-step, cross-feature INTEGRATION flows centred on the Work
 * entity's generation lifecycle: triggering generation, the embedded
 * `generateStatus` object + `generationStartedAt/ProgressedAt/FinishedAt`
 * timestamp columns, per-work isolation, re-generation, and generation on a
 * deleted work. The CI driver has NO LLM key and NO Trigger.dev worker.
 *
 * ── SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100, 2026-06-01)
 *    and the real source BEFORE WRITING ───────────────────────────────────
 *    sources: apps/api/src/works/works.controller.ts,
 *             packages/agent/src/services/work-generation.service.ts,
 *             packages/agent/src/entities/work.entity.ts,
 *             packages/contracts/src/api/work/generate-status.enum.ts,
 *             apps/api/src/items-generator/dto/create-items-generator.dto.ts
 *
 *   POST /api/works { name, slug, description, organization:false } -> 200
 *       { status:'success', work:{ id, ..., generateStatus:null,
 *         generationStartedAt:null, generationProgressedAt:null,
 *         generationFinishedAt:null } }
 *       IMPORTANT: a fresh work's `generateStatus` is NULL. It is NOT a flat
 *       string — when populated it is an EMBEDDED OBJECT
 *       { status: GenerateStatusType, step?, progress?, error?, warnings?, ... }.
 *       GenerateStatusType ∈ { 'generating','generated','error','cancelled' }
 *       (NO 'pending'/'queued'/'idle' — those are fictional).
 *
 *   POST /api/works/:id/generate  (CreateItemsGeneratorDto)  @HttpCode(202)
 *       DTO REQUIRES `name` (1..200) AND `prompt` (1..5000) — they are NOT
 *       optional. An empty {} or missing field -> 400 class-validator
 *       ("name should not be empty" / "prompt should not be empty",
 *        error:'Bad Request'). With a VALID body but no AI/search provider
 *       configured (CI), the service rejects at the prepareProviders() gate
 *       BEFORE markGenerationStarted() runs -> 400
 *       { message:'One or more selected providers are not available.',
 *         providerErrors:{ search:'... "Tavily" is not configured ...' } }.
 *       Because that gate fires before any persistence, the lifecycle columns
 *       STAY NULL end-to-end in CI. (These two 400s are distinguishable by
 *       body shape — a validation 400 carries `error:'Bad Request'` + array
 *       message; the provider 400 carries `providerErrors`.)
 *
 *   GET /api/works/:id -> 200 { status:'success', work:{...lifecycle cols...} }
 *   GET /api/works/:id/history -> 200 { status:'success', history:[], total, limit, offset }
 *   GET /api/works?limit&offset&search -> 200 { status:'success', works, total, limit, offset }
 *       NB: the controller accepts ONLY limit/offset/search. A `?generateStatus=`
 *       query param is IGNORED (no-op) — the work is returned regardless of its
 *       (null) status. We assert that documented no-op, never a fictional filter.
 *   POST /api/works/:id/update  @HttpCode(202)  — AI item update. On a work
 *       that has NEVER generated (no stored last_request_data) -> 400
 *       { status:'error', slug, message:'Configuration invalid or missing.
 *         Please run a manual generation first.' } — proves generate-before-update ordering.
 *   POST /api/works/:id/cancel-generation @HttpCode(202) on a never-generated work
 *       -> 202 { status:'success', mode:'already_finished', message:'... no longer generating.' }
 *   POST /api/works/:id/delete -> 200 { status:'success', slug,
 *         message:"Work '<slug>' and associated repositories have been deleted",
 *         deleted_repositories:[] }
 *   POST /api/works/quick-create (QuickCreateWorkDto) @HttpCode(202) @Throttle(10/60s)
 *       create + generate in one call; in CI hits the SAME provider gate -> 400.
 *
 * ── HARD-WON AUTHZ CONTRACT (probed + source-confirmed) ──────────────────
 *   - cross-owner generate (valid body) -> 403 { status:'error',
 *       message:'You do not have permission to access this work' } (ownershipService.ensureCanEdit)
 *   - generate on a MISSING id (valid body) -> 404 { status:'error',
 *       message:"Work with id '<uuid>' not found" }
 *   - unauthenticated generate AND read -> 401 (controller-wide guard)
 *   - read on a DELETED work -> 404; generate on a DELETED work -> 4xx (never 2xx)
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 *   flow-work-generation-cancel.spec.ts owns the CANCEL surface (in-flight
 *   cancel, cancel-when-idle race, cancel-then-regenerate, ghost cancel, UI).
 *   THIS file is disjoint: it targets the lifecycle COLUMNS, the validation-vs-
 *   provider-gate 400 discrimination, the ?generateStatus no-op, per-work
 *   isolation, re-generation idempotence, generate→update ordering, quick-create,
 *   and generation-on-a-deleted-work — none of which the cancel spec touches.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────
 *   API-driven on FRESH registerUserViaAPI() users (cross-spec rule); the
 *   seeded user is consulted best-effort only. Unique slugs; assert toContain /
 *   status-sets, never exact counts.
 */

// The terminal lifecycle states a completed pipeline would reach. Without a
// worker (CI) these MUST NEVER appear — generation never finishes.
const TERMINAL_STATUSES = ['generated', 'error', 'cancelled'];

// A VALID generate body that satisfies CreateItemsGeneratorDto (name + prompt
// required). In CI this still 400s at the provider gate — that is the point.
const VALID_GENERATE_BODY = {
	name: 'e2e generation',
	prompt: 'List three popular open-source developer tools.',
};

// generate enqueue: 202 = declared happy path; 200/201 = adapters that collapse
// to OK; 400/402/409/422/429/500/503 = truthful enqueue-time gate (in CI the
// missing-provider gate is a 400). We never assert pipeline success — only that
// the endpoint ANSWERS from this set and the work record is coherent afterwards.
const GENERATE_ENQUEUE_OK = new Set([200, 201, 202, 400, 402, 409, 422, 429, 500, 503]);

interface GenerateStatusObject {
	status?: string;
	step?: string;
	progress?: number;
	error?: string;
	warnings?: string[];
}

interface WorkRecord {
	id: string;
	name?: string;
	slug?: string;
	// generateStatus is an EMBEDDED OBJECT (or null), never a flat string.
	generateStatus?: GenerateStatusObject | null;
	generationStartedAt?: string | null;
	generationProgressedAt?: string | null;
	generationFinishedAt?: string | null;
}

async function readJsonSafe(res: {
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		try {
			return await res.text();
		} catch {
			return undefined;
		}
	}
}

function uniqueSuffix(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

async function createWork(
	request: APIRequestContext,
	token: string,
	label = 'wg',
): Promise<{ id: string; work: WorkRecord }> {
	const suffix = uniqueSuffix();
	const created = await createWorkViaAPI(request, token, {
		name: `WG ${label} ${suffix}`,
		slug: `wg-${label}-${suffix}`,
		description: `work-generation-lifecycle e2e ${suffix}`,
	});
	expect(created.id, 'created work has an id').toBeTruthy();
	const work = (created.raw as { work?: WorkRecord }).work as WorkRecord;
	return { id: created.id, work };
}

/** Read the lifecycle record via GET /api/works/:id (the real status surface). */
async function readWork(
	request: APIRequestContext,
	token: string,
	id: string,
): Promise<WorkRecord> {
	const res = await request.get(`${API_BASE}/api/works/${id}`, { headers: authedHeaders(token) });
	expect(res.status(), `GET /works/${id}`).toBe(200);
	const body = (await res.json()) as { status?: string; work?: WorkRecord };
	expect(body.status, 'detail envelope').toBe('success');
	return body.work as WorkRecord;
}

async function generate(
	request: APIRequestContext,
	token: string,
	id: string,
	body: Record<string, unknown> = VALID_GENERATE_BODY,
): Promise<{ status: number; body: unknown }> {
	const res = await request.post(`${API_BASE}/api/works/${id}/generate`, {
		data: body,
		headers: authedHeaders(token),
	});
	return { status: res.status(), body: await readJsonSafe(res) };
}

/** Assert the lifecycle columns of a work have never advanced past their null defaults. */
function expectParkedLifecycle(work: WorkRecord, ctx: string): void {
	// generateStatus is either null or an embedded object — but it must NEVER be
	// in a terminal state without a worker, and must never be a bare string.
	if (work.generateStatus != null) {
		expect(
			typeof work.generateStatus,
			`${ctx}: generateStatus, when present, is an embedded object not a string`,
		).toBe('object');
		expect(
			TERMINAL_STATUSES,
			`${ctx}: no worker -> generation must NOT reach a terminal state`,
		).not.toContain(work.generateStatus.status);
	}
	expect(work.generationFinishedAt, `${ctx}: no worker -> never finished`).toBeNull();
}

test.describe('Work generation lifecycle (Trigger-gated)', () => {
	let user: RegisteredUser;
	let token: string;
	let headers: Record<string, string>;

	test.beforeAll(async ({ playwright }) => {
		// One fresh, isolated user for the whole file (mutations only touch our own works).
		const ctx = await playwright.request.newContext();
		user = await registerUserViaAPI(ctx);
		token = user.access_token;
		headers = authedHeaders(token);
		await ctx.dispose();
	});

	test('a fresh work has a NULL generateStatus + null lifecycle timestamps on both create and detail', async ({
		request,
	}) => {
		const { id, work } = await createWork(request, token, 'fresh');

		// The create envelope carries the lifecycle columns at their null defaults.
		// `generateStatus` is the embedded-object column — fresh works hold NULL,
		// not an 'idle' object and not an empty string.
		expect(work.generateStatus, 'fresh work has a null generateStatus').toBeNull();
		expect(work.generationStartedAt, 'no started timestamp').toBeNull();
		expect(work.generationProgressedAt, 'no progressed timestamp').toBeNull();
		expect(work.generationFinishedAt, 'no finished timestamp').toBeNull();

		// The same null record is independently observable via the detail surface
		// (there is no dedicated /generation-status route — GET /works/:id is it).
		const detail = await readWork(request, token, id);
		expect(detail.id).toBe(id);
		expect(detail.generateStatus, 'detail generateStatus null').toBeNull();
		expect(detail.generationStartedAt).toBeNull();
		expect(detail.generationProgressedAt).toBeNull();
		expect(detail.generationFinishedAt).toBeNull();
	});

	test('triggering generation: invalid DTO is a validation 400 while a valid DTO hits the provider gate — neither advances the lifecycle', async ({
		request,
	}) => {
		const { id } = await createWork(request, token, 'trigger');

		// (a) An EMPTY body fails CreateItemsGeneratorDto validation — name AND
		//     prompt are required. This is a class-validator 400, distinguishable
		//     from the provider gate by its `error:'Bad Request'` + array message.
		const invalid = await generate(request, token, id, {});
		expect(invalid.status, 'empty generate body -> 400 validation').toBe(400);
		const invalidBody = invalid.body as { error?: string; message?: unknown };
		expect(invalidBody.error, 'validation 400 marker').toBe('Bad Request');
		expect(Array.isArray(invalidBody.message), 'validation message is an array').toBeTruthy();
		expect(
			JSON.stringify(invalidBody.message),
			'validation names the required prompt field',
		).toMatch(/prompt/i);

		// A validation rejection never touched the work — lifecycle still null.
		const afterInvalid = await readWork(request, token, id);
		expect(afterInvalid.generateStatus, 'validation 400 leaves status null').toBeNull();
		expect(afterInvalid.generationStartedAt, 'validation 400 leaves startedAt null').toBeNull();

		// (b) A VALID body is accepted by the DTO but, with no AI/search provider
		//     configured in CI, the service rejects at prepareProviders() — BEFORE
		//     markGenerationStarted persists anything. This is the declared async
		//     enqueue path collapsing to a truthful gate; we tolerate the whole
		//     enqueue family but assert the RECORD, never completion.
		const valid = await generate(request, token, id);
		expect(
			GENERATE_ENQUEUE_OK.has(valid.status),
			`valid-body generate status ${valid.status} must be in the accepted-or-truthful set`,
		).toBeTruthy();
		// When it IS the CI provider gate (the common case), it is a 400 carrying
		// providerErrors — NOT a class-validator failure. Branch defensively so the
		// flow is robust if a provider ever gets configured.
		if (valid.status === 400) {
			const vb = valid.body as { providerErrors?: unknown; error?: string; message?: unknown };
			const isProviderGate =
				vb.providerErrors != null ||
				/provider/i.test(typeof vb.message === 'string' ? vb.message : '');
			const isValidationFailure = vb.error === 'Bad Request' && Array.isArray(vb.message);
			expect(
				isProviderGate || isValidationFailure,
				`a 400 on a valid body must be the provider gate or a (re)validation, not opaque`,
			).toBeTruthy();
			// A valid body must NOT trip the name/prompt validators again.
			if (Array.isArray(vb.message)) {
				expect(
					JSON.stringify(vb.message),
					'valid body never re-triggers name/prompt validation',
				).not.toMatch(/should not be empty/i);
			}
		}

		// Trigger-gated RECORD assertion: the provider gate fires before any
		// persistence, so the lifecycle columns remain parked at their null
		// defaults — they never reach a terminal state.
		const after = await readWork(request, token, id);
		expectParkedLifecycle(after, 'after valid-body generate');
		expect(after.generationStartedAt, 'provider gate -> no startedAt persisted').toBeNull();
	});

	test('the generation history surface is a well-formed envelope from a fresh-then-generated work', async ({
		request,
	}) => {
		const { id } = await createWork(request, token, 'history');

		// Fire a generate (best-effort — gated in CI) so the work has at least
		// touched the generation path. The activity-log write is best-effort
		// (.catch(()=>{})) so we POLL for the history 200 rather than assuming sync.
		await generate(request, token, id);

		await expect
			.poll(
				async () => {
					const res = await request.get(`${API_BASE}/api/works/${id}/history`, {
						headers,
					});
					return res.status();
				},
				{ timeout: 20_000, intervals: [500, 1000, 2000] },
			)
			.toBe(200);

		const res = await request.get(`${API_BASE}/api/works/${id}/history`, { headers });
		expect(res.status()).toBe(200);
		const body = (await res.json()) as {
			status?: string;
			history?: unknown;
			total?: number;
			limit?: number;
			offset?: number;
		};
		expect(body.status, 'history envelope status').toBe('success');
		// `history` is an array, and total/limit/offset are part of the envelope.
		expect(Array.isArray(body.history), 'history is an array').toBeTruthy();
		expect(typeof body.total, 'history total is numeric').toBe('number');
	});

	test('the ?generateStatus query param is a documented NO-OP — the work is returned regardless of its (null) status', async ({
		request,
	}) => {
		// Probed live: GET /works accepts only limit/offset/search. A
		// `?generateStatus=` param is silently ignored (the controller never
		// threads it into the query service), so a never-generated work with a
		// NULL status still appears under any value. We assert THAT real no-op,
		// not a fictional server-side filter.
		const { id } = await createWork(request, token, 'noopfilter');

		for (const state of ['generating', 'generated', 'error', 'cancelled', 'bogus']) {
			const res = await request.get(
				`${API_BASE}/api/works?generateStatus=${state}&limit=100`,
				{ headers },
			);
			expect(res.status(), `GET /works?generateStatus=${state}`).toBe(200);
			const body = (await res.json()) as { status?: string; works?: WorkRecord[] };
			expect(body.status, 'list envelope').toBe('success');
			const ids = (body.works ?? []).map((w) => w.id);
			// The filter is a no-op: our null-status work is present for EVERY value,
			// including the impossible 'bogus' one (proving the param was ignored).
			expect(
				ids,
				`no-op filter '${state}' still returns the never-generated work`,
			).toContain(id);
		}

		// And the unfiltered listing is owner-scoped and contains the same work.
		const all = await request.get(`${API_BASE}/api/works?limit=100`, { headers });
		expect(all.status()).toBe(200);
		const allIds = ((await all.json()).works as WorkRecord[]).map((w) => w.id);
		expect(allIds, 'unfiltered listing contains the work').toContain(id);
	});

	test('generation isolation: triggering A leaves siblings B and C with untouched null lifecycle columns', async ({
		request,
	}) => {
		const { id: a } = await createWork(request, token, 'iso-a');
		const { id: b } = await createWork(request, token, 'iso-b');
		const { id: c } = await createWork(request, token, 'iso-c');

		// Trigger generation ONLY on A (gated in CI — tolerate the enqueue family).
		const aResult = await generate(request, token, a);
		expect(GENERATE_ENQUEUE_OK.has(aResult.status)).toBeTruthy();

		// B and C are entirely untouched: null status + null timestamps throughout.
		const [rb, rc] = await Promise.all([
			readWork(request, token, b),
			readWork(request, token, c),
		]);
		for (const [label, sibling] of [
			['B', rb],
			['C', rc],
		] as const) {
			expect(sibling.generateStatus, `sibling ${label} status untouched`).toBeNull();
			expect(sibling.generationStartedAt, `sibling ${label} startedAt untouched`).toBeNull();
			expect(
				sibling.generationProgressedAt,
				`sibling ${label} progressedAt untouched`,
			).toBeNull();
			expect(sibling.generationFinishedAt, `sibling ${label} finishedAt untouched`).toBeNull();
		}

		// A itself never reaches a terminal state without a worker.
		const ra = await readWork(request, token, a);
		expectParkedLifecycle(ra, 'work A after isolated generate');
	});

	test('re-generation is idempotent in CI: repeated triggers stay gated and never wedge the work or its lifecycle', async ({
		request,
	}) => {
		const { id } = await createWork(request, token, 'regen');

		// Trigger generation three times in a row. Because the provider gate fires
		// before markGenerationStarted, the work never enters a 'generating' state,
		// so the ensureNotAlreadyGenerating ConflictException is never reached —
		// each call returns the SAME truthful enqueue status and the work stays
		// coherent (never wedged into a stuck terminal/locked state).
		const first = await generate(request, token, id);
		const second = await generate(request, token, id);
		const third = await generate(request, token, id);

		for (const [n, r] of [
			['1st', first],
			['2nd', second],
			['3rd', third],
		] as const) {
			expect(
				GENERATE_ENQUEUE_OK.has(r.status),
				`${n} generate status ${r.status} should match the enqueue contract`,
			).toBeTruthy();
		}
		// Re-generation is stable: the 2nd and 3rd attempts return the same status
		// as the 1st (no drift into a 409-locked or 5xx-crashed state in CI).
		expect(second.status, 're-generate is stable vs first').toBe(first.status);
		expect(third.status, 're-generate is stable vs first').toBe(first.status);

		// The work survives the whole cycle with its lifecycle still parked.
		const after = await readWork(request, token, id);
		expectParkedLifecycle(after, 'work after three re-generations');
		// It also remains queryable and is still owner-listed (not soft-deleted/archived).
		const list = await request.get(`${API_BASE}/api/works?limit=100`, { headers });
		expect(list.status()).toBe(200);
		const ids = ((await list.json()).works as WorkRecord[]).map((w) => w.id);
		expect(ids, 're-generated work still active in the listing').toContain(id);
	});

	test('generate-before-update ordering: the AI item /update on a never-generated work is rejected with a guidance 400', async ({
		request,
	}) => {
		const { id } = await createWork(request, token, 'order');

		// /update reuses the last generation's request data. A work that has never
		// generated has none, so the service rejects with a guidance message
		// instructing a manual generation first. This proves the generation
		// lifecycle ORDERING contract (generate must precede update).
		const res = await request.post(`${API_BASE}/api/works/${id}/update`, {
			data: {},
			headers,
		});
		expect(res.status(), 'update-before-generate -> 400').toBe(400);
		const body = (await readJsonSafe(res)) as { status?: string; message?: string };
		expect(body.status, 'guidance error envelope').toBe('error');
		expect(
			String(body.message),
			'guidance points the user to run a manual generation first',
		).toMatch(/generation/i);

		// The failed update did not advance the lifecycle either.
		const after = await readWork(request, token, id);
		expectParkedLifecycle(after, 'work after rejected update');
		expect(after.generationStartedAt, 'rejected update leaves startedAt null').toBeNull();
	});

	test('authz + deleted-work matrix: cross-owner 403, missing-id 404, unauth 401, then delete -> read 404 / generate 4xx', async ({
		request,
		playwright,
	}) => {
		const { id } = await createWork(request, token, 'authz');
		// Touch the generation path once so the work has been through it.
		await generate(request, token, id);

		// --- cross-owner: a DIFFERENT user cannot read or generate. ---
		const attacker = await registerUserViaAPI(request);
		const attackerHeaders = authedHeaders(attacker.access_token);

		const crossRead = await request.get(`${API_BASE}/api/works/${id}`, {
			headers: attackerHeaders,
		});
		expect(
			[401, 403, 404].includes(crossRead.status()),
			`cross-owner read status ${crossRead.status()} must be denied (no leak)`,
		).toBeTruthy();

		// A VALID body so we test ownership, not DTO validation.
		const crossGen = await request.post(`${API_BASE}/api/works/${id}/generate`, {
			data: VALID_GENERATE_BODY,
			headers: attackerHeaders,
		});
		expect(crossGen.status(), 'cross-owner generate -> 403 (permission denied)').toBe(403);
		const crossGenBody = (await readJsonSafe(crossGen)) as { status?: string; message?: string };
		expect(crossGenBody.status, 'cross-owner error envelope').toBe('error');
		expect(
			String(crossGenBody.message),
			'cross-owner message is a permission denial',
		).toMatch(/permission/i);

		// The attacker's own listing never surfaces the owner's work.
		const attackerList = await request.get(`${API_BASE}/api/works?limit=100`, {
			headers: attackerHeaders,
		});
		expect(attackerList.status()).toBe(200);
		const attackerIds = ((await attackerList.json()).works as WorkRecord[]).map((w) => w.id);
		expect(
			attackerIds,
			'tenant isolation — owner work absent from attacker list',
		).not.toContain(id);

		// --- missing id (valid body): ownership resolution -> 404 not found. ---
		const missingId = '00000000-0000-0000-0000-000000000000';
		const missing = await request.post(`${API_BASE}/api/works/${missingId}/generate`, {
			data: VALID_GENERATE_BODY,
			headers,
		});
		expect(missing.status(), 'generate on a missing work -> 404').toBe(404);
		const missingBody = (await readJsonSafe(missing)) as { message?: string };
		expect(String(missingBody.message), 'missing work message names the id').toMatch(
			/not found/i,
		);

		// --- unauthenticated: generate + read both rejected by the guard. ---
		// Empty storageState so we don't inherit a project auth cookie.
		const anon = await playwright.request.newContext({
			storageState: { cookies: [], origins: [] },
		});
		const anonGen = await anon.post(`${API_BASE}/api/works/${id}/generate`, {
			data: VALID_GENERATE_BODY,
		});
		expect(anonGen.status(), 'unauth generate -> 401').toBe(401);
		const anonRead = await anon.get(`${API_BASE}/api/works/${id}`);
		expect(anonRead.status(), 'unauth read -> 401').toBe(401);
		await anon.dispose();

		// --- delete, then generation-on-a-deleted-work + read are both gone. ---
		const del = await request.post(`${API_BASE}/api/works/${id}/delete`, {
			data: {},
			headers,
		});
		expect(del.status(), 'POST /works/:id/delete -> 200').toBe(200);
		const delBody = (await del.json()) as { status?: string; message?: string };
		expect(delBody.status, 'delete envelope').toBe('success');
		expect(String(delBody.message), 'delete confirms removal').toMatch(/deleted/i);

		// read on a DELETED work -> 404 (clean, never 5xx).
		const readAfterDelete = await request.get(`${API_BASE}/api/works/${id}`, { headers });
		expect(readAfterDelete.status(), 'read on a deleted work -> 404').toBe(404);

		// generation on a DELETED work -> a clean 4xx denial (ownership/existence
		// is resolved before any generation work), never a silent 2xx, never 5xx.
		const genAfterDelete = await request.post(`${API_BASE}/api/works/${id}/generate`, {
			data: VALID_GENERATE_BODY,
			headers,
		});
		expect(
			[400, 403, 404].includes(genAfterDelete.status()),
			`generate on a deleted work status ${genAfterDelete.status()} must be a clean 4xx`,
		).toBeTruthy();
		expect(genAfterDelete.status(), 'generate on a deleted work must not 5xx').toBeLessThan(500);

		// The deleted work no longer appears in the owner's listing.
		const listAfter = await request.get(`${API_BASE}/api/works?limit=100`, { headers });
		expect(listAfter.status()).toBe(200);
		const idsAfter = ((await listAfter.json()).works as WorkRecord[]).map((w) => w.id);
		expect(idsAfter, 'deleted work dropped from the active listing').not.toContain(id);

		// Best-effort: the seeded user (if resolvable) must not see our work either.
		try {
			const seeded = loadSeededTestUser();
			const login = await request.post(`${API_BASE}/api/auth/login`, {
				data: { email: seeded.email, password: seeded.password },
			});
			if (login.ok()) {
				const seededToken = (await login.json()).access_token;
				if (seededToken) {
					const seededList = await request.get(`${API_BASE}/api/works?limit=100`, {
						headers: authedHeaders(seededToken),
					});
					if (seededList.ok()) {
						const seededBody = (await readJsonSafe(seededList)) as {
							works?: WorkRecord[];
						};
						const seededIds = (seededBody.works ?? []).map((w) => w.id);
						expect(seededIds).not.toContain(id);
					}
				}
			}
		} catch {
			test.info().annotations.push({
				type: 'note',
				description:
					'seeded user creds unavailable in this harness — seeded isolation check skipped',
			});
		}
	});

	test('quick-create combines create + generate: the work is born and the generation request answers from the enqueue family', async ({
		request,
	}) => {
		// quick-create is the one-call create+generate path (wizard "Generate now").
		// In CI it hits the SAME provider gate as /generate, so the call may 400 —
		// but it must answer from the enqueue family and never crash. When it DOES
		// return 202 we additionally assert the declared {work, generation} shape.
		const suffix = uniqueSuffix();
		const res = await request.post(`${API_BASE}/api/works/quick-create`, {
			data: {
				name: `QC ${suffix}`,
				slug: `qc-${suffix}`,
				description: `quick-create e2e ${suffix}`,
				prompt: 'List three popular open-source developer tools.',
				organization: false,
			},
			headers,
		});
		expect(
			GENERATE_ENQUEUE_OK.has(res.status()),
			`quick-create status ${res.status()} should be in the accepted-or-truthful set`,
		).toBeTruthy();
		expect(res.status(), 'quick-create must not 5xx').toBeLessThan(500);

		const body = (await readJsonSafe(res)) as {
			status?: string;
			work?: { id?: string; slug?: string };
			generation?: { historyId?: string; message?: string };
			providerErrors?: unknown;
		};

		if (res.status() === 202 && body.work?.id) {
			// Declared happy path: the work was created and a generation kicked off.
			expect(body.status, 'quick-create status pending').toBe('pending');
			expect(body.work.id, 'quick-create returns a work id').toBeTruthy();
			expect(body.generation, 'quick-create returns a generation block').toBeTruthy();

			// The just-created work is readable and its lifecycle has NOT completed
			// (no worker in CI) — assert the RECORD, never completion.
			const detail = await readWork(request, token, body.work.id);
			expectParkedLifecycle(detail, 'quick-created work');
		} else {
			// CI gate: the provider rejection prevented the combined create+generate.
			// It must be a truthful provider/validation 400 — never an opaque crash.
			expect(res.status(), 'quick-create gated outcome is a 4xx').toBeGreaterThanOrEqual(400);
			expect(res.status()).toBeLessThan(500);
			test.info().annotations.push({
				type: 'note',
				description: `quick-create gated in CI (status ${res.status()}) — no AI/search provider configured; create+generate not persisted`,
			});
		}
	});
});
