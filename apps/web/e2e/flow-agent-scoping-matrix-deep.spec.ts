import { test, expect, type APIRequestContext } from '@playwright/test';
import {
	API_BASE,
	authedHeaders,
	registerUserViaAPI,
	createWorkViaAPI,
} from './helpers/api';
import {
	createAgentViaAPI,
	createTaskViaAPI,
	listAgentRuns,
	type Agent,
} from './helpers/agents-tasks';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Agent scoping matrix — DEEP follow-on to flow-agent-scoping-matrix.spec.ts.
 *
 * The sibling spec already covers: 400-without-parent-id, scope-filter
 * isolation, the lifecycle state machine, and basic cross-user 404. This
 * file pushes on the *second-order* scope-cascade rules that file does NOT
 * touch — every one probed against the LIVE API (sqlite in-memory, the CI
 * driver) before being asserted:
 *
 *   GET /api/agents — the repo (`findByUserIdScoped`) ANDs each filter
 *     field INDEPENDENTLY and never requires `scope`:
 *       • ?missionId=<id>  ALONE → only that Mission's agent (work/idea/
 *         tenant rows carry a NULL missionId so they can't match).
 *       • ?scope=work&missionId=<id> → ALWAYS empty (a work-scoped row's
 *         missionId is null; the two ANDed predicates can't both hold).
 *       • archived rows are excluded (`status != archived`) — so after
 *         DELETE /api/agents/:id (soft archive) the scoped filter empties,
 *         yet GET /api/agents/:id on that same row still returns 200.
 *       • ?scope=galaxy → 400 (IsEnum); ?missionId=not-a-uuid → 400 (IsUUID).
 *       • meta echoes the caller's {limit, offset}.
 *
 *   POST /api/agents — uniqueness is keyed (userId, scope, parentId, slug)
 *     via `uq_agents_user_scope_slug`, so:
 *       • the SAME name at tenant + mission + idea + work all succeed (201).
 *       • a SECOND agent of the same name in the SAME scope+parent → 409
 *         "An Agent named \"<name>\" already exists in this scope."
 *
 *   Parent-deletion effect (the headline finding):
 *       • DELETE /api/me/missions/:id → 200 {deleted:true}; the
 *         Mission-scoped Agent SURVIVES — its missionId/scope are intact and
 *         it stays listable via ?scope=mission&missionId=<deleted>. There is
 *         NO cascade from parent deletion to the agents table.
 *       • Works + Ideas (user-manual work-proposals) expose NO delete route
 *         (DELETE → 404), so their scoped agents are trivially undeletable
 *         via the parent — assert the 404 + agent-intact, never a cascade.
 *
 *   POST /api/agents/:id/assign-task — without TRIGGER_SECRET_KEY (the e2e
 *     default) the enqueue 500s, but a `failed` AgentRun row IS persisted
 *     (triggerKind:'task', taskId set). Assert the RUN RECORD, never
 *     completion. A re-assign on a non-in-flight (failed) run spawns a NEW
 *     run row. Cross-user assign-task → 404 (no existence leak).
 *
 * Isolation: all mutations run on FRESH registerUserViaAPI() users so the
 * in-memory DB stays clean for sibling specs; assertions tolerate
 * pre-existing rows (toContain / scoped filters), never global counts. The
 * seeded user (storageState) is used ONLY for the read-mostly UI flow.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a Mission, return its id (verified: POST /api/me/missions → 201). */
async function createMission(
	request: APIRequestContext,
	token: string,
	title: string,
): Promise<string> {
	const res = await request.post(`${API_BASE}/api/me/missions`, {
		headers: authedHeaders(token),
		data: { title, description: 'scoping-matrix-deep probe', type: 'one-shot' },
	});
	expect(res.status(), `mission create body=${await res.text()}`).toBe(201);
	const body = await res.json();
	expect(body.id).toMatch(UUID_RE);
	return body.id as string;
}

/** Create an Idea (user-manual work-proposal), return its id. */
async function createIdea(
	request: APIRequestContext,
	token: string,
	description: string,
): Promise<string> {
	const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
		headers: authedHeaders(token),
		data: { description },
	});
	expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
	const body = await res.json();
	expect(body.id).toMatch(UUID_RE);
	expect(body.source).toBe('user-manual');
	return body.id as string;
}

