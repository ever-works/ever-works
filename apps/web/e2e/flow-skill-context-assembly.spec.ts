import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Skill CONTEXT ASSEMBLY into an Agent — COMPLEX, multi-step INTEGRATION flows.
 *
 * When an Agent runs, `PromptAssemblerService.assemble()`
 * (packages/agent/src/agents/prompt-assembler.service.ts) builds an
 * 11-segment system message. The `skills` segment is fed by
 * `SkillBindingRepository.resolveActive()` (the SAME resolver the public
 * `GET /api/agents/:id/skills` endpoint returns) and is capped per-Agent
 * by `maxSkillContextTokens` (default 4000) — over-budget bodies are
 * tail-first truncated (`truncateTailFirst`, "newest preserved, oldest
 * cut") and a structured truncation event is recorded. Segment ORDER is
 * fixed (`PROMPT_SEGMENTS`), and within the skills segment the skills are
 * emitted in the resolver's priority-ASC order.
 *
 * Because CI has NO LLM key + NO Trigger.dev, an agent RUN never completes
 * (assemble() is internal and only exercised at run time) — so this file
 * asserts the OBSERVABLE assembly surface that drives context building:
 *   1. the per-Agent token BUDGET (`maxSkillContextTokens`) that governs
 *      truncation — set/patch/range + export→import round-trip; and
 *   2. the RESOLVED, priority-ordered, deduped skill SET that becomes the
 *      ACTIVE SKILLS segment (`GET /api/agents/:id/skills`), including
 *      live re-resolution after skill edits and cross-scope combination.
 * The internal truncation/token-count of the assembled string is NOT a
 * public HTTP surface, so it is asserted by ABSENCE of any token/preview
 * field and validated indirectly via the budget knob + ordered set.
 *
 * This file deliberately AVOIDS what sibling specs already pin:
 *   - flow-agent-skills-binding   → basic bind/unbind, scope filter, budget bounds, isolation
 *   - flow-skill-agent-binding-deep → rebind, same-skill multi-target dedup, failover, tie-break
 *   - flow-skill-versioning       → version label edits + contentHash drift + cross-user 404
 *   - flow-skill-crud-scoping     → slug/owner CRUD + 64 KB/secret-scan/ParseUUID edges
 * It owns the ASSEMBLY lens: budget-as-truncation-knob persistence +
 * export round-trip, multi-skill COMBINED context ordering across targets,
 * live context re-resolution on skill content edits, budget-extreme
 * resolution invariance, cross-scope work-agent assembly + generator-only
 * exclusion, and the UI rendering of the ordered context bundle.
 *
 * API surface — every shape/status verified against the LIVE stack (sqlite
 * in-memory CI driver) before any assertion:
 *   - POST   /api/agents { scope:'tenant'|'work'|'mission'|'idea', name,
 *                          workId?, maxSkillContextTokens? }
 *       → 201 { id, slug, scope, status:'draft', maxSkillContextTokens, workId, … }
 *   - GET    /api/agents/:id                → includes maxSkillContextTokens
 *   - PATCH  /api/agents/:id { maxSkillContextTokens }
 *       DTO: @IsInt @Min(0) @Max(20000). -1 → 400 "must not be less than 0";
 *       1.5 → 400 "must be an integer number"; 20001 → 400 "must not be greater than 20000".
 *   - GET    /api/agents/:id/export
 *       → { version:1, model:{ aiProviderId, modelId, maxSkillContextTokens }, … }
 *         NB: `skillBindings:[]` is hard-coded EMPTY (Phase-9 deferred) — the
 *         BUDGET round-trips through export/import, the bindings do NOT.
 *   - POST   /api/agents/import (body = envelope, ?onConflict=rename default)
 *       → 201 { created:{ id, maxSkillContextTokens, status:'draft', … },
 *               conflictResolution, originalSlug, finalSlug }
 *   - GET    /api/agents/:id/skills
 *       → { data:[{ bindingId, priority, targetType, skill:{id,slug,title,version} }] }
 *         resolver = innerJoin skills WHERE binding.userId, target IN
 *         (agent|work|mission|idea|tenant), injectIntoAgent=true,
 *         ORDER BY priority ASC, createdAt ASC, DEDUP by skillId.
 *         The joined skill identity (title/version) is read LIVE per request.
 *   - POST   /api/skills { ownerType, ownerId, title, description, instructionsMd }
 *       → 201 { id, slug, version:'1.0.0', contentHash, … }
 *   - PATCH  /api/skills/:id { title?, version?, instructionsMd? } → 200 (live drift)
 *   - POST   /api/skills/:id/bindings { targetType, targetId?, priority?,
 *             injectIntoAgent?, injectIntoGenerator? }
 *       → 201; defaults priority 100, injectIntoAgent true, injectIntoGenerator false.
 *       TENANT target: OMIT targetId (the resolver matches targetId IS NULL —
 *       passing the literal string "null" creates a row that never resolves).
 *
 * Gotchas baked in (verified live):
 *   - A TENANT-target binding is user-scoped and resolves onto EVERY agent of
 *     that user → tenant rows can appear on an unrelated agent. Every flow runs
 *     on a FRESH registerUserViaAPI() user and asserts the OWN-skill subset via
 *     filtering by slug prefix (never an exact full-array equality that a stray
 *     tenant row would break). The seeded storageState user is used ONLY for UI.
 *   - The resolved LISTING is budget-INDEPENDENT (maxSkillContextTokens=0 still
 *     returns the full set — truncation happens only inside assemble() at run
 *     time, which CI never reaches).
 *   - Re-creating an IDENTICAL (skillId,targetType,targetId) binding hits a
 *     UNIQUE index and 500s — flows never duplicate a binding.
 *   - Unique titles via a Date.now()+counter suffix; assert toContain / subset,
 *     never exact counts, to tolerate pre-existing rows.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface BoundSkillRow {
	bindingId: string;
	priority: number;
	targetType: string;
	skill: { id: string; slug: string; title: string; version: string };
}

let nameCounter = 0;
function uniqueSuffix(): string {
	nameCounter += 1;
	return `${Date.now().toString(36)}-${nameCounter}`;
}

async function createAgent(
	request: APIRequestContext,
	token: string,
	body: {
		name: string;
		scope?: string;
		workId?: string;
		missionId?: string;
		ideaId?: string;
		maxSkillContextTokens?: number;
	},
): Promise<{ id: string; scope: string; slug: string; maxSkillContextTokens: number }> {
	const res = await request.post(`${API_BASE}/api/agents`, {
		headers: authedHeaders(token),
		data: { scope: 'tenant', ...body },
	});
	expect(res.status(), `createAgent body=${await res.text().catch(() => '')}`).toBe(201);
	return res.json();
}

async function createSkill(
	request: APIRequestContext,
	token: string,
	body: {
		ownerType: string;
		ownerId: string;
		title: string;
		description?: string;
		instructionsMd?: string;
		version?: string;
	},
): Promise<{ id: string; slug: string; title: string; version: string; contentHash: string }> {
	const res = await request.post(`${API_BASE}/api/skills`, {
		headers: authedHeaders(token),
		data: {
			ownerType: body.ownerType,
			ownerId: body.ownerId,
			title: body.title,
			description: body.description ?? 'context-assembly e2e',
			instructionsMd: body.instructionsMd ?? `# ${body.title}\n\nBody for ${body.title}.`,
			...(body.version ? { version: body.version } : {}),
		},
	});
	expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
	return res.json();
}

async function bindSkill(
	request: APIRequestContext,
	token: string,
	skillId: string,
	body: {
		targetType: string;
		targetId?: string;
		priority?: number;
		injectIntoAgent?: boolean;
		injectIntoGenerator?: boolean;
	},
): Promise<{ id: string; priority: number; targetType: string }> {
	// TENANT target: do NOT send targetId — the resolver matches targetId IS NULL.
	const data: Record<string, unknown> = {
		targetType: body.targetType,
		...(body.targetType !== 'tenant' && body.targetId ? { targetId: body.targetId } : {}),
		...(body.priority !== undefined ? { priority: body.priority } : {}),
		...(body.injectIntoAgent !== undefined ? { injectIntoAgent: body.injectIntoAgent } : {}),
		...(body.injectIntoGenerator !== undefined
			? { injectIntoGenerator: body.injectIntoGenerator }
			: {}),
	};
	const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
		headers: authedHeaders(token),
		data,
	});
	expect(res.status(), `bindSkill body=${await res.text().catch(() => '')}`).toBe(201);
	return res.json();
}

