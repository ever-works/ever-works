import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * sec-pin: Skill-binding scoping (EW-710 Wave L #40/#41 —
 * packages/agent skills service + skill-binding repository).
 *
 * Wave L #40 made SkillsService.listBindings defense-in-depth: besides the
 * getOne() skill-ownership gate, the repository lookup is now
 * findBySkillId(skillId, userId) — userId enforced in the WHERE clause, so
 * binding rows (which carry targetType/targetId of the owner's Agents and
 * Works) can never leak cross-user even if the front gate were refactored
 * away. Wave L #41 made removeBinding TOCTOU-proof: the findByIdAndUser
 * guard is followed by an ownership-scoped deleteByIdAndUser (userId in the
 * DELETE's WHERE clause), so a foreign binding id can never be destroyed.
 *
 * NON-DUPLICATION — already pinned elsewhere, NOT re-pinned here:
 *   - flow-agent-skills-binding.spec.ts: bind→resolve→unbind lifecycle seen
 *     through GET /api/agents/:id/skills (priority order, dedup, opt-out);
 *     repeat-delete → bare 404 STATUS; cross-user delete/bind/read → bare
 *     status checks.
 *   - flow-skill-binding-permission.spec.ts: scope-resolution rules,
 *     foreign-TARGET binding → 404 "Skill target not found.", owner-side
 *     binding-write 400 guards (missing targetId / bogus targetType /
 *     duplicate 500), canEditSkills posture.
 *   - flow-idor-resource-access.spec.ts flow 5: parentless cross-user DELETE
 *     → 404 fingerprint-equal to a never-existed binding, owner delete still
 *     works afterwards.
 *   - flow-skill-bulk-operations.spec.ts / flow-scope-guard-forbidden-matrix
 *     .spec.ts: cross-user GET /api/skills/:id/bindings → bare 404 status.
 *   - flow-cross-tenant-leak-matrix.spec.ts: GET /api/skills/not-a-uuid →
 *     400 status; GET /api/skills/<unknown> → 404 status.
 *   This file pins the COMPLEMENTARY surface: exact 404 BODIES on both Wave L
 *   routes, the deleted/foreign/never-existed TRI-STATE indistinguishability,
 *   the victim's bindings-LIST intactness after a failed cross-delete, the
 *   exactly-one-row scoped delete, the binding row's exact FIELD SET +
 *   defaults, the validation→ownership→service GATE ORDERING asymmetry on
 *   POST bindings, the anonymous-401 surface (incl. guard-before-pipe), the
 *   400/404 malformed-vs-unknown boundary on the bindings sub-routes, and
 *   the DELETE-only parentless route surface — none of which any existing
 *   spec asserts.
 *
 * PROBED CONTRACTS (live sqlite stack, 2026-06-11 — every assertion below
 * was observed via curl before being written):
 *   - POST /api/skills/:id/bindings {targetType:'tenant'} → 201 with exactly
 *     these 11 keys: id, skillId, targetType, targetId(null), userId(caller),
 *     injectIntoAgent(true), injectIntoGenerator(false), priority(100),
 *     tenantId, organizationId, createdAt. GET :id/bindings rows carry the
 *     SAME 11-key set — never the skill body/instructionsMd.
 *   - DELETE /api/skill-bindings/:id (owner) → 200 body EXACTLY
 *     {deleted:true}; repeat → 404 { message:"Skill binding <id> not
 *     found.", error:"Not Found", statusCode:404 }.
 *   - Cross-user DELETE, never-existed id, owner-deleted tombstone, and
 *     B-probing-a-tombstone all return that SAME id-redacted 404 body.
 *   - Cross-user GET /api/skills/:id/bindings → 404 { message:"Skill <id>
 *     not found.", … } — an OBJECT, never an empty array — byte-identical
 *     in shape to a never-existed skill id.
 *   - POST bindings gate order: DTO validation → skill ownership → service
 *     rules. B posting {targetType:'bogus'} onto A's REAL skill → 400 (the
 *     IDENTICAL class-validator body the owner gets — no disclosure);
 *     B posting {targetType:'work'} (no targetId — a SERVICE-level rule) →
 *     404 skill-gate; the OWNER posting the same body → 400 "targetId is
 *     required when targetType=work.".
 *   - Anonymous GET/POST /api/skills/:id/bindings + DELETE
 *     /api/skill-bindings/:id → 401 { message:"Unauthorized",
 *     statusCode:401 }; anonymous DELETE with a MALFORMED id is ALSO 401
 *     (auth guard precedes ParseUUIDPipe — id validity is not probeable
 *     anonymously).
 *   - Authenticated malformed ids: DELETE /api/skill-bindings/not-a-uuid and
 *     GET/POST /api/skills/not-a-uuid/bindings → 400 "Validation failed
 *     (uuid is expected)"; well-formed unknown ids → 404.
 *   - GET/PATCH/PUT /api/skill-bindings/:id → 404 "Cannot <METHOD>
 *     /api/skill-bindings/<id>" even for the OWNER: the parentless surface
 *     is DELETE-only — binding rows cannot be read, enumerated, or updated
 *     by id.
 *
 * Isolation: every test registers FRESH users via registerUserViaAPI and
 * uses unique timestamp-suffixed titles; nothing touches the seeded
 * storageState user. API-contract assertions only (no UI navigation).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Well-formed RFC-4122 v4 UUIDs that exist nowhere in the DB. */
const UNKNOWN_BINDING_UUID = 'c3b8a1d2-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const UNKNOWN_SKILL_UUID = 'd4c9b2e3-5f6a-4b7c-9d8e-1f2a3b4c5d6e';

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

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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

/** Redact embedded UUIDs so two error bodies can be fingerprint-compared. */
function fingerprint(body: ErrorBody): string {
    return JSON.stringify(body).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '<uuid>',
    );
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
            description: 'sec-pin skills-scoping skill',
            instructionsMd: `# ${title}`,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function bindSkill(
    request: APIRequestContext,
    token: string,
    skillId: string,
    binding: { targetType: string; targetId?: string; priority?: number },
): Promise<BindingRow> {
    const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data: binding,
    });
    expect(res.status(), `bindSkill body=${await res.text().catch(() => '')}`).toBe(201);
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
    expect(res.status(), `listBindings body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('sec-pin: skill-binding scoping (Wave L #40 listBindings / #41 removeBinding)', () => {
    test('own-binding lifecycle: the created row carries the exact 11-key shape + defaults, lists once, deletes to {deleted:true}, re-delete 404s', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Lifecycle Skill ${stamp()}`);

        // ADD — the POST response is the full binding row with the probed
        // defaults: priority 100, injectIntoAgent true, injectIntoGenerator
        // false, userId stamped to the caller, tenant target ⇒ targetId null.
        const created = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'tenant',
        });
        expect(created.id).toMatch(UUID_RE);
        expect(created.skillId).toBe(skill.id);
        expect(created.targetType).toBe('tenant');
        expect(created.targetId).toBeNull();
        expect(created.userId).toBe(a.user.id);
        expect(created.injectIntoAgent).toBe(true);
        expect(created.injectIntoGenerator).toBe(false);
        expect(created.priority).toBe(100);
        expect(Object.keys(created).sort()).toEqual(BINDING_ROW_KEYS);

        // LIST — exactly one row, the SAME 11-key field set, and crucially no
        // skill body: binding rows never embed instructionsMd/title.
        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe(created.id);
        expect(Object.keys(listed[0]).sort()).toEqual(BINDING_ROW_KEYS);

        // REMOVE — the success body is EXACTLY {deleted:true}, nothing else.
        const del = await request.delete(`${API_BASE}/api/skill-bindings/${created.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);

        // IDEMPOTENT RE-REMOVE — a clean scoped 404 naming the binding.
        const again = await request.delete(`${API_BASE}/api/skill-bindings/${created.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(again.status()).toBe(404);
        expect((await again.json()) as ErrorBody).toEqual({
            message: `Skill binding ${created.id} not found.`,
            error: 'Not Found',
            statusCode: 404,
        });
    });

    test("Wave L #41 — user B removing user A's binding gets the exact opaque 404 and A's bindings list is untouched", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Victim Skill ${stamp()}`);
        const binding = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'tenant',
        });

        // B holds the REAL binding id — the delete still 404s with a body
        // that names the binding exactly like a never-existed one would.
        const cross = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(cross.status()).toBe(404);
        expect((await cross.json()) as ErrorBody).toEqual({
            message: `Skill binding ${binding.id} not found.`,
            error: 'Not Found',
            statusCode: 404,
        });

        // The ownership-scoped DELETE (userId in the WHERE clause) provably
        // removed ZERO rows: A's bindings list still holds the exact row.
        const after = await listBindings(request, a.access_token, skill.id);
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe(binding.id);
        expect(after[0].userId).toBe(a.user.id);
    });

    test('tri-state non-disclosure: foreign, never-existed, and owner-deleted binding ids are indistinguishable on DELETE', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Tristate Skill ${stamp()}`);
        const binding = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'tenant',
        });

        // State 1 — FOREIGN: B deletes A's live binding.
        const foreign = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(foreign.status()).toBe(404);
        const foreignBody = (await foreign.json()) as ErrorBody;

        // State 2 — NEVER-EXISTED: B deletes a UUID no row ever had.
        const unknown = await request.delete(
            `${API_BASE}/api/skill-bindings/${UNKNOWN_BINDING_UUID}`,
            { headers: authedHeaders(b.access_token) },
        );
        expect(unknown.status()).toBe(404);
        const unknownBody = (await unknown.json()) as ErrorBody;

        // State 3 — TOMBSTONE: A deletes for real, then re-deletes.
        const ownDel = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(ownDel.status()).toBe(200);
        const tombstone = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(tombstone.status()).toBe(404);
        const tombstoneBody = (await tombstone.json()) as ErrorBody;

        // And B probing the tombstoned id learns nothing post-deletion either.
        const foreignTombstone = await request.delete(
            `${API_BASE}/api/skill-bindings/${binding.id}`,
            { headers: authedHeaders(b.access_token) },
        );
        expect(foreignTombstone.status()).toBe(404);

        // Id-redacted bodies are byte-identical across all states: a prober
        // can never tell "someone else's" from "deleted" from "never was".
        const fp = fingerprint(foreignBody);
        expect(fp).toBe(fingerprint(unknownBody));
        expect(fp).toBe(fingerprint(tombstoneBody));
        expect(fp).toBe(fingerprint((await foreignTombstone.json()) as ErrorBody));
    });

    test("Wave L #40 — user B listing user A's bindings gets a skill-gate 404 OBJECT (never an empty array), identical to an unknown skill", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `ListGate Skill ${stamp()}`);
        await bindSkill(request, a.access_token, skill.id, { targetType: 'tenant' });

        // The cross-user list is a 404 at the SKILL gate — the answer to
        // "404 or empty?": it is a 404 error OBJECT, never [] (an empty array
        // would still disclose that the skill exists).
        const cross = await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(b.access_token),
        });
        expect(cross.status()).toBe(404);
        const crossBody = (await cross.json()) as ErrorBody;
        expect(Array.isArray(crossBody)).toBe(false);
        expect(crossBody).toEqual({
            message: `Skill ${skill.id} not found.`,
            error: 'Not Found',
            statusCode: 404,
        });

        // Fingerprint-equal to listing bindings of a NEVER-EXISTED skill id —
        // skill existence is not disclosed via the bindings list route.
        const unknown = await request.get(`${API_BASE}/api/skills/${UNKNOWN_SKILL_UUID}/bindings`, {
            headers: authedHeaders(b.access_token),
        });
        expect(unknown.status()).toBe(404);
        expect(fingerprint(crossBody)).toBe(fingerprint((await unknown.json()) as ErrorBody));

        // The owner still lists the row — the 404 above is ownership, not 404-route.
        expect(await listBindings(request, a.access_token, skill.id)).toHaveLength(1);
    });

    test('bindings lists are per-user disjoint even for same-titled skills, and every row is stamped with the caller userId', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const title = `Twin Skill ${stamp()}`;

        // Same human title on both sides (slugs collide by design cross-user).
        const skillA = await createSkill(request, a, title);
        const skillB = await createSkill(request, b, title);
        const bindingA = await bindSkill(request, a.access_token, skillA.id, {
            targetType: 'tenant',
        });
        const bindingB = await bindSkill(request, b.access_token, skillB.id, {
            targetType: 'tenant',
        });

        const listA = await listBindings(request, a.access_token, skillA.id);
        const listB = await listBindings(request, b.access_token, skillB.id);

        // Each owner sees exactly ONE row — their own — and the row's userId
        // (Wave L #40: userId is in the repository WHERE clause) is theirs.
        expect(listA.map((r) => r.id)).toEqual([bindingA.id]);
        expect(listB.map((r) => r.id)).toEqual([bindingB.id]);
        expect(listA[0].userId).toBe(a.user.id);
        expect(listB[0].userId).toBe(b.user.id);

        // Fully disjoint row sets despite identical titles/slugs.
        expect(bindingA.id).not.toBe(bindingB.id);
        expect(listA.map((r) => r.id)).not.toContain(bindingB.id);
        expect(listB.map((r) => r.id)).not.toContain(bindingA.id);
    });

    test("ownership-scoped delete removes EXACTLY one row: B's cross-delete removes zero, A's delete leaves the sibling binding resolving", async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `TwoRows Skill ${stamp()}`);
        const agent = await createAgentViaAPI(request, a.access_token, {
            name: `TwoRows Agent ${stamp()}`,
            scope: 'tenant',
        });

        // Two bindings on ONE skill: tenant-wide (default priority 100) and
        // agent-direct (priority 5).
        const tenantBinding = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'tenant',
        });
        const agentBinding = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 5,
        });

        // B's cross-delete of the agent binding fails and removes NOTHING.
        const cross = await request.delete(`${API_BASE}/api/skill-bindings/${agentBinding.id}`, {
            headers: authedHeaders(b.access_token),
        });
        expect(cross.status()).toBe(404);
        const stillTwo = await listBindings(request, a.access_token, skill.id);
        expect(stillTwo.map((r) => r.id).sort()).toEqual(
            [tenantBinding.id, agentBinding.id].sort(),
        );

        // A's delete of the TENANT binding removes exactly that one row —
        // the WHERE-scoped delete never over-deletes the sibling.
        const del = await request.delete(`${API_BASE}/api/skill-bindings/${tenantBinding.id}`, {
            headers: authedHeaders(a.access_token),
        });
        expect(del.status()).toBe(200);
        const afterOwn = await listBindings(request, a.access_token, skill.id);
        expect(afterOwn.map((r) => r.id)).toEqual([agentBinding.id]);
        expect(afterOwn[0].priority).toBe(5);

        // And the surviving agent-direct binding still RESOLVES on the agent.
        const resolved = await request.get(`${API_BASE}/api/agents/${agent.id}/skills`, {
            headers: authedHeaders(a.access_token),
        });
        expect(resolved.status()).toBe(200);
        const rows = ((await resolved.json()) as { data: Array<{ bindingId: string }> }).data;
        expect(rows.map((r) => r.bindingId)).toEqual([agentBinding.id]);
    });

    test('POST bindings gate order: DTO 400 precedes the skill gate (no disclosure), but service-level rules run AFTER it (cross-user 404, owner 400)', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `GateOrder Skill ${stamp()}`);

        // (a) DTO-invalid body (bogus targetType) from B on A's REAL skill →
        // 400 from the global ValidationPipe, byte-identical to the 400 the
        // OWNER gets: validation fires before ownership, so the response
        // discloses nothing about the skill's existence.
        const bBogus = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(b.access_token),
            data: { targetType: 'bogus' },
        });
        expect(bBogus.status()).toBe(400);
        const bBogusBody = (await bBogus.json()) as ErrorBody;
        expect(Array.isArray(bBogusBody.message)).toBe(true);
        expect(JSON.stringify(bBogusBody.message)).toMatch(
            /targetType must be one of the following values/i,
        );

        const ownerBogus = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(a.access_token),
            data: { targetType: 'bogus' },
        });
        expect(ownerBogus.status()).toBe(400);
        expect((await ownerBogus.json()) as ErrorBody).toEqual(bBogusBody);

        // (b) DTO-VALID but SERVICE-invalid body (work target, no targetId —
        // that rule lives in SkillsService AFTER the getOne ownership gate):
        // B now hits the skill gate first → 404 "Skill <id> not found.",
        // learning nothing about which rule he tripped…
        const bNoTarget = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(b.access_token),
            data: { targetType: 'work' },
        });
        expect(bNoTarget.status()).toBe(404);
        expect(((await bNoTarget.json()) as ErrorBody).message).toBe(
            `Skill ${skill.id} not found.`,
        );

        // …while the OWNER with the identical body reaches the service rule
        // and gets its truthful 400. The asymmetry proves the gate ordering.
        const ownerNoTarget = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(a.access_token),
            data: { targetType: 'work' },
        });
        expect(ownerNoTarget.status()).toBe(400);
        expect((await ownerNoTarget.json()) as ErrorBody).toEqual({
            message: 'targetId is required when targetType=work.',
            error: 'Bad Request',
            statusCode: 400,
        });

        // None of the rejected writes persisted anything.
        expect(await listBindings(request, a.access_token, skill.id)).toEqual([]);
    });

    test('the whole binding surface demands a bearer: anonymous GET/POST/DELETE are uniform 401s, and auth precedes id validation', async ({
        request,
    }) => {
        // The API authenticates by Authorization header only, so requests
        // without a bearer are anonymous even under the storageState project.
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `Anon Skill ${stamp()}`);
        const binding = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'tenant',
        });

        const anonList = await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`);
        expect(anonList.status()).toBe(401);
        expect((await anonList.json()) as ErrorBody).toEqual({
            message: 'Unauthorized',
            statusCode: 401,
        });

        const anonBind = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            data: { targetType: 'tenant' },
        });
        expect(anonBind.status()).toBe(401);

        const anonDelete = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`);
        expect(anonDelete.status()).toBe(401);

        // Guard-before-pipe: an anonymous DELETE with a MALFORMED id is 401,
        // NOT the ParseUUIDPipe 400 — id validity cannot be probed without a
        // bearer (and the auth wall leaks nothing about the id space).
        const anonMalformed = await request.delete(`${API_BASE}/api/skill-bindings/not-a-uuid`);
        expect(anonMalformed.status()).toBe(401);
        expect(((await anonMalformed.json()) as ErrorBody).message).toBe('Unauthorized');

        // The binding survived every anonymous probe.
        expect((await listBindings(request, a.access_token, skill.id)).map((r) => r.id)).toEqual([
            binding.id,
        ]);
    });

    test('malformed-vs-unknown id boundary on the bindings sub-routes: ParseUUIDPipe 400 with the canonical message, unknown UUID 404', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);

        // All three binding routes share the same ParseUUIDPipe rejection.
        const delMalformed = await request.delete(`${API_BASE}/api/skill-bindings/not-a-uuid`, {
            headers: authedHeaders(a.access_token),
        });
        expect(delMalformed.status()).toBe(400);
        expect((await delMalformed.json()) as ErrorBody).toEqual({
            message: 'Validation failed (uuid is expected)',
            error: 'Bad Request',
            statusCode: 400,
        });

        const listMalformed = await request.get(`${API_BASE}/api/skills/not-a-uuid/bindings`, {
            headers: authedHeaders(a.access_token),
        });
        expect(listMalformed.status()).toBe(400);
        expect(((await listMalformed.json()) as ErrorBody).message).toBe(
            'Validation failed (uuid is expected)',
        );

        const postMalformed = await request.post(`${API_BASE}/api/skills/not-a-uuid/bindings`, {
            headers: authedHeaders(a.access_token),
            data: { targetType: 'tenant' },
        });
        expect(postMalformed.status()).toBe(400);
        expect(((await postMalformed.json()) as ErrorBody).message).toBe(
            'Validation failed (uuid is expected)',
        );

        // Well-formed but unknown ids cross the pipe and 404 at the gates —
        // the 400/404 boundary separates SYNTAX from EXISTENCE, and neither
        // side reveals whether a foreign row sits behind the id.
        const delUnknown = await request.delete(
            `${API_BASE}/api/skill-bindings/${UNKNOWN_BINDING_UUID}`,
            { headers: authedHeaders(a.access_token) },
        );
        expect(delUnknown.status()).toBe(404);

        const listUnknown = await request.get(
            `${API_BASE}/api/skills/${UNKNOWN_SKILL_UUID}/bindings`,
            { headers: authedHeaders(a.access_token) },
        );
        expect(listUnknown.status()).toBe(404);
    });

    test('the parentless /api/skill-bindings/:id surface is DELETE-only: GET/PATCH/PUT are absent routes even for the owner', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const skill = await createSkill(request, a, `RouteSurface Skill ${stamp()}`);
        const binding = await bindSkill(request, a.access_token, skill.id, {
            targetType: 'tenant',
        });
        const url = `${API_BASE}/api/skill-bindings/${binding.id}`;
        const headers = authedHeaders(a.access_token);

        // Binding rows can never be READ back by id — no enumeration surface.
        const get = await request.get(url, { headers });
        expect(get.status()).toBe(404);
        expect((await get.json()) as ErrorBody).toEqual({
            message: `Cannot GET /api/skill-bindings/${binding.id}`,
            error: 'Not Found',
            statusCode: 404,
        });

        // …and never UPDATED by id (no priority/flag tampering route).
        const patch = await request.patch(url, { headers, data: { priority: 1 } });
        expect(patch.status()).toBe(404);
        expect(((await patch.json()) as ErrorBody).message).toBe(
            `Cannot PATCH /api/skill-bindings/${binding.id}`,
        );

        const put = await request.put(url, { headers, data: { priority: 1 } });
        expect(put.status()).toBe(404);
        expect(((await put.json()) as ErrorBody).message).toBe(
            `Cannot PUT /api/skill-bindings/${binding.id}`,
        );

        // The probes changed nothing: the row is intact with its defaults…
        const listed = await listBindings(request, a.access_token, skill.id);
        expect(listed.map((r) => r.id)).toEqual([binding.id]);
        expect(listed[0].priority).toBe(100);

        // …and the ONE verb that does exist still works.
        const del = await request.delete(url, { headers });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
    });
});
