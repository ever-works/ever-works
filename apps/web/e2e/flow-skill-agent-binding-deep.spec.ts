import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Skill ↔ Agent binding — DEEP resolution semantics.
 *
 * This file complements `flow-agent-skills-binding.spec.ts` (basic
 * bind/unbind, scope filtering, multi-DISTINCT-skill priority order +
 * opt-out, token-budget bounds, cross-user isolation) by drilling into
 * the resolver edge cases that file does NOT cover: rebinding, the
 * SAME skill bound to multiple targets being deduped to one winning
 * binding, binding-target failover, work-scope target join, the
 * injectIntoAgent vs injectIntoGenerator matrix, live skill-version
 * propagation, the negative/validation matrix (404/400/409), priority
 * tie-break ordering, and the per-agent Skills page Remove button.
 *
 * API surface — ALL shapes verified against the LIVE stack before asserting
 * (probe users registered via the API; sqlite in-memory CI driver):
 *   - POST   /api/agents { scope:'tenant'|'work'|'mission'|'idea', name, maxSkillContextTokens? }
 *       → 201 { id, scope, status:'draft', maxSkillContextTokens, workId, … }
 *   - PATCH  /api/agents/:id { maxSkillContextTokens }   (DTO @IsInt @Min 0 @Max 20000)
 *   - GET    /api/agents/:id/skills
 *       → { data:[{ bindingId, priority, targetType, skill:{id,slug,title,version} }] }
 *         resolver = innerJoin skills, WHERE binding.userId, target IN
 *         (agent | work | mission | idea | tenant), injectIntoAgent=true,
 *         ORDER BY priority ASC, createdAt ASC, then DEDUP by skillId
 *         (FIRST row per skillId wins = lowest priority number, tie → earliest).
 *       Cross-user / unknown agent → 404.
 *   - POST   /api/skills { ownerType, ownerId, title, description, instructionsMd }
 *       → 201 { id, slug, version:'1.0.0', contentHash, … }
 *       Duplicate (ownerType, ownerId, slug) → 409 "A Skill with slug … already exists".
 *   - PATCH  /api/skills/:id { version?, instructionsMd? }
 *       → 200; new version + recomputed sha256 contentHash surface live in /agents/:id/skills.
 *   - DELETE /api/skills/:id      → 200 { deleted:true }; FK CASCADE drops its bindings.
 *   - GET/POST /api/skills/:id/bindings
 *       create body { targetType, targetId?, priority?, injectIntoAgent?, injectIntoGenerator? }
 *       defaults: priority 100, injectIntoAgent true, injectIntoGenerator false.
 *       Binding a NONEXISTENT skill → 404 "Skill <id> not found.".
 *       Invalid targetType → 400 "Invalid targetType \"x\".".
 *       Missing targetId for a non-tenant target → 400 "targetId is required when targetType=…".
 *   - DELETE /api/skill-bindings/:id  → 200 { deleted:true }; repeat → 404; cross-user → 404.
 *
 * Notes / deviations:
 *   - Re-creating an IDENTICAL (skillId,targetType,targetId) binding hits a
 *     UNIQUE index and 500s — every "rebind" here DELETEs the old binding
 *     first, then re-creates at a different priority (or a different target),
 *     never a literal duplicate.
 *   - injectIntoGenerator:true does NOT surface a skill on the agent-run
 *     resolver (`forAgentRun:true` filters on injectIntoAgent); there is no
 *     public generator-resolver endpoint, so it is asserted by ABSENCE.
 *   - Fresh API users for every API-only mutation (cross-spec isolation,
 *     unique titles via Date.now); the SEEDED storageState user is used ONLY
 *     for the final UI-driven Remove assertion.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface BoundSkillRow {
    bindingId: string;
    priority: number;
    targetType: string;
    skill: { id: string; slug: string; title: string; version: string };
}

