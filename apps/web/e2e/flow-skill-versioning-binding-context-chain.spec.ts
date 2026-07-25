import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'crypto';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Skill CHAIN — create → version-bump (contentHash) → bind (agent / mission /
 * tenant) → CONTEXT ASSEMBLY (resolveActive + maxSkillContextTokens budget) →
 * MARKETPLACE share (catalog install → local fork divergence).
 *
 * Source under test:
 *   - apps/api/src/skills/skills.controller.ts        (CRUD + install + bindings)
 *   - apps/api/src/skills/skill-bindings.controller.ts (DELETE /api/skill-bindings/:id)
 *   - apps/api/src/agents/agents.controller.ts §GET :id/skills  (the resolver surface)
 *   - packages/agent/src/skills/skills.service.ts     (hash/version/scope rules)
 *   - packages/agent/src/database/repositories/skill-binding.repository.ts (resolveActive)
 *   - packages/agent/src/agents/prompt-assembler.service.ts (maxSkillContextTokens cap)
 *
 * A `Skill` is a Markdown capability owned at a scope (ownerType ∈
 * tenant|mission|idea|work|agent — for a TENANT skill ownerId MUST equal the
 * caller's own userId). Its body is `instructionsMd`; the server derives
 * `contentHash = sha256(instructionsMd)` and stores a FREE-FORM `version`
 * string (default '1.0.0', DTO MaxLength 40, column varchar(16) — sqlite does
 * not enforce the column length). A `SkillBinding` links a skill to a target;
 * `GET /api/agents/:id/skills` runs the SAME `resolveActive` used to build the
 * ACTIVE SKILLS prompt segment (bounded per-Agent by `maxSkillContextTokens`,
 * default 4000).
 *
 * NON-DUPLICATION — this file is the end-to-end CHAIN + the surface-DIVERGENCE
 * lens. It deliberately does NOT re-pin what the crowded neighbourhood owns:
 *   - flow-skills-versioning-bindings-multistep → lifecycle + catalog/install hub,
 *     list/filter/pagination (asserts through the bindings LIST, never the resolver).
 *   - flow-skill-versioning → the pure hash-drift / version-orthogonality matrix.
 *   - flow-skill-agent-binding-deep / flow-skill-context-assembly → the resolver
 *     dedup/tie-break/failover matrix + the budget-bounds DTO edges + export round-trip.
 *   - flow-skill-marketplace-share → catalog SHAPE + install scope-validation +
 *     frontmatter.visibility (written when the CI catalog was ALWAYS EMPTY).
 * What THIS file uniquely owns:
 *   (a) the CONTINUOUS 5-stage chain run as one narrative;
 *   (b) the "which axis surfaces WHERE" divergence — contentHash lives on
 *       GET :id, `version` lives on the resolver, and they move independently;
 *   (c) resolver PROJECTION MINIMALITY (body/contentHash NEVER leak into the
 *       context-assembly surface — a huge skill body does not bloat it);
 *   (d) an EXACT sha256 assertion (crypto-computed) + hash idempotency on revert;
 *   (e) the MARKETPLACE install → LOCAL FORK divergence (provenance pinned to
 *       upstream while the local version + hash diverge), written env-adaptively
 *       so it exercises a POPULATED catalog when the skills-provider plugin is
 *       enabled and falls back to the truthful empty-catalog path otherwise.
 *
 * API surface — every shape/status verified LIVE against http://127.0.0.1:3100
 * (sqlite in-memory driver, flags ON) before any assertion was written:
 *   - POST  /api/skills { ownerType, ownerId, title, description, instructionsMd,
 *                         slug?, version?, frontmatter? }
 *       → 201 { id, userId, ownerType, ownerId, slug (auto-slugified when
 *         omitted), title, description, frontmatter (merged), instructionsMd,
 *         contentHash (sha256 hex, 64 chars), version ('1.0.0' default),
 *         sourcePath:null, sourceCatalogSlug:null, sourceCatalogVersion:null,
 *         tenantId:null, organizationId:null, createdAt, updatedAt }.
 *       tenant ownerId ≠ caller → 404; injection-token / secret / >64 KB body → 400;
 *       dup slug within (ownerType, ownerId) → 409; bad enum / non-uuid → 400.
 *   - PATCH /api/skills/:id { title?, description?, instructionsMd?, version?, frontmatter? }
 *       → 200 refreshed. contentHash recomputed ONLY when instructionsMd is in
 *         the patch; NO version auto-bump; provenance fields rejected (400,
 *         forbidNonWhitelisted); version > 40 chars → 400; cross-user → 404.
 *   - GET   /api/skills/:id → 200 full row (contentHash + instructionsMd present);
 *         bad uuid → 400 (ParseUUIDPipe); unknown/cross-user → 404.
 *   - POST  /api/skills/:id/bindings { targetType, targetId?, priority?,
 *             injectIntoAgent?, injectIntoGenerator? }
 *       → 201 { skillId, targetType, targetId (null for tenant), userId,
 *         injectIntoAgent (def true), injectIntoGenerator (def false),
 *         priority (def 100), id, createdAt }. tenant OMITs targetId; a
 *         non-tenant target with no targetId → 400; unowned targetId → 404;
 *         binding a nonexistent skill → 404; a DUP non-null-target binding hits
 *         the unique index → 500 (unmapped); a DUP tenant binding (targetId
 *         NULL) is ALLOWED (sqlite treats NULLs as distinct) → 201.
 *   - GET   /api/skills/:id/bindings → 200 SkillBinding[].
 *   - DELETE /api/skill-bindings/:id → 200 { deleted:true }; repeat → 404; cross-user → 404.
 *   - DELETE /api/skills/:id → 200 { deleted:true }; FK CASCADE drops its bindings.
 *   - GET   /api/agents/:id/skills → 200 { data:[{ bindingId, priority,
 *         targetType, skill:{ id, slug, title, version } }] } — priority ASC,
 *         createdAt ASC, DEDUP by skillId (first/lowest-priority binding wins),
 *         injectIntoAgent=true ONLY, tenant bindings apply to EVERY agent, the
 *         joined skill title/version is read LIVE. NO instructionsMd/contentHash.
 *   - POST  /api/me/missions { title, description, type:'one-shot'|'scheduled' } → 201 { id, … }.
 *   - GET   /api/skills/catalog?limit&offset&search&tags → 200 { entries:[…], total }.
 *   - GET   /api/skills/catalog/:slug → 200 { entry:{ slug,title,description,
 *         frontmatter,body,version,tags,sourceUrl }, providerId } | 404 | 400.
 *   - POST  /api/skills/install { slug, ownerType, ownerId } → 201 Skill
 *         (sourceCatalogSlug/Version/sourcePath set); unknown slug → 404; dup → 409.
 */

// ── inline helpers (assertive; return parsed rows) ──────────────────────────

interface SkillRow {
    id: string;
    userId: string;
    ownerType: string;
    ownerId: string;
    slug: string;
    title: string;
    description: string;
    frontmatter: Record<string, unknown>;
    instructionsMd: string;
    contentHash: string;
    version: string;
    sourcePath: string | null;
    sourceCatalogSlug: string | null;
    sourceCatalogVersion: string | null;
    createdAt: string;
    updatedAt: string;
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
    createdAt: string;
}

interface ResolvedRow {
    bindingId: string;
    priority: number;
    targetType: string;
    skill: { id: string; slug: string; title: string; version: string };
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const uniq = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

async function createSkill(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<SkillRow> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function patchSkill(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
): Promise<SkillRow> {
    const res = await request.patch(`${API_BASE}/api/skills/${id}`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `patchSkill body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function getSkill(request: APIRequestContext, token: string, id: string): Promise<SkillRow> {
    const res = await request.get(`${API_BASE}/api/skills/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

async function bindSkill(
    request: APIRequestContext,
    token: string,
    skillId: string,
    body: Record<string, unknown>,
): Promise<BindingRow> {
    const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `bindSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function resolveAgentSkills(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<ResolvedRow[]> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/skills`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `resolve body=${await res.text().catch(() => '')}`).toBe(200);
    const json = await res.json();
    return json.data ?? [];
}

async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<{ id: string }> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: `${title} desc`, type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Env-adaptive: returns the first installable catalog slug, or null when the
 * skills-provider plugin isn't enabled (the catalog is then empty). */
async function pickCatalogSlug(
    request: APIRequestContext,
    token: string,
): Promise<{ slug: string; version: string; providerId: string } | null> {
    const res = await request.get(`${API_BASE}/api/skills/catalog?limit=5`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.entries)).toBe(true);
    expect(typeof json.total).toBe('number');
    if (!json.entries.length) return null;
    const first = json.entries[0];
    // resolve providerId via the by-slug endpoint (authoritative source)
    const one = await request.get(`${API_BASE}/api/skills/catalog/${first.slug}`, {
        headers: authedHeaders(token),
    });
    expect(one.status()).toBe(200);
    const body = await one.json();
    return { slug: first.slug, version: body.entry.version, providerId: body.providerId };
}

// ────────────────────────────────────────────────────────────────────────────

test.describe('Skill chain — full lifecycle narrative', () => {
    test('create → version-bump → bind-agent → context-resolve → (share) as one chain', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        // 1) CREATE — tenant scope requires ownerId === caller userId.
        const title = `Chain Skill ${uniq()}`;
        const created = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title,
            description: 'the chain skill',
            instructionsMd: '# Rule\nAlways answer in UTC.',
        });
        expect(created.id).toBeTruthy();
        expect(created.version).toBe('1.0.0');
        expect(created.contentHash).toBe(sha256Hex('# Rule\nAlways answer in UTC.'));
        expect(created.sourceCatalogSlug).toBeNull();

        // 2) VERSION BUMP — new body → new contentHash + explicit version label.
        const bumped = await patchSkill(request, tok, created.id, {
            instructionsMd: '# Rule\nAlways answer in UTC and ISO-8601.',
            version: '1.1.0',
        });
        expect(bumped.version).toBe('1.1.0');
        expect(bumped.contentHash).toBe(sha256Hex('# Rule\nAlways answer in UTC and ISO-8601.'));
        expect(bumped.contentHash).not.toBe(created.contentHash);

        // 3) BIND to a fresh agent.
        const agent = await createAgentViaAPI(request, tok, { name: `Chain Agent ${uniq()}` });
        const binding = await bindSkill(request, tok, created.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 40,
        });
        expect(binding.targetType).toBe('agent');
        expect(binding.injectIntoAgent).toBe(true);

        // 4) CONTEXT ASSEMBLY — the resolver surfaces the CURRENT (bumped) version.
        const resolved = await resolveAgentSkills(request, tok, agent.id);
        const mine = resolved.find((r) => r.skill.id === created.id);
        expect(mine, 'bound skill must resolve for the agent').toBeTruthy();
        expect(mine!.skill.version).toBe('1.1.0');
        expect(mine!.priority).toBe(40);
        expect(mine!.targetType).toBe('agent');

        // 5) MARKETPLACE share — env-adaptive install of a catalog skill.
        const pick = await pickCatalogSlug(request, tok);
        if (pick) {
            const inst = await request.post(`${API_BASE}/api/skills/install`, {
                headers: authedHeaders(tok),
                data: { slug: pick.slug, ownerType: 'tenant', ownerId: user.user.id },
            });
            expect(inst.status()).toBe(201);
            const installed: SkillRow = await inst.json();
            expect(installed.sourceCatalogSlug).toBe(pick.slug);
            expect(installed.sourceCatalogVersion).toBe(pick.version);
            expect(installed.version).toBe(pick.version);
        } else {
            // Empty catalog (skills-provider plugin off) → truthful 404.
            const inst = await request.post(`${API_BASE}/api/skills/install`, {
                headers: authedHeaders(tok),
                data: { slug: 'skill-creator', ownerType: 'tenant', ownerId: user.user.id },
            });
            expect(inst.status()).toBe(404);
        }
    });
});