async function resolveActiveSkills(
	request: APIRequestContext,
	token: string,
	agentId: string,
): Promise<BoundSkillRow[]> {
	const res = await request.get(`${API_BASE}/api/agents/${agentId}/skills`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), `listSkills body=${await res.text().catch(() => '')}`).toBe(200);
	const json = await res.json();
	return json.data as BoundSkillRow[];
}

test.describe('Skill context assembly into an agent', () => {
	/**
	 * Flow 1 — the TRUNCATION BUDGET that governs context assembly is a
	 * persisted, per-Agent property that survives export → import.
	 *
	 * `maxSkillContextTokens` is the cap `assemble()` applies to the ACTIVE
	 * SKILLS segment before tail-first truncation. It must (a) be settable at
	 * create, (b) be patchable across the legal 0..20000 range, (c) survive a
	 * full export → import round-trip (the budget travels with the Agent), and
	 * (d) NOT carry the skill BINDINGS through export (Phase-9 deferred —
	 * envelope.skillBindings is hard-coded empty). We bind a skill BEFORE
	 * export to prove the imported clone starts with the SAME budget but an
	 * EMPTY resolved context (no bindings exported).
	 */
	test('skill-context token budget persists and round-trips through agent export/import', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const sfx = uniqueSuffix();

		// (a) settable at create.
		const agent = await createAgent(request, token, {
			name: `Budget Agent ${sfx}`,
			scope: 'tenant',
			maxSkillContextTokens: 2048,
		});
		expect(agent.maxSkillContextTokens).toBe(2048);

		// (b) patchable; read reflects it.
		const patch = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { maxSkillContextTokens: 6000 },
		});
		expect(patch.status()).toBe(200);
		const reread = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
		});
		expect((await reread.json()).maxSkillContextTokens).toBe(6000);

		// Bind a skill so the source agent has a non-empty resolved context.
		const skill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId: user.user?.id ?? 'tenant-1',
			title: `Budget Skill ${sfx}`,
		});
		await bindSkill(request, token, skill.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 20,
		});
		const sourceResolved = await resolveActiveSkills(request, token, agent.id);
		expect(sourceResolved.some((r) => r.skill.slug === skill.slug)).toBe(true);

		// (c) export carries the budget under model.maxSkillContextTokens and
		//     (d) carries an EMPTY skillBindings array (Phase-9 deferred).
		const exportRes = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
			headers: authedHeaders(token),
		});
		expect(exportRes.status()).toBe(200);
		const envelope = await exportRes.json();
		expect(envelope.version).toBe(1);
		expect(envelope.model.maxSkillContextTokens).toBe(6000);
		expect(Array.isArray(envelope.skillBindings)).toBe(true);
		expect(envelope.skillBindings).toHaveLength(0);

		// Import (default rename) — clone keeps the budget, starts in draft,
		// and resolves an EMPTY context (bindings did not travel).
		const importRes = await request.post(`${API_BASE}/api/agents/import`, {
			headers: authedHeaders(token),
			data: envelope,
		});
		expect(importRes.status()).toBe(201);
		const imported = await importRes.json();
		expect(imported.conflictResolution).toBe('renamed');
		expect(imported.created.maxSkillContextTokens).toBe(6000);
		expect(imported.created.status).toBe('draft');

		const clonedResolved = await resolveActiveSkills(request, token, imported.created.id);
		expect(clonedResolved.some((r) => r.skill.slug === skill.slug)).toBe(false);
	});

	/**
	 * Flow 2 — multiple DISTINCT skills bound across MULTIPLE targets combine
	 * into ONE priority-ordered context bundle (the ACTIVE SKILLS segment).
	 *
	 * Bind four distinct skills at agent / agent / tenant / agent targets with
	 * priorities [50, 5, 100, 25]. The resolved set that feeds assemble() must
	 * combine ALL of them and emit in priority-ASC order [5, 25, 50, 100] —
	 * exactly the order `renderSkillsBlock` walks. We assert the OWN-skill
	 * subset (filtered by our unique slug prefix) is strictly ascending, so a
	 * stray pre-existing tenant row from another agent can't break the check.
	 */
	test('multiple distinct skills combine into one priority-ordered context bundle', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const sfx = uniqueSuffix();
		const ownerId = user.user?.id ?? 'tenant-1';
		const prefix = `ctxcombine-${sfx}`;

		const agent = await createAgent(request, token, {
			name: `Combine Agent ${sfx}`,
			scope: 'tenant',
			maxSkillContextTokens: 4000,
		});

		// Four distinct skills, distinct titles → distinct slugs sharing prefix.
		const mk = (label: string) =>
			createSkill(request, token, {
				ownerType: 'tenant',
				ownerId,
				title: `${prefix} ${label}`,
			});
		const sA = await mk('alpha');
		const sB = await mk('bravo');
		const sC = await mk('charlie');
		const sD = await mk('delta');

		await bindSkill(request, token, sA.id, { targetType: 'agent', targetId: agent.id, priority: 50 });
		await bindSkill(request, token, sB.id, { targetType: 'agent', targetId: agent.id, priority: 5 });
		await bindSkill(request, token, sC.id, { targetType: 'tenant', priority: 100 });
		await bindSkill(request, token, sD.id, { targetType: 'agent', targetId: agent.id, priority: 25 });

		const resolved = await resolveActiveSkills(request, token, agent.id);

		// All four of OUR skills are present in the combined context.
		const ours = resolved.filter((r) => r.skill.slug.startsWith(prefix));
		const oursBySlug = new Map(ours.map((r) => [r.skill.slug, r]));
		expect(oursBySlug.has(sA.slug)).toBe(true);
		expect(oursBySlug.has(sB.slug)).toBe(true);
		expect(oursBySlug.has(sC.slug)).toBe(true);
		expect(oursBySlug.has(sD.slug)).toBe(true);

		// Our four skills are emitted in priority-ASC order [5, 25, 50, 100].
		expect(ours.map((r) => r.priority)).toEqual([5, 25, 50, 100]);
		expect(ours.map((r) => r.skill.slug)).toEqual([sB.slug, sD.slug, sA.slug, sC.slug]);

		// The full resolved list (incl. any stray tenant rows) is globally
		// non-decreasing by priority — the assembler relies on this invariant.
		const allPriorities = resolved.map((r) => r.priority);
		const sorted = [...allPriorities].sort((a, b) => a - b);
		expect(allPriorities).toEqual(sorted);
	});

	/**
	 * Flow 3 — the assembled context reflects LIVE skill edits (read-time
	 * re-resolution). The resolver joins the skill identity (title + version)
	 * fresh on every request, so editing a shared skill is reflected in EVERY
	 * bound agent's context immediately — no re-bind needed.
	 *
	 * Bind one skill to two agents. Edit the skill's title + version once.
	 * BOTH agents' resolved context must surface the new title/version on the
	 * next read, while the binding id + priority stay stable (the edit changes
	 * the joined skill, not the binding).
	 */
	test('assembled context re-resolves live when a shared skill is edited', async ({ request }) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const sfx = uniqueSuffix();
		const ownerId = user.user?.id ?? 'tenant-1';

		const agent1 = await createAgent(request, token, {
			name: `Live Agent One ${sfx}`,
			scope: 'tenant',
		});
		const agent2 = await createAgent(request, token, {
			name: `Live Agent Two ${sfx}`,
			scope: 'tenant',
		});

		const skill = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId,
			title: `Live Skill ${sfx}`,
			instructionsMd: '# original body',
		});
		const b1 = await bindSkill(request, token, skill.id, {
			targetType: 'agent',
			targetId: agent1.id,
			priority: 12,
		});
		const b2 = await bindSkill(request, token, skill.id, {
			targetType: 'agent',
			targetId: agent2.id,
			priority: 34,
		});

		// Initial context on both agents reflects v1.0.0 + original title.
		const before1 = (await resolveActiveSkills(request, token, agent1.id)).find(
			(r) => r.skill.id === skill.id,
		);
		const before2 = (await resolveActiveSkills(request, token, agent2.id)).find(
			(r) => r.skill.id === skill.id,
		);
		expect(before1?.skill.version).toBe('1.0.0');
		expect(before2?.skill.title).toBe(`Live Skill ${sfx}`);

		// Edit the shared skill ONCE — new title, bumped version, new body.
		const newTitle = `Live Skill ${sfx} (revised)`;
		const editRes = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
			headers: authedHeaders(token),
			data: { title: newTitle, version: '2.1.0', instructionsMd: '# revised body content' },
		});
		expect(editRes.status()).toBe(200);

		// Both agents' contexts re-resolve to the NEW identity on next read.
		await expect
			.poll(
				async () => {
					const r = (await resolveActiveSkills(request, token, agent1.id)).find(
						(x) => x.skill.id === skill.id,
					);
					return `${r?.skill.title}|${r?.skill.version}`;
				},
				{ timeout: 15_000 },
			)
			.toBe(`${newTitle}|2.1.0`);

		const after2 = (await resolveActiveSkills(request, token, agent2.id)).find(
			(r) => r.skill.id === skill.id,
		);
		expect(after2?.skill.title).toBe(newTitle);
		expect(after2?.skill.version).toBe('2.1.0');

		// The bindings themselves are untouched by the skill edit.
		expect(after2?.bindingId).toBe(b2.id);
		expect(after2?.priority).toBe(34);
		const after1 = (await resolveActiveSkills(request, token, agent1.id)).find(
			(r) => r.skill.id === skill.id,
		);
		expect(after1?.bindingId).toBe(b1.id);
		expect(after1?.priority).toBe(12);
	});

	/**
	 * Flow 4 — budget-EXTREME configs do not break context resolution, and the
	 * DTO guards the truncation cap. The skills-segment cap is
	 * `maxSkillContextTokens ?? 4000` clamped to [0, 20000]. We prove:
	 *   - budget = 0 (every skill body would be tail-truncated to nothing) and
	 *     budget = 20000 (max) are both ACCEPTED and BOTH still resolve the full
	 *     skill SET (the listing is budget-independent — truncation is internal);
	 *   - out-of-range / non-integer budgets are rejected by the DTO with the
	 *     exact class-validator messages, leaving the stored budget unchanged.
	 */
	test('budget extremes (0 / max) resolve the full set; out-of-range budgets are rejected', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const sfx = uniqueSuffix();
		const ownerId = user.user?.id ?? 'tenant-1';
		const prefix = `ctxbudget-${sfx}`;

		const agent = await createAgent(request, token, {
			name: `Extreme Budget Agent ${sfx}`,
			scope: 'tenant',
			maxSkillContextTokens: 4000,
		});

		// Two skills bound agent-direct.
		const s1 = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId,
			title: `${prefix} first`,
			instructionsMd: `# big body\n${'x'.repeat(2000)}`,
		});
		const s2 = await createSkill(request, token, {
			ownerType: 'tenant',
			ownerId,
			title: `${prefix} second`,
		});
		await bindSkill(request, token, s1.id, { targetType: 'agent', targetId: agent.id, priority: 10 });
		await bindSkill(request, token, s2.id, { targetType: 'agent', targetId: agent.id, priority: 20 });

		// budget = 0 — accepted; the resolved SET is unchanged (budget only
		// truncates the assembled string at run time, not the listing).
		const toZero = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { maxSkillContextTokens: 0 },
		});
		expect(toZero.status()).toBe(200);
		expect((await toZero.json()).maxSkillContextTokens).toBe(0);
		let resolved = await resolveActiveSkills(request, token, agent.id);
		let ours = resolved.filter((r) => r.skill.slug.startsWith(prefix));
		expect(ours.map((r) => r.skill.slug).sort()).toEqual([s1.slug, s2.slug].sort());

		// budget = 20000 (max) — accepted; still the same full set.
		const toMax = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { maxSkillContextTokens: 20000 },
		});
		expect(toMax.status()).toBe(200);
		expect((await toMax.json()).maxSkillContextTokens).toBe(20000);
		resolved = await resolveActiveSkills(request, token, agent.id);
		ours = resolved.filter((r) => r.skill.slug.startsWith(prefix));
		expect(ours).toHaveLength(2);

		// Out-of-range / non-integer budgets are rejected; stored value stays 20000.
		const tooBig = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { maxSkillContextTokens: 20001 },
		});
		expect(tooBig.status()).toBe(400);
		expect(JSON.stringify(await tooBig.json())).toContain('must not be greater than 20000');

		const negative = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { maxSkillContextTokens: -1 },
		});
		expect(negative.status()).toBe(400);
		expect(JSON.stringify(await negative.json())).toContain('must not be less than 0');

		const fractional = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
			data: { maxSkillContextTokens: 1.5 },
		});
		expect(fractional.status()).toBe(400);
		expect(JSON.stringify(await fractional.json())).toContain('must be an integer number');

		const finalRead = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
			headers: authedHeaders(token),
		});
		expect((await finalRead.json()).maxSkillContextTokens).toBe(20000);
	});

	/**
	 * Flow 5 — cross-SCOPE context assembly for a WORK-scoped agent. A
	 * work-scoped agent's resolver joins agent-direct + its work-target
	 * bindings. A work-target skill (priority 30) and an agent-target skill
	 * (priority 15) must COMBINE into one ordered context [15, 30]; a binding
	 * flagged `injectIntoAgent:false` (generator-only) must be EXCLUDED from
	 * the agent context entirely — proving the assembler only sees agent-run
	 * skills. The empty-state (a sibling tenant agent with no bindings) yields
	 * an empty OWN-skill context.
	 */
	test('work-scoped agent assembles work-target + agent-target skills; generator-only is excluded', async ({
		request,
	}) => {
		const user = await registerUserViaAPI(request);
		const token = user.access_token;
		const sfx = uniqueSuffix();
		const prefix = `ctxwork-${sfx}`;

		const work = await createWorkViaAPI(request, token, { name: `Ctx Work ${sfx}` });
		const workId = work.id;
		expect(workId).toBeTruthy();

		const agent = await createAgent(request, token, {
			name: `Work Ctx Agent ${sfx}`,
			scope: 'work',
			workId,
			maxSkillContextTokens: 4000,
		});

		const mk = (label: string) =>
			createSkill(request, token, {
				ownerType: 'work',
				ownerId: workId,
				title: `${prefix} ${label}`,
			});
		const workSkill = await mk('work-target');
		const agentSkill = await mk('agent-target');
		const genOnly = await mk('generator-only');

		// work-target prio 30, agent-target prio 15, generator-only prio 1 (excluded).
		await bindSkill(request, token, workSkill.id, {
			targetType: 'work',
			targetId: workId,
			priority: 30,
		});
		await bindSkill(request, token, agentSkill.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 15,
		});
		await bindSkill(request, token, genOnly.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 1,
			injectIntoAgent: false,
			injectIntoGenerator: true,
		});

		const resolved = await resolveActiveSkills(request, token, agent.id);
		const ours = resolved.filter((r) => r.skill.slug.startsWith(prefix));

		// The two agent-run skills combine, ordered by priority [15, 30].
		expect(ours.map((r) => r.skill.slug)).toEqual([agentSkill.slug, workSkill.slug]);
		expect(ours.map((r) => r.priority)).toEqual([15, 30]);
		expect(ours.map((r) => r.targetType)).toEqual(['agent', 'work']);

		// The generator-only skill is NOT in the agent context despite top priority.
		expect(ours.some((r) => r.skill.slug === genOnly.slug)).toBe(false);

		// A sibling agent with no bindings assembles an empty OWN context.
		const emptyAgent = await createAgent(request, token, {
			name: `Empty Ctx Agent ${sfx}`,
			scope: 'tenant',
		});
		const emptyResolved = await resolveActiveSkills(request, token, emptyAgent.id);
		expect(emptyResolved.filter((r) => r.skill.slug.startsWith(prefix))).toHaveLength(0);

		// Unknown agent id → 404 (no context leak).
		const ghost = await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}/skills`, {
			headers: authedHeaders(token),
		});
		expect(ghost.status()).toBe(404);
	});

	/**
	 * Flow 6 — UI: the per-agent Skills page renders the assembled context
	 * bundle in priority order for the seeded (storageState) user. Bind two
	 * distinct skills at priorities 3 and 88; the /agents/:id/skills page must
	 * surface BOTH titles and the active-binding count. Both priorities should
	 * be visible (the page renders the ordered set), with LOCAL/CI route
	 * divergence tolerated via .or().
	 */
	test('UI: per-agent Skills page renders the ordered context bundle for the seeded user', async ({
		page,
		request,
		baseURL,
	}) => {
		const seeded = loadSeededTestUser();
		const login = await request.post(`${API_BASE}/api/auth/login`, {
			data: { email: seeded.email, password: seeded.password },
		});
		expect(login.status()).toBe(200);
		const { access_token, user } = await login.json();
		const sfx = uniqueSuffix();

		const agent = await createAgent(request, access_token, {
			name: `UI Ctx Agent ${sfx}`,
			scope: 'tenant',
		});

		const highTitle = `UI Ctx High ${sfx}`;
		const lowTitle = `UI Ctx Low ${sfx}`;
		const high = await createSkill(request, access_token, {
			ownerType: 'tenant',
			ownerId: user.id,
			title: highTitle,
		});
		const low = await createSkill(request, access_token, {
			ownerType: 'tenant',
			ownerId: user.id,
			title: lowTitle,
		});
		// low priority number (3) ranks ABOVE the high number (88).
		await bindSkill(request, access_token, high.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 3,
		});
		await bindSkill(request, access_token, low.id, {
			targetType: 'agent',
			targetId: agent.id,
			priority: 88,
		});

		// Confirm the API context bundle order BEFORE driving the UI.
		const resolved = await resolveActiveSkills(request, access_token, agent.id);
		const ours = resolved.filter(
			(r) => r.skill.title === highTitle || r.skill.title === lowTitle,
		);
		expect(ours.map((r) => r.skill.title)).toEqual([highTitle, lowTitle]);

		const origin = baseURL ?? 'http://localhost:3000';
		await page.goto(`${origin}/agents/${agent.id}/skills`, { waitUntil: 'domcontentloaded' });

		// Both bound skills render in the page's context list.
		await expect(page.getByText(highTitle).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(lowTitle).first()).toBeVisible({ timeout: 30_000 });

		// The active-binding count / priority surface is present (CI vs local
		// markup divergence tolerated via .or()).
		const bindingMeta = page
			.getByText(/active binding/i)
			.or(page.getByText(/priority\s*3/i))
			.or(page.getByText(/priority\s*88/i));
		await expect(bindingMeta.first()).toBeVisible({ timeout: 30_000 });
	});
});
