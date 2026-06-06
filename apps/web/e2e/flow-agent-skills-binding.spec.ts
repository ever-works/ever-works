import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent + Skills binding — complex, multi-entity orchestration flows.
 *
 * A `Skill` is a reusable Markdown capability owned at a scope (ownerType =
 * tenant | mission | idea | work | agent). A `SkillBinding` attaches a Skill
 * to a *target* (agent | work | mission | idea | tenant). The agent-facing
 * read endpoint resolves the *active* set of skills for an Agent — joining
 * agent-direct bindings + the agent's tenant/mission/idea/work-scoped
 * bindings, sorted by priority ASC, deduped by skillId, and excluding
 * bindings flagged `injectIntoAgent:false`.
 *
 * API surface — ALL shapes verified against the live stack before asserting:
 *   - POST   /api/agents { scope, name, maxSkillContextTokens? }
 *       → 201 { id, slug, scope, status:'draft', maxSkillContextTokens, … }
 *   - GET    /api/agents/:id                  → includes maxSkillContextTokens
 *   - PATCH  /api/agents/:id { maxSkillContextTokens }  (DTO Min 0 / Max 20000)
 *   - GET    /api/agents/:id/skills
 *       → { data:[{ bindingId, priority, targetType, skill:{id,slug,title,version} }] }
 *         sorted priority ASC, deduped by skillId, injectIntoAgent:false excluded.
 *         Cross-user / unknown agent → 404.
 *   - POST   /api/skills { ownerType, ownerId, title, description, instructionsMd, frontmatter? }
 *       → 201 { id, slug, ownerType, ownerId, version:'1.0.0', sourceCatalogSlug:null, contentHash }
 *       ownerType ∈ {tenant,mission,idea,work,agent}; 'user' → 400 "Invalid ownerType".
 *   - GET    /api/skills?ownerType=&ownerId=&search=&limit=&offset=  → { data, meta:{total,limit,offset} }
 *   - GET/POST /api/skills/:id/bindings   (agent/work/mission/idea target requires targetId; tenant does not)
 *       → binding row { id, skillId, targetType, targetId, userId, injectIntoAgent, injectIntoGenerator, priority, … }
 *   - DELETE /api/skill-bindings/:id      → 200 { deleted:true }; repeat → 404; cross-user → 404.
 *
 * Notes / deviations:
 *   - There is no dedicated skill "type" column. The real "type" dimension is
 *     `ownerType` (the owner scope: tenant/mission/idea/work/agent), which is
 *     what flow #2 filters by; tag-style metadata lives in `frontmatter.tags`.
 *   - Creating a (skill+targetType+targetId) binding that already exists hits a
 *     UNIQUE index and 500s (no graceful conflict handler) — flows never
 *     re-create an identical binding.
 *   - These flows use FRESH API users for all API-only mutations (cross-spec
 *     isolation, unique emails) and the SEEDED user only for the UI assertion.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface BoundSkillRow {
    bindingId: string;
    priority: number;
    targetType: string;
    skill: { id: string; slug: string; title: string; version: string };
}

/**
 * Flatten a NestJS error body's `message` into a single searchable string.
 *
 * The API's global ValidationPipe (apps/api/src/main.ts) runs with the default
 * exception factory, so DTO validation failures (CreateSkillDto's
 * `@IsEnum(SKILL_OWNER_TYPES)` / `@IsUUID()` on ownerType/ownerId) surface as
 * `{ statusCode, error, message: string[] }` — `message` is an ARRAY of the
 * default class-validator strings, not a single custom sentence. Asserting on
 * the array directly (`.toMatch`) throws, so collapse it to one string first.
 */
function errorMessageText(body: unknown): string {
    const msg = (body as { message?: unknown })?.message;
    return Array.isArray(msg) ? msg.join(' ') : String(msg ?? '');
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
        frontmatter?: Record<string, unknown>;
    },
): Promise<{ id: string; slug: string; ownerType: string; ownerId: string; version: string }> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            description: 'e2e skill',
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
    },
): Promise<{ id: string; targetType: string; priority: number; injectIntoAgent: boolean }> {
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
    expect(res.status(), `listAgentSkills status`).toBe(200);
    return (await res.json()).data ?? [];
}

