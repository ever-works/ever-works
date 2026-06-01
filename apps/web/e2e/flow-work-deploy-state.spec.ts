import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * FLOW: Work deploy STATE MACHINE — complex, multi-step INTEGRATION flows.
 *
 * Theme (assigned): the deploy state machine carried on the Work entity
 * (`deploymentState` / `deploymentStartedAt` / `lastDeployCorrelationId` /
 * `deployProjectId` / `website`), deploy capability gating (configured-vs-
 * unconfigured), redeploy, the deployment-history list, rollback gating, and
 * deploy attempts on an UNDEPLOYABLE work.
 *
 * GROUNDING — every shape below was verified against the LIVE sqlite e2e API
 * (port 3100) with a throwaway user on 2026-06-01, and cross-checked against
 * the real source (apps/api/src/plugins-capabilities/deploy/deploy.controller.ts
 * + deploy.service.ts, packages/agent/src/entities/work.entity.ts,
 * apps/web/src/app/api/works/[id]/deploy/status/route.ts):
 *
 *   - The deploy capability is mounted under `/api/deploy` (NOT `/api/works/:id/...`):
 *       GET  /api/deploy/providers
 *            → 200 { status:'success', providers:[{ id,name,enabled,configured,... }] }
 *            (CI exposes k8s + vercel, both enabled:true configured:false)
 *       POST /api/deploy/works/:id            (DeployWorkDto: { teamScope? })
 *            unconfigured → 400 { status:'error',
 *              message:'Vercel token is required. Please configure it in Plugin Settings.' }
 *            extra body key → 400 { message:['property <k> should not exist'], ... } (forbidNonWhitelisted)
 *       POST /api/deploy/works/:id/check       → 201 { status:'success',
 *              canDeploy:false, isShared:false, ownerHasToken:false, userHasToken:false }
 *       POST /api/deploy/works/:id/lookup      unconfigured →
 *              400 { status:'error', message:'Vercel token is required to lookup deployments...' }
 *            (when a deployment exists it returns { website, deploymentState, found:true })
 *       GET  /api/deploy/works/:id/deployments → 200 { status:'success', deployments:[] }
 *       POST /api/deploy/works/:id/rollback    (RollbackDto: { deploymentId: @IsUUID @IsNotEmpty })
 *            bad uuid     → 400 { message:['deploymentId must be a UUID'], error:'Bad Request' }
 *            empty body   → 400 { message:[...3 validations] }
 *            valid-uuid but absent → 400 { status:'error', message:'Deployment not found for this work.' }
 *       POST /api/deploy/batch                 → 201 { status:'success'|'partial'|'error',
 *              totalRequested, successfullyStarted, failed, results:[{ workId,slug,status,message }] }
 *
 *   - Work deploy state-machine columns on a FRESH work (POST /api/works):
 *       deployProvider:'vercel' (column default), deploymentState:null,
 *       deploymentStartedAt:null, lastDeployCorrelationId:null, deployProjectId:null, website:null.
 *     deploy.service only writes deploymentState:'INITIALIZING' + deploymentStartedAt AFTER a
 *     successful workflow dispatch — which CANNOT happen on the CI stack (no provider token, no
 *     git token), so an unconfigured deploy 400s at the capability gate BEFORE any state write.
 *
 *   - Ownership matrix (WorkOwnershipService.ensureCanEdit / ensureCanView):
 *       cross-user (no membership) → 403 { status:'error', message:'You do not have permission to access this work' }
 *       missing work id            → 404 { status:'error', message:"Work with id '...' not found" }
 *       unauthenticated            → 401 { message:'Unauthorized', statusCode:401 }
 *
 *   - Web Next.js route GET /api/works/:id/deploy/status reads the SAME work and projects
 *     { deploymentState, deploymentStartedAt, website, deployProvider }; unauth → 500 { error:'Unauthorized' }
 *     (the route wraps the upstream 401 as 500). With the seeded session cookie it returns the projection.
 *
 * ADAPTIVITY: these flows assert the UNCONFIGURED branch (the CI reality) as the primary path
 * but tolerate a configured stack (a real Vercel/k8s token) by widening the accepted status set
 * with .or()-style status arrays — they never assert a fictional success. NON-DUPLICATION: the
 * sibling flow-templates-deploy.spec.ts already pins providers-list / vercel-configured / bogus-
 * configured / a single /check / /validate-token / one bare deploy; this file instead exercises
 * the STATE MACHINE (column invariants, idempotent reads, no-state-write-on-refusal), the
 * deployments-history list, redeploy idempotency, rollback gating, the cross-capability ownership
 * matrix, and the web deploy/status projection.
 *
 * ISOLATION: API mutations run on FRESH registerUserViaAPI() users (never the shared seeded user).
 * The seeded user (storageState) drives ONLY the UI status-route flow.
 */

