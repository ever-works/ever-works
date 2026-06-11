import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    registerUserViaAPI,
    createWorkViaAPI,
    type RegisteredUser,
} from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Skill bindings — DEEP per-skill bindings-list lifecycle + filtering + DTO.
 *
 * The skill-bindings surface is:
 *   POST   /api/skills/:id/bindings   → 201 binding row
 *   GET    /api/skills/:id/bindings   → SkillBinding[] (per-skill, userId-scoped)
 *   DELETE /api/skill-bindings/:id    → 200 { deleted:true }
 * There is NO PATCH/PUT — "rebind/update" is delete-then-recreate.
 *
 * NON-DUPLICATION — these existing specs already pin a DIFFERENT slice, so
 * this file deliberately does NOT re-pin them:
 *   - sec-pin-skills-scoping.spec.ts (Batch 1): the SECURITY edges — exact 404
 *     bodies on both Wave-L routes, the foreign/never-existed/tombstone TRI-
 *     STATE non-disclosure, cross-user list-gate 404 vs empty-array, the gate-
 *     ORDER asymmetry on POST, anon-401 surface, malformed-vs-unknown id, the
 *     DELETE-only parentless route. We do NOT re-pin the cross-user 404s.
 *   - flow-skill-agent-binding-deep.spec.ts / flow-agent-skills-binding.spec.ts
 *     / flow-skill-binding-permission.spec.ts: the AGENT-RESOLVER projection
 *     (GET /api/agents/:id/skills — priority ASC, dedup-by-skillId, failover,
 *     injectIntoAgent filter, work/mission scope joins, live version
 *     propagation, canEditSkills posture). We assert through the per-skill
 *     BINDINGS LIST, never the agent resolver, and never re-pin dedup/priority
 *     ordering of the resolver.
 *   This file goes DEEPER on the happy-path lifecycle + filtering + DTO that
 *   none of the above pins: the per-skill bindings-LIST reflection of a
 *   bind/rebind/unbind across EACH target type (agent/work/mission/idea), the
 *   list filtered-by-skillId (two same-user skills stay disjoint), the binding
 *   DTO shape + defaults + bounds (priority 1..1000, boolean flags), the
 *   tenant-target targetId-nulling, the tenant-duplicate-ALLOWED vs
 *   work/agent-duplicate-500 unique-index asymmetry, the foreign-SKILL vs
 *   foreign-TARGET 404 message boundary, and the FK-cascade list teardown.
 *
 * PROBED CONTRACTS (live sqlite stack, 2026-06-11 — every assertion below was
 * observed via curl before being written):
 *   - POST /api/skills/:id/bindings → 201 with EXACTLY 11 keys: id, skillId,
 *     targetType, targetId, userId(=caller), injectIntoAgent, injectIntoGenerator,
 *     priority, tenantId(null), organizationId(null), createdAt. Defaults:
 *     priority 100, injectIntoAgent true, injectIntoGenerator false.
 *   - GET /api/skills/:id/bindings → a SkillBinding[] (raw array) of ONLY this
 *     skill's bindings, each row the SAME 11-key shape. Order is not sorted by
 *     priority (repository find() has no ORDER BY) → assert by set, not order.
 *   - targetType ∈ {tenant, agent, work, mission, idea}; agent/work/mission/idea
 *     bindings carry the supplied targetId; a `tenant` binding ALWAYS stores
 *     targetId:null even when an explicit targetId is supplied in the body
 *     (service forces it null) — injectIntoGenerator/priority still persist.
 *   - DELETE /api/skill-bindings/:id → 200 { deleted:true }; the row then
 *     disappears from GET :id/bindings.
 *   - tenant duplicate (targetId NULL) → 201 BOTH times (NULL≠NULL in the
 *     unique index) → the list holds two rows. work/agent duplicate (non-null
 *     targetId) → 500 { statusCode:500, message:"Internal server error" }
 *     (uq_skill_binding fires).
 *   - priority bounds (DTO @Min 1 @Max 1000 @IsInt): 0 → 400 "priority must not
 *     be less than 1"; 1001 → 400 "priority must not be greater than 1000";
 *     3.5 → 400 "priority must be an integer number".
 *   - injectIntoAgent/injectIntoGenerator (DTO @IsBoolean): a non-boolean →
 *     400 "<field> must be a boolean value".
 *   - Binding a NONEXISTENT skill → 404 "Skill <id> not found." (the SKILL
 *     gate). Binding a non-tenant target the caller does not own → 404 "Skill
 *     target not found." (the TARGET ownership gate). Distinct messages.
 *   - DELETE /api/skills/:id → 200 { deleted:true } FK-CASCADEs its bindings:
 *     GET that skill's /bindings → 404 (skill gone); a SIBLING skill's list is
 *     untouched.
 *
 * Isolation: every test registers FRESH users via registerUserViaAPI with
 * per-test-title unique suffixes; nothing touches the seeded storageState user.
 * API-contract assertions only (no UI navigation).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID no row in the DB ever has. */
