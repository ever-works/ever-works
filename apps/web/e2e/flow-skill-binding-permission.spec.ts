import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Skill binding × Agent permissions × scope rules — complex, multi-entity
 * INTEGRATION flows. Every shape below was probed against the LIVE stack
 * (sqlite in-memory, the CI driver) before any assertion was written.
 *
 * THEME (distinct from flow-agent-skills-binding.spec.ts, which covers the
 * bind/unbind lifecycle, ownerType filtering, priority ordering, and the
 * empty/agent-bound UI states): this file pins the PERMISSION GATE truth and
 * the SCOPE-RESOLUTION + CROSS-TENANT-ISOLATION rules for bindings.
 *
 * Probed contract:
 *   - POST /api/agents { scope:'work', workId, name, permissions? } → 201.
 *       Agents carry a denormalized workId/missionId/ideaId; GET
 *       /api/agents/:id/skills resolves bindings against THAT scope tuple.
 *   - AGENT PERMISSION MATRIX has a `canEditSkills` boolean (default false).
 *       It is the runtime tool-catalog gate (packages/agent agent-tool.service
 *       only registers the skill-edit tool when true) — that catalog is built
 *       INSIDE an agent run (needs LLM + Trigger.dev, neither bound in CI).
 *       So `canEditSkills` does NOT gate the HTTP binding write at all: binding
 *       a skill to a canEditSkills:false agent still 201s and still resolves.
 *       (Same documented posture as assign-task vs canAssignTasks.) We assert
 *       the REAL reachable contract: the persisted binding + resolution set is
 *       independent of the flag, and the flag PATCH is a partial merge.
 *   - POST /api/skills { ownerType, ownerId, title, description, instructionsMd }
 *       → 201 { id, slug, version:'1.0.0', … }. ownerType ∈ tenant|mission|idea|work|agent.
 *   - POST /api/skills/:id/bindings { targetType, targetId?, priority?, injectIntoAgent? }
 *       → 201 binding row. targetType ∈ agent|work|mission|idea|tenant.
 *       * non-tenant targetType WITHOUT targetId → 400 "targetId is required when targetType=<t>."
 *       * unknown targetType → 400 'Invalid targetType "<t>".'
 *       * an IDENTICAL (skill+targetType+targetId) binding → 500 (uq_skill_binding).
 *       * NO targetId-ownership check: a user may bind their own skill to a
 *         FOREIGN work/agent id and get 201 — but the resolver is userId-scoped,
 *         so it NEVER surfaces onto the other user's agent.
 *   - GET /api/agents/:id/skills → { data:[{ bindingId, priority, targetType,
 *       skill:{id,slug,title,version} }] } — userId-scoped, priority ASC,
 *       deduped by skillId (highest-priority binding wins), injectIntoAgent:false
 *       excluded. Resolution OR-matches tenant (targetId null) + the agent's own
 *       agent/work/mission/idea ids. Cross-user / unknown agent → 404.
 *   - POST /api/skills/:id/bindings cross-user (binding onto ANOTHER user's
 *       skill) → 404 (no existence leak); GET /api/skills/:id cross-user → 404.
 *   - DELETE /api/skill-bindings/:id → 200 { deleted:true }; cross-user → 404.
 *
 * Isolation: API-only mutations run on FRESH registerUserViaAPI() users (unique
 * emails/Date.now suffixes), asserting toContain / scoped counts (never global
 * exact counts). The seeded storageState user is used ONLY for the UI render.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface BoundSkillRow {
	bindingId: string;
	priority: number;
	targetType: string;
	skill: { id: string; slug: string; title: string; version: string };
}

async function createSkill(
	request: APIRequestContext,
	token: string,
	body: { ownerType: string; ownerId: string; title: string }
): Promise<{ id: string; slug: string; ownerType: string; ownerId: string; version: string }> {
	const res = await request.post(`${API_BASE}/api/skills`, {
		headers: authedHeaders(token),
		data: {
			description: 'e2e binding-permission skill',
			instructionsMd: `# ${body.title}`,
			...body
		}
	});
	expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
	return res.json();
}