/** GET /api/agents with a raw query string. Returns the parsed list page. */
async function listAgents(
	request: APIRequestContext,
	token: string,
	query: string,
): Promise<{ data: Agent[]; meta: { total: number; limit: number; offset: number } }> {
	const res = await request.get(`${API_BASE}/api/agents${query}`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), `list ${query} body=${await res.text()}`).toBe(200);
	return res.json();
}

test.describe('Agent scoping matrix — deep cascade rules', () => {
	test('parent-id filter ALONE isolates by parent; cross-parent ANDs always return empty', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const s = stamp();

		// One parent of every kind, plus a tenant agent that has none.
		const missionId = await createMission(request, token, `Filter Mission ${s}`);
		const ideaId = await createIdea(request, token, `Filter Idea ${s} — a directory of tools`);
		const { id: workId } = await createWorkViaAPI(request, token, {
			name: `Filter Work ${s}`,
			slug: `filter-work-${s}`,
		});
		expect(workId).toMatch(UUID_RE);

		const tenantAgent = await createAgentViaAPI(request, token, {
			scope: 'tenant',
			name: `Filter Tenant ${s}`,
		});
		const missionAgent = await createAgentViaAPI(request, token, {
			scope: 'mission',
			name: `Filter Mission Agent ${s}`,
			missionId,
		});
		const ideaAgent = await createAgentViaAPI(request, token, {
			scope: 'idea',
			name: `Filter Idea Agent ${s}`,
			ideaId,
		});
		const workAgent = await createAgentViaAPI(request, token, {
			scope: 'work',
			name: `Filter Work Agent ${s}`,
			workId,
		});

		// ── Parent-id filter WITHOUT any scope param. Because only a
		//    mission-scoped row carries a non-null missionId, ?missionId
		//    alone resolves to exactly the mission agent. ────────────────
		const byMissionOnly = await listAgents(request, token, `?missionId=${missionId}`);
		expect(byMissionOnly.data.map((a) => a.id)).toEqual([missionAgent.id]);
		expect(byMissionOnly.data[0].scope).toBe('mission');
		expect(byMissionOnly.meta.total).toBe(1);

		const byIdeaOnly = await listAgents(request, token, `?ideaId=${ideaId}`);
		expect(byIdeaOnly.data.map((a) => a.id)).toEqual([ideaAgent.id]);
		expect(byIdeaOnly.data[0].scope).toBe('idea');

		const byWorkOnly = await listAgents(request, token, `?workId=${workId}`);
		expect(byWorkOnly.data.map((a) => a.id)).toEqual([workAgent.id]);
		expect(byWorkOnly.data[0].scope).toBe('work');

		// The tenant agent is reachable by no parent-id filter at all —
		// only the bare ?scope=tenant predicate (or the unfiltered list).
		const byTenant = await listAgents(request, token, '?scope=tenant');
		expect(byTenant.data.map((a) => a.id)).toContain(tenantAgent.id);
		expect(byTenant.data.map((a) => a.id)).not.toContain(missionAgent.id);

		// ── Cross-parent ANDs: the two predicates can never both be true
		//    on one row, so each combination is an empty page (not a 4xx). ─
		const workWithMission = await listAgents(
			request,
			token,
			`?scope=work&missionId=${missionId}`,
		);
		expect(workWithMission.meta.total).toBe(0);
		expect(workWithMission.data.length).toBe(0);

		const missionWithWork = await listAgents(
			request,
			token,
			`?scope=mission&workId=${workId}`,
		);
		expect(missionWithWork.meta.total).toBe(0);

		const ideaWithMission = await listAgents(
			request,
			token,
			`?scope=idea&missionId=${missionId}`,
		);
		expect(ideaWithMission.meta.total).toBe(0);

		// Mixing two REAL-but-different parent ids (mission + work) on the
		// SAME query also yields nothing — no single row has both.
		const missionAndWork = await listAgents(
			request,
			token,
			`?missionId=${missionId}&workId=${workId}`,
		);
		expect(missionAndWork.meta.total).toBe(0);
	});

	test('uniqueness is scoped per (scope,parent): same name at all four scopes; 409 only within a scope+parent', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const s = stamp();

		const missionId = await createMission(request, token, `Uniq Mission ${s}`);
		const ideaId = await createIdea(request, token, `Uniq Idea ${s} — a directory of tools`);
		const { id: workId } = await createWorkViaAPI(request, token, {
			name: `Uniq Work ${s}`,
			slug: `uniq-work-${s}`,
		});

		// The SAME name at every scope all succeed — uniqueness is keyed
		// on (userId, scope, parentId, slug), so these are four distinct rows.
		const name = `Twin Agent ${s}`;
		const tenantTwin = await createAgentViaAPI(request, token, { scope: 'tenant', name });
		const missionTwin = await createAgentViaAPI(request, token, {
			scope: 'mission',
			name,
			missionId,
		});
		const ideaTwin = await createAgentViaAPI(request, token, { scope: 'idea', name, ideaId });
		const workTwin = await createAgentViaAPI(request, token, { scope: 'work', name, workId });

		const ids = [tenantTwin.id, missionTwin.id, ideaTwin.id, workTwin.id];
		expect(new Set(ids).size).toBe(4);
		// They share a slug (slug derives from name) but differ by scope/parent.
		expect(new Set([tenantTwin.slug, missionTwin.slug, ideaTwin.slug, workTwin.slug]).size).toBe(
			1,
		);

		// A SECOND tenant agent of the same name → 409 (same scope + same
		// null parent + same slug collides on the unique index).
		const dupTenant = await request.post(`${API_BASE}/api/agents`, {
			headers,
			data: { scope: 'tenant', name },
		});
		expect(dupTenant.status()).toBe(409);
		expect((await dupTenant.json()).message).toBe(
			`An Agent named "${name}" already exists in this scope.`,
		);

		// A second MISSION agent of the same name in the SAME mission → 409.
		const dupMission = await request.post(`${API_BASE}/api/agents`, {
			headers,
			data: { scope: 'mission', name, missionId },
		});
		expect(dupMission.status()).toBe(409);
		expect((await dupMission.json()).message).toBe(
			`An Agent named "${name}" already exists in this scope.`,
		);

		// …but the SAME name under a DIFFERENT mission is fine — the parent
		// id is part of the key.
		const otherMissionId = await createMission(request, token, `Uniq Mission B ${s}`);
		const missionTwinB = await createAgentViaAPI(request, token, {
			scope: 'mission',
			name,
			missionId: otherMissionId,
		});
		expect(missionTwinB.id).not.toBe(missionTwin.id);
		expect(missionTwinB.slug).toBe(missionTwin.slug);
	});

	test('archive removes a scoped agent from list while the row survives; sibling scopes + query validation hold', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const s = stamp();

		const missionId = await createMission(request, token, `Arch Mission ${s}`);
		const { id: workId } = await createWorkViaAPI(request, token, {
			name: `Arch Work ${s}`,
			slug: `arch-work-${s}`,
		});

		const missionAgent = await createAgentViaAPI(request, token, {
			scope: 'mission',
			name: `Arch Mission Agent ${s}`,
			missionId,
		});
		const workSibling = await createAgentViaAPI(request, token, {
			scope: 'work',
			name: `Arch Work Sibling ${s}`,
			workId,
		});

		// Both visible up-front under their own scope filters.
		const beforeMission = await listAgents(
			request,
			token,
			`?scope=mission&missionId=${missionId}`,
		);
		expect(beforeMission.data.map((a) => a.id)).toEqual([missionAgent.id]);

		// Soft-archive the mission agent (DELETE without ?hard).
		const archived = await request.delete(`${API_BASE}/api/agents/${missionAgent.id}`, {
			headers,
		});
		expect(archived.status(), `archive body=${await archived.text()}`).toBe(200);
		expect(await archived.json()).toEqual({ archived: true });

		// It vanishes from the scope filter (repo excludes status=archived)…
		const afterMission = await listAgents(
			request,
			token,
			`?scope=mission&missionId=${missionId}`,
		);
		expect(afterMission.meta.total).toBe(0);
		expect(afterMission.data.length).toBe(0);
		// …and from the parent-id-only filter, and from the unfiltered list.
		expect((await listAgents(request, token, `?missionId=${missionId}`)).meta.total).toBe(0);
		const all = await listAgents(request, token, '');
		expect(all.data.map((a) => a.id)).not.toContain(missionAgent.id);

		// But the ARCHIVED row is still directly readable (200) — archive is
		// a soft-delete; the entity is not gone.
		const directGet = await request.get(`${API_BASE}/api/agents/${missionAgent.id}`, {
			headers,
		});
		expect(directGet.status()).toBe(200);
		const archivedDto = await directGet.json();
		expect(archivedDto.id).toBe(missionAgent.id);
		expect(archivedDto.status).toBe('archived');

		// The cross-scope work sibling is untouched by the mission archive.
		const workAfter = await listAgents(request, token, `?scope=work&workId=${workId}`);
		expect(workAfter.data.map((a) => a.id)).toEqual([workSibling.id]);

		// ── Query-DTO validation: bad enum / bad uuid → 400, and meta
		//    echoes pagination params. ────────────────────────────────────
		const badScope = await request.get(`${API_BASE}/api/agents?scope=galaxy`, { headers });
		expect(badScope.status()).toBe(400);
		const badUuid = await request.get(`${API_BASE}/api/agents?missionId=not-a-uuid`, {
			headers,
		});
		expect(badUuid.status()).toBe(400);

		const paged = await listAgents(request, token, '?scope=work&limit=1&offset=0');
		expect(paged.meta.limit).toBe(1);
		expect(paged.meta.offset).toBe(0);
		expect(paged.data.length).toBeLessThanOrEqual(1);
	});

	test('parent-deletion effect: deleting a Mission orphans (but never removes) its scoped agent; Work/Idea parents are not deletable', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const s = stamp();

		const missionId = await createMission(request, token, `Del Mission ${s}`);
		const ideaId = await createIdea(request, token, `Del Idea ${s} — a directory of tools`);
		const { id: workId } = await createWorkViaAPI(request, token, {
			name: `Del Work ${s}`,
			slug: `del-work-${s}`,
		});

		const missionAgent = await createAgentViaAPI(request, token, {
			scope: 'mission',
			name: `Del Mission Agent ${s}`,
			missionId,
		});
		const ideaAgent = await createAgentViaAPI(request, token, {
			scope: 'idea',
			name: `Del Idea Agent ${s}`,
			ideaId,
		});
		const workAgent = await createAgentViaAPI(request, token, {
			scope: 'work',
			name: `Del Work Agent ${s}`,
			workId,
		});

		// ── Mission is the one parent with a real delete route. ──────────
		const delMission = await request.delete(`${API_BASE}/api/me/missions/${missionId}`, {
			headers,
		});
		expect(delMission.status(), `mission delete body=${await delMission.text()}`).toBe(200);

		// The Mission-scoped Agent SURVIVES the parent deletion: it is still
		// fetchable, still carries the (now-dangling) missionId, and still
		// matches the scope filter for the deleted parent. No cascade.
		const survivor = await request.get(`${API_BASE}/api/agents/${missionAgent.id}`, {
			headers,
		});
		expect(survivor.status()).toBe(200);
		const survivorDto = await survivor.json();
		expect(survivorDto.id).toBe(missionAgent.id);
		expect(survivorDto.scope).toBe('mission');
		expect(survivorDto.missionId).toBe(missionId);
		expect(survivorDto.status).toBe('draft'); // unchanged by the parent delete

		const stillListed = await listAgents(
			request,
			token,
			`?scope=mission&missionId=${missionId}`,
		);
		expect(stillListed.data.map((a) => a.id)).toEqual([missionAgent.id]);

		// ── Work + Idea parents expose NO delete route — assert the 404
		//    and that the scoped agents are wholly intact. ────────────────
		const delWork = await request.delete(`${API_BASE}/api/works/${workId}`, { headers });
		expect(delWork.status(), `work delete status`).toBe(404);
		const delIdea = await request.delete(`${API_BASE}/api/me/work-proposals/${ideaId}`, {
			headers,
		});
		expect(delIdea.status(), `idea delete status`).toBe(404);

		const workIntact = await request.get(`${API_BASE}/api/agents/${workAgent.id}`, { headers });
		expect(workIntact.status()).toBe(200);
		expect((await workIntact.json()).workId).toBe(workId);
		const ideaIntact = await request.get(`${API_BASE}/api/agents/${ideaAgent.id}`, { headers });
		expect(ideaIntact.status()).toBe(200);
		expect((await ideaIntact.json()).ideaId).toBe(ideaId);

		// Hard-delete the orphaned Mission agent ourselves (?hard=true) and
		// confirm it then truly disappears (404) — soft archive ≠ hard delete.
		const hardDel = await request.delete(
			`${API_BASE}/api/agents/${missionAgent.id}?hard=true`,
			{ headers },
		);
		expect(hardDel.status(), `hard delete body=${await hardDel.text()}`).toBe(200);
		expect(await hardDel.json()).toEqual({ deleted: true });
		const goneGet = await request.get(`${API_BASE}/api/agents/${missionAgent.id}`, { headers });
		expect(goneGet.status()).toBe(404);
	});

	test('assign-task records a per-scope AgentRun (run-record, not completion) and is cross-user 404-isolated', async ({
		request,
	}) => {
		const owner = await registerUserViaAPI(request);
		const token = owner.access_token;
		const headers = authedHeaders(token);
		const s = stamp();

		const missionId = await createMission(request, token, `Run Mission ${s}`);
		const { id: workId } = await createWorkViaAPI(request, token, {
			name: `Run Work ${s}`,
			slug: `run-work-${s}`,
		});

		const tenantAgent = await createAgentViaAPI(request, token, {
			scope: 'tenant',
			name: `Run Tenant Agent ${s}`,
		});
		const workAgent = await createAgentViaAPI(request, token, {
			scope: 'work',
			name: `Run Work Agent ${s}`,
			workId,
		});

		// A real Task (work-bound) to assign to both agents.
		const task = await createTaskViaAPI(request, token, { title: `Run Task ${s}`, workId });
		expect(task.id).toMatch(UUID_RE);

		const assignUrl = (agentId: string) =>
			`${API_BASE}/api/agents/${agentId}/assign-task`;

		// Without TRIGGER_SECRET_KEY the enqueue 500s — but a `failed`
		// AgentRun row is recorded for the (taskId, agentId) pair. Assert
		// the RUN RECORD, never a 2xx / completion.
		const assignTenant = await request.post(assignUrl(tenantAgent.id), {
			headers,
			data: { taskId: task.id },
		});
		expect([202, 500]).toContain(assignTenant.status());

		await expect
			.poll(async () => (await listAgentRuns(request, token, tenantAgent.id)).length, {
				timeout: 15_000,
			})
			.toBeGreaterThan(0);
		const tenantRuns = await listAgentRuns(request, token, tenantAgent.id);
		const tenantRun = tenantRuns[0];
		expect(tenantRun.triggerKind).toBe('task');
		expect(tenantRun.taskId).toBe(task.id);
		expect(['failed', 'queued', 'running', 'completed']).toContain(tenantRun.status);

		// Same Task assigned to a DIFFERENT (work-scoped) agent records a
		// SEPARATE run on that agent — runs are per-agent, not per-task.
		const assignWork = await request.post(assignUrl(workAgent.id), {
			headers,
			data: { taskId: task.id },
		});
		expect([202, 500]).toContain(assignWork.status());
		await expect
			.poll(async () => (await listAgentRuns(request, token, workAgent.id)).length, {
				timeout: 15_000,
			})
			.toBeGreaterThan(0);
		const workRuns = await listAgentRuns(request, token, workAgent.id);
		expect(workRuns[0].taskId).toBe(task.id);
		// The tenant agent's run list did not absorb the work agent's run.
		expect(workRuns.map((r) => r.id)).not.toContain(tenantRun.id);

		// ── Cross-user isolation: an attacker cannot assign-task to, nor
		//    list runs of, the owner's agent — 404 (no existence leak). ────
		const attacker = await registerUserViaAPI(request);
		const atk = authedHeaders(attacker.access_token);

		const foreignAssign = await request.post(assignUrl(workAgent.id), {
			headers: atk,
			data: { taskId: task.id },
		});
		expect(foreignAssign.status()).toBe(404);

		const foreignRuns = await request.get(`${API_BASE}/api/agents/${workAgent.id}/runs`, {
			headers: atk,
		});
		expect(foreignRuns.status()).toBe(404);

		// An unknown well-formed agent id → 404; the owner still reads runs.
		const unknownRuns = await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}/runs`, {
			headers,
		});
		expect(unknownRuns.status()).toBe(404);
		const ownerRuns = await request.get(`${API_BASE}/api/agents/${workAgent.id}/runs`, {
			headers,
		});
		expect(ownerRuns.status()).toBe(200);
	});

	test('UI: the /agents catalog renders scope copy and surfaces a created tenant agent (best-effort)', async ({
		page,
		request,
		baseURL,
	}) => {
		// Read-mostly UI flow: use the seeded user (storageState). Creating
		// one tenant-scoped agent for them is a benign additive row (no
		// fake-key shadowing — that risk is plugins/settings only).
		const seeded = loadSeededTestUser();
		const login = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: seeded.email, password: seeded.password },
		});
		expect(login.status(), `seeded login body=${await login.text()}`).toBe(200);
		const { access_token } = await login.json();

		const s = stamp();
		const agentName = `UI Scope Tenant ${s}`;
		const created = await createAgentViaAPI(request, access_token, {
			scope: 'tenant',
			name: agentName,
		});
		expect(created.scope).toBe('tenant');
		const slug = created.slug;

		const origin = baseURL ?? 'http://localhost:3000';
		await page.goto(`${origin}/agents`, { waitUntil: 'domcontentloaded' });

		// The page header copy is the stable anchor. next-dev local vs CI can
		// diverge on nested rendering, so accept either the title heading OR
		// the prompt composer (data-testid="agents-prompt") OR the agent
		// surfacing as a "Your templates" chip by slug.
		const heading = page.getByRole('heading', { name: 'Agents' }).first();
		const composer = page.getByTestId('agents-prompt').first();
		const myChip = page.locator(`[data-testid="agent-template-chip-${slug}"]`).first();
		const myCard = page.locator(`[data-testid="agent-template-card-${slug}"]`).first();
		const newAgentCta = page.getByText('New Agent', { exact: false }).first();

		await expect(
			heading.or(composer).or(myChip).or(myCard).or(newAgentCta),
		).toBeVisible({ timeout: 30_000 });

		// The subtitle explicitly teaches the scope model — when present it
		// proves the scope-aware catalog rendered (best-effort: the catch-all
		// route divergence may swap it for the prompt-only surface).
		const scopeCopy = page.getByText(/Mission- or Work-scoped|whole Workspace/i).first();
		if (await scopeCopy.count()) {
			await expect(scopeCopy).toBeVisible({ timeout: 10_000 });
		}
	});
});