test.describe('Agent + Skills binding', () => {
    /**
     * Flow 1 — Full bind/unbind lifecycle across two entities.
     *
     * Create an agent + a tenant-scoped skill → assert the agent has zero
     * bound skills → bind the skill to the agent → assert the agent now lists
     * exactly that skill (with the binding's priority/targetType + the skill's
     * slug/version) → unbind via DELETE /api/skill-bindings/:id → assert the
     * agent's skill list is empty again and a repeat delete 404s.
     */
    test('bind a skill to an agent, agent lists it, then unbind removes it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const agent = await createAgentViaAPI(request, token, {
            name: `Binder Agent ${Date.now().toString(36)}`,
            scope: 'tenant',
        });
        expect(agent.status).toBe('draft');

        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Review Checklist ${Date.now().toString(36)}`,
        });
        expect(skill.version).toBe('1.0.0');

        // Pre-bind: the agent resolves no skills.
        expect(await listAgentSkills(request, token, agent.id)).toEqual([]);

        // Bind skill → agent (agent target requires a targetId).
        const binding = await bindSkill(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 42,
        });
        expect(binding.targetType).toBe('agent');
        expect(binding.priority).toBe(42);
        expect(binding.injectIntoAgent).toBe(true);

        // Agent now lists exactly the bound skill, surfacing both the binding
        // metadata and the joined skill identity.
        const bound = await listAgentSkills(request, token, agent.id);
        expect(bound).toHaveLength(1);
        expect(bound[0]).toMatchObject({
            bindingId: binding.id,
            priority: 42,
            targetType: 'agent',
            skill: { id: skill.id, slug: skill.slug, version: '1.0.0' },
        });

        // The skill's own bindings list mirrors the same row.
        const skillBindings = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(skillBindings.map((b: { id: string }) => b.id)).toContain(binding.id);

        // Unbind via the standalone binding endpoint.
        const del = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toMatchObject({ deleted: true });

        // Gone: agent resolves no skills again.
        expect(await listAgentSkills(request, token, agent.id)).toEqual([]);

        // Repeat delete is a clean 404 (binding no longer exists).
        const delAgain = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(token),
        });
        expect(delAgain.status()).toBe(404);
    });

    /**
     * Flow 2 — Skill scoping: create skills at multiple owner scopes, assert
     * scope/owner-type validation, and filter the skills list by scope
     * (ownerType) + owner id. Then prove a mission-scoped skill resolves onto
     * an agent in that mission via a mission-target binding.
     */
    test('skills are created at distinct scopes, validated, and filtered by ownerType/ownerId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        // A mission + an agent scoped to that mission (mission is the ownerId
        // for a mission-scoped skill; the agent is the ownerId for an
        // agent-scoped skill).
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers: authedHeaders(token),
                data: { title: `Scope Mission ${stamp}`, description: 'd', type: 'one-shot' },
            })
        ).json();
        expect(mission.id).toBeTruthy();

        const agent = await createAgentViaAPI(request, token, {
            name: `Scope Agent ${stamp}`,
            scope: 'mission',
            missionId: mission.id,
        });
        expect(agent.scope).toBe('mission');

        // Three skills at three different scopes (= "types").
        const tenantSkill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Tenant Skill ${stamp}`,
            frontmatter: {
                name: `tenant-skill-${stamp}`,
                description: 'd',
                tags: ['review', 'qa'],
            },
        });
        expect(tenantSkill.ownerType).toBe('tenant');

        const missionSkill = await createSkill(request, token, {
            ownerType: 'mission',
            ownerId: mission.id,
            title: `Mission Skill ${stamp}`,
        });
        expect(missionSkill.ownerType).toBe('mission');
        expect(missionSkill.ownerId).toBe(mission.id);

        const agentSkill = await createSkill(request, token, {
            ownerType: 'agent',
            ownerId: agent.id,
            title: `Agent Note ${stamp}`,
        });
        expect(agentSkill.ownerType).toBe('agent');
        expect(agentSkill.ownerId).toBe(agent.id);

        // Scope/owner validation: a non-lattice ownerType is rejected, and a
        // missing ownerId is rejected — both 400 via the DTO's class-validator
        // constraints (CreateSkillDto `@IsEnum(SKILL_OWNER_TYPES)` /
        // `@IsUUID()`). 'user' is not in the {tenant,mission,idea,work,agent}
        // lattice, so the ValidationPipe rejects ownerType before the service
        // ever runs — the default message names the offending `ownerType`
        // field + its enum constraint (not a custom "invalid ownerType"
        // sentence).
        const badType = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'user',
                ownerId: user.user.id,
                title: 'Bad Scope',
                description: 'd',
                instructionsMd: '# x',
            },
        });
        expect(badType.status()).toBe(400);
        expect(errorMessageText(await badType.json())).toMatch(
            /ownerType must be one of the following values/i,
        );

        // ownerId is a required `@IsUUID()` field; omitting it fails that
        // constraint, so the default message names `ownerId` (not a custom
        // "ownerId is required" sentence).
        const noOwner = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'tenant',
                title: 'No Owner',
                description: 'd',
                instructionsMd: '# x',
            },
        });
        expect(noOwner.status()).toBe(400);
        expect(errorMessageText(await noOwner.json())).toMatch(/ownerId must be a uuid/i);

        // The list endpoint rejects an unknown ownerType filter the same way.
        const badFilter = await request.get(`${API_BASE}/api/skills?ownerType=bogus`, {
            headers: authedHeaders(token),
        });
        expect(badFilter.status()).toBe(400);

        // Filter by scope (ownerType). Each scope yields only its own skills.
        const all = await (
            await request.get(`${API_BASE}/api/skills`, { headers: authedHeaders(token) })
        ).json();
        expect(all.meta.total).toBe(3);

        const tenantOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=tenant`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(tenantOnly.data.every((s: { ownerType: string }) => s.ownerType === 'tenant')).toBe(
            true,
        );
        expect(tenantOnly.data.map((s: { id: string }) => s.id)).toContain(tenantSkill.id);

        const missionOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=mission`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(missionOnly.data.map((s: { id: string }) => s.id)).toEqual([missionSkill.id]);

        // Filter by ownerType + ownerId (the agent's private note only).
        const agentScoped = await (
            await request.get(`${API_BASE}/api/skills?ownerType=agent&ownerId=${agent.id}`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(agentScoped.data.map((s: { id: string }) => s.id)).toEqual([agentSkill.id]);

        // Search narrows by title token (independent of scope).
        const searched = await (
            await request.get(`${API_BASE}/api/skills?search=Mission%20Skill%20${stamp}`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(searched.data.map((s: { id: string }) => s.id)).toEqual([missionSkill.id]);

        // Cross-scope resolution: bind the agent-scoped skill directly to the
        // agent, and the mission-scoped skill to the mission. The agent (a
        // member of that mission) resolves BOTH.
        await bindSkill(request, token, agentSkill.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        await bindSkill(request, token, missionSkill.id, {
            targetType: 'mission',
            targetId: mission.id,
        });
        const resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved.map((r) => r.targetType).sort()).toEqual(['agent', 'mission']);
        expect(resolved.map((r) => r.skill.id).sort()).toEqual(
            [agentSkill.id, missionSkill.id].sort(),
        );
    });

    /**
     * Flow 3 — maxSkillContextTokens + multi-binding interplay, plus
     * cross-user isolation. Set/patch the agent's token budget, bind several
     * skills at varying priorities/scopes, assert the resolved set is
     * priority-ordered + dedup-correct + excludes opt-out bindings, then prove
     * another user cannot see or mutate any of it.
     */
    test('agent token budget + multi-skill bindings resolve in priority order, isolated per user', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceToken = alice.access_token;
        const stamp = Date.now().toString(36);

        // Agent created WITH a skill-context token budget; verified on read.
        const agent = await createAgentViaAPI(request, aliceToken, {
            name: `Context Agent ${stamp}`,
            scope: 'tenant',
        });
        const patchTokens = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(aliceToken),
            data: { maxSkillContextTokens: 4096 },
        });
        expect(patchTokens.status()).toBe(200);
        expect((await patchTokens.json()).maxSkillContextTokens).toBe(4096);

        // Over-budget value is rejected by the DTO (Max 20000).
        const overMax = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(aliceToken),
            data: { maxSkillContextTokens: 99999 },
        });
        expect(overMax.status()).toBe(400);
        // The previous valid value is preserved.
        const reread = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(aliceToken),
        });
        expect((await reread.json()).maxSkillContextTokens).toBe(4096);

        // Three tenant-scoped skills: two bound to the agent (priorities 5 and
        // 10), one bound tenant-wide (priority 100). All three resolve onto the
        // agent. Priority is lower-is-higher, so order is [5, 10, 100].
        const skillHi = await createSkill(request, aliceToken, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Hi Priority ${stamp}`,
        });
        const skillMid = await createSkill(request, aliceToken, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Mid Priority ${stamp}`,
        });
        const skillTenant = await createSkill(request, aliceToken, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Tenant Wide ${stamp}`,
        });
        // A fourth skill whose binding opts OUT of agent injection — it must NOT
        // appear in the resolved set.
        const skillOptOut = await createSkill(request, aliceToken, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Opt Out ${stamp}`,
        });

        await bindSkill(request, aliceToken, skillMid.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 10,
        });
        await bindSkill(request, aliceToken, skillHi.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 5,
        });
        await bindSkill(request, aliceToken, skillTenant.id, {
            targetType: 'tenant',
            priority: 100,
        });
        await bindSkill(request, aliceToken, skillOptOut.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 1,
            injectIntoAgent: false,
        });

        const resolved = await listAgentSkills(request, aliceToken, agent.id);
        // Exactly the three injected skills, in priority-ascending order.
        expect(resolved.map((r) => r.skill.id)).toEqual([skillHi.id, skillMid.id, skillTenant.id]);
        expect(resolved.map((r) => r.priority)).toEqual([5, 10, 100]);
        expect(resolved.map((r) => r.targetType)).toEqual(['agent', 'agent', 'tenant']);
        // The opt-out skill is excluded despite its top priority.
        expect(resolved.map((r) => r.skill.id)).not.toContain(skillOptOut.id);

        // Cross-user isolation — Bob (a separate registered user) cannot:
        //  (a) read Alice's agent's skills,
        const bobOnAgent = await request.get(`${API_BASE}/api/agents/${agent.id}/skills`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobOnAgent.status()).toBe(404);

        //  (b) read Alice's skill,
        const bobOnSkill = await request.get(`${API_BASE}/api/skills/${skillHi.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([403, 404]).toContain(bobOnSkill.status());

        //  (c) bind a target onto Alice's skill,
        const bobBind = await request.post(`${API_BASE}/api/skills/${skillHi.id}/bindings`, {
            headers: authedHeaders(bob.access_token),
            data: { targetType: 'tenant' },
        });
        expect([403, 404]).toContain(bobBind.status());

        //  (d) delete one of Alice's bindings.
        const aliceBindings = await (
            await request.get(`${API_BASE}/api/skills/${skillHi.id}/bindings`, {
                headers: authedHeaders(aliceToken),
            })
        ).json();
        const bobDelete = await request.delete(
            `${API_BASE}/api/skill-bindings/${aliceBindings[0].id}`,
            { headers: authedHeaders(bob.access_token) },
        );
        expect(bobDelete.status()).toBe(404);

        // Alice's resolved set is unchanged after Bob's failed attempts.
        const stillResolved = await listAgentSkills(request, aliceToken, agent.id);
        expect(stillResolved.map((r) => r.skill.id)).toEqual([
            skillHi.id,
            skillMid.id,
            skillTenant.id,
        ]);

        // Unknown agent id → 404 (no existence leak).
        const unknown = await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}/skills`, {
            headers: authedHeaders(aliceToken),
        });
        expect(unknown.status()).toBe(404);
    });

    /**
     * Flow 4 — UI surface: a skill bound to the SEEDED user's agent renders on
     * the per-agent Skills page (/agents/:id/skills), and the empty-state copy
     * shows when nothing is bound. Driven via the storageState session.
     */
    test('UI: per-agent Skills page reflects bound + unbound state for the seeded user', async ({
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

        // Two agents: one with a bound skill, one left empty.
        const boundAgent = await createAgentViaAPI(request, access_token, {
            name: `UI Bound Agent ${stamp}`,
            scope: 'tenant',
        });
        const emptyAgent = await createAgentViaAPI(request, access_token, {
            name: `UI Empty Agent ${stamp}`,
            scope: 'tenant',
        });

        const skillTitle = `UI Bound Skill ${stamp}`;
        const skill = await createSkill(request, access_token, {
            ownerType: 'tenant',
            ownerId: user.id,
            title: skillTitle,
        });
        await bindSkill(request, access_token, skill.id, {
            targetType: 'agent',
            targetId: boundAgent.id,
            priority: 7,
        });

        // The bound agent's Skills page lists the skill title + active-binding count.
        await page.goto(`/agents/${boundAgent.id}/skills`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(skillTitle).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/active binding/i).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/priority\s*7/i).first()).toBeVisible({ timeout: 30_000 });

        // The empty agent shows the truthful empty-state copy.
        await page.goto(`/agents/${emptyAgent.id}/skills`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(/no skills bound yet/i).first()).toBeVisible({
            timeout: 30_000,
        });
    });
});