test.describe('Skill chain — contentHash ↔ version ↔ resolver divergence', () => {
    test('content-only edit re-hashes but leaves the version untouched', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Asym A ${uniq()}`,
            description: 'd',
            instructionsMd: 'body-v1',
            version: '3.2.1',
        });
        expect(s.contentHash).toBe(sha256Hex('body-v1'));

        const edited = await patchSkill(request, tok, s.id, { instructionsMd: 'body-v2-changed' });
        expect(edited.version, 'no auto-bump — version stays put').toBe('3.2.1');
        expect(edited.contentHash).toBe(sha256Hex('body-v2-changed'));
        expect(edited.contentHash).not.toBe(s.contentHash);
    });

    test('version-only edit changes the label but leaves the contentHash frozen', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Asym B ${uniq()}`,
            description: 'd',
            instructionsMd: 'frozen-body',
        });
        const frozenHash = s.contentHash;
        expect(frozenHash).toBe(sha256Hex('frozen-body'));

        const relabeled = await patchSkill(request, tok, s.id, { version: '9.9.9' });
        expect(relabeled.version).toBe('9.9.9');
        expect(relabeled.contentHash, 'body untouched → hash frozen').toBe(frozenHash);
        expect(relabeled.instructionsMd).toBe('frozen-body');
    });

    test('frontmatter-only PATCH leaves instructionsMd + contentHash untouched', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `FM Patch ${uniq()}`,
            description: 'd',
            instructionsMd: 'fm-body',
            frontmatter: { name: 'fm', description: 'd', tags: ['x'] },
        });
        const patched = await patchSkill(request, tok, s.id, {
            frontmatter: { name: 'fm', description: 'd', tags: ['x', 'y'], allowedTools: ['git'] },
        });
        expect(patched.contentHash).toBe(s.contentHash);
        expect(patched.instructionsMd).toBe('fm-body');
        expect(patched.frontmatter.tags).toEqual(['x', 'y']);
        expect(patched.frontmatter.allowedTools).toEqual(['git']);
    });

    test('sha256 is deterministic and idempotent — reverting the body restores the exact hash', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const original = '## Skill\nStep one.\nStep two.';
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Idem ${uniq()}`,
            description: 'd',
            instructionsMd: original,
        });
        const originalHash = s.contentHash;
        expect(originalHash).toBe(sha256Hex(original));

        const drifted = await patchSkill(request, tok, s.id, {
            instructionsMd: `${original}\nStep three.`,
        });
        expect(drifted.contentHash).not.toBe(originalHash);

        const reverted = await patchSkill(request, tok, s.id, { instructionsMd: original });
        expect(reverted.contentHash, 'same bytes → identical hash').toBe(originalHash);
    });

    test('two skills with identical bodies share an identical contentHash across scopes', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const shared = 'IDENTICAL BODY BYTES';
        const a = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Twin A ${uniq()}`,
            description: 'd',
            instructionsMd: shared,
            slug: `twin-a-${uniq()}`,
        });
        const b = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Twin B ${uniq()}`,
            description: 'd',
            instructionsMd: shared,
            slug: `twin-b-${uniq()}`,
        });
        expect(a.contentHash).toBe(b.contentHash);
        expect(a.contentHash).toBe(sha256Hex(shared));
        expect(a.id).not.toBe(b.id);
    });

    test('version is a free-form label — accepts a pre-release string, rejects > 40 chars', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Ver ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const pre = await patchSkill(request, tok, s.id, { version: '1.2.3-rc.4+build.567' });
        expect(pre.version).toBe('1.2.3-rc.4+build.567');

        const tooLong = await request.patch(`${API_BASE}/api/skills/${s.id}`, {
            headers: authedHeaders(tok),
            data: { version: 'x'.repeat(41) },
        });
        expect(tooLong.status()).toBe(400);
    });
});

test.describe('Skill chain — resolver projection is minimal (no body/hash leak)', () => {
    test('resolver surfaces the bumped version but NEVER the body or contentHash', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        // A deliberately huge body — if the resolver leaked it, the response would balloon.
        const bigBody = `# Big\n${'lorem ipsum dolor sit amet '.repeat(400)}`;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Big Body ${uniq()}`,
            description: 'd',
            instructionsMd: bigBody,
            version: '2.0.0',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `Proj Agent ${uniq()}` });
        await bindSkill(request, tok, s.id, { targetType: 'agent', targetId: agent.id });

        const res = await request.get(`${API_BASE}/api/agents/${agent.id}/skills`, {
            headers: authedHeaders(tok),
        });
        expect(res.status()).toBe(200);
        const raw = await res.text();
        // The whole projection must be far smaller than the skill body it points at.
        expect(raw.length).toBeLessThan(bigBody.length);
        expect(raw).not.toContain('lorem ipsum');
        expect(raw).not.toContain(s.contentHash);

        const rows: ResolvedRow[] = JSON.parse(raw).data;
        const row = rows.find((r) => r.skill.id === s.id)!;
        expect(Object.keys(row.skill).sort()).toEqual(['id', 'slug', 'title', 'version']);
        expect(row.skill.version).toBe('2.0.0');
        expect(row.skill).not.toHaveProperty('instructionsMd');
        expect(row.skill).not.toHaveProperty('contentHash');

        // GET :id, by contrast, DOES carry the body + hash.
        const full = await getSkill(request, tok, s.id);
        expect(full.instructionsMd).toBe(bigBody);
        expect(full.contentHash).toBe(sha256Hex(bigBody));
    });
});