async function bindSkill(
	request: APIRequestContext,
	token: string,
	skillId: string,
	binding: { targetType: string; targetId?: string | null; priority?: number; injectIntoAgent?: boolean }
): Promise<{ id: string; targetType: string; targetId: string | null; priority: number }> {
	const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
		headers: authedHeaders(token),
		data: binding
	});
	expect(res.status(), `bindSkill body=${await res.text().catch(() => '')}`).toBe(201);
	return res.json();
}

async function listAgentSkills(
	request: APIRequestContext,
	token: string,
	agentId: string
): Promise<BoundSkillRow[]> {
	const res = await request.get(`${API_BASE}/api/agents/${agentId}/skills`, {
		headers: authedHeaders(token)
	});
	expect(res.status(), 'listAgentSkills status').toBe(200);
	return (await res.json()).data ?? [];
}

/** Create a Work and return its id (createWorkViaAPI unwraps the envelope). */
async function makeWork(request: APIRequestContext, token: string, label: string): Promise<string> {
	const { id } = await createWorkViaAPI(request, token, { name: label });
	expect(id, `work id for ${label}`).toBeTruthy();
	return id;
}

test.describe('Skill binding — permission gate, scope rules, cross-tenant isolation', () => {
	/**
	 * Flow 1 — canEditSkills is a RUNTIME tool-catalog gate, NOT an HTTP binding
	 * gate. Bind a tenant skill to a work-scoped agent whose canEditSkills is
	 * FALSE (the default) → the binding still 201s and the agent still resolves
	 * it. Then PATCH canEditSkills true → false (a partial merge that leaves the
	 * other seven flags untouched) and prove the resolved binding set is byte-for
	 * -byte identical at every step. The flag never touches the binding write.
	 */
	test('canEditSkills does not gate binding at the HTTP layer — the resolved set is invariant to the flag', async ({
		request
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const s = stamp();

		const workId = await makeWork(request, token, `Perm Gate Work ${s}`);

		// A work-scoped agent left at the locked-down default (canEditSkills:false).
		const agent = await createAgentViaAPI(request, token, {
			name: `Perm Gate Agent ${s}`,
			scope: 'work',
			workId
		});
		const created = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token)
		});
		expect(created.status()).toBe(200);
		expect((await created.json()).permissions.canEditSkills).toBe(false);

		const skill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user.id,
			title: `Perm Gate Skill ${s}`
		});

		// Despite canEditSkills:false, the HTTP bind succeeds and resolves.
		const binding = await bindSkill(request, token, skill.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 30
		});
		const resolvedWhileFalse = await listAgentSkills(request, token, agent.id);
		expect(resolvedWhileFalse).toHaveLength(1);
		expect(resolvedWhileFalse[0]).toMatchObject({
			bindingId: binding.id,
			priority: 30,
			targetType: 'agent',
			skill: { id: skill.id }
		});

		// Flip canEditSkills ON — a partial merge: the other seven flags stay false.
		const on = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { permissions: { canEditSkills: true } }
		});
		expect(on.status()).toBe(200);
		const onPerms = (await on.json()).permissions;
		expect(onPerms.canEditSkills).toBe(true);
		expect(onPerms.canAssignTasks).toBe(false);
		expect(onPerms.canCommitToRepo).toBe(false);
		expect(onPerms.canSpend).toBe(false);

		// The resolved binding set is unchanged by enabling the flag.
		const resolvedWhileTrue = await listAgentSkills(request, token, agent.id);
		expect(resolvedWhileTrue.map((r) => r.bindingId)).toEqual([binding.id]);

		// Flip it back OFF — still a partial merge, still no effect on bindings.
		const off = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { permissions: { canEditSkills: false } }
		});
		expect(off.status()).toBe(200);
		expect((await off.json()).permissions.canEditSkills).toBe(false);
		const resolvedAgain = await listAgentSkills(request, token, agent.id);
		expect(resolvedAgain.map((r) => r.bindingId)).toEqual([binding.id]);

		test.info().annotations.push({
			type: 'note',
			description:
				'canEditSkills gates the agent run-time tool catalog (skill-edit tool), built inside an agent run that needs an LLM + Trigger.dev — neither bound in CI. So the reachable contract is: binding writes + resolution ignore the flag. Same posture as assign-task vs canAssignTasks.'
		});
	});

	/**
	 * Flow 2 — work-target binding scope rules. A tenant-owned skill bound at a
	 * WORK target resolves onto the agent whose denormalized workId matches the
	 * target — and NOT onto a tenant-scoped agent of the same user (which has no
	 * workId). Proves GET /:id/skills resolves against the agent's OWN scope
	 * tuple, not just userId.
	 */
	test('a WORK-target binding resolves onto the matching work agent but never onto a tenant agent', async ({
		request
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const s = stamp();

		const workId = await makeWork(request, token, `Scope Work ${s}`);
		const workAgent = await createAgentViaAPI(request, token, {
			name: `Scope Work Agent ${s}`,
			scope: 'work',
			workId
		});
		const tenantAgent = await createAgentViaAPI(request, token, {
			name: `Scope Tenant Agent ${s}`,
			scope: 'tenant'
		});
		expect(workAgent.scope).toBe('work');
		expect(tenantAgent.scope).toBe('tenant');

		const skill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user.id,
			title: `Scope Skill ${s}`
		});

		// Bind ONLY at the work scope.
		const wb = await bindSkill(request, token, skill.id, {
			targetType: 'work',
			targetId: workId,
			priority: 20
		});
		expect(wb.targetType).toBe('work');
		expect(wb.targetId).toBe(workId);

		// The work agent (workId === target) resolves it…
		const onWork = await listAgentSkills(request, token, workAgent.id);
		expect(onWork).toHaveLength(1);
		expect(onWork[0]).toMatchObject({ targetType: 'work', priority: 20, skill: { id: skill.id } });

		// …the tenant agent (no workId) does NOT — a work binding is not tenant-wide.
		const onTenant = await listAgentSkills(request, token, tenantAgent.id);
		expect(onTenant.map((r) => r.skill.id)).not.toContain(skill.id);
		expect(onTenant).toEqual([]);

		// A tenant-WIDE binding of a second skill, by contrast, DOES surface on
		// both agents (targetId null ⇒ matched by userId alone).
		const tenantSkill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user.id,
			title: `Tenant Wide Skill ${s}`
		});
		await bindSkill(request, token, tenantSkill.id, { targetType: 'tenant', priority: 80 });

		const onWork2 = await listAgentSkills(request, token, workAgent.id);
		expect(onWork2.map((r) => r.skill.id).sort()).toEqual([skill.id, tenantSkill.id].sort());
		const onTenant2 = await listAgentSkills(request, token, tenantAgent.id);
		expect(onTenant2.map((r) => r.skill.id)).toEqual([tenantSkill.id]);
	});

	/**
	 * Flow 3 — cross-work isolation within ONE user + dedup-by-skill. The same
	 * skill is bound at three scopes for one user: agent-direct on a W1 agent
	 * (priority 10), the W1 work (priority 60), and a SECOND work W2 (priority 1,
	 * globally the highest). The W1 agent must (a) dedup the skill to a single
	 * row, (b) pick the agent-direct binding (highest priority AMONG the bindings
	 * its scope tuple matches — 10 beats 60), and (c) be completely blind to the
	 * W2 binding despite its top priority, because W2 ∉ {agentId, W1}.
	 */
	test('a work agent dedups to its highest-precedence binding and ignores another work’s binding entirely', async ({
		request
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const s = stamp();

		const w1 = await makeWork(request, token, `Iso W1 ${s}`);
		const w2 = await makeWork(request, token, `Iso W2 ${s}`);
		const agent = await createAgentViaAPI(request, token, {
			name: `Iso Agent ${s}`,
			scope: 'work',
			workId: w1
		});

		const skill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user.id,
			title: `Iso Skill ${s}`
		});

		// Same skill, three bindings at three scopes.
		const w1Binding = await bindSkill(request, token, skill.id, {
			targetType: 'work',
			targetId: w1,
			priority: 60
		});
		const agentBinding = await bindSkill(request, token, skill.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 10
		});
		await bindSkill(request, token, skill.id, { targetType: 'work', targetId: w2, priority: 1 });

		// The W1 agent resolves exactly ONE row (deduped by skillId): the
		// agent-direct binding (priority 10), NOT the W1 work binding (60), and
		// definitely NOT the W2 binding (priority 1) — W2 is out of scope.
		const resolved = await listAgentSkills(request, token, agent.id);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].skill.id).toBe(skill.id);
		expect(resolved[0].bindingId).toBe(agentBinding.id);
		expect(resolved[0].priority).toBe(10);
		expect(resolved[0].targetType).toBe('agent');

		// Sanity: the skill's own bindings list shows ALL THREE rows exist (the
		// dedup is a RESOLUTION concern, not a persistence one).
		const allBindings = await (
			await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, {
				headers: authedHeaders(token)
			})
		).json();
		expect(allBindings).toHaveLength(3);
		const byTarget = allBindings.map((b: { targetType: string; targetId: string | null }) => ({
			t: b.targetType,
			id: b.targetId
		}));
		expect(byTarget).toContainEqual({ t: 'agent', id: agent.id });
		expect(byTarget).toContainEqual({ t: 'work', id: w1 });
		expect(byTarget).toContainEqual({ t: 'work', id: w2 });

		// Dropping the winning agent-direct binding lets the W1 work binding
		// (priority 60) take over — the skill is still bound, just at lower
		// precedence — and W2 is STILL never visible.
		const del = await request.delete(`${API_BASE}/api/skill-bindings/${agentBinding.id}`, {
			headers: authedHeaders(token)
		});
		expect(del.status()).toBe(200);
		const afterDelete = await listAgentSkills(request, token, agent.id);
		expect(afterDelete).toHaveLength(1);
		expect(afterDelete[0].bindingId).toBe(w1Binding.id);
		expect(afterDelete[0].priority).toBe(60);
		expect(afterDelete[0].targetType).toBe('work');
	});

	/**
	 * Flow 4 — cross-tenant skill binding is forbidden, and the userId-scoped
	 * resolver is the REAL isolation boundary. Alice owns a work + work-agent +
	 * skill. Bob (a separate tenant):
	 *   (a) cannot read Alice's skill (404, no existence leak),
	 *   (b) cannot bind a target onto Alice's skill (404),
	 *   (c) cannot read Alice's agent's resolved skills (404),
	 *   (d) cannot delete one of Alice's bindings (404).
	 * BUT Bob CAN bind HIS OWN skill to Alice's FOREIGN work id / agent id and get
	 * a 201 — the API does not validate targetId ownership. That binding is inert:
	 * because resolveActive filters by userId, it NEVER surfaces onto Alice's
	 * agent. Alice's resolved set is unchanged throughout.
	 */
	test('cross-tenant: binding ONTO another tenant’s skill 404s, and a foreign-target binding never resolves across tenants', async ({
		request
	}) => {
		const alice = await registerUserViaAPI(request);
		const bob = await registerUserViaAPI(request);
		const aliceToken = alice.access_token;
		const bobToken = bob.access_token;
		const s = stamp();

		const workId = await makeWork(request, aliceToken, `Alice Work ${s}`);
		const aliceAgent = await createAgentViaAPI(request, aliceToken, {
			name: `Alice Work Agent ${s}`,
			scope: 'work',
			workId
		});
		const aliceSkill = await createSkill(request, aliceToken, {
			ownerType: 'tenant',
			ownerId: alice.user.id,
			title: `Alice Skill ${s}`
		});
		const aliceBinding = await bindSkill(request, aliceToken, aliceSkill.id, {
			targetType: 'work',
			targetId: workId,
			priority: 15
		});
		// Alice's agent resolves her own skill.
		expect((await listAgentSkills(request, aliceToken, aliceAgent.id)).map((r) => r.skill.id)).toEqual([
			aliceSkill.id
		]);

		// (a) Bob cannot read Alice's skill — 404 (no existence leak via 403).
		const bobReadSkill = await request.get(`${API_BASE}/api/skills/${aliceSkill.id}`, {
			headers: authedHeaders(bobToken)
		});
		expect([403, 404]).toContain(bobReadSkill.status());

		// (b) Bob cannot bind a target onto Alice's skill — 404.
		const bobBindOntoAlice = await request.post(`${API_BASE}/api/skills/${aliceSkill.id}/bindings`, {
			headers: authedHeaders(bobToken),
			data: { targetType: 'tenant' }
		});
		expect([403, 404]).toContain(bobBindOntoAlice.status());

		// (c) Bob cannot read Alice's agent's resolved skills — 404.
		const bobReadAgentSkills = await request.get(`${API_BASE}/api/agents/${aliceAgent.id}/skills`, {
			headers: authedHeaders(bobToken)
		});
		expect(bobReadAgentSkills.status()).toBe(404);

		// (d) Bob cannot delete Alice's binding — 404.
		const bobDelete = await request.delete(`${API_BASE}/api/skill-bindings/${aliceBinding.id}`, {
			headers: authedHeaders(bobToken)
		});
		expect(bobDelete.status()).toBe(404);

		// Bob CAN bind his OWN skill to Alice's FOREIGN work id AND agent id — the
		// API performs no targetId-ownership check, so both 201.
		const bobSkill = await createSkill(request, bobToken, {
			ownerType: 'tenant',
			ownerId: bob.user.id,
			title: `Bob Skill ${s}`
		});
		const bobToAliceWork = await bindSkill(request, bobToken, bobSkill.id, {
			targetType: 'work',
			targetId: workId,
			priority: 1
		});
		const bobToAliceAgent = await bindSkill(request, bobToken, bobSkill.id, {
			targetType: 'agent',
			targetId: aliceAgent.id,
			priority: 1
		});
		expect(bobToAliceWork.id).toBeTruthy();
		expect(bobToAliceAgent.id).toBeTruthy();

		// …yet those bindings are inert across the tenant boundary: Alice's agent
		// still resolves ONLY her own skill (the resolver filters by userId).
		const aliceResolvedAfter = await listAgentSkills(request, aliceToken, aliceAgent.id);
		expect(aliceResolvedAfter.map((r) => r.skill.id)).toEqual([aliceSkill.id]);
		expect(aliceResolvedAfter.map((r) => r.skill.id)).not.toContain(bobSkill.id);

		// Bob's foreign-target binding is also invisible to Bob via the agent
		// resolve path (he can't read Alice's agent at all) — but his own skill's
		// bindings list confirms the rows persisted under his ownership.
		const bobBindings = await (
			await request.get(`${API_BASE}/api/skills/${bobSkill.id}/bindings`, {
				headers: authedHeaders(bobToken)
			})
		).json();
		expect(bobBindings.map((b: { id: string }) => b.id).sort()).toEqual(
			[bobToAliceWork.id, bobToAliceAgent.id].sort()
		);

		test.info().annotations.push({
			type: 'note',
			description:
				'The API does not validate that a binding targetId belongs to the caller; the userId-scoped resolveActive query is the enforced isolation boundary, so a cross-tenant foreign-target binding is created (201) but never surfaces onto the other tenant’s agent.'
		});
	});

	/**
	 * Flow 5 — binding-write validation matrix on a work agent + tenant-wide
	 * fallback. Drives every documented 4xx/5xx guard on the binding endpoint,
	 * then proves that after the bad writes a legitimate work-target + tenant
	 * binding pair resolves correctly on the work agent. Cross-user / unknown
	 * agent resolution → 404.
	 */
	test('binding write guards (missing targetId / bad targetType / duplicate) and tenant-wide + work bindings co-resolve', async ({
		request
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const s = stamp();

		const workId = await makeWork(request, token, `Guard Work ${s}`);
		const agent = await createAgentViaAPI(request, token, {
			name: `Guard Agent ${s}`,
			scope: 'work',
			workId
		});
		const skill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user.id,
			title: `Guard Skill ${s}`
		});

		// Missing targetId for a non-tenant target → 400 with a truthful message.
		const missingTarget = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
			headers: authedHeaders(token),
			data: { targetType: 'work' }
		});
		expect(missingTarget.status()).toBe(400);
		expect((await missingTarget.json()).message).toMatch(/targetId is required when targetType=work/i);

		// Unknown targetType → 400.
		const badType = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
			headers: authedHeaders(token),
			data: { targetType: 'bogus', targetId: agent.id }
		});
		expect(badType.status()).toBe(400);
		expect((await badType.json()).message).toMatch(/invalid targetType/i);

		// A valid work binding succeeds…
		const wb = await bindSkill(request, token, skill.id, {
			targetType: 'work',
			targetId: workId,
			priority: 25
		});
		expect(wb.id).toBeTruthy();

		// …and an IDENTICAL (skill+targetType+targetId) binding hits the unique
		// index — the API surfaces it as a raw 500 (no graceful conflict handler).
		const dup = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
			headers: authedHeaders(token),
			data: { targetType: 'work', targetId: workId }
		});
		expect(dup.status()).toBe(500);

		// A SECOND skill bound tenant-wide co-resolves with the work binding on
		// the work agent (both targets are in the agent's scope tuple).
		const tenantSkill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user.id,
			title: `Guard Tenant Skill ${s}`
		});
		await bindSkill(request, token, tenantSkill.id, { targetType: 'tenant', priority: 70 });

		const resolved = await listAgentSkills(request, token, agent.id);
		// Priority ASC: the work binding (25) before the tenant binding (70).
		expect(resolved.map((r) => r.skill.id)).toEqual([skill.id, tenantSkill.id]);
		expect(resolved.map((r) => r.priority)).toEqual([25, 70]);
		expect(resolved.map((r) => r.targetType)).toEqual(['work', 'tenant']);

		// Unknown agent id → 404 (no existence leak), even for the owner.
		const unknown = await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}/skills`, {
			headers: authedHeaders(token)
		});
		expect(unknown.status()).toBe(404);
	});

	/**
	 * Flow 6 — UI: a WORK-scoped agent's Skills page renders SCOPE-DISTINCT
	 * binding rows. Distinct from flow-agent-skills-binding.spec.ts Flow 4 (which
	 * only asserts a single agent binding + the empty state): here we bind the
	 * SAME work agent at two DIFFERENT scopes (work-target + tenant-wide) and
	 * assert the per-row "<targetType> binding" labels the client renders ("work
	 * binding" and "tenant binding"), plus the active-binding count. Driven via
	 * the seeded storageState session.
	 */
	test('UI: a work agent’s Skills page renders scope-distinct binding rows (work + tenant) for the seeded user', async ({
		page,
		request
	}) => {
		const seeded = loadSeededTestUser();
		const login = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: seeded.email, password: seeded.password }
		});
		expect(login.status()).toBe(200);
		const { access_token, user } = await login.json();
		const s = stamp();

		const workId = await makeWork(request, access_token, `UI Scope Work ${s}`);
		const agent = await createAgentViaAPI(request, access_token, {
			name: `UI Scope Agent ${s}`,
			scope: 'work',
			workId
		});

		const workScopedTitle = `UI Work Scoped Skill ${s}`;
		const tenantScopedTitle = `UI Tenant Scoped Skill ${s}`;
		const workSkill = await createSkill(request, access_token, {
			ownerType: 'tenant',
			ownerId: user.id,
			title: workScopedTitle
		});
		const tenantSkill = await createSkill(request, access_token, {
			ownerType: 'tenant',
			ownerId: user.id,
			title: tenantScopedTitle
		});
		// One work-target binding (priority 12) + one tenant-wide binding (priority 88).
		await bindSkill(request, access_token, workSkill.id, {
			targetType: 'work',
			targetId: workId,
			priority: 12
		});
		await bindSkill(request, access_token, tenantSkill.id, {
			targetType: 'tenant',
			priority: 88
		});

		await page.goto(`/agents/${agent.id}/skills`, { waitUntil: 'domcontentloaded' });

		// Both skills render with their titles.
		await expect(page.getByText(workScopedTitle).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(tenantScopedTitle).first()).toBeVisible({ timeout: 30_000 });

		// The per-row labels distinguish the binding SCOPE ("<targetType> binding").
		await expect(page.getByText(/work binding/i).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/tenant binding/i).first()).toBeVisible({ timeout: 30_000 });

		// Priorities surface verbatim, and the active-binding count is plural.
		await expect(page.getByText(/priority\s*12/i).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/priority\s*88/i).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/2 active bindings/i).first()).toBeVisible({ timeout: 30_000 });
	});
});