interface BindingRow {
    id: string;
    skillId: string;
    targetType: string;
    targetId: string | null;
    priority: number;
    injectIntoAgent: boolean;
    injectIntoGenerator: boolean;
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
    },
): Promise<{
    id: string;
    slug: string;
    ownerType: string;
    ownerId: string;
    version: string;
    contentHash: string;
}> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            description: 'e2e deep-binding skill',
            instructionsMd: `# ${body.title}`,
            ...body,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function bindSkill(
    request: APIRequestContext,
    token: string,
    skillId: string,
    binding: {
        targetType: string;
        targetId?: string;
        priority?: number;
        injectIntoAgent?: boolean;
        injectIntoGenerator?: boolean;
    },
): Promise<BindingRow> {
    const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data: binding,
    });
    expect(res.status(), `bindSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function listAgentSkills(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<BoundSkillRow[]> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/skills`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'listAgentSkills status').toBe(200);
    return (await res.json()).data ?? [];
}

async function listSkillBindings(
    request: APIRequestContext,
    token: string,
    skillId: string,
): Promise<BindingRow[]> {
    const res = await request.get(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'listSkillBindings status').toBe(200);
    return res.json();
}

async function unbind(
    request: APIRequestContext,
    token: string,
    bindingId: string,
): Promise<number> {
    const res = await request.delete(`${API_BASE}/api/skill-bindings/${bindingId}`, {
        headers: authedHeaders(token),
    });
    return res.status();
}