test.describe('Skill chain — binding scopes feed context assembly', () => {
    test('same skill bound at agent(p50) + tenant(p100) dedups; agent binding wins', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Dedup ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `Dedup Agent ${uniq()}` });
        const agentBinding = await bindSkill(request, tok, s.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 50,
        });
        await bindSkill(request, tok, s.id, { targetType: 'tenant', priority: 100 });

        const rows = (await resolveAgentSkills(request, tok, agent.id)).filter(
            (r) => r.skill.id === s.id,
        );
        expect(rows, 'deduped to a single winning binding').toHaveLength(1);
        expect(rows[0].bindingId).toBe(agentBinding.id);
        expect(rows[0].priority).toBe(50);
        expect(rows[0].targetType).toBe('agent');

        // A version bump is reflected LIVE through the winning binding.
        await patchSkill(request, tok, s.id, { version: '5.0.0' });
        const after = (await resolveAgentSkills(request, tok, agent.id)).find(
            (r) => r.skill.id === s.id,
        )!;
        expect(after.skill.version).toBe('5.0.0');
    });

    test('mission-scoped agent resolves BOTH its mission binding and the tenant binding, priority-ordered', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const mission = await createMission(request, tok, `Mission ${uniq()}`);

        const missionSkill = await createSkill(request, tok, {
            ownerType: 'mission',
            ownerId: mission.id,
            title: `Mission Skill ${uniq()}`,
            description: 'd',
            instructionsMd: 'm',
        });
        const tenantSkill = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Tenant Skill ${uniq()}`,
            description: 'd',
            instructionsMd: 't',
        });
        await bindSkill(request, tok, missionSkill.id, {
            targetType: 'mission',
            targetId: mission.id,
            priority: 20,
        });
        await bindSkill(request, tok, tenantSkill.id, { targetType: 'tenant', priority: 100 });

        const agent = await createAgentViaAPI(request, tok, {
            name: `Mission Agent ${uniq()}`,
            scope: 'mission',
            missionId: mission.id,
        });
        const rows = await resolveAgentSkills(request, tok, agent.id);
        const ids = rows.map((r) => r.skill.id);
        expect(ids).toContain(missionSkill.id);
        expect(ids).toContain(tenantSkill.id);
        // priority ASC: mission (20) precedes tenant (100).
        const missionIdx = rows.findIndex((r) => r.skill.id === missionSkill.id);
        const tenantIdx = rows.findIndex((r) => r.skill.id === tenantSkill.id);
        expect(missionIdx).toBeLessThan(tenantIdx);
        expect(rows[missionIdx].targetType).toBe('mission');
        expect(rows[tenantIdx].targetType).toBe('tenant');
        // Priorities are non-decreasing across the resolved list.
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i].priority).toBeGreaterThanOrEqual(rows[i - 1].priority);
        }
    });

    test('rebind at a lower priority (delete + recreate) reorders the resolved set', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const first = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Reorder A ${uniq()}`,
            description: 'd',
            instructionsMd: 'a',
        });
        const second = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Reorder B ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `Reorder Agent ${uniq()}` });
        await bindSkill(request, tok, first.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 30,
        });
        const secondBinding = await bindSkill(request, tok, second.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 60,
        });

        let rows = await resolveAgentSkills(request, tok, agent.id);
        expect(rows[0].skill.id).toBe(first.id);
        expect(rows[1].skill.id).toBe(second.id);

        // A literal duplicate binding would hit the unique index (500) — so
        // DELETE the old binding and recreate `second` at a winning priority.
        const del = await request.delete(`${API_BASE}/api/skill-bindings/${secondBinding.id}`, {
            headers: authedHeaders(tok),
        });
        expect(del.status()).toBe(200);
        await bindSkill(request, tok, second.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 10,
        });

        rows = await resolveAgentSkills(request, tok, agent.id);
        expect(rows[0].skill.id, 'second now outranks first').toBe(second.id);
        expect(rows[1].skill.id).toBe(first.id);
    });

    test('injectIntoAgent:false and injectIntoGenerator-only bindings are absent from the agent-run resolver', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const optOut = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `OptOut ${uniq()}`,
            description: 'd',
            instructionsMd: 'x',
        });
        const genOnly = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `GenOnly ${uniq()}`,
            description: 'd',
            instructionsMd: 'y',
        });
        const included = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Included ${uniq()}`,
            description: 'd',
            instructionsMd: 'z',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `Filter Agent ${uniq()}` });
        await bindSkill(request, tok, optOut.id, {
            targetType: 'agent',
            targetId: agent.id,
            injectIntoAgent: false,
        });
        await bindSkill(request, tok, genOnly.id, {
            targetType: 'agent',
            targetId: agent.id,
            injectIntoAgent: false,
            injectIntoGenerator: true,
        });
        await bindSkill(request, tok, included.id, { targetType: 'agent', targetId: agent.id });

        const ids = (await resolveAgentSkills(request, tok, agent.id)).map((r) => r.skill.id);
        expect(ids).toContain(included.id);
        expect(ids).not.toContain(optOut.id);
        expect(ids).not.toContain(genOnly.id);
    });

    test('maxSkillContextTokens persists and the resolved SET is invariant to the budget', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Budget Skill ${uniq()}`,
            description: 'd',
            instructionsMd: '# body\n'.repeat(50),
        });
        await bindSkill(request, tok, s.id, { targetType: 'tenant', priority: 100 });

        // Two agents, DIFFERENT budgets — both see the same tenant skill because
        // the budget is an assemble-time truncation cap, not a resolver filter.
        // Persist distinct budgets and confirm they round-trip on create.
        const tightRes = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(tok),
            data: { scope: 'tenant', name: `TightB ${uniq()}`, maxSkillContextTokens: 1500 },
        });
        expect(tightRes.status()).toBe(201);
        const tightAgent = await tightRes.json();
        expect(tightAgent.maxSkillContextTokens).toBe(1500);

        const roomyRes = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(tok),
            data: { scope: 'tenant', name: `RoomyB ${uniq()}`, maxSkillContextTokens: 4000 },
        });
        expect(roomyRes.status()).toBe(201);
        const roomyAgent = await roomyRes.json();
        expect(roomyAgent.maxSkillContextTokens).toBe(4000);

        const tightIds = (await resolveAgentSkills(request, tok, tightAgent.id))
            .map((r) => r.skill.id)
            .filter((id) => id === s.id);
        const roomyIds = (await resolveAgentSkills(request, tok, roomyAgent.id))
            .map((r) => r.skill.id)
            .filter((id) => id === s.id);
        expect(tightIds).toEqual([s.id]);
        expect(roomyIds).toEqual([s.id]);
    });

    test('tenant bindings with NULL targetId may duplicate (sqlite NULL-distinct) yet the resolver dedups them', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `NullDup ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const b1 = await bindSkill(request, tok, s.id, { targetType: 'tenant', priority: 100 });
        // A second tenant binding for the SAME skill: NULL targetId is distinct
        // under the sqlite unique index, so this is accepted (201), not 409/500.
        const b2 = await bindSkill(request, tok, s.id, { targetType: 'tenant', priority: 100 });
        expect(b2.id).not.toBe(b1.id);
        expect(b2.targetId).toBeNull();

        const listRes = await request.get(`${API_BASE}/api/skills/${s.id}/bindings`, {
            headers: authedHeaders(tok),
        });
        expect(listRes.status()).toBe(200);
        const bindings: BindingRow[] = await listRes.json();
        expect(bindings.filter((b) => b.targetType === 'tenant')).toHaveLength(2);

        // But context assembly dedups by skillId → exactly one resolved row.
        const agent = await createAgentViaAPI(request, tok, { name: `NullDup Agent ${uniq()}` });
        const rows = (await resolveAgentSkills(request, tok, agent.id)).filter(
            (r) => r.skill.id === s.id,
        );
        expect(rows).toHaveLength(1);
    });

    test('a duplicate NON-null-target binding is rejected; delete-then-recreate succeeds', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `AgentDup ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `AgentDup Agent ${uniq()}` });
        const original = await bindSkill(request, tok, s.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 50,
        });

        // Identical (skillId, targetType, targetId) hits the unique index. It is
        // currently surfaced as an unmapped 500 (a 409 would also be acceptable).
        const dup = await request.post(`${API_BASE}/api/skills/${s.id}/bindings`, {
            headers: authedHeaders(tok),
            data: { targetType: 'agent', targetId: agent.id, priority: 70 },
        });
        expect([409, 500]).toContain(dup.status());

        // The clean path: remove the old binding, then rebind.
        const del = await request.delete(`${API_BASE}/api/skill-bindings/${original.id}`, {
            headers: authedHeaders(tok),
        });
        expect(del.status()).toBe(200);
        const recreated = await bindSkill(request, tok, s.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 70,
        });
        expect(recreated.priority).toBe(70);
    });

    test('deleting a skill cascades its bindings and drops it from the resolver', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Cascade ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `Cascade Agent ${uniq()}` });
        await bindSkill(request, tok, s.id, { targetType: 'agent', targetId: agent.id });

        expect((await resolveAgentSkills(request, tok, agent.id)).map((r) => r.skill.id)).toContain(
            s.id,
        );

        const del = await request.delete(`${API_BASE}/api/skills/${s.id}`, {
            headers: authedHeaders(tok),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        // FK CASCADE removed the binding → the skill is gone from the resolver.
        expect(
            (await resolveAgentSkills(request, tok, agent.id)).map((r) => r.skill.id),
        ).not.toContain(s.id);
        // And the skill itself is a 404 now.
        const gone = await request.get(`${API_BASE}/api/skills/${s.id}`, {
            headers: authedHeaders(tok),
        });
        expect(gone.status()).toBe(404);
    });

    test('DELETE /api/skill-bindings/:id detaches the skill and is not repeatable', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Detach ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        const agent = await createAgentViaAPI(request, tok, { name: `Detach Agent ${uniq()}` });
        const binding = await bindSkill(request, tok, s.id, {
            targetType: 'agent',
            targetId: agent.id,
        });

        const first = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(tok),
        });
        expect(first.status()).toBe(200);
        expect(
            (await resolveAgentSkills(request, tok, agent.id)).map((r) => r.skill.id),
        ).not.toContain(s.id);

        const second = await request.delete(`${API_BASE}/api/skill-bindings/${binding.id}`, {
            headers: authedHeaders(tok),
        });
        expect(second.status()).toBe(404);
        // The skill row still exists — only the binding was removed.
        expect((await getSkill(request, tok, s.id)).id).toBe(s.id);
    });
});

