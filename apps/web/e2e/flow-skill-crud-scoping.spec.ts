import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Skill CRUD + scope/owner validation — COMPLEX, multi-step INTEGRATION flows.
 *
 * A `Skill` is a Markdown capability (frontmatter + instructionsMd) owned at one
 * of five scopes via (ownerType, ownerId). The unique key is
 * (ownerType, ownerId, slug) — so the SAME slug can live at two different
 * scopes, but a second skill at the SAME scope+slug is a 409 conflict.
 *
 * This file deliberately AVOIDS what the existing specs already pin:
 *   - skills.spec.ts            → basic create/patch/delete + bindings happy-path
 *   - skills-list-filter.spec.ts→ ?ownerType / ?search / limit-offset paging
 *   - flow-agent-skills-binding → agent-resolution + priority ordering + binding isolation
 * It owns the un-covered CRUD/scoping edges: custom slug verbatim, slug-conflict
 * 409, same-slug-across-scopes, immutable-slug-on-update, contentHash invariants,
 * 64 KB cap, secret-scan 500, ParseUUIDPipe 400, full owner-scope matrix with
 * ownerType+ownerId filter precision, catalog install errors, and cross-user
 * 404 on the write paths (PATCH/DELETE).
 *
 * API surface — every shape/status verified against the LIVE stack before assert:
 *   - POST   /api/skills { ownerType, ownerId, title, description, instructionsMd,
 *                          frontmatter?, slug?, version? }
 *       → 201 { id, userId, ownerType, ownerId, slug, title, description,
 *               frontmatter:{name,description,…}, instructionsMd, contentHash,
 *               version:'1.0.0' (default), sourceCatalogSlug:null, … }
 *       · ownerType ∈ {tenant,mission,idea,work,agent}; 'user'/'bogus' → 400 "Invalid ownerType".
 *       · missing ownerId → 400 "ownerId is required."
 *       · missing instructionsMd → 400 "title, description, and instructionsMd are required."
 *       · custom `slug` is stored VERBATIM (case + `_` preserved — NOT re-slugified).
 *       · no `slug` → slugifyText(title): NFKD-strip accents/punct, spaces→'-', lowercase.
 *       · title that slugifies to '' (e.g. all-CJK) → 400 "must contain at least one alphanumeric".
 *       · duplicate (ownerType,ownerId,slug) → 409 "A Skill with slug … already exists at …".
 *       · instructionsMd > 64 KB → 400 "instructionsMd exceeds max 64 KB."
 *       · secret-like body (ghp_…/AKIA…/sk-…) → 500 (assertNoSecrets throws a plain Error).
 *   - GET    /api/skills?ownerType=&ownerId=&search=&limit=&offset= → { data, meta:{total,limit,offset} }
 *   - GET    /api/skills/:id   → 200 owner; cross-user → 404; non-UUID → 400 (ParseUUIDPipe).
 *   - PATCH  /api/skills/:id   → 200 { … }; slug is IMMUTABLE; contentHash recomputes ONLY when
 *                                instructionsMd changes; cross-user → 404.
 *   - DELETE /api/skills/:id   → 200 { deleted:true }; cascades bindings; cross-user → 404; repeat → 404.
 *   - POST   /api/skills/install { slug, ownerType, ownerId }
 *       → missing ownerId → 400; unknown/absent catalog slug → 404 "Catalog skill … not found."
 *
 * Notes / deviations from a naive contract:
 *   - There is NO `type` column on a Skill. The real "type" dimension is the
 *     owner SCOPE (ownerType). Flows treat the ownerTypes as the skill "types"
 *     and validate per-scope ownerId semantics. The `idea` ownerType is on the
 *     entity lattice but Ideas have NO REST endpoint yet (POST /api/me/ideas →
 *     404), so the scope matrix exercises tenant/mission/work/agent only.
 *   - `ownerId` is NOT FK-validated at create time for any scope — the server
 *     trusts the supplied id. Flows therefore use REAL entity ids (mission/work/
 *     agent) so the scope is meaningful, but never assert a "bad ownerId → 4xx".
 *   - secret-scan rejection surfaces as a raw 500 (not a 400) — asserted truthfully.
 *   - Each mutating flow runs on a FRESH registerUserViaAPI() user (cross-spec
 *     isolation); the seeded storageState user is used ONLY for the UI flow.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface SkillRow {
    id: string;
    userId: string;
    ownerType: string;
    ownerId: string;
    slug: string;
    title: string;
    description: string;
    frontmatter: { name: string; description: string; tags?: string[]; [k: string]: unknown };
    instructionsMd: string;
    contentHash: string;
    version: string;
    sourceCatalogSlug: string | null;
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
        slug?: string;
        version?: string;
    },
): Promise<SkillRow> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            description: 'e2e skill',
            instructionsMd: `# ${body.title}\n\nbody`,
            ...body,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Resolve the authenticated user's own id (tenant ownerId == userId). */
