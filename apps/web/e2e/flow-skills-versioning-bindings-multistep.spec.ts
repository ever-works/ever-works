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
 * Skills — versioning + bindings + catalog/install, driven as MULTI-STEP
 * end-to-end lifecycles (apps/api/src/skills/*,
 * packages/agent/src/skills/skills.service.ts).
 *
 * A `Skill` is a Markdown capability owned at a scope (ownerType ∈
 * tenant|mission|idea|work|agent, ownerId is the id of that scope — for a
 * tenant-scoped skill ownerId MUST equal the caller's own userId). Its body
 * lives in `instructionsMd`; the server derives
 * `contentHash = sha256(instructionsMd)` and stores a free-form `version`
 * string (varchar(16), default '1.0.0'). A `SkillBinding` connects a skill to
 * a target (agent|work|mission|idea|tenant); tenant bindings null out targetId,
 * every other target requires one.
 *
 * NON-DUPLICATION — this file is the LIFECYCLE / catalog+install slice. It
 * deliberately does NOT re-pin what the neighbours already own:
 *   - flow-skill-versioning.spec.ts: the pure hash-drift / version-orthogonality
 *     matrix + the seeded-user UI detail page. We touch create/patch version
 *     semantics only as the connective tissue of larger flows.
 *   - flow-skill-bindings-deep.spec.ts / flow-skill-agent-binding-deep.spec.ts /
 *     sec-pin-skills-scoping.spec.ts: the per-target bindings-list DTO matrix and
 *     the GET /api/agents/:id/skills RESOLVER projection + the exhaustive
 *     security 404 tri-state. We assert through the per-skill bindings LIST and
 *     the /api/skills index — never the agent resolver — and go DEEPER on the
 *     under-covered CATALOG + INSTALL surface + the list/filter/pagination hub.
 *
 * API surface — every shape/status verified LIVE against http://127.0.0.1:3100
 * (sqlite in-memory CI driver) before any assertion was written:
 *   - POST  /api/skills { ownerType, ownerId, title, description, instructionsMd,
 *                         slug?, version?, frontmatter? }
 *       → 201 full row { id, userId, ownerType, ownerId, slug (auto-slugified
 *         from title when omitted), title, description, frontmatter (merged:
 *         name defaults to slug, description defaults to `description`, custom
 *         keys preserved), instructionsMd, contentHash (sha256 hex, 64 chars),
 *         version ('1.0.0' default), sourcePath:null, sourceCatalogSlug:null,
 *         sourceCatalogVersion:null, tenantId:null, organizationId:null,
 *         createdAt, updatedAt }.
 *       Duplicate slug within the SAME (ownerType, ownerId) → 409; the same slug
 *       under a DIFFERENT owner scope is allowed (uniqueness is per-scope, not
 *       global). Body >64 KB → 400. Bad ownerType enum / missing title / bad
 *       slug / non-uuid ownerId → 400. tenant ownerId ≠ caller → 404. agent/…
 *       owner the caller does not own → 404 ("Skill target not found."). No
 *       auth → 401.
 *   - PATCH /api/skills/:id { title?, description?, instructionsMd?, version?,
 *                             frontmatter? }
 *       → 200 refreshed row. contentHash is recomputed ONLY when `instructionsMd`
 *         is in the patch. There is NO server-side version auto-bump — `version`
 *         changes ONLY when the caller supplies it (the two axes are
 *         independent). Cross-user → 404.
 *   - GET   /api/skills?ownerType&ownerId&search&limit&offset
 *       → 200 { data:[row…], meta:{ total, limit, offset } }. limit>200 / bad
 *         ownerType / non-uuid ownerId → 400. No auth → 401.
 *   - GET   /api/skills/:id  → the row; malformed uuid → 400; unknown → 404;
 *         cross-user → 404.
 *   - DELETE /api/skills/:id → 200 { deleted:true }; FK CASCADE reaps bindings.
 *   - POST  /api/skills/:id/bindings { targetType, targetId?, priority?,
 *                                      injectIntoAgent?, injectIntoGenerator? }
 *       → 201 binding row { id, skillId, targetType, targetId (null for tenant),
 *         userId, injectIntoAgent (default true), injectIntoGenerator (default
 *         false), priority (default 100), tenantId:null, organizationId:null,
 *         createdAt } — note: NO updatedAt column on a binding.
 *         non-tenant WITHOUT targetId → 400 ("targetId is required when
 *         targetType=…."). bad targetType enum / non-uuid targetId / priority
 *         out of 1..1000 → 400. Foreign/unknown target → 404. Unknown/cross-user
 *         skill → 404.
 *         Duplicate binding (same skillId+targetType+targetId) violates the
 *         `uq_skill_binding` unique index and surfaces as an UNMAPPED 500 (the
 *         service never catches the QueryFailedError) — asserted tolerantly as
 *         [409, 500]. See notes.
 *   - GET   /api/skills/:id/bindings → 200 SkillBinding[] (per-skill,
 *         userId-scoped). Unknown/cross-user skill → 404. No auth → 401.
 *   - DELETE /api/skill-bindings/:id → 200 { deleted:true }; re-delete → 404;
 *         malformed uuid → 400; cross-user → 404.
 *   - GET   /api/skills/catalog?limit&offset&search&tags
 *       → 200 { entries:[{ slug, title, description, frontmatter, body, version,
 *         tags, sourceUrl }…], total }. limit>200 → 400. No auth → 401.
 *   - GET   /api/skills/catalog/:slug → 200 { entry, providerId }; bad slug
 *         format (uppercase/space) → 400; unknown-but-valid slug → 404.
 *   - POST  /api/skills/install { slug, ownerType, ownerId } → 201 a real Skill
 *         row carrying sourceCatalogSlug=slug + sourcePath=providerId +
 *         version=<catalog version>. Unknown slug → 404; duplicate install at
 *         the same scope → 409.
 *
 * Isolation discipline: every test mints FRESH registerUserViaAPI() users with
 * unique emails; fully API-orchestrated (safe `flow-` prefix, not matched by the
 * no-auth testIgnore regex).
 */

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SkillRow {
    id: string;
    userId: string;
    slug: string;
    title: string;
    description: string;
    ownerType: string;
    ownerId: string;
    instructionsMd: string;
    contentHash: string;
    version: string;
    frontmatter: Record<string, unknown>;
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

async function createSkill(
    request: APIRequestContext,
    token: string,
    body: {
        ownerType: string;
        ownerId: string;
        title: string;
        description?: string;
        instructionsMd?: string;
        slug?: string;
        version?: string;
        frontmatter?: Record<string, unknown>;
    },
): Promise<SkillRow> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            description: 'e2e skill',
            instructionsMd: `# ${body.title}\n\ninitial body`,
            ...body,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function patchSkill(
    request: APIRequestContext,
    token: string,
    skillId: string,
    patch: Record<string, unknown>,
): Promise<{ status: number; body: SkillRow }> {
    const res = await request.patch(`${API_BASE}/api/skills/${skillId}`, {
        headers: authedHeaders(token),
        data: patch,
    });
    const text = await res.text();
    return { status: res.status(), body: text ? (JSON.parse(text) as SkillRow) : ({} as SkillRow) };
}

async function getSkill(
    request: APIRequestContext,
    token: string,
    skillId: string,
): Promise<{ status: number; body: SkillRow }> {
    const res = await request.get(`${API_BASE}/api/skills/${skillId}`, {
        headers: authedHeaders(token),
    });
    const text = await res.text();
    return { status: res.status(), body: text ? (JSON.parse(text) as SkillRow) : ({} as SkillRow) };
}

async function listSkills(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{
    status: number;
    data: SkillRow[];
    meta: { total: number; limit: number; offset: number };
}> {
    const res = await request.get(`${API_BASE}/api/skills${query}`, {
        headers: authedHeaders(token),
    });
    const status = res.status();
    if (status !== 200) return { status, data: [], meta: { total: 0, limit: 0, offset: 0 } };
    const json = await res.json();
    return { status, data: json.data, meta: json.meta };
}

async function bind(
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
): Promise<{ status: number; body: BindingRow }> {
    const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data: binding,
    });
    const text = await res.text();
    return {
        status: res.status(),
        body: text ? (JSON.parse(text) as BindingRow) : ({} as BindingRow),
    };
}

async function listBindings(
    request: APIRequestContext,
    token: string,
    skillId: string,
): Promise<{ status: number; rows: BindingRow[] }> {
    const res = await request.get(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
    });
    const status = res.status();
    return { status, rows: status === 200 ? await res.json() : [] };
}