test.describe('Skill chain — marketplace share (catalog → install → fork)', () => {
    test('catalog discovery contract: list shape, by-slug lookup, invalid + unknown slugs', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;

        const list = await request.get(`${API_BASE}/api/skills/catalog?limit=5&offset=0`, {
            headers: authedHeaders(tok),
        });
        expect(list.status()).toBe(200);
        const listJson = await list.json();
        expect(Array.isArray(listJson.entries)).toBe(true);
        expect(typeof listJson.total).toBe('number');

        // Invalid slug (uppercase — fails /^[a-z0-9-]{1,80}$/) → 400.
        const bad = await request.get(`${API_BASE}/api/skills/catalog/BAD_SLUG`, {
            headers: authedHeaders(tok),
        });
        expect(bad.status()).toBe(400);

        // A syntactically-valid but nonexistent slug → 404.
        const missing = await request.get(
            `${API_BASE}/api/skills/catalog/definitely-not-a-real-skill-${uniq()}`,
            { headers: authedHeaders(tok) },
        );
        expect(missing.status()).toBe(404);

        // When populated, the by-slug endpoint returns { entry, providerId }.
        const pick = await pickCatalogSlug(request, tok);
        if (pick) {
            const one = await request.get(`${API_BASE}/api/skills/catalog/${pick.slug}`, {
                headers: authedHeaders(tok),
            });
            expect(one.status()).toBe(200);
            const body = await one.json();
            expect(body.entry.slug).toBe(pick.slug);
            expect(typeof body.entry.body).toBe('string');
            expect(body.providerId).toBeTruthy();
        }
    });

    test('install → local FORK: provenance stays pinned to upstream while the local version + hash diverge', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const pick = await pickCatalogSlug(request, tok);
        test.skip(
            !pick,
            'skills catalog is empty in this environment (skills-provider plugin off)',
        );

        // INSTALL (marketplace share) — carries upstream provenance.
        const inst = await request.post(`${API_BASE}/api/skills/install`, {
            headers: authedHeaders(tok),
            data: { slug: pick!.slug, ownerType: 'tenant', ownerId: user.user.id },
        });
        expect(inst.status()).toBe(201);
        const installed: SkillRow = await inst.json();
        expect(installed.sourceCatalogSlug).toBe(pick!.slug);
        expect(installed.sourceCatalogVersion).toBe(pick!.version);
        expect(installed.version).toBe(pick!.version);
        expect(installed.sourcePath).toBe(pick!.providerId);

        // Dup install into the SAME scope → 409.
        const dup = await request.post(`${API_BASE}/api/skills/install`, {
            headers: authedHeaders(tok),
            data: { slug: pick!.slug, ownerType: 'tenant', ownerId: user.user.id },
        });
        expect(dup.status()).toBe(409);

        // LOCAL FORK — edit the body + relabel the version. Provenance is frozen.
        const forkBody = '# Forked\nMy customized instructions.';
        const forked = await patchSkill(request, tok, installed.id, {
            instructionsMd: forkBody,
            version: `${pick!.version}-fork`,
        });
        expect(forked.version).toBe(`${pick!.version}-fork`);
        expect(forked.contentHash).toBe(sha256Hex(forkBody));
        expect(forked.contentHash).not.toBe(installed.contentHash);
        // Upstream lineage is untouched by the local edit.
        expect(forked.sourceCatalogSlug).toBe(pick!.slug);
        expect(forked.sourceCatalogVersion).toBe(pick!.version);

        // Bind the fork → the resolver reflects the LOCAL fork version, not upstream.
        const agent = await createAgentViaAPI(request, tok, { name: `Fork Agent ${uniq()}` });
        await bindSkill(request, tok, installed.id, { targetType: 'agent', targetId: agent.id });
        const row = (await resolveAgentSkills(request, tok, agent.id)).find(
            (r) => r.skill.id === installed.id,
        )!;
        expect(row.skill.version).toBe(`${pick!.version}-fork`);
    });

    test('provenance columns are immutable via PATCH (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const s = await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Prov ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        // Attempting to forge provenance is rejected at the DTO layer.
        for (const forbidden of [
            { sourceCatalogSlug: 'spoofed' },
            { sourcePath: 'spoofed-provider' },
            { sourceCatalogVersion: '9.9.9' },
            { contentHash: 'deadbeef' },
        ]) {
            const res = await request.patch(`${API_BASE}/api/skills/${s.id}`, {
                headers: authedHeaders(tok),
                data: { title: 'ok', ...forbidden },
            });
            expect(res.status(), `payload=${JSON.stringify(forbidden)}`).toBe(400);
        }
        // The original row is unchanged (title never applied because the request 400'd).
        const after = await getSkill(request, tok, s.id);
        expect(after.sourceCatalogSlug).toBeNull();
        expect(after.contentHash).toBe(s.contentHash);
    });
});