const UNKNOWN_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** The exact 11-key field set of a binding row (POST response and list row). */
const BINDING_ROW_KEYS = [
    'createdAt',
    'id',
    'injectIntoAgent',
    'injectIntoGenerator',
    'organizationId',
    'priority',
    'skillId',
    'targetId',
    'targetType',
    'tenantId',
    'userId',
];

interface BindingRow {
    id: string;
    skillId: string;
    targetType: string;
    targetId: string | null;
    userId: string;
    injectIntoAgent: boolean;
    injectIntoGenerator: boolean;
    priority: number;
    tenantId: string | null;
    organizationId: string | null;
    createdAt: string;
}

interface ErrorBody {
    message: string | string[];
    error?: string;
    statusCode: number;
}

/** Per-test unique suffix derived from the test title (no module-scope clock). */
function suffix(testName: string): string {
    let h = 0;
    for (let i = 0; i < testName.length; i++) h = (h * 31 + testName.charCodeAt(i)) >>> 0;
    return `${h.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function createSkill(
    request: APIRequestContext,
    user: RegisteredUser,
    title: string,
): Promise<{ id: string; slug: string }> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(user.access_token),
        data: {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title,
            description: 'deep skill-bindings skill',
            instructionsMd: `# ${title}`,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function bindRaw(
    request: APIRequestContext,
    token: string,
    skillId: string,
    binding: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data: binding,
    });
}