async function myUserId(request: APIRequestContext, token: string): Promise<string> {
    const res = await request.get(`${API_BASE}/api/auth/profile`, {
        headers: authedHeaders(token),
    });
    const me = await res.json();
    return me.id ?? me.user?.id;
}

test.describe('Skill CRUD + scope/owner validation', () => {
    /**
     * Flow 1 — Custom slug + explicit version on create; slug stored verbatim;
     * a SECOND skill with the same slug at the SAME scope is a 409 conflict, yet
     * the SAME slug at a DIFFERENT scope (mission) is allowed (the unique key is
     * the (ownerType, ownerId, slug) triple, not the slug alone).
     */
    test('custom slug is verbatim + per-scope unique: dup-at-scope 409, same-slug-other-scope OK', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);
        const slug = `Keep_This-AS_IS-${stamp}`;

        // Custom slug + explicit version. Slug is stored EXACTLY as supplied —
        // mixed case and underscores survive (no re-slugify). frontmatter.name
        // defaults to the slug. version is honoured (not the 1.0.0 default).
        const first = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: 'Verbatim Slug Skill',
            slug,
            version: '2.3.4',
        });
        expect(first.slug).toBe(slug);
        expect(first.version).toBe('2.3.4');
        expect(first.frontmatter.name).toBe(slug);
        expect(first.sourceCatalogSlug).toBeNull();

        // Same scope (tenant:user.id) + same slug → 409 ConflictException with a
        // truthful, scope-qualified message.
        const dup = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                title: 'Dup',
                description: 'd',
                instructionsMd: '# dup',
                slug,
            },
        });
        expect(dup.status()).toBe(409);
        const dupBody = await dup.json();
        expect(dupBody.message).toMatch(/already exists/i);
        expect(dupBody.message).toContain(slug);

        // Different scope (a mission) + the SAME slug → allowed (distinct triple).
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers: authedHeaders(token),
                data: { title: `Slug Mission ${stamp}`, description: 'd', type: 'one-shot' },
            })
        ).json();
        expect(mission.id).toBeTruthy();

        const sameSlugOtherScope = await createSkill(request, token, {
            ownerType: 'mission',
            ownerId: mission.id,
            title: 'Same Slug Different Scope',
            slug,
        });
        expect(sameSlugOtherScope.slug).toBe(slug);
        expect(sameSlugOtherScope.ownerType).toBe('mission');
        expect(sameSlugOtherScope.ownerId).toBe(mission.id);
        // Two distinct skill rows now share the slug across two scopes.
        expect(sameSlugOtherScope.id).not.toBe(first.id);

        // The full list shows exactly the two slug-sharing rows (the 409 never persisted).
        const all = await (
            await request.get(`${API_BASE}/api/skills`, { headers: authedHeaders(token) })
        ).json();
        const sameSlug = all.data.filter((s: SkillRow) => s.slug === slug);
        expect(sameSlug.map((s: SkillRow) => s.ownerType).sort()).toEqual(['mission', 'tenant']);
    });

    /**
     * Flow 2 — Title-derived slug (no explicit slug): slugifyText drops accents
     * (NFKD) + punctuation + lowercases + collapses spaces → hyphens. A title
     * that reduces to the empty slug (all non-ASCII-word chars) is a 400. A
     * second create that slugifies to the SAME derived slug at the same scope
     * 409s.
     */
    test('auto-derived slug normalizes title; empty-slug title 400; derived-slug collision 409', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Accents + punctuation + casing + spacing all normalize deterministically.
        const derived = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: 'Code  Review:  Best Practices!!',
        });
        expect(derived.slug).toBe('code-review-best-practices');
        // version defaults to 1.0.0 when not supplied.
        expect(derived.version).toBe('1.0.0');
        // frontmatter.name falls back to the derived slug.
        expect(derived.frontmatter.name).toBe('code-review-best-practices');

        // A title that slugifies to '' (CJK / emoji are stripped by the ASCII \w
        // class) is rejected up-front with a truthful message. NOTE: no internal
        // whitespace — a space would survive as a hyphen (`\s+`→`-`, which `[^\w-]+`
        // keeps), yielding the truthy slug '-' and a 201 instead of the empty-slug 400.
        const emptySlug = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                title: '日本語🎉',
                description: 'd',
                instructionsMd: '# x',
            },
        });
        expect(emptySlug.status()).toBe(400);
        expect((await emptySlug.json()).message).toMatch(/at least one alphanumeric/i);

        // A different title that COLLIDES on the derived slug at the same scope → 409.
        const collide = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                // punctuation noise collapses to the SAME slug as `derived`.
                title: 'Code Review --- Best Practices',
                description: 'd',
                instructionsMd: '# y',
            },
        });
        expect(collide.status()).toBe(409);
        expect((await collide.json()).message).toContain('code-review-best-practices');
    });

    /**
     * Flow 3 — Body-validation matrix on the write path. Each branch is a
     * distinct guard with a distinct status: required-field 400, oversize-body
     * 400 (64 KB cap), secret-scan 500 (raw Error), invalid ownerType 400,
     * missing ownerId 400, and ParseUUIDPipe 400 on a malformed :id read.
     */
    test('write-path validation: required-field/oversize 400, secret-body 500, bad ownerType/ownerId 400, bad-UUID 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);

        // (a) missing instructionsMd → 400 with the combined required-fields message.
        const noBody = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                title: 'No Body',
                description: 'd',
            },
        });
        expect(noBody.status()).toBe(400);
        expect((await noBody.json()).message).toMatch(/instructionsMd are required/i);

        // (b) oversize instructionsMd (> 64 KB) → 400 with the cap message.
        const oversize = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                title: 'Oversize',
                description: 'd',
                instructionsMd: 'a'.repeat(64 * 1024 + 16),
            },
        });
        expect(oversize.status()).toBe(400);
        expect((await oversize.json()).message).toMatch(/exceeds max 64 ?KB/i);

        // (c) secret-like value in the body → 500. assertNoSecrets throws a plain
        // Error (no HttpException wrap), so this surfaces as Internal server error.
        // Truthful assertion: the create is rejected (NOT persisted), not a 201.
        const secretBody = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                title: 'Secret Skill',
                description: 'd',
                instructionsMd: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
            },
        });
        expect(secretBody.status()).toBe(500);
        expect(secretBody.ok()).toBe(false);

        // (d) invalid ownerType ('user' is not in the lattice) → 400.
        const badType = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'user',
                ownerId: user.user.id,
                title: 'Bad Type',
                description: 'd',
                instructionsMd: '# x',
            },
        });
        expect(badType.status()).toBe(400);
        expect((await badType.json()).message).toMatch(/invalid ownerType/i);

        // (e) missing ownerId → 400.
        const noOwner = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                title: 'No Owner',
                description: 'd',
                instructionsMd: '# x',
            },
        });
        expect(noOwner.status()).toBe(400);
        expect((await noOwner.json()).message).toMatch(/ownerId is required/i);

        // (f) malformed :id on the read path → 400 from ParseUUIDPipe (NOT 404).
        const badUuid = await request.get(`${API_BASE}/api/skills/not-a-real-uuid`, { headers });
        expect(badUuid.status()).toBe(400);

        // After all the failures, the user still owns ZERO skills (nothing leaked through).
        const list = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        expect(list.meta.total).toBe(0);
    });

    /**
     * Flow 4 — Update lifecycle invariants. PATCH each field independently and
     * prove: slug is IMMUTABLE across updates, contentHash recomputes ONLY when
     * instructionsMd changes (a title/description/version/frontmatter-only patch
     * leaves the hash untouched), version is freely settable, and frontmatter is
     * wholly replaced. Then a cross-user PATCH → 404 with no mutation leak.
     */
    test('update: slug immutable, contentHash tracks body only, version/frontmatter mutable, cross-user PATCH 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const token = owner.access_token;
        const stamp = Date.now().toString(36);

        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: owner.user.id,
            title: 'Editable Skill',
            slug: `editable-${stamp}`,
            instructionsMd: '# v1\n\noriginal',
        });
        const originalHash = skill.contentHash;
        const originalSlug = skill.slug;

        // Metadata-only PATCH (title + description + version + frontmatter). The
        // body is untouched → contentHash MUST be identical. slug MUST be unchanged
        // (there is no slug field on the update DTO).
        const meta = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(token),
            data: {
                title: 'Renamed Skill',
                description: 'updated description',
                version: '9.9.9',
                frontmatter: {
                    name: `editable-${stamp}`,
                    description: 'fm desc',
                    tags: ['qa', 'review'],
                },
            },
        });
        expect(meta.status()).toBe(200);
        const afterMeta: SkillRow = await meta.json();
        expect(afterMeta.title).toBe('Renamed Skill');
        expect(afterMeta.description).toBe('updated description');
        expect(afterMeta.version).toBe('9.9.9');
        expect(afterMeta.frontmatter.tags).toEqual(['qa', 'review']);
        expect(afterMeta.slug).toBe(originalSlug); // immutable
        expect(afterMeta.contentHash).toBe(originalHash); // body unchanged → hash stable

        // Body PATCH → contentHash MUST change; slug still immutable.
        const bodyPatch = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(token),
            data: { instructionsMd: '# v2\n\nrewritten body' },
        });
        expect(bodyPatch.status()).toBe(200);
        const afterBody: SkillRow = await bodyPatch.json();
        expect(afterBody.instructionsMd).toBe('# v2\n\nrewritten body');
        expect(afterBody.contentHash).not.toBe(originalHash);
        expect(afterBody.slug).toBe(originalSlug);
        // Metadata from the prior patch is preserved.
        expect(afterBody.title).toBe('Renamed Skill');
        expect(afterBody.version).toBe('9.9.9');

        // An oversize body on UPDATE is also capped at 64 KB → 400 (no mutation).
        const oversizeUpdate = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(token),
            data: { instructionsMd: 'b'.repeat(64 * 1024 + 1) },
        });
        expect(oversizeUpdate.status()).toBe(400);

        // Cross-user PATCH → 404 (no existence leak, no mutation).
        const crossPatch = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(other.access_token),
            data: { title: 'hijacked' },
        });
        expect(crossPatch.status()).toBe(404);

        // Owner re-reads the unchanged title — the cross-user attempt did nothing.
        const reread: SkillRow = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}`, {
                headers: authedHeaders(token),
            })
        ).json();
        expect(reread.title).toBe('Renamed Skill');
        expect(reread.instructionsMd).toBe('# v2\n\nrewritten body');
    });

    /**
     * Flow 5 — Owner-scope matrix (the skill "types"): create one skill at each
     * of the three scopes that have a REST-creatable owning entity in CI —
     * tenant (userId) / mission / work — then prove ownerType+ownerId filtering
     * pinpoints exactly one skill per scope. An `agent`-scoped skill is added
     * via a real Agent owner to round out the lattice. Finally delete the
     * work-scoped skill and assert the precise filter empties while the other
     * scopes stay intact (per-scope isolation of delete).
     *
     * NB: the `idea` ownerType exists on the entity lattice but Ideas have no
     * REST endpoint yet (POST /api/me/ideas → 404), so it is intentionally not
     * exercised here — see the top docblock.
     */
    test('owner-scope matrix: tenant/mission/work/agent skills filter precisely by ownerType+ownerId; scoped delete', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);
        const stamp = Date.now().toString(36);

        // Real owning entities for each non-tenant scope.
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: `Matrix Mission ${stamp}`, description: 'd', type: 'one-shot' },
            })
        ).json();
        expect(mission.id).toBeTruthy();

        const work = await createWorkViaAPI(request, token, { name: `Matrix Work ${stamp}` });
        expect(work.id, `work id from ${JSON.stringify(work.raw)}`).toBeTruthy();

        const agentRes = await request.post(`${API_BASE}/api/agents`, {
            headers,
            data: { name: `Matrix Agent ${stamp}`, scope: 'tenant' },
        });
        expect(agentRes.status(), `agent body=${await agentRes.text().catch(() => '')}`).toBe(201);
        const agent = await agentRes.json();
        expect(agent.id).toBeTruthy();

        const tenantSkill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Tenant Scoped ${stamp}`,
        });
        const missionSkill = await createSkill(request, token, {
            ownerType: 'mission',
            ownerId: mission.id,
            title: `Mission Scoped ${stamp}`,
        });
        const workSkill = await createSkill(request, token, {
            ownerType: 'work',
            ownerId: work.id,
            title: `Work Scoped ${stamp}`,
        });
        const agentSkill = await createSkill(request, token, {
            ownerType: 'agent',
            ownerId: agent.id,
            title: `Agent Scoped ${stamp}`,
        });

        const all = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        expect(all.meta.total).toBe(4);

        // ownerType+ownerId filter pinpoints exactly the one skill at each scope.
        const tenantOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=tenant&ownerId=${user.user.id}`, {
                headers,
            })
        ).json();
        expect(tenantOnly.data.map((s: SkillRow) => s.id)).toEqual([tenantSkill.id]);

        const missionOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=mission&ownerId=${mission.id}`, {
                headers,
            })
        ).json();
        expect(missionOnly.data.map((s: SkillRow) => s.id)).toEqual([missionSkill.id]);

        const workOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=work&ownerId=${work.id}`, {
                headers,
            })
        ).json();
        expect(workOnly.data.map((s: SkillRow) => s.id)).toEqual([workSkill.id]);

        const agentOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=agent&ownerId=${agent.id}`, {
                headers,
            })
        ).json();
        expect(agentOnly.data.map((s: SkillRow) => s.id)).toEqual([agentSkill.id]);

        // A correct ownerType paired with a NON-matching ownerId yields nothing.
        const wrongPair = await (
            await request.get(`${API_BASE}/api/skills?ownerType=mission&ownerId=${UNKNOWN_UUID}`, {
                headers,
            })
        ).json();
        expect(wrongPair.data).toEqual([]);

        // Delete ONLY the work-scoped skill; its precise filter empties while the
        // other scopes remain untouched (delete is scoped to the single row).
        const del = await request.delete(`${API_BASE}/api/skills/${workSkill.id}`, { headers });
        expect(del.status()).toBe(200);
        expect(await del.json()).toMatchObject({ deleted: true });

        const workAfter = await (
            await request.get(`${API_BASE}/api/skills?ownerType=work&ownerId=${work.id}`, {
                headers,
            })
        ).json();
        expect(workAfter.data).toEqual([]);

        const remaining = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        expect(remaining.meta.total).toBe(3);
        expect(remaining.data.map((s: SkillRow) => s.id)).toContain(tenantSkill.id);
        expect(remaining.data.map((s: SkillRow) => s.id)).toContain(missionSkill.id);
        expect(remaining.data.map((s: SkillRow) => s.id)).toContain(agentSkill.id);
        expect(remaining.data.map((s: SkillRow) => s.id)).not.toContain(workSkill.id);

        // Re-deleting the now-gone skill → clean 404.
        const delAgain = await request.delete(`${API_BASE}/api/skills/${workSkill.id}`, {
            headers,
        });
        expect([403, 404]).toContain(delAgain.status());
    });

    /**
     * Flow 6 — Delete cascades bindings + cross-user delete is a no-op; plus the
     * catalog-install error surface (missing ownerId 400, unknown slug 404).
     * Proves the (ownerType, ownerId, slug) delete tears down the dependent
     * SkillBinding rows (FK CASCADE) and that another user cannot delete it.
     */
    test('delete cascades bindings + is cross-user-safe; install errors are truthful', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const token = owner.access_token;
        const headers = authedHeaders(token);
        const stamp = Date.now().toString(36);

        const skill = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: owner.user.id,
            title: `Cascade Skill ${stamp}`,
        });

        // Attach two bindings (tenant-wide + a mission target) so we can prove the
        // delete cascades them.
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: `Cascade Mission ${stamp}`, description: 'd', type: 'one-shot' },
            })
        ).json();
        const tenantBinding = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers,
            data: { targetType: 'tenant', priority: 50 },
        });
        expect(tenantBinding.status()).toBe(201);
        const missionBinding = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers,
            data: { targetType: 'mission', targetId: mission.id },
        });
        expect(missionBinding.status()).toBe(201);
        const tbId = (await tenantBinding.json()).id;

        const before = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, { headers })
        ).json();
        expect(before).toHaveLength(2);

        // Cross-user DELETE → 404; the skill (and its bindings) survive.
        const crossDelete = await request.delete(`${API_BASE}/api/skills/${skill.id}`, {
            headers: authedHeaders(other.access_token),
        });
        expect(crossDelete.status()).toBe(404);
        const stillThere = await request.get(`${API_BASE}/api/skills/${skill.id}`, { headers });
        expect(stillThere.status()).toBe(200);

        // Owner DELETE → 200 {deleted:true}, cascading both bindings.
        const del = await request.delete(`${API_BASE}/api/skills/${skill.id}`, { headers });
        expect(del.status()).toBe(200);
        expect(await del.json()).toMatchObject({ deleted: true });

        // The skill is gone (404) and the standalone binding endpoint can no
        // longer find the cascaded binding (404) — proving the FK CASCADE fired.
        const skillAfter = await request.get(`${API_BASE}/api/skills/${skill.id}`, { headers });
        expect([403, 404]).toContain(skillAfter.status());
        const bindingAfter = await request.delete(`${API_BASE}/api/skill-bindings/${tbId}`, {
            headers,
        });
        expect(bindingAfter.status()).toBe(404);

        // Catalog-install error surface (no catalog provider in CI → install of a
        // real slug is impossible; assert the truthful error contract instead).
        const installNoOwner = await request.post(`${API_BASE}/api/skills/install`, {
            headers,
            data: { slug: 'some-skill', ownerType: 'tenant' },
        });
        expect(installNoOwner.status()).toBe(400);
        expect((await installNoOwner.json()).message).toMatch(/ownerId is required/i);

        const installUnknown = await request.post(`${API_BASE}/api/skills/install`, {
            headers,
            data: {
                slug: `definitely-not-real-${stamp}`,
                ownerType: 'tenant',
                ownerId: owner.user.id,
            },
        });
        expect(installUnknown.status()).toBe(404);
        expect((await installUnknown.json()).message).toMatch(/catalog skill .* not found/i);
    });

    /**
     * Flow 7 — UI: a CRUD-created skill (custom slug + explicit version) created
     * via API for the SEEDED storageState user renders on its detail page, and
     * the index hub renders. Driven through the authenticated session. (Distinct
     * from skills.spec.ts's UI test, which asserts a default-slug skill — here we
     * verify the custom-slug + versioned CRUD output surfaces in the UI.)
     */
    test('UI: a custom-slug skill created via the CRUD API renders for the seeded user', async ({
        page,
        request,
    }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.status()).toBe(200);
        const { access_token, user } = await login.json();
        const ownerId = user?.id ?? (await myUserId(request, access_token));
        const stamp = Date.now().toString(36);

        const title = `CRUD UI Skill ${stamp}`;
        const skill = await createSkill(request, access_token, {
            ownerType: 'tenant',
            ownerId,
            title,
            slug: `crud-ui-${stamp}`,
            version: '3.1.4',
            instructionsMd: `# ${title}\n\nrendered body`,
        });
        expect(skill.slug).toBe(`crud-ui-${stamp}`);
        expect(skill.version).toBe('3.1.4');

        // The index hub renders (section toggles present). Navigation uses
        // relative paths against the playwright-configured baseURL.
        await page.goto('/skills', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        await expect(page.getByText(/installed/i).first()).toBeVisible({ timeout: 30_000 });

        // The detail page renders the skill's title heading. Local-vs-CI route
        // divergence: tolerate either the heading or a plain text match.
        await page.goto(`/skills/${skill.id}`, { waitUntil: 'domcontentloaded' });
        await expect(
            page.getByRole('heading', { name: title }).or(page.getByText(title)).first(),
        ).toBeVisible({ timeout: 30_000 });
    });
});