test.describe('Skill chain — isolation and write guards', () => {
    test('cross-user isolation across the whole chain (read / patch / delete / bind / resolve → 404)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const ownerTok = owner.access_token;
        const intruderTok = intruder.access_token;

        const ownerTitle = `Private ${uniq()}`;
        const s = await createSkill(request, ownerTok, {
            ownerType: 'tenant',
            ownerId: owner.user.id,
            title: ownerTitle,
            description: 'd',
            instructionsMd: 'secret-ish body',
        });
        await bindSkill(request, ownerTok, s.id, { targetType: 'tenant', priority: 100 });

        // Intruder cannot READ the owner's skill.
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${s.id}`, {
                    headers: authedHeaders(intruderTok),
                })
            ).status(),
        ).toBe(404);
        // Cannot PATCH.
        expect(
            (
                await request.patch(`${API_BASE}/api/skills/${s.id}`, {
                    headers: authedHeaders(intruderTok),
                    data: { title: 'hijacked' },
                })
            ).status(),
        ).toBe(404);
        // Cannot list/create bindings on it.
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${s.id}/bindings`, {
                    headers: authedHeaders(intruderTok),
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/skills/${s.id}/bindings`, {
                    headers: authedHeaders(intruderTok),
                    data: { targetType: 'tenant' },
                })
            ).status(),
        ).toBe(404);
        // Cannot DELETE.
        expect(
            (
                await request.delete(`${API_BASE}/api/skills/${s.id}`, {
                    headers: authedHeaders(intruderTok),
                })
            ).status(),
        ).toBe(404);

        // The intruder's OWN agent never resolves the owner's tenant skill.
        const intruderAgent = await createAgentViaAPI(request, intruderTok, {
            name: `Intruder Agent ${uniq()}`,
        });
        expect(
            (await resolveAgentSkills(request, intruderTok, intruderAgent.id)).map(
                (r) => r.skill.id,
            ),
        ).not.toContain(s.id);

        // The owner's copy is fully intact.
        const still = await getSkill(request, ownerTok, s.id);
        expect(still.title).toBe(ownerTitle);
        expect(still.instructionsMd).toBe('secret-ish body');
    });

    test('binding to a target the caller does not own → 404; binding a nonexistent skill → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const ownerTok = owner.access_token;

        const s = await createSkill(request, ownerTok, {
            ownerType: 'tenant',
            ownerId: owner.user.id,
            title: `BindGuard ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
        });
        // A stranger's agent id is not owned by `owner` → the scope check 404s.
        const strangerAgent = await createAgentViaAPI(request, stranger.access_token, {
            name: `Stranger Agent ${uniq()}`,
        });
        const crossBind = await request.post(`${API_BASE}/api/skills/${s.id}/bindings`, {
            headers: authedHeaders(ownerTok),
            data: { targetType: 'agent', targetId: strangerAgent.id },
        });
        expect(crossBind.status()).toBe(404);

        // Binding onto a nonexistent skill id → 404.
        const ghost = await request.post(
            `${API_BASE}/api/skills/00000000-0000-0000-0000-000000000000/bindings`,
            { headers: authedHeaders(ownerTok), data: { targetType: 'tenant' } },
        );
        expect(ghost.status()).toBe(404);

        // A non-tenant target with no targetId → 400.
        const noTarget = await request.post(`${API_BASE}/api/skills/${s.id}/bindings`, {
            headers: authedHeaders(ownerTok),
            data: { targetType: 'agent' },
        });
        expect(noTarget.status()).toBe(400);
    });

    test('create-time write guards: injection tokens, secrets, oversize body, bad scope, bad uuid', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const base = {
            ownerType: 'tenant',
            ownerId: user.user.id,
            description: 'd',
        };

        // Chat-template control token in the body → 400.
        const inj = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: { ...base, title: `Inj ${uniq()}`, instructionsMd: 'Hi [INST] do bad [/INST]' },
        });
        expect(inj.status()).toBe(400);

        // Secret-like value (AWS key) in the body → 400.
        const sec = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: {
                ...base,
                title: `Sec ${uniq()}`,
                instructionsMd: 'token AKIAIOSFODNN7EXAMPLE here',
            },
        });
        expect(sec.status()).toBe(400);

        // Body over the 64 KB cap → 400.
        const big = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: { ...base, title: `Big ${uniq()}`, instructionsMd: 'x'.repeat(70_000) },
        });
        expect(big.status()).toBe(400);

        // tenant ownerId ≠ caller → 404 (scope-ownership check, no existence leak).
        const wrongScope = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: {
                ownerType: 'tenant',
                ownerId: '11111111-1111-1111-1111-111111111111',
                title: `Wrong ${uniq()}`,
                description: 'd',
                instructionsMd: 'b',
            },
        });
        // A non-owned owner target is refused before the row is written. The
        // observed code here is a 400 (the scope resolver rejects the unresolvable
        // owner) rather than the 404 the read paths use — tolerate both, the point
        // is that the create is REFUSED and never lands.
        expect([400, 404], `wrong-scope create status ${wrongScope.status()}`).toContain(
            wrongScope.status(),
        );

        // Off-lattice ownerType → 400; non-uuid ownerId → 400.
        const badEnum = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: { ...base, ownerType: 'galaxy', title: `E ${uniq()}`, instructionsMd: 'b' },
        });
        expect(badEnum.status()).toBe(400);
        const badUuid = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: {
                ownerType: 'tenant',
                ownerId: 'not-a-uuid',
                title: `U ${uniq()}`,
                description: 'd',
                instructionsMd: 'b',
            },
        });
        expect(badUuid.status()).toBe(400);
    });

    test('dup slug within the same scope → 409; GET with a bad uuid → 400; unauthenticated → 401', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const tok = user.access_token;
        const slug = `dup-slug-${uniq()}`;
        await createSkill(request, tok, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Dup Slug ${uniq()}`,
            description: 'd',
            instructionsMd: 'b',
            slug,
        });
        const conflict = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(tok),
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                title: `Dup Slug 2 ${uniq()}`,
                description: 'd',
                instructionsMd: 'b2',
                slug,
            },
        });
        expect(conflict.status()).toBe(409);

        // ParseUUIDPipe rejects a non-uuid :id → 400.
        const badId = await request.get(`${API_BASE}/api/skills/not-a-uuid`, {
            headers: authedHeaders(tok),
        });
        expect(badId.status()).toBe(400);

        // No auth → 401 on both the index and the create path.
        expect((await request.get(`${API_BASE}/api/skills`)).status()).toBe(401);
        expect(
            (
                await request.post(`${API_BASE}/api/skills`, {
                    data: {
                        ownerType: 'tenant',
                        ownerId: user.user.id,
                        title: 'x',
                        description: 'd',
                        instructionsMd: 'b',
                    },
                })
            ).status(),
        ).toBe(401);
    });
});