const DEPLOY_BASE = `${API_BASE}/api/deploy`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Status classes accepted for a deploy POST: the CI-real 400 refusal, OR a configured success. */
const DEPLOY_OUTCOMES = [200, 201, 202, 400, 401, 403, 409, 422, 500];

interface WorkDeployFields {
	id: string;
	deploymentState: unknown;
	deploymentStartedAt: unknown;
	lastDeployCorrelationId: unknown;
	deployProjectId: unknown;
	website: unknown;
	deployProvider: unknown;
}

/** Create a fresh work and return its id. */
async function freshWorkId(
	request: APIRequestContext,
	token: string,
	name = `Deploy State Work ${Date.now()}`,
): Promise<string> {
	const { id } = await createWorkViaAPI(request, token, { name });
	expect(id, 'createWorkViaAPI should yield a work id').toBeTruthy();
	return id;
}

/** Read the deploy-relevant columns off GET /api/works/:id (envelope-tolerant). */
async function readWorkDeployFields(
	request: APIRequestContext,
	token: string,
	workId: string,
): Promise<WorkDeployFields> {
	const res = await request.get(`${API_BASE}/api/works/${workId}`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), 'work read should succeed').toBe(200);
	const json = (await res.json()) as Record<string, unknown>;
	const w = (json.work ?? json) as Record<string, unknown>;
	expect(w.id, 'work read should carry an id').toBeTruthy();
	return {
		id: w.id as string,
		deploymentState: w.deploymentState ?? null,
		deploymentStartedAt: w.deploymentStartedAt ?? null,
		lastDeployCorrelationId: w.lastDeployCorrelationId ?? null,
		deployProjectId: w.deployProjectId ?? null,
		website: w.website ?? null,
		deployProvider: w.deployProvider ?? null,
	};
}