test.describe('Skill ↔ Agent binding — deep resolution', () => {
    /**
     * Flow 1 — Work-scope target join + full rebind cycle.
     *
     * A work-scoped agent resolves skills bound to its WORK (not just
     * agent-direct bindings). Bind a work-owned skill to the work target,
     * confirm it resolves onto the work-scoped agent, UNBIND it (agent
     * empties), then REBIND the same skill to the same work target at a
     * higher priority — proving rebinding yields a fresh binding id and the
     * new priority surfaces. Finally retarget the same skill agent-direct
     * at an even higher priority and confirm the agent-direct binding now
     * wins the dedup over the work binding.
     */
    test('work-scoped agent resolves work-target skill; unbind → rebind cycles the binding', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        const work = await createWorkViaAPI(request, token, { name: `Bind Work ${stamp}` });
        expect(work.id).toBeTruthy();

        const agent = await createAgentViaAPI(request, token, {
            name: `Work Agent ${stamp}`,
            scope: 'work',
            workId: work.id,
        });
        expect(agent.scope).toBe('work');

        const skill = await createSkill(request, token, {
            ownerType: 'work',
            ownerId: work.id,
            title: `Work Playbook ${stamp}`,
        });

        // Pre-bind: nothing resolves.
        expect(await listAgentSkills(request, token, agent.id)).toEqual([]);

        // Bind to the WORK target → resolves on the work-scoped agent.
        const workBinding = await bindSkill(request, token, skill.id, {
            targetType: 'work',
            targetId: work.id,
            priority: 20,
        });
        let resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            bindingId: workBinding.id,
            priority: 20,
            targetType: 'work',
            skill: { id: skill.id, version: '1.0.0' },
        });

        // Unbind → agent empties.
        expect(await unbind(request, token, workBinding.id)).toBe(200);
        expect(await listAgentSkills(request, token, agent.id)).toEqual([]);

        // Rebind the SAME skill to the SAME work target at a higher priority.
        // (delete-then-recreate avoids the unique-index 500 on identical rows.)
        const reboundWork = await bindSkill(request, token, skill.id, {
            targetType: 'work',
            targetId: work.id,
            priority: 5,
        });
        expect(reboundWork.id).not.toBe(workBinding.id);
        resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].bindingId).toBe(reboundWork.id);
        expect(resolved[0].priority).toBe(5);

        // Now ALSO bind agent-direct at priority 1 → wins the per-skill dedup.
        const agentBinding = await bindSkill(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 1,
        });
        resolved = await listAgentSkills(request, token, agent.id);
        // Still a single row (same skillId deduped); the agent-direct binding
        // (lowest priority number) is the winner.
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            bindingId: agentBinding.id,
            priority: 1,
            targetType: 'agent',
        });
        // Both physical bindings still exist on the skill — the dedup is a
        // READ-time projection, not a delete.
        const physical = await listSkillBindings(request, token, skill.id);
        expect(physical.map((b) => b.id).sort()).toEqual([reboundWork.id, agentBinding.id].sort());
    });

    /**
     * Flow 2 — Same-skill multi-binding dedup + winner failover.
     *
     * One skill is bound at THREE targets (tenant / mission / agent) with
     * distinct priorities. The resolver returns exactly ONE row (deduped by
     * skillId), and the winner is the lowest-priority-number binding.
     * Removing the current winner makes the next-best binding take over —
     * a graceful failover, never a vanish. The skill's own bindings list
     * keeps showing every physical row throughout.
     */
    test('same skill bound at 3 targets dedups to one row; removing the winner fails over', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers: authedHeaders(token),
                data: { title: `Dedup Mission ${stamp}`, description: 'd', type: 'one-shot' },
            })
        ).json();
        expect(mission.id).toBeTruthy();

        const agent = await createAgentViaAPI(request, token, {
            name: `Dedup Agent ${stamp}`,
            scope: 'mission',
            missionId: mission.id,
        });

        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Shared Skill ${stamp}`,
        });

        // Bind the SAME skill three ways. Priorities: agent=30, mission=20, tenant=10.
        const bAgent = await bindSkill(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 30,
        });
        const bMission = await bindSkill(request, token, skill.id, {
            targetType: 'mission',
            targetId: mission.id,
            priority: 20,
        });
        const bTenant = await bindSkill(request, token, skill.id, {
            targetType: 'tenant',
            priority: 10,
        });

        // All three physical bindings exist.
        expect((await listSkillBindings(request, token, skill.id)).map((b) => b.id).sort()).toEqual(
            [bAgent.id, bMission.id, bTenant.id].sort(),
        );

        // But the agent resolves exactly ONE row — the tenant binding (prio 10).
        let resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            bindingId: bTenant.id,
            priority: 10,
            targetType: 'tenant',
        });

        // Remove the winner → the mission binding (prio 20) takes over.
        expect(await unbind(request, token, bTenant.id)).toBe(200);
        resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            bindingId: bMission.id,
            priority: 20,
            targetType: 'mission',
        });

        // Remove that too → the agent-direct binding (prio 30) is last standing.
        expect(await unbind(request, token, bMission.id)).toBe(200);
        resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            bindingId: bAgent.id,
            priority: 30,
            targetType: 'agent',
        });

        // Remove the last → empty.
        expect(await unbind(request, token, bAgent.id)).toBe(200);
        expect(await listAgentSkills(request, token, agent.id)).toEqual([]);
    });

    /**
     * Flow 3 — maxSkillContextTokens transitions are orthogonal to binding
     * resolution.
     *
     * Walk the token-budget DTO bounds (default → explicit → 0 → over-max
     * rejected → restored) while a stable set of skills stays bound. The
     * resolved skill set must be identical at every budget value — the
     * budget is a downstream truncation knob, not a binding filter.
     */
    test('maxSkillContextTokens transitions do not change which skills resolve', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Budget Agent ${stamp}`,
            scope: 'tenant',
        });

        // Two skills bound agent-direct.
        const s1 = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Budget Skill One ${stamp}`,
        });
        const s2 = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Budget Skill Two ${stamp}`,
        });
        await bindSkill(request, token, s1.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 10,
        });
        await bindSkill(request, token, s2.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 20,
        });

        const expectedSet = [s1.id, s2.id];
        const assertSet = async () => {
            const resolved = await listAgentSkills(request, token, agent.id);
            expect(resolved.map((r) => r.skill.id)).toEqual(expectedSet);
        };

        const patchBudget = async (value: number) => {
            const res = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
                headers: authedHeaders(token),
                data: { maxSkillContextTokens: value },
            });
            return res;
        };

        // Sequence of valid budgets — each accepted, each leaves the set intact.
        for (const value of [4096, 0, 20000, 512]) {
            const res = await patchBudget(value);
            expect(res.status(), `patch budget ${value}`).toBe(200);
            expect((await res.json()).maxSkillContextTokens).toBe(value);
            await assertSet();
        }

        // Over-max is rejected by the DTO; the last valid value (512) persists
        // and the resolved set is still intact.
        const overMax = await patchBudget(20001);
        expect(overMax.status()).toBe(400);
        const negative = await patchBudget(-1);
        expect(negative.status()).toBe(400);
        const reread = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(token),
        });
        expect((await reread.json()).maxSkillContextTokens).toBe(512);
        await assertSet();
    });

    /**
     * Flow 4 — injectIntoAgent vs injectIntoGenerator matrix.
     *
     * A binding flagged generator-only (injectIntoAgent:false,
     * injectIntoGenerator:true) is INVISIBLE on the agent-run resolver. The
     * binding row still exists and reports its flags truthfully. Toggling it
     * back to agent-injectable (rebind) makes the skill appear; default flags
     * (no flags supplied) are agent:true / generator:false.
     */
    test('generator-only binding is hidden from the agent resolver; toggling re-exposes it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Matrix Agent ${stamp}`,
            scope: 'tenant',
        });

        const genSkill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Generator Only ${stamp}`,
        });
        const agentSkill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Agent Default ${stamp}`,
        });

        // Generator-only binding — present physically, absent from resolver.
        const genBinding = await bindSkill(request, token, genSkill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 1,
            injectIntoAgent: false,
            injectIntoGenerator: true,
        });
        expect(genBinding.injectIntoAgent).toBe(false);
        expect(genBinding.injectIntoGenerator).toBe(true);

        // Default-flag binding — agent:true / generator:false.
        const defBinding = await bindSkill(request, token, agentSkill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 50,
        });
        expect(defBinding.injectIntoAgent).toBe(true);
        expect(defBinding.injectIntoGenerator).toBe(false);

        // Only the default binding resolves — the generator-only one is hidden
        // despite its top priority.
        let resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved.map((r) => r.skill.id)).toEqual([agentSkill.id]);
        expect(resolved.map((r) => r.skill.id)).not.toContain(genSkill.id);

        // Toggle the generator-only skill into the agent run by rebinding it
        // agent-injectable. (delete-then-recreate; cannot flip flags in place.)
        expect(await unbind(request, token, genBinding.id)).toBe(200);
        const reExposed = await bindSkill(request, token, genSkill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 1,
            injectIntoAgent: true,
        });
        expect(reExposed.injectIntoAgent).toBe(true);

        // Now both resolve, in priority order: gen (1) then default (50).
        resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved.map((r) => r.skill.id)).toEqual([genSkill.id, agentSkill.id]);
        expect(resolved.map((r) => r.priority)).toEqual([1, 50]);
    });

    /**
     * Flow 5 — live skill-version + content-hash propagation through a
     * binding.
     *
     * The agent-run resolver joins the live Skill row, so editing the bound
     * skill (version + body) is reflected immediately in /agents/:id/skills
     * with NO rebind. Multiple bumps each propagate; the binding id/priority
     * never change.
     */
    test('editing a bound skill version + body propagates live to the agent resolver', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Versioned Agent ${stamp}`,
            scope: 'tenant',
        });
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Versioned Skill ${stamp}`,
        });
        const v1Hash = skill.contentHash;

        const binding = await bindSkill(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 7,
        });

        let resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].skill.version).toBe('1.0.0');
        expect(resolved[0].bindingId).toBe(binding.id);

        // Bump 1: version + body. The content hash must change (sha256 of body).
        const patch1 = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(token),
            data: { version: '2.0.0', instructionsMd: `# ${skill.slug} v2 body ${stamp}` },
        });
        expect(patch1.status()).toBe(200);
        const after1 = await patch1.json();
        expect(after1.version).toBe('2.0.0');
        expect(after1.contentHash).not.toBe(v1Hash);

        resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved).toHaveLength(1);
        // Same binding, same priority — but the joined skill version is new.
        expect(resolved[0].bindingId).toBe(binding.id);
        expect(resolved[0].priority).toBe(7);
        expect(resolved[0].skill.version).toBe('2.0.0');

        // Bump 2: version only.
        const patch2 = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(token),
            data: { version: '2.1.3' },
        });
        expect(patch2.status()).toBe(200);
        resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved[0].skill.version).toBe('2.1.3');
        expect(resolved[0].skill.slug).toBe(skill.slug);
    });

    /**
     * Flow 6 — negative + validation matrix and per-user isolation around
     * the binding write paths.
     *
     * Binding a nonexistent skill 404s; an invalid targetType and a missing
     * targetId both 400 with truthful messages; a duplicate-slug skill 409s;
     * a second user can neither bind onto nor read the first user's skill.
     * Finally, equal-priority bindings tie-break by creation order
     * (createdAt ASC), and a repeat unbind 404s.
     */
    test('binding negatives: 404 unknown skill, 400 bad target, 409 slug clash, tie-break, isolation', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const token = alice.access_token;
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Neg Agent ${stamp}`,
            scope: 'tenant',
        });

        // 404 — binding a skill id that does not exist.
        const noSkill = await request.post(`${API_BASE}/api/skills/${UNKNOWN_UUID}/bindings`, {
            headers: authedHeaders(token),
            data: { targetType: 'agent', targetId: agent.id },
        });
        expect(noSkill.status()).toBe(404);
        expect((await noSkill.json()).message).toMatch(/not found/i);

        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Neg Skill ${stamp}`,
        });

        // 400 — invalid targetType. The hardened API validates `targetType`
        // with class-validator's `@IsEnum(SKILL_BINDING_TARGET_TYPES)` on the
        // CreateSkillBindingDto, so the global ValidationPipe rejects an
        // unknown value BEFORE the service runs — the body is the standard
        // ValidationPipe envelope (`message` is a string[] of constraint
        // violations) rather than the service's "Invalid targetType …" string.
        // Intent preserved: a bogus targetType is a 400 whose error names the
        // offending `targetType` field. Coerce the array→string before matching.
        const badType = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(token),
            data: { targetType: 'bogus', targetId: agent.id },
        });
        expect(badType.status()).toBe(400);
        const badTypeMessage = (await badType.json()).message;
        expect(JSON.stringify(badTypeMessage)).toMatch(/targetType must be one of/i);

        // 400 — non-tenant target missing its targetId.
        const noTarget = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(token),
            data: { targetType: 'agent' },
        });
        expect(noTarget.status()).toBe(400);
        expect((await noTarget.json()).message).toMatch(/targetId is required/i);

        // 409 — a second skill with the same (ownerType, ownerId, slug).
        const dup = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'tenant',
                ownerId: alice.user.id,
                title: `Neg Skill ${stamp}`,
                description: 'd',
                instructionsMd: '# dup',
            },
        });
        expect(dup.status()).toBe(409);
        expect((await dup.json()).message).toMatch(/already exists/i);

        // Cross-user — Bob cannot bind onto Alice's skill (404, no leak).
        const bobBind = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(bob.access_token),
            data: { targetType: 'tenant' },
        });
        expect([403, 404]).toContain(bobBind.status());

        // Tie-break — two DIFFERENT skills bound agent-direct at the SAME
        // priority resolve in creation order (the earlier binding first).
        const tieA = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Tie A ${stamp}`,
        });
        const tieB = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Tie B ${stamp}`,
        });
        const firstBinding = await bindSkill(request, token, tieA.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 15,
        });
        await bindSkill(request, token, tieB.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 15,
        });
        const tieResolved = await listAgentSkills(request, token, agent.id);
        expect(tieResolved.map((r) => r.skill.id)).toEqual([tieA.id, tieB.id]);
        expect(tieResolved.map((r) => r.priority)).toEqual([15, 15]);

        // A repeat unbind of the first binding 404s after the initial delete.
        expect(await unbind(request, token, firstBinding.id)).toBe(200);
        expect(await unbind(request, token, firstBinding.id)).toBe(404);
        // Bob cannot delete one of Alice's surviving bindings either.
        const survivors = await listSkillBindings(request, token, tieB.id);
        expect(await unbind(request, bob.access_token, survivors[0].id)).toBe(404);
    });

    /**
     * Flow 7 — UI: remove a binding from the per-agent Skills page.
     *
     * Driven through the SEEDED storageState session. Bind two skills to a
     * fresh agent owned by the seeded user, open /agents/:id/skills, assert
     * both rows + the "2 active bindings" count render, click one row's
     * Remove button, and assert that row disappears while the other stays —
     * the client re-fetches via listAgentSkillsAction after deleteBindingAction.
     */
    test('UI: the per-agent Skills page removes a single binding and updates the count', async ({
        page,
        request,
    }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.status()).toBe(200);
        const { access_token, user } = await login.json();
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, access_token, {
            name: `UI Remove Agent ${stamp}`,
            scope: 'tenant',
        });

        const keepTitle = `UI Keep Skill ${stamp}`;
        const dropTitle = `UI Drop Skill ${stamp}`;
        const keep = await createSkill(request, access_token, {
            ownerType: 'tenant',
            ownerId: user.id,
            title: keepTitle,
        });
        const drop = await createSkill(request, access_token, {
            ownerType: 'tenant',
            ownerId: user.id,
            title: dropTitle,
        });
        await bindSkill(request, access_token, keep.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 10,
        });
        await bindSkill(request, access_token, drop.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 20,
        });

        // The /agents/:id/skills resolver ALSO surfaces the user's tenant-scoped
        // bindings (targetType='tenant', scoped by userId) on top of this agent's
        // own bindings — so under workers=4 a sibling spec's tenant binding can
        // inflate the page count. Derive the TRUE expected counts from the live
        // resolver instead of hard-coding 2→1, and build the exact rendered copy
        // ("N active binding" singular / "N active bindings" plural, matching the
        // component's `rows.length === 1 ? '' : 's'`). Intent is preserved: the
        // count is exactly right and drops by exactly one when a binding is removed.
        const countCopy = (n: number) =>
            new RegExp(`(?<!\\d)${n} active binding${n === 1 ? '(?!s)' : 's'}`, 'i');
        const before = await listAgentSkills(request, access_token, agent.id);
        const beforeCount = before.length; // ≥ 2: our keep + drop, plus any leaked tenant bindings
        expect(before.map((r) => r.skill.id)).toContain(keep.id);
        expect(before.map((r) => r.skill.id)).toContain(drop.id);

        await page.goto(`/agents/${agent.id}/skills`, { waitUntil: 'domcontentloaded' });

        // Both rows + the count are visible.
        await expect(page.getByText(keepTitle).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(dropTitle).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(countCopy(beforeCount)).first()).toBeVisible({
            timeout: 30_000,
        });

        // Find the article row for the skill we want to drop and click its
        // Remove button. The row is the <article> containing the drop title.
        const dropRow = page.locator('article').filter({ hasText: dropTitle }).first();
        await expect(dropRow).toBeVisible({ timeout: 30_000 });
        const removeBtn = dropRow.getByRole('button', { name: /remove/i });

        // Retry-to-click: dev hydration can swallow the first click before the
        // transition handler is wired up.
        await expect(async () => {
            await removeBtn.click({ timeout: 5_000 }).catch(() => {});
            await expect(page.getByText(dropTitle)).toHaveCount(0, { timeout: 5_000 });
        }).toPass({ timeout: 30_000 });

        // The kept skill remains and the count drops by exactly one.
        await expect(page.getByText(keepTitle).first()).toBeVisible();
        await expect(page.getByText(countCopy(beforeCount - 1)).first()).toBeVisible({
            timeout: 30_000,
        });

        // API agrees: the dropped binding is gone and the kept one survives
        // (the list may still carry leaked tenant-scoped bindings for this user).
        const resolved = await listAgentSkills(request, access_token, agent.id);
        const resolvedIds = resolved.map((r) => r.skill.id);
        expect(resolvedIds).toContain(keep.id);
        expect(resolvedIds).not.toContain(drop.id);
    });
});