async function createMission(
    request: APIRequestContext,
    token: string,
    title: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { title, description: 'skill target mission', type: 'one-shot' },
    });
    expect(res.status(), `createMission body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).id as string;
}

async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    return registerUserViaAPI(request);
}

test.describe('Skills — create + version/hash semantics', () => {
    test('create at tenant scope returns the full row with server-derived defaults', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const skill = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Default Shape ${stamp()}`,
            description: 'a capability',
            instructionsMd: '# Body\n\none',
        });
        expect(skill.id).toMatch(UUID_RE);
        expect(skill.userId).toBe(u.user.id);
        expect(skill.ownerType).toBe('tenant');
        expect(skill.ownerId).toBe(u.user.id);
        // slug auto-slugified from title (lowercased, hyphenated).
        expect(skill.slug).toMatch(/^default-shape-/);
        expect(skill.contentHash).toMatch(SHA256_RE);
        expect(skill.version).toBe('1.0.0');
        // No frontmatter supplied → service default { name: slug, description }.
        expect(skill.frontmatter).toMatchObject({ name: skill.slug, description: 'a capability' });
        // A freshly authored (non-catalog) skill carries null provenance.
        expect(skill.sourcePath).toBeNull();
        expect(skill.sourceCatalogSlug).toBeNull();
        expect(skill.sourceCatalogVersion).toBeNull();
        expect(typeof skill.createdAt).toBe('string');
    });

    test('explicit slug + version + custom frontmatter are honored; frontmatter merges name/description', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const slug = `pinned-${stamp()}`;
        const skill = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Explicit ${stamp()}`,
            description: 'described',
            slug,
            version: '3.1.4',
            // No name/description inside frontmatter → merged from slug + description.
            frontmatter: { tags: ['writing', 'qa'], allowedTools: ['Read'] },
        });
        expect(skill.slug).toBe(slug);
        expect(skill.version).toBe('3.1.4');
        expect(skill.frontmatter).toMatchObject({
            name: slug,
            description: 'described',
            tags: ['writing', 'qa'],
            allowedTools: ['Read'],
        });
    });

    test('PATCH body recomputes contentHash but does NOT auto-bump version; metadata-only patch is inert on the body', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const skill = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Hash Truth ${stamp()}`,
            instructionsMd: '# v1',
        });
        const hash1 = skill.contentHash;
        expect(skill.version).toBe('1.0.0');

        // Body edit → hash drifts, version UNCHANGED (there is no server bump).
        const bodyEdit = await patchSkill(request, u.access_token, skill.id, {
            instructionsMd: '# v2 — expanded',
        });
        expect(bodyEdit.status).toBe(200);
        expect(bodyEdit.body.contentHash).toMatch(SHA256_RE);
        expect(bodyEdit.body.contentHash).not.toBe(hash1);
        expect(bodyEdit.body.version).toBe('1.0.0');
        const hash2 = bodyEdit.body.contentHash;

        // Metadata-only patch (title + frontmatter, NO body) → body + hash intact.
        const metaEdit = await patchSkill(request, u.access_token, skill.id, {
            title: 'Renamed',
            frontmatter: { name: 'renamed', description: 'fm', tags: ['x'] },
        });
        expect(metaEdit.status).toBe(200);
        expect(metaEdit.body.title).toBe('Renamed');
        expect(metaEdit.body.instructionsMd).toBe('# v2 — expanded');
        expect(metaEdit.body.contentHash).toBe(hash2);
        expect(metaEdit.body.version).toBe('1.0.0');
    });

    test('version is a caller-owned free-form label orthogonal to the body hash (multi-step release)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const skill = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Release Train ${stamp()}`,
            instructionsMd: '# release\n\nv1',
            version: '1.0.0',
        });
        const baseHash = skill.contentHash;

        // Bump version only → hash unchanged.
        const v2 = await patchSkill(request, u.access_token, skill.id, { version: '1.1.0' });
        expect(v2.body.version).toBe('1.1.0');
        expect(v2.body.contentHash).toBe(baseHash);

        // Ship body + version together → both move.
        const v3 = await patchSkill(request, u.access_token, skill.id, {
            version: '2.0.0',
            instructionsMd: '# release\n\nv2 GA',
        });
        expect(v3.body.version).toBe('2.0.0');
        expect(v3.body.contentHash).not.toBe(baseHash);

        // A non-semver label ≤16 chars is accepted verbatim (no format guard).
        const draft = await patchSkill(request, u.access_token, skill.id, {
            version: 'draft-2026.07',
        });
        expect(draft.body.version).toBe('draft-2026.07');

        // Final read pins the last write.
        const fresh = await getSkill(request, u.access_token, skill.id);
        expect(fresh.body.version).toBe('draft-2026.07');
        expect(fresh.body.instructionsMd).toBe('# release\n\nv2 GA');
    });

    test('create validation matrix — missing/invalid fields 400, scope-ownership violations 404', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const post = (data: Record<string, unknown>) =>
            request.post(`${API_BASE}/api/skills`, {
                headers: authedHeaders(u.access_token),
                data,
            });
        const good = {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: 'Valid',
            description: 'd',
            instructionsMd: '# b',
        };

        expect((await post({ ...good, title: undefined })).status()).toBe(400);
        expect((await post({ ...good, ownerType: 'galaxy' })).status()).toBe(400);
        expect((await post({ ...good, slug: 'Bad Slug!' })).status()).toBe(400);
        expect((await post({ ...good, ownerId: 'not-a-uuid' })).status()).toBe(400);
        // tenant skill whose ownerId is NOT the caller → 404 (never a leak).
        expect((await post({ ...good, ownerId: UNKNOWN_UUID })).status()).toBe(404);
        // agent-scoped skill on an agent the caller does not own → 404.
        expect((await post({ ...good, ownerType: 'agent', ownerId: UNKNOWN_UUID })).status()).toBe(
            404,
        );
    });

    test('slug uniqueness is per (ownerType, ownerId): same-scope dup 409, different scope allowed; >64KB body 400', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const slug = `unique-${stamp()}`;
        const first = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: 'First',
            slug,
            instructionsMd: '# first',
        });
        expect(first.slug).toBe(slug);

        // Same slug, same tenant scope → 409, first body untouched.
        const dup = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(u.access_token),
            data: {
                ownerType: 'tenant',
                ownerId: u.user.id,
                title: 'Second',
                slug,
                description: 'd',
                instructionsMd: '# second',
            },
        });
        expect(dup.status()).toBe(409);
        expect((await dup.json()).message).toMatch(/already exists at tenant:/i);

        // Same slug under a DIFFERENT owner scope (agent) is allowed.
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Slug Owner ${stamp()}`,
        });
        const agentScoped = await createSkill(request, u.access_token, {
            ownerType: 'agent',
            ownerId: agent.id,
            title: 'Agent Scoped Same Slug',
            slug,
            instructionsMd: '# agent',
        });
        expect(agentScoped.slug).toBe(slug);
        expect(agentScoped.id).not.toBe(first.id);

        // Oversized body on create → 400.
        const over = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(u.access_token),
            data: {
                ownerType: 'tenant',
                ownerId: u.user.id,
                title: `Huge ${stamp()}`,
                description: 'd',
                instructionsMd: '#'.repeat(70_000),
            },
        });
        expect(over.status()).toBe(400);
    });
});

test.describe('Skills — list + filter + pagination hub', () => {
    test('GET /skills returns { data, meta } and surfaces a freshly created skill; meta echoes limit/offset', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const skill = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Listed ${stamp()}`,
            instructionsMd: '# b',
        });
        const listed = await listSkills(request, u.access_token, '?limit=5&offset=0');
        expect(listed.status).toBe(200);
        expect(Array.isArray(listed.data)).toBe(true);
        expect(typeof listed.meta.total).toBe('number');
        expect(listed.meta.limit).toBe(5);
        expect(listed.meta.offset).toBe(0);
        expect(listed.data.map((r) => r.id)).toContain(skill.id);
    });

    test('filter by ownerType + search narrows the result set to matching rows only', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const tag = stamp();
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `Filter Agent ${tag}`,
        });
        const tenantSkill = await createSkill(request, u.access_token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Tenant Filter ${tag}`,
            instructionsMd: '# b',
        });
        const agentSkill = await createSkill(request, u.access_token, {
            ownerType: 'agent',
            ownerId: agent.id,
            title: `Agent Filter ${tag}`,
            instructionsMd: '# b',
        });

        // ownerType=agent must exclude the tenant-scoped skill.
        const agentsOnly = await listSkills(request, u.access_token, '?ownerType=agent');
        expect(agentsOnly.data.map((r) => r.id)).toContain(agentSkill.id);
        expect(agentsOnly.data.map((r) => r.id)).not.toContain(tenantSkill.id);
        expect(agentsOnly.data.every((r) => r.ownerType === 'agent')).toBe(true);

        // ownerType=tenant is the complementary slice.
        const tenantsOnly = await listSkills(request, u.access_token, '?ownerType=tenant');
        expect(tenantsOnly.data.map((r) => r.id)).toContain(tenantSkill.id);
        expect(tenantsOnly.data.map((r) => r.id)).not.toContain(agentSkill.id);

        // search matches on title — the unique stamp finds both of this user's rows.
        const searched = await listSkills(request, u.access_token, `?search=${tag}`);
        const ids = searched.data.map((r) => r.id);
        expect(ids).toContain(tenantSkill.id);
        expect(ids).toContain(agentSkill.id);
    });

    test('list validation — limit>200 / bad ownerType / non-uuid ownerId → 400; no auth → 401', async ({
        request,
    }) => {
        const u = await freshUser(request);
        expect(
            (
                await request.get(`${API_BASE}/api/skills?limit=500`, {
                    headers: authedHeaders(u.access_token),
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/skills?ownerType=galaxy`, {
                    headers: authedHeaders(u.access_token),
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/skills?ownerId=not-a-uuid`, {
                    headers: authedHeaders(u.access_token),
                })
            ).status(),
        ).toBe(400);
        expect((await request.get(`${API_BASE}/api/skills`)).status()).toBe(401);
    });
});

test.describe('Skills — bindings, multi-target + lifecycle', () => {
    test('bind tenant + agent + work + mission; the per-skill bindings list reflects all four with correct DTO', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const u = await freshUser(request);
        const token = u.access_token;
        const tag = stamp();
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Multi Bind ${tag}`,
            instructionsMd: '# b',
        });
        const agent = await createAgentViaAPI(request, token, { name: `MB Agent ${tag}` });
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `MB Work ${tag}`,
            slug: `mb-work-${tag}`,
        });
        const missionId = await createMission(request, token, `MB Mission ${tag}`);

        // tenant binding → targetId nulled by the service.
        const tenantBind = await bind(request, token, skill.id, { targetType: 'tenant' });
        expect(tenantBind.status).toBe(201);
        expect(tenantBind.body.id).toMatch(UUID_RE);
        expect(tenantBind.body.skillId).toBe(skill.id);
        expect(tenantBind.body.targetType).toBe('tenant');
        expect(tenantBind.body.targetId).toBeNull();
        expect(tenantBind.body.userId).toBe(u.user.id);
        // Documented defaults.
        expect(tenantBind.body.injectIntoAgent).toBe(true);
        expect(tenantBind.body.injectIntoGenerator).toBe(false);
        expect(tenantBind.body.priority).toBe(100);

        const agentBind = await bind(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        expect(agentBind.status).toBe(201);
        expect(agentBind.body.targetId).toBe(agent.id);
        const workBind = await bind(request, token, skill.id, {
            targetType: 'work',
            targetId: workId,
        });
        expect(workBind.status).toBe(201);
        expect(workBind.body.targetId).toBe(workId);
        const missionBind = await bind(request, token, skill.id, {
            targetType: 'mission',
            targetId: missionId,
        });
        expect(missionBind.status).toBe(201);
        expect(missionBind.body.targetId).toBe(missionId);

        const listed = await listBindings(request, token, skill.id);
        expect(listed.status).toBe(200);
        const byId = listed.rows.map((r) => r.id);
        for (const b of [tenantBind, agentBind, workBind, missionBind]) {
            expect(byId).toContain(b.body.id);
        }
        // Every listed binding is scoped to the caller and this skill.
        expect(listed.rows.every((r) => r.skillId === skill.id)).toBe(true);
        expect(listed.rows.every((r) => r.userId === u.user.id)).toBe(true);
    });

    test('explicit priority + inject flags are persisted verbatim on the binding', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Flags ${stamp()}` });
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Flags Skill ${stamp()}`,
            instructionsMd: '# b',
        });
        const b = await bind(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 7,
            injectIntoAgent: false,
            injectIntoGenerator: true,
        });
        expect(b.status).toBe(201);
        expect(b.body.priority).toBe(7);
        expect(b.body.injectIntoAgent).toBe(false);
        expect(b.body.injectIntoGenerator).toBe(true);
        // Persisted — re-read via the list surfaces the same values.
        const row = (await listBindings(request, token, skill.id)).rows.find(
            (r) => r.id === b.body.id,
        );
        expect(row).toBeTruthy();
        expect(row!.priority).toBe(7);
        expect(row!.injectIntoAgent).toBe(false);
        expect(row!.injectIntoGenerator).toBe(true);
    });

    test('binding validation — non-tenant needs targetId (400), bad enum/uuid/priority → 400', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Bind Val ${stamp()}`,
            instructionsMd: '# b',
        });

        // Every non-tenant target REQUIRES a targetId → 400 with a precise message.
        for (const targetType of ['agent', 'work', 'mission', 'idea']) {
            const res = await bind(request, token, skill.id, { targetType });
            expect(res.status, `missing targetId for ${targetType}`).toBe(400);
        }
        const missionNoTarget = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: authedHeaders(token),
            data: { targetType: 'mission' },
        });
        expect((await missionNoTarget.json()).message).toMatch(
            /targetId is required when targetType=mission/i,
        );

        // Bad enum / non-uuid targetId / out-of-range priority all fail DTO validation.
        expect(
            (await bind(request, token, skill.id, { targetType: 'galaxy', targetId: u.user.id }))
                .status,
        ).toBe(400);
        expect(
            (await bind(request, token, skill.id, { targetType: 'agent', targetId: 'not-a-uuid' }))
                .status,
        ).toBe(400);
        expect(
            (await bind(request, token, skill.id, { targetType: 'tenant', priority: 0 })).status,
        ).toBe(400);
        expect(
            (await bind(request, token, skill.id, { targetType: 'tenant', priority: 9999 })).status,
        ).toBe(400);
    });

    test('binding to a target the caller does not own → 404; unknown skill → 404 (no existence leak)', async ({
        request,
    }) => {
        const owner = await freshUser(request);
        const other = await freshUser(request);
        // An agent owned by a DIFFERENT user.
        const foreignAgent = await createAgentViaAPI(request, other.access_token, {
            name: `Foreign ${stamp()}`,
        });
        const skill = await createSkill(request, owner.access_token, {
            ownerType: 'tenant',
            ownerId: owner.user.id,
            title: `Guard Skill ${stamp()}`,
            instructionsMd: '# b',
        });

        // Binding onto a foreign agent → 404 "Skill target not found".
        expect(
            (
                await bind(request, owner.access_token, skill.id, {
                    targetType: 'agent',
                    targetId: foreignAgent.id,
                })
            ).status,
        ).toBe(404);
        // Binding onto a mission id that does not exist → 404.
        expect(
            (
                await bind(request, owner.access_token, skill.id, {
                    targetType: 'mission',
                    targetId: UNKNOWN_UUID,
                })
            ).status,
        ).toBe(404);
        // Binding onto an unknown skill → 404.
        expect(
            (await bind(request, owner.access_token, UNKNOWN_UUID, { targetType: 'tenant' }))
                .status,
        ).toBe(404);
    });

    test('duplicate binding of the same (skill, target) is rejected by the unique index (409 or unmapped 500)', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Dup ${stamp()}` });
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Dup Skill ${stamp()}`,
            instructionsMd: '# b',
        });
        const first = await bind(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        expect(first.status).toBe(201);
        // The `uq_skill_binding` (skillId, targetType, targetId) index rejects the
        // second identical binding. The service does not catch the driver error,
        // so it surfaces as an UNMAPPED 500 in this build — tolerate either.
        const dup = await bind(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
        });
        expect([409, 500]).toContain(dup.status);
    });

    test('delete a binding via /skill-bindings/:id → { deleted:true }; list empties; re-delete 404; malformed 400', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Del ${stamp()}` });
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Del Skill ${stamp()}`,
            instructionsMd: '# b',
        });
        const b = await bind(request, token, skill.id, { targetType: 'agent', targetId: agent.id });
        expect(b.status).toBe(201);
        expect((await listBindings(request, token, skill.id)).rows.map((r) => r.id)).toContain(
            b.body.id,
        );

        const del = await request.delete(`${API_BASE}/api/skill-bindings/${b.body.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        // The binding is gone from the per-skill list…
        expect((await listBindings(request, token, skill.id)).rows.map((r) => r.id)).not.toContain(
            b.body.id,
        );
        // …a re-delete of the tombstoned id → 404; a malformed id → 400 (ParseUUIDPipe).
        expect(
            (
                await request.delete(`${API_BASE}/api/skill-bindings/${b.body.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(`${API_BASE}/api/skill-bindings/not-a-uuid`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(400);
    });

    test('bindings survive version bumps — bumping the skill version 3x leaves the binding rows stable', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Survive ${stamp()}` });
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Survive Skill ${stamp()}`,
            instructionsMd: '# v1',
            version: '1.0.0',
        });
        const a = await bind(request, token, skill.id, {
            targetType: 'agent',
            targetId: agent.id,
            priority: 15,
        });
        const t = await bind(request, token, skill.id, { targetType: 'tenant', priority: 25 });
        const before = (await listBindings(request, token, skill.id)).rows.map((r) => r.id).sort();
        expect(before).toEqual([a.body.id, t.body.id].sort());

        // A version/body release train must NOT disturb the binding rows.
        for (const [version, body] of [
            ['1.1.0', '# v1.1'],
            ['2.0.0', '# v2'],
            ['2.0.1', '# v2 patch'],
        ] as const) {
            const p = await patchSkill(request, token, skill.id, { version, instructionsMd: body });
            expect(p.status).toBe(200);
            expect(p.body.version).toBe(version);
        }
        const after = (await listBindings(request, token, skill.id)).rows;
        expect(after.map((r) => r.id).sort()).toEqual(before);
        // Priorities are untouched by skill edits.
        expect(after.find((r) => r.id === a.body.id)!.priority).toBe(15);
        expect(after.find((r) => r.id === t.body.id)!.priority).toBe(25);
    });

    test('deleting a skill cascades its bindings — list-bindings 404s, orphan binding delete 404s', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const agent = await createAgentViaAPI(request, token, { name: `Cascade ${stamp()}` });
        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: u.user.id,
            title: `Cascade Skill ${stamp()}`,
            instructionsMd: '# b',
        });
        const b = await bind(request, token, skill.id, { targetType: 'agent', targetId: agent.id });
        expect(b.status).toBe(201);

        const del = await request.delete(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        // Skill gone → its bindings-list route 404s (guard runs getOne first).
        expect((await listBindings(request, token, skill.id)).status).toBe(404);
        // The orphaned binding row is already reaped by the FK CASCADE → 404.
        expect(
            (
                await request.delete(`${API_BASE}/api/skill-bindings/${b.body.id}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);
        // The skill GET itself is now a 404.
        expect((await getSkill(request, token, skill.id)).status).toBe(404);
    });
});