test.describe('Work deploy state machine (deep integration)', () => {
	test('fresh-work deploy columns are all idle/null and a refused (unconfigured) deploy NEVER writes deploymentState/StartedAt — the gate runs before any state mutation', async ({
		request,
	}) => {
		const { access_token } = await registerUserViaAPI(request);
		const workId = await freshWorkId(request, access_token);

		// 1. Baseline: a never-deployed work has the entire deploy state machine at rest.
		const before = await readWorkDeployFields(request, access_token, workId);
		expect(before.deploymentState, 'fresh deploymentState is null').toBeNull();
		expect(before.deploymentStartedAt, 'fresh deploymentStartedAt is null').toBeNull();
		expect(before.lastDeployCorrelationId, 'fresh lastDeployCorrelationId is null').toBeNull();
		expect(before.website, 'fresh website is null').toBeNull();
		// deployProvider defaults to the column default ('vercel' on this stack) — a non-empty hint.
		expect(before.deployProvider, 'deployProvider has a default provider hint').toBeTruthy();

		// 2. Attempt a deploy. On CI (no provider token) the capability gate refuses with a 400
		//    BEFORE deploy.service ever runs the dispatch that would set INITIALIZING — so the
		//    refusal MUST leave the state machine untouched. (A configured stack may 2xx; both ok.)
		const deploy = await request.post(`${DEPLOY_BASE}/works/${workId}`, {
			headers: authedHeaders(access_token),
			data: {},
		});
		expect(DEPLOY_OUTCOMES).toContain(deploy.status());
		const deployBody = (await deploy.json().catch(() => null)) as Record<string, unknown> | null;
		if (deploy.status() === 400) {
			// Truthful capability refusal carries the provider-token message.
			expect(deployBody?.status).toBe('error');
			expect(String(deployBody?.message ?? '')).toMatch(/token is required|not configured|Plugin Settings/i);
		}

		// 3. Re-read the work. If the deploy was REFUSED (no 2xx), the state machine must be
		//    EXACTLY as before — no spontaneous INITIALIZING, no deploymentStartedAt stamp.
		const after = await readWorkDeployFields(request, access_token, workId);
		const wasAccepted = deploy.status() >= 200 && deploy.status() < 300;
		if (!wasAccepted) {
			expect(after.deploymentState, 'refused deploy must not set deploymentState').toBeNull();
			expect(after.deploymentStartedAt, 'refused deploy must not stamp deploymentStartedAt').toBeNull();
			expect(after.website, 'refused deploy must not set website').toBeNull();
		}
		// The deployProvider hint is invariant across the attempt either way.
		expect(after.deployProvider).toEqual(before.deployProvider);
	});

	test('capability gating is CONSISTENT across check/lookup/deploy on the same undeployable work, and is idempotent across repeated reads', async ({
		request,
	}) => {
		const { access_token } = await registerUserViaAPI(request);
		const workId = await freshWorkId(request, access_token, `Gate Consistency ${Date.now()}`);

		// /check is a POST that returns 201 with the per-actor capability breakdown.
		const check = await request.post(`${DEPLOY_BASE}/works/${workId}/check`, {
			headers: authedHeaders(access_token),
			data: {},
		});
		expect([200, 201]).toContain(check.status());
		const checkBody = (await check.json()) as Record<string, unknown>;
		expect(checkBody.status).toBe('success');
		expect(typeof checkBody.canDeploy, 'check exposes canDeploy boolean').toBe('boolean');
		expect(checkBody.isShared, 'creator is not a shared viewer').toBe(false);
		// On the unconfigured CI stack, no token anywhere → cannot deploy.
		const canDeploy = checkBody.canDeploy === true;

		// A SECOND /check must return the SAME capability verdict (pure read, no drift).
		const check2 = await request.post(`${DEPLOY_BASE}/works/${workId}/check`, {
			headers: authedHeaders(access_token),
			data: {},
		});
		expect([200, 201]).toContain(check2.status());
		expect(((await check2.json()) as Record<string, unknown>).canDeploy).toEqual(checkBody.canDeploy);

		// /lookup mirrors the same gate: with no token AND no existing website it 400s with the
		// "token is required to lookup deployments" copy; if a deployment somehow existed it would
		// 200 with { found, deploymentState }. Consistency: lookup's gate == check's canDeploy gate.
		const lookup = await request.post(`${DEPLOY_BASE}/works/${workId}/lookup`, {
			headers: authedHeaders(access_token),
			data: {},
		});
		const lookupBody = (await lookup.json().catch(() => null)) as Record<string, unknown> | null;
		if (!canDeploy) {
			expect(lookup.status(), `lookup body=${JSON.stringify(lookupBody)}`).toBe(400);
			expect(lookupBody?.status).toBe('error');
			expect(String(lookupBody?.message ?? '')).toMatch(/token is required to lookup|not configured/i);
		} else {
			expect([200, 201]).toContain(lookup.status());
			expect(lookupBody).toBeTruthy();
		}

		// /deploy itself: same gate. Unconfigured → 400 token-required; configured → a 2xx pending.
		const deploy = await request.post(`${DEPLOY_BASE}/works/${workId}`, {
			headers: authedHeaders(access_token),
			data: {},
		});
		expect(DEPLOY_OUTCOMES).toContain(deploy.status());
		if (!canDeploy) {
			expect(deploy.status(), 'undeployable work cannot be cleanly deployed').not.toBe(200);
			expect([400, 401, 403, 409, 422, 500]).toContain(deploy.status());
		}
	});

	test('deployment-history list is empty for a never-deployed work, ownership-gated, and a REFUSED deploy attempt appends NO history row', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const other = await registerUserViaAPI(request);
		const workId = await freshWorkId(request, owner.access_token, `History Work ${Date.now()}`);

		// 1. A never-deployed work has an empty (or at least array-shaped) deployment history.
		const list1 = await request.get(`${DEPLOY_BASE}/works/${workId}/deployments`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(list1.status()).toBe(200);
		const body1 = (await list1.json()) as Record<string, unknown>;
		expect(body1.status).toBe('success');
		expect(Array.isArray(body1.deployments), 'deployments is an array').toBe(true);
		const initialCount = (body1.deployments as unknown[]).length;
		expect(initialCount, 'fresh work has no deployment history').toBe(0);

		// 2. The list is ownership-gated: a different user with no membership → 403 (never a leak).
		const cross = await request.get(`${DEPLOY_BASE}/works/${workId}/deployments`, {
			headers: authedHeaders(other.access_token),
		});
		expect([403, 404], `cross-user deployments status`).toContain(cross.status());

		// 3. Attempt a deploy. On the unconfigured stack it 400s at the gate — and because deploy.service
		//    only creates a WorkDeployment row AFTER the gate passes, a refused deploy must add NO row.
		const deploy = await request.post(`${DEPLOY_BASE}/works/${workId}`, {
			headers: authedHeaders(owner.access_token),
			data: {},
		});
		expect(DEPLOY_OUTCOMES).toContain(deploy.status());

		const list2 = await request.get(`${DEPLOY_BASE}/works/${workId}/deployments`, {
			headers: authedHeaders(owner.access_token),
		});
		expect(list2.status()).toBe(200);
		const afterCount = ((await list2.json()).deployments as unknown[]).length;
		const wasAccepted = deploy.status() >= 200 && deploy.status() < 300;
		if (!wasAccepted) {
			expect(afterCount, 'refused deploy must not append a history row').toBe(initialCount);
		} else {
			// A configured stack legitimately records a row; only assert non-decreasing.
			expect(afterCount).toBeGreaterThanOrEqual(initialCount);
		}
	});

	test('redeploy idempotency: repeatedly deploying an undeployable work yields a STABLE truthful refusal each time and never corrupts the work or its history', async ({
		request,
	}) => {
		const { access_token } = await registerUserViaAPI(request);
		const workId = await freshWorkId(request, access_token, `Redeploy Work ${Date.now()}`);

		const statuses: number[] = [];
		const messages: string[] = [];
		for (let i = 0; i < 3; i++) {
			const res = await request.post(`${DEPLOY_BASE}/works/${workId}`, {
				headers: authedHeaders(access_token),
				data: {},
			});
			statuses.push(res.status());
			const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
			messages.push(String(body?.message ?? ''));
		}

		// Every attempt lands in the SAME outcome class — a deploy that is refused once is refused
		// the same way on retry (the gate is deterministic, not a transient that flickers to success).
		expect(new Set(statuses).size, `redeploy statuses drifted: ${statuses.join(',')}`).toBe(1);
		const firstStatus = statuses[0];
		expect(DEPLOY_OUTCOMES).toContain(firstStatus);
		if (firstStatus === 400) {
			// The refusal copy is stable across retries.
			expect(messages.every((m) => /token is required|not configured|Plugin Settings/i.test(m))).toBe(true);
		}

		// After three deploy attempts the work is intact and (if refused) still has no history.
		const after = await readWorkDeployFields(request, access_token, workId);
		expect(after.id).toBe(workId);
		const list = await request.get(`${DEPLOY_BASE}/works/${workId}/deployments`, {
			headers: authedHeaders(access_token),
		});
		expect(list.status()).toBe(200);
		const count = ((await list.json()).deployments as unknown[]).length;
		if (firstStatus !== 200 && firstStatus !== 201 && firstStatus !== 202) {
			expect(after.deploymentState, 'refused redeploys leave state idle').toBeNull();
			expect(count, 'refused redeploys append no history rows').toBe(0);
		}
	});

	test('rollback gating state machine: bad-UUID and empty-body are DTO-rejected (400), a well-formed but non-existent deployment id is 400 "Deployment not found", and the work survives every rejected rollback', async ({
		request,
	}) => {
		const { access_token } = await registerUserViaAPI(request);
		const workId = await freshWorkId(request, access_token, `Rollback Work ${Date.now()}`);

		// 1. A malformed deploymentId fails the @IsUUID DTO validation → 400 Bad Request (class-validator).
		const badUuid = await request.post(`${DEPLOY_BASE}/works/${workId}/rollback`, {
			headers: authedHeaders(access_token),
			data: { deploymentId: 'not-a-uuid' },
		});
		expect(badUuid.status()).toBe(400);
		const badUuidBody = (await badUuid.json()) as Record<string, unknown>;
		expect(JSON.stringify(badUuidBody.message ?? badUuidBody)).toMatch(/deploymentId must be a UUID|uuid/i);

		// 2. An empty body fails @IsNotEmpty + @IsUUID → 400 with multiple validation messages.
		const empty = await request.post(`${DEPLOY_BASE}/works/${workId}/rollback`, {
			headers: authedHeaders(access_token),
			data: {},
		});
		expect(empty.status()).toBe(400);

		// 3. A well-formed UUID that maps to no deployment row → 400 with the controller's domain
		//    error envelope (NOT a DTO error) — the rollback target lookup fails after validation.
		const absent = await request.post(`${DEPLOY_BASE}/works/${workId}/rollback`, {
			headers: authedHeaders(access_token),
			data: { deploymentId: NIL_UUID },
		});
		expect(absent.status(), `absent rollback body=${await absent.text().catch(() => '')}`).toBe(400);
		const absentBody = (await absent.json()) as Record<string, unknown>;
		// Either the domain "not found" copy (no deployments at all) or the "production only" copy.
		expect(String(absentBody.message ?? '')).toMatch(/Deployment not found|production deployments|rolled back/i);
		expect(absentBody.status ?? 'error').toBeTruthy();

		// 4. None of the rejected rollbacks changed the work's deploy state.
		const after = await readWorkDeployFields(request, access_token, workId);
		expect(after.deploymentState, 'rejected rollback leaves state idle').toBeNull();
		expect(after.id).toBe(workId);
	});

	test('deploy ownership matrix: every deploy-capability verb honours ownership — cross-user 403, missing-work 404, unauthenticated 401 — across deploy/check/lookup/deployments/rollback', async ({
		request,
		browser,
	}) => {
		const owner = await registerUserViaAPI(request);
		const other = await registerUserViaAPI(request);
		const workId = await freshWorkId(request, owner.access_token, `Ownership Work ${Date.now()}`);

		// The capability verbs and how to call each one for a given work id.
		type Verb = { name: string; method: 'GET' | 'POST'; path: (id: string) => string; data?: unknown };
		const verbs: Verb[] = [
			{ name: 'deploy', method: 'POST', path: (id) => `${DEPLOY_BASE}/works/${id}`, data: {} },
			{ name: 'check', method: 'POST', path: (id) => `${DEPLOY_BASE}/works/${id}/check`, data: {} },
			{ name: 'lookup', method: 'POST', path: (id) => `${DEPLOY_BASE}/works/${id}/lookup`, data: {} },
			{ name: 'deployments', method: 'GET', path: (id) => `${DEPLOY_BASE}/works/${id}/deployments` },
			{
				name: 'rollback',
				method: 'POST',
				path: (id) => `${DEPLOY_BASE}/works/${id}/rollback`,
				data: { deploymentId: NIL_UUID },
			},
		];

		const call = (ctx: APIRequestContext, v: Verb, id: string, token?: string) =>
			v.method === 'GET'
				? ctx.get(v.path(id), { headers: token ? authedHeaders(token) : { 'Content-Type': 'application/json' } })
				: ctx.post(v.path(id), {
						headers: token
							? { ...authedHeaders(token), 'Content-Type': 'application/json' }
							: { 'Content-Type': 'application/json' },
						data: v.data ?? {},
				  });

		// 1. CROSS-USER: a different authenticated user with no membership row is rejected on the
		//    owner's work by the ownership guard (ensureCanEdit/ensureCanView) → 403 (or 404 if the
		//    work is invisible to them). Must NEVER be a 2xx that leaks/acts on someone else's work.
		for (const v of verbs) {
			const res = await call(request, v, workId, other.access_token);
			expect([403, 404], `cross-user ${v.name} status (body=${await res.text().catch(() => '')})`).toContain(
				res.status(),
			);
		}

		// 2. MISSING WORK: the owner hitting a non-existent work id → 404 NotFound from ownership.
		for (const v of verbs) {
			const res = await call(request, v, NIL_UUID, owner.access_token);
			expect([404, 400, 403], `missing-work ${v.name} status`).toContain(res.status());
			// At minimum: never a clean 2xx success on a non-existent work.
			expect(res.status(), `missing-work ${v.name} must not 2xx`).toBeGreaterThanOrEqual(400);
		}

		// 3. UNAUTHENTICATED: a clean anon context (bare newContext inherits the storageState
		//    cookie, so pass an empty storageState) → 401/403 on every verb.
		const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		try {
			for (const v of verbs) {
				const res = await call(anon.request, v, workId);
				expect([401, 403], `unauth ${v.name} status`).toContain(res.status());
			}
		} finally {
			await anon.close();
		}

		// 4. The owner's work is unaffected by the whole barrage of rejected attempts.
		const after = await readWorkDeployFields(request, owner.access_token, workId);
		expect(after.id).toBe(workId);
		expect(after.deploymentState, 'rejected attempts left state idle').toBeNull();
	});

	test('web deploy/status route projects the live work state machine for the SEEDED owner and reports the unconfigured idle state without crashing', async ({
		request,
		baseURL,
	}) => {
		// The web Next.js route GET /api/works/:id/deploy/status reads GET /works/:id with the
		// session cookie and projects { deploymentState, deploymentStartedAt, website, deployProvider }.
		// Drive it for a work owned by the SEEDED user so the storageState cookie aligns.
		const seeded = loadSeededTestUser();
		const login = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: seeded.email, password: seeded.password },
		});
		expect(login.ok(), `seed login body=${await login.text().catch(() => '')}`).toBeTruthy();
		const { access_token } = await login.json();
		const workId = await freshWorkId(request, access_token, `UI Status Work ${Date.now()}`);

		const origin = baseURL ?? 'http://localhost:3000';

		// The page-fixture `request` here carries the storageState session cookie, so the web route
		// resolves the work. Poll it (next-dev cold compile of the route handler can be slow).
		let body: Record<string, unknown> | null = null;
		await expect
			.poll(
				async () => {
					const res = await request.get(`${origin}/api/works/${workId}/deploy/status`);
					if (res.status() === 200) {
						body = (await res.json()) as Record<string, unknown>;
						return 200;
					}
					return res.status();
				},
				{ timeout: 30_000, intervals: [500, 1000, 2000, 3000] },
			)
			.toBe(200);

		expect(body, 'deploy/status returned a JSON projection').toBeTruthy();
		const projection = body as unknown as Record<string, unknown>;
		// The projection mirrors the resting state machine of a never-deployed work.
		expect(projection.deploymentState ?? null, 'idle deploymentState').toBeNull();
		expect(projection.deploymentStartedAt ?? null, 'idle deploymentStartedAt').toBeNull();
		expect(projection.website ?? null, 'idle website').toBeNull();
		// deployProvider is the provider hint and must be present (default 'vercel' on this stack).
		expect(projection.deployProvider ?? null, 'projection exposes deployProvider').toBeTruthy();

		// Cross-check the projection against the raw API for the SAME work — the web route is a
		// faithful read-through, so the deployProvider it surfaces must match the entity column.
		const apiFields = await readWorkDeployFields(request, access_token, workId);
		expect(projection.deployProvider).toEqual(apiFields.deployProvider);
		expect(projection.deploymentState ?? null).toEqual(apiFields.deploymentState ?? null);
	});
});