async function bind(
    request: APIRequestContext,
    token: string,
    skillId: string,
    binding: Record<string, unknown>,
): Promise<BindingRow> {
    const res = await bindRaw(request, token, skillId, binding);
    expect(res.status(), `bind body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function listBindings(
    request: APIRequestContext,
    token: string,
    skillId: string,
): Promise<BindingRow[]> {
    const res = await request.get(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text().catch(() => '')}`).toBe(200);
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

test.describe('Skill bindings — deep per-skill list lifecycle + filtering + DTO', () => {
    // ── DTO shape + per-target list reflection ───────────────────────────

    test('the binding DTO response is the exact 11-key row with probed defaults (priority 100 / agent:true / generator:false)', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Shape Skill ${suffix('shape')}`);

        // No priority / no flags supplied → the documented defaults apply.
        const created = await bind(request, a.access_token, skill.id, { targetType: 'tenant' });

        expect(Object.keys(created).sort()).toEqual(BINDING_ROW_KEYS);
        expect(created.id).toMatch(UUID_RE);
        expect(created.skillId).toBe(skill.id);
        expect(created.userId).toBe(a.user.id);
        expect(created.targetType).toBe('tenant');
        expect(created.targetId).toBeNull();
        expect(created.priority).toBe(100);
        expect(created.injectIntoAgent).toBe(true);
        expect(created.injectIntoGenerator).toBe(false);
        expect(created.tenantId).toBeNull();
        expect(created.organizationId).toBeNull();
        expect(typeof created.createdAt).toBe('string');

        // The list row carries the IDENTICAL 11-key shape — never the skill
        // body/title/instructionsMd leaks into a binding row.
        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed).toHaveLength(1);
        expect(Object.keys(listed[0]).sort()).toEqual(BINDING_ROW_KEYS);
        expect(listed[0]).toEqual(created);
    });

    test('agent-target bind → the per-skill list reflects it scoped → unbind empties the list', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Agent Bind Skill ${suffix('agent')}`);
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Agent Bind ${suffix('agent')}`,
            scope: 'tenant',
        });

        // Pre-bind the list is an empty array (NOT a 404 for the owner).
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);

        const binding = await bind(request, a.access_token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 42,
        });
        expect(binding.targetType).toBe('agent');
        expect(binding.targetId).toBe(agent.id);

        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed.map((r) => r.id)).toEqual([binding.id]);
        expect(listed[0].targetType).toBe('agent');
        expect(listed[0].targetId).toBe(agent.id);
        expect(listed[0].priority).toBe(42);

        // Unbind → the list empties (and the success body is exactly {deleted:true}).
        const del = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);
    });

    test('work-target bind → the list row maps the exact work targetId; unbind removes only that row', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Work Bind Skill ${suffix('work')}`);
        const work = await createWorkViaAPI(request, a.access_token, {
            name: `Work Bind ${suffix('work')}`,
        });
        expect(work.id).toBeTruthy();

        const binding = await bind(request, a.access_token, skill.id, {
            targetType: 'work',
            targetId: work.id,
            priority: 15,
        });
        expect(binding.targetType).toBe('work');
        expect(binding.targetId).toBe(work.id);

        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            id: binding.id,
            targetType: 'work',
            targetId: work.id,
            priority: 15,
        });

        expect(await unbind(request, a.access_token, binding.id)).toBe(200);
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);
    });

    test('mission-target bind → the list row carries the mission targetId', async ({ request }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Mission Bind Skill ${suffix('mission')}`);
        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(a.access_token),
            data: {
                title: `Mission Bind ${suffix('mission')}`,
                description: 'd',
                type: 'one-shot',
            },
        });
        expect(missionRes.status(), `mission body=${await missionRes.text().catch(() => '')}`).toBe(
            201,
        );
        const mission = await missionRes.json();
        expect(mission.id).toBeTruthy();

        const binding = await bind(request, a.access_token, skill.id, {
            targetType: 'mission',
            targetId: mission.id,
            priority: 8,
        });
        expect(binding.targetType).toBe('mission');
        expect(binding.targetId).toBe(mission.id);

        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed.map((r) => ({ t: r.targetType, id: r.targetId }))).toEqual([
            { t: 'mission', id: mission.id },
        ]);
    });

    test('idea-target bind → the list row carries the idea (work-proposal) targetId', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Idea Bind Skill ${suffix('idea')}`);

        // An "Idea" is a work-proposal created via the user-manual +Add route.
        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers: authedHeaders(a.access_token),
            data: { title: `Idea Bind ${suffix('idea')}`, description: 'idea body for binding' },
        });
        expect(ideaRes.status(), `idea body=${await ideaRes.text().catch(() => '')}`).toBe(201);
        const idea = await ideaRes.json();
        expect(idea.id).toBeTruthy();

        const binding = await bind(request, a.access_token, skill.id, {
            targetType: 'idea',
            targetId: idea.id,
            priority: 33,
        });
        expect(binding.targetType).toBe('idea');
        expect(binding.targetId).toBe(idea.id);

        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed.map((r) => ({ t: r.targetType, id: r.targetId }))).toEqual([
            { t: 'idea', id: idea.id },
        ]);
    });

    // ── Filtering: list is per-skill (filtered by skillId implicitly) ────

    test('one skill bound at four targets (tenant/work/mission/agent) lists all four rows, each with the right targetType→targetId', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Multi Target Skill ${suffix('multi')}`);
        const work = await createWorkViaAPI(request, a.access_token, {
            name: `Multi Work ${suffix('multi')}`,
        });
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Multi Agent ${suffix('multi')}`,
            scope: 'tenant',
        });
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers: authedHeaders(a.access_token),
                data: {
                    title: `Multi Mission ${suffix('multi')}`,
                    description: 'd',
                    type: 'one-shot',
                },
            })
        ).json();

        const tenantBinding = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 10,
        });
        const workBinding = await bind(request, a.access_token, skill.id, {
            targetType: 'work',
            targetId: work.id,
            priority: 20,
        });
        const missionBinding = await bind(request, a.access_token, skill.id, {
            targetType: 'mission',
            targetId: mission.id,
            priority: 30,
        });
        const agentBinding = await bind(request, a.access_token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 40,
        });

        const listed = await listBindings(request, a.access_token, skill.id);
        // The list endpoint isn't priority-sorted (repository find has no ORDER
        // BY), so compare as sets.
        expect(listed).toHaveLength(4);
        expect(listed.map((r) => r.id).sort()).toEqual(
            [tenantBinding.id, workBinding.id, missionBinding.id, agentBinding.id].sort(),
        );
        const byType = new Map(listed.map((r) => [r.targetType, r.targetId]));
        expect(byType.get('tenant')).toBeNull();
        expect(byType.get('work')).toBe(work.id);
        expect(byType.get('mission')).toBe(mission.id);
        expect(byType.get('agent')).toBe(agent.id);
        // Every row is stamped to this skill and this caller.
        expect(listed.every((r) => r.skillId === skill.id)).toBe(true);
        expect(listed.every((r) => r.userId === a.user.id)).toBe(true);
    });

    test('the bindings list is filtered by skillId: two of the SAME user’s skills keep disjoint lists', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const s = suffix('filter');
        const skillX = await createSkill(request, a, `Filter Skill X ${s}`);
        const skillY = await createSkill(request, a, `Filter Skill Y ${s}`);
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Filter Agent ${s}`,
            scope: 'tenant',
        });

        // Two bindings on X, one on Y — all owned by the same user.
        const x1 = await bind(request, a.access_token, skillX.id, { targetType: 'tenant' });
        const x2 = await bind(request, a.access_token, skillX.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        const y1 = await bind(request, a.access_token, skillY.id, { targetType: 'tenant' });

        const listX = await listBindings(request, a.access_token, skillX.id);
        const listY = await listBindings(request, a.access_token, skillY.id);

        // X lists ONLY X's two; Y lists ONLY Y's one. No cross-bleed despite
        // shared ownership — the list is scoped by the path skillId.
        expect(listX.map((r) => r.id).sort()).toEqual([x1.id, x2.id].sort());
        expect(listY.map((r) => r.id)).toEqual([y1.id]);
        expect(listX.map((r) => r.id)).not.toContain(y1.id);
        expect(listY.map((r) => r.id)).not.toContain(x1.id);
        expect(listX.every((r) => r.skillId === skillX.id)).toBe(true);
        expect(listY.every((r) => r.skillId === skillY.id)).toBe(true);
    });

    // ── Rebind / update (delete + recreate; no PATCH route) ──────────────

    test('rebind = delete + recreate: the list reflects the new id + new priority + new flags, old id gone', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Rebind Skill ${suffix('rebind')}`);

        // Original binding at priority 100, generator-injection off.
        const first = await bind(request, a.access_token, skill.id, { targetType: 'tenant' });
        expect(first.priority).toBe(100);
        expect(first.injectIntoGenerator).toBe(false);
        expect((await listBindings(request, a.access_token, skill.id)).map((r) => r.id)).toEqual([
            first.id,
        ]);

        // "Update" the binding: there is no PATCH route, so unbind then re-bind
        // at a new priority with generator injection toggled on.
        expect(await unbind(request, a.access_token, first.id)).toBe(200);
        const second = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 7,
            injectIntoGenerator: true,
        });
        expect(second.id).not.toBe(first.id);

        // The list now reflects ONLY the new binding with the updated fields.
        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe(second.id);
        expect(listed[0].id).not.toBe(first.id);
        expect(listed[0].priority).toBe(7);
        expect(listed[0].injectIntoGenerator).toBe(true);

        // Re-deleting the now-stale original id is a clean 404.
        expect(await unbind(request, a.access_token, first.id)).toBe(404);
    });

    // ── tenant targetId nulling + duplicate-allowance asymmetry ──────────

    test('a tenant binding forces targetId to null even when an explicit targetId is supplied, but keeps priority + generator flag', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Tenant Null Skill ${suffix('tnull')}`);

        // Supply a (real, owned) targetId AND a tenant targetType: the service
        // stores targetId:null regardless, but the other supplied fields stick.
        const created = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            targetId: a.user.id,
            priority: 50,
            injectIntoGenerator: true,
        });
        expect(created.targetType).toBe('tenant');
        expect(created.targetId).toBeNull();
        expect(created.priority).toBe(50);
        expect(created.injectIntoGenerator).toBe(true);

        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed).toHaveLength(1);
        expect(listed[0].targetId).toBeNull();
        expect(listed[0].priority).toBe(50);
    });

    test('duplicate tenant bindings are ALLOWED (null targetId ≠ null in the unique index) — both 201, list holds two rows', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Tenant Dup Skill ${suffix('tdup')}`);

        const first = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 10,
        });
        const second = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 20,
        });
        expect(second.id).not.toBe(first.id);

        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed).toHaveLength(2);
        expect(listed.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
        // Both are tenant rows with a null targetId — the unique index does not
        // collapse them because NULL is never equal to NULL in SQL.
        expect(listed.every((r) => r.targetType === 'tenant' && r.targetId === null)).toBe(true);
        expect(listed.map((r) => r.priority).sort((x, y) => x - y)).toEqual([10, 20]);
    });

    test('duplicate non-tenant bindings hit the unique index: an identical work/agent binding 500s while the first survives', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `NonTenant Dup Skill ${suffix('ntdup')}`);
        const work = await createWorkViaAPI(request, a.access_token, {
            name: `Dup Work ${suffix('ntdup')}`,
        });
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `Dup Agent ${suffix('ntdup')}`,
            scope: 'tenant',
        });

        // First work binding succeeds.
        const workBinding = await bind(request, a.access_token, skill.id, {
            targetType: 'work',
            targetId: work.id,
        });
        // An IDENTICAL (skill+work+targetId) binding hits uq_skill_binding → raw 500.
        const dupWork = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'work',
            targetId: work.id,
        });
        expect(dupWork.status()).toBe(500);

        // Same asymmetry for an agent target.
        const agentBinding = await bind(request, a.access_token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        const dupAgent = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        expect(dupAgent.status()).toBe(500);

        // The failed dup writes persisted nothing extra: exactly the two
        // originals remain.
        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed.map((r) => r.id).sort()).toEqual([workBinding.id, agentBinding.id].sort());
    });

    // ── DTO validation bounds ────────────────────────────────────────────

    test('priority DTO bounds: 0 < min, 1001 > max, and a non-integer are each 400 with the canonical class-validator message', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Priority Bounds Skill ${suffix('prio')}`);

        const below = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 0,
        });
        expect(below.status()).toBe(400);
        expect(JSON.stringify(((await below.json()) as ErrorBody).message)).toMatch(
            /priority must not be less than 1/i,
        );

        const above = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 1001,
        });
        expect(above.status()).toBe(400);
        expect(JSON.stringify(((await above.json()) as ErrorBody).message)).toMatch(
            /priority must not be greater than 1000/i,
        );

        const fractional = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 3.5,
        });
        expect(fractional.status()).toBe(400);
        expect(JSON.stringify(((await fractional.json()) as ErrorBody).message)).toMatch(
            /priority must be an integer number/i,
        );

        // The boundary values 1 and 1000 ARE accepted (inclusive bounds).
        const minOk = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 1,
        });
        expect(minOk.priority).toBe(1);
        const maxOk = await bind(request, a.access_token, skill.id, {
            targetType: 'tenant',
            priority: 1000,
        });
        expect(maxOk.priority).toBe(1000);

        // None of the three rejected writes persisted; the two accepted did.
        expect((await listBindings(request, a.access_token, skill.id)).length).toBe(2);
    });

    test('the inject flags are strictly boolean: a non-boolean injectIntoAgent / injectIntoGenerator is 400', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Flag Bool Skill ${suffix('flag')}`);

        const badAgent = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'tenant',
            injectIntoAgent: 'yes',
        });
        expect(badAgent.status()).toBe(400);
        expect(JSON.stringify(((await badAgent.json()) as ErrorBody).message)).toMatch(
            /injectIntoAgent must be a boolean value/i,
        );

        const badGen = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'tenant',
            injectIntoGenerator: 3,
        });
        expect(badGen.status()).toBe(400);
        expect(JSON.stringify(((await badGen.json()) as ErrorBody).message)).toMatch(
            /injectIntoGenerator must be a boolean value/i,
        );

        // Both rejected — nothing persisted.
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);
    });

    // ── 404 boundary: foreign skill vs foreign target ───────────────────

    test('binding boundary: an unknown SKILL → 404 "Skill <id> not found", a foreign TARGET on a real skill → 404 "Skill target not found"', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Boundary Skill ${suffix('boundary')}`);

        // (a) Unknown skill id → the SKILL gate fires first, naming the skill.
        const unknownSkill = await bindRaw(request, a.access_token, UNKNOWN_UUID, {
            targetType: 'tenant',
        });
        expect(unknownSkill.status()).toBe(404);
        expect(((await unknownSkill.json()) as ErrorBody).message).toBe(
            `Skill ${UNKNOWN_UUID} not found.`,
        );

        // (b) Real owned skill, but a non-tenant target the caller does not own
        // → the TARGET ownership gate fires with a DISTINCT generic message
        // (no targetId echoed back — no existence probe of the target space).
        const foreignTarget = await bindRaw(request, a.access_token, skill.id, {
            targetType: 'work',
            targetId: UNKNOWN_UUID,
        });
        expect(foreignTarget.status()).toBe(404);
        expect(((await foreignTarget.json()) as ErrorBody).message).toBe('Skill target not found.');

        // The two 404s are genuinely different messages — the skill gate names
        // the id, the target gate stays opaque.
        expect(`Skill ${UNKNOWN_UUID} not found.`).not.toBe('Skill target not found.');

        // Neither rejected write left a row.
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);
    });

    // ── FK cascade ───────────────────────────────────────────────────────

    test('deleting the parent skill FK-cascades its bindings: the list 404s afterward, a sibling skill’s list is intact', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const s = suffix('cascade');
        const doomed = await createSkill(request, a, `Cascade Doomed Skill ${s}`);
        const sibling = await createSkill(request, a, `Cascade Sibling Skill ${s}`);
        const work = await createWorkViaAPI(request, a.access_token, {
            name: `Cascade Work ${s}`,
        });

        // The doomed skill carries two bindings; the sibling carries one.
        const doomedTenant = await bind(request, a.access_token, doomed.id, {
            targetType: 'tenant',
        });
        const doomedWork = await bind(request, a.access_token, doomed.id, {
            targetType: 'work',
            targetId: work.id,
        });
        const siblingBinding = await bind(request, a.access_token, sibling.id, {
            targetType: 'tenant',
        });
        expect(
            (await listBindings(request, a.access_token, doomed.id)).map((r) => r.id).sort(),
        ).toEqual([doomedTenant.id, doomedWork.id].sort());

        // Delete the parent skill → its bindings cascade away.
        const delSkill = await request.delete(`${API_BASE}/api/skills/${doomed.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(delSkill.status()).toBe(200);
        expect(await delSkill.json()).toEqual({ deleted: true });

        // The doomed skill's bindings list is now a 404 (the skill is gone, so
        // the skill-ownership gate in listBindings fails), NOT an empty array.
        const afterList = await request.get(`${API_BASE}/api/skills/${doomed.id}/bindings`, {
            headers: authedHeaders(a.access_token),
        });
        expect(afterList.status()).toBe(404);

        // The cascaded binding ids are truly gone — re-deleting either 404s.
        expect(await unbind(request, a.access_token, doomedTenant.id)).toBe(404);
        expect(await unbind(request, a.access_token, doomedWork.id)).toBe(404);

        // The sibling skill + its binding are completely untouched.
        const siblingList = await listBindings(request, a.access_token, sibling.id);
        expect(siblingList.map((r) => r.id)).toEqual([siblingBinding.id]);
    });
});