test.describe('Skills — catalog + install', () => {
    test('catalog list returns { entries, total }; each entry carries the provider DTO; get-one returns { entry, providerId }', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const res = await request.get(`${API_BASE}/api/skills/catalog?limit=5`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const catalog = await res.json();
        expect(Array.isArray(catalog.entries)).toBe(true);
        expect(typeof catalog.total).toBe('number');
        // Env-adaptive: a skills-provider plugin may or may not be enabled. When
        // entries exist, pin the entry DTO + the get-one envelope.
        if (catalog.entries.length > 0) {
            const entry = catalog.entries[0];
            expect(typeof entry.slug).toBe('string');
            expect(typeof entry.title).toBe('string');
            expect(typeof entry.body).toBe('string');
            expect(entry.frontmatter).toBeTruthy();

            const one = await request.get(`${API_BASE}/api/skills/catalog/${entry.slug}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(one.status()).toBe(200);
            const found = await one.json();
            expect(found.entry.slug).toBe(entry.slug);
            expect(typeof found.providerId).toBe('string');
        }
    });

    test('catalog validation — bad slug format 400, unknown slug 404, limit>200 400, no auth 401', async ({
        request,
    }) => {
        const u = await freshUser(request);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/catalog/BadSlug`, {
                    headers: authedHeaders(u.access_token),
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/catalog/does-not-exist-${stamp()}`, {
                    headers: authedHeaders(u.access_token),
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.get(`${API_BASE}/api/skills/catalog?limit=500`, {
                    headers: authedHeaders(u.access_token),
                })
            ).status(),
        ).toBe(400);
        expect((await request.get(`${API_BASE}/api/skills/catalog`)).status()).toBe(401);
    });

    test('install a catalog entry → a real Skill row with catalog provenance; it lists, binds, and re-installs 409', async ({
        request,
    }) => {
        const u = await freshUser(request);
        const token = u.access_token;
        const catalog = await (
            await request.get(`${API_BASE}/api/skills/catalog?limit=1`, {
                headers: authedHeaders(token),
            })
        ).json();
        // Skip the install assertions only if this env has no skills provider.
        test.skip(
            catalog.entries.length === 0,
            'no skills-provider plugin enabled in this environment',
        );

        const slug: string = catalog.entries[0].slug;
        const res = await request.post(`${API_BASE}/api/skills/install`, {
            headers: authedHeaders(token),
            data: { slug, ownerType: 'tenant', ownerId: u.user.id },
        });
        expect(res.status(), `install body=${await res.text().catch(() => '')}`).toBe(201);
        const installed: SkillRow = await res.json();
        expect(installed.id).toMatch(UUID_RE);
        expect(installed.slug).toBe(slug);
        // Catalog provenance is stamped onto the installed row.
        expect(installed.sourceCatalogSlug).toBe(slug);
        expect(typeof installed.sourcePath).toBe('string');
        expect(installed.contentHash).toMatch(SHA256_RE);

        // The installed skill is a first-class row: it shows up in the index…
        const listed = await listSkills(request, token, '?limit=200');
        expect(listed.data.map((r) => r.id)).toContain(installed.id);
        // …and is bindable like any other skill.
        const b = await bind(request, token, installed.id, { targetType: 'tenant' });
        expect(b.status).toBe(201);
        expect(b.body.skillId).toBe(installed.id);

        // Re-installing the same slug at the same scope collides on slug → 409.
        const dup = await request.post(`${API_BASE}/api/skills/install`, {
            headers: authedHeaders(token),
            data: { slug, ownerType: 'tenant', ownerId: u.user.id },
        });
        expect(dup.status()).toBe(409);
    });

    test('install of an unknown catalog slug → 404', async ({ request }) => {
        const u = await freshUser(request);
        const res = await request.post(`${API_BASE}/api/skills/install`, {
            headers: authedHeaders(u.access_token),
            data: { slug: `no-such-skill-${stamp()}`, ownerType: 'tenant', ownerId: u.user.id },
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Skills — cross-user isolation across the whole surface', () => {
    test('a second user cannot read/patch/delete the owner skill, nor list/create/delete its bindings (all 404)', async ({
        request,
    }) => {
        const owner = await freshUser(request);
        const intruder = await freshUser(request);
        const skill = await createSkill(request, owner.access_token, {
            ownerType: 'tenant',
            ownerId: owner.user.id,
            title: `Private ${stamp()}`,
            instructionsMd: '# secret',
        });
        const b = await bind(request, owner.access_token, skill.id, { targetType: 'tenant' });
        expect(b.status).toBe(201);

        const it = authedHeaders(intruder.access_token);
        // Read / patch / delete the skill → 404 (never 403 — no existence leak).
        expect(
            (await request.get(`${API_BASE}/api/skills/${skill.id}`, { headers: it })).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
                    headers: it,
                    data: { version: '9.9.9' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (await request.delete(`${API_BASE}/api/skills/${skill.id}`, { headers: it })).status(),
        ).toBe(404);
        // Bindings surface is equally walled off.
        expect(
            (
                await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, { headers: it })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
                    headers: it,
                    data: { targetType: 'tenant' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(`${API_BASE}/api/skill-bindings/${b.body.id}`, { headers: it })
            ).status(),
        ).toBe(404);

        // The owner's skill + binding are entirely intact afterwards.
        const survivor = await getSkill(request, owner.access_token, skill.id);
        expect(survivor.status).toBe(200);
        expect(survivor.body.instructionsMd).toBe('# secret');
        expect(
            (await listBindings(request, owner.access_token, skill.id)).rows.map((r) => r.id),
        ).toContain(b.body.id);
    });
});
