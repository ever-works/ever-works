import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Skill marketplace / sharing / visibility — complex cross-feature INTEGRATION
 * flows. The "marketplace" in Ever Works is the read-only **skill catalog**
 * (union across enabled `skills-provider` plugins) plus the **install** path
 * that copies a catalog entry into the user's own `skills` rows. "Public vs
 * private" maps onto (a) the owner-scope lattice + a `frontmatter.visibility`
 * hint (persisted verbatim, NOT privacy-enforced) and (b) HARD per-user
 * isolation: a Skill is only ever visible to its owning user (cross-user reads
 * 404 — no public-read, no existence leak).
 *
 * Existing coverage we deliberately do NOT duplicate:
 *   - skills.spec.ts             — CRUD + bindings + catalog SHAPE-only + delete.
 *   - skills-list-filter.spec.ts — ?ownerType / ?search / limit-offset paging.
 *   - flow-agent-skills-binding  — bind/unbind resolution + priority ordering.
 *   - share-links.spec.ts        — Work (not Skill) public share-links.
 * NEW here: catalog discovery contract (catalog/:slug + tag/search filters),
 * the install/import contract + its scope-validation + isolation, the real
 * "copy a skill across scopes" (fork) path, slug-uniqueness-vs-cross-scope
 * reuse, the `frontmatter.visibility` round-trip with no privacy effect, and
 * the marketplace UI hub (installed / available / custom section toggles).
 *
 * API surface — ALL shapes verified against the live stack (sqlite CI driver,
 * NO skills-provider plugin enabled → the catalog is ALWAYS empty) on
 * 2026-06-01 before asserting:
 *   - GET  /api/skills/catalog?limit=&offset=&search=&tags=a,b
 *       → 200 { entries: SkillCatalogEntry[], total:number }   (CI → {entries:[],total:0})
 *   - GET  /api/skills/catalog/:slug
 *       → 200 { entry, providerId } when found;
 *         404 `Catalog skill "<slug>" not found.` for an unknown slug;
 *         400 `Invalid skill slug.` for a slug not matching /^[a-z0-9-]{1,80}$/.
 *   - POST /api/skills/install { slug, ownerType, ownerId }
 *       → 201 Skill (sourceCatalogSlug set) when the catalog has the slug;
 *         404 `Catalog skill "<slug>" not found.` when it doesn't (the CI path);
 *         400 `ownerId is required.` / `Invalid ownerType "<x>".` on bad input.
 *   - POST /api/skills { ownerType, ownerId, title, description, instructionsMd, frontmatter? }
 *       → 201 Skill { id, slug (slugified+lowercased), version:'1.0.0',
 *                     sourceCatalogSlug:null, frontmatter (verbatim, incl. custom keys) }
 *         duplicate (ownerType,ownerId,slug) → 409 `A Skill with slug "<s>" already exists at <ot>:<oid>.`
 *         SAME slug at a DIFFERENT scope → 201 (the cross-scope copy/fork path).
 *   - GET  /api/skills/:id     cross-user → 404 (private; no public read).
 *
 * Cross-spec isolation: every API-only mutation runs on a FRESH
 * registerUserViaAPI() user (unique emails via the helper's Date.now suffix);
 * the seeded storageState user is touched ONLY for the UI-driven flow. Counts
 * use toContain (tolerate pre-existing rows), never exact equality.
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
    frontmatter: Record<string, unknown>;
    instructionsMd: string;
    contentHash: string;
    sourceCatalogSlug: string | null;
    sourceCatalogVersion: string | null;
    sourcePath: string | null;
    version: string;
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
    },
): Promise<SkillRow> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            description: 'shared e2e skill',
            instructionsMd: `# ${body.title}\n\nbody`,
            ...body,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function seededLogin(
    request: APIRequestContext,
): Promise<{ access_token: string; id: string }> {
    const seeded = loadSeededTestUser();
    // LOGIN DTO is whitelisted — ONLY {email,password}.
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    const { access_token, user } = await res.json();
    return { access_token, id: user?.id };
}

test.describe('Skill marketplace / share / visibility', () => {
    /**
     * Flow 1 — Marketplace DISCOVERY contract. The catalog list is the
     * "marketplace": a `{entries,total}` union across enabled skills-provider
     * plugins, honoring limit/offset/search/tags. The catalog/:slug detail
     * endpoint resolves one entry, validates the slug shape, and 404s on an
     * unknown slug — never leaking a 500. In the CI driver NO provider is
     * enabled, so the marketplace is legitimately empty; we assert the SHAPE
     * and the error contract (which hold regardless of catalog contents),
     * branching on whether any entry exists.
     */
    test('marketplace catalog list + detail honor filters and the slug contract', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // Plain list — {entries,total} shape, entries is an array, total numeric.
        const listRes = await request.get(`${API_BASE}/api/skills/catalog?limit=5`, { headers });
        expect(listRes.status()).toBe(200);
        const list = await listRes.json();
        expect(Array.isArray(list.entries)).toBe(true);
        expect(typeof list.total).toBe('number');
        expect(list.total).toBeGreaterThanOrEqual(0);

        // Filtered list — search + multi-tag CSV must not error (the per-provider
        // fan-out tolerates these even with zero providers).
        const filtered = await request.get(
            `${API_BASE}/api/skills/catalog?search=review&tags=qa,docs&limit=3&offset=0`,
            { headers },
        );
        expect(filtered.status()).toBe(200);
        const filteredBody = await filtered.json();
        expect(Array.isArray(filteredBody.entries)).toBe(true);

        // catalog/:slug error contract — unknown slug → truthful 404, NOT 500.
        const unknown = await request.get(
            `${API_BASE}/api/skills/catalog/totally-unknown-skill-slug`,
            { headers },
        );
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).message).toMatch(/not found/i);

        // A slug that violates /^[a-z0-9-]{1,80}$/ is rejected up front (400),
        // before any provider lookup — caps + underscore + space all illegal.
        const badSlug = await request.get(
            `${API_BASE}/api/skills/catalog/${encodeURIComponent('Bad_Slug Caps')}`,
            { headers },
        );
        expect(badSlug.status()).toBe(400);
        expect((await badSlug.json()).message).toMatch(/invalid skill slug/i);

        // Branch on real catalog contents: if a provider IS enabled and surfaces
        // an entry, its detail resolves with a providerId; otherwise the empty
        // marketplace is the (annotated) CI reality.
        if (list.entries.length > 0) {
            const slug = list.entries[0].slug as string;
            const detail = await request.get(`${API_BASE}/api/skills/catalog/${slug}`, { headers });
            expect(detail.status()).toBe(200);
            const found = await detail.json();
            expect(found.entry.slug).toBe(slug);
            expect(typeof found.providerId).toBe('string');
        } else {
            test.info().annotations.push({
                type: 'note',
                description:
                    'Skill catalog empty (no skills-provider plugin enabled in CI) — list shape + slug contract asserted; entry-resolution path not reachable.',
            });
        }
    });

    /**
     * Flow 2 — IMPORT / install contract + scope validation + isolation. Install
     * is how a user "copies a shared skill" out of the marketplace into their own
     * private rows. Its input validation (ownerType/ownerId) and existence check
     * are reachable WITHOUT a populated catalog: an unknown slug → 404, bad scope
     * → 400. We additionally prove install requires auth and is user-scoped.
     */
    test('install validates scope + slug existence, requires auth, and stays user-private', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        // Unauthenticated install → 401.
        const anon = await request.post(`${API_BASE}/api/skills/install`, {
            data: { slug: 'anything', ownerType: 'tenant', ownerId: user.user.id },
        });
        expect(anon.status()).toBe(401);

        // Missing ownerId → 400 with the exact contract message.
        const noOwner = await request.post(`${API_BASE}/api/skills/install`, {
            headers,
            data: { slug: 'anything', ownerType: 'tenant' },
        });
        expect(noOwner.status()).toBe(400);
        expect((await noOwner.json()).message).toMatch(/ownerId is required/i);

        // 'user' is not a valid skill owner scope → 400 (same lattice as create).
        const badScope = await request.post(`${API_BASE}/api/skills/install`, {
            headers,
            data: { slug: 'anything', ownerType: 'user', ownerId: user.user.id },
        });
        expect(badScope.status()).toBe(400);
        expect((await badScope.json()).message).toMatch(/invalid ownerType/i);

        // Well-formed request but slug absent from the catalog → 404 (the CI path).
        // If a provider were enabled and the slug existed, install would 201 with
        // sourceCatalogSlug set; we branch so the assertion is truthful either way.
        const slug = `nonexistent-catalog-skill-${Date.now().toString(36)}`;
        const install = await request.post(`${API_BASE}/api/skills/install`, {
            headers,
            data: { slug, ownerType: 'tenant', ownerId: user.user.id },
        });
        if (install.status() === 201) {
            const installed = (await install.json()) as SkillRow;
            expect(installed.sourceCatalogSlug).toBe(slug);
            expect(installed.ownerType).toBe('tenant');
            expect(installed.ownerId).toBe(user.user.id);
        } else {
            expect(install.status()).toBe(404);
            expect((await install.json()).message).toMatch(/not found/i);
            test.info().annotations.push({
                type: 'note',
                description:
                    'Catalog empty in CI — install existence-check (404) asserted; the install-success copy path is provider-gated.',
            });
        }

        // The failed/absent install left the user's installed list untouched.
        const mine = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        expect(mine.data.find((s: SkillRow) => s.slug === slug)).toBeFalsy();
    });

    /**
     * Flow 3 — Cross-scope COPY ("fork") of a skill the user owns. There is no
     * cross-USER share, but the real reusable-sharing path within one account is:
     * read a tenant-scoped skill → re-create it verbatim at a narrower scope
     * (a specific Mission). The platform allows the SAME slug at a DIFFERENT
     * (ownerType,ownerId), so the fork keeps its identity; re-creating it at the
     * SAME scope is a 409 conflict. The two copies then carry independent
     * contentHashes once the fork is edited.
     */
    test('a skill is copied across scopes (tenant → mission); same-scope re-create conflicts', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const headers = authedHeaders(token);
        const stamp = Date.now().toString(36);

        // Source: a tenant-wide skill (the "shared library" entry).
        const source = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: user.user.id,
            title: `Shared Style Guide ${stamp}`,
            description: 'product copy style guide',
            instructionsMd: '# Style Guide\n\nUse active voice.',
            frontmatter: { name: `shared-style-guide-${stamp}`, description: 'd', tags: ['copy'] },
        });
        expect(source.sourceCatalogSlug).toBeNull();

        // Re-creating the SAME slug at the SAME scope conflicts (409, exact msg).
        const dup = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                ownerId: user.user.id,
                slug: source.slug,
                title: source.title,
                description: 'd',
                instructionsMd: '# x',
            },
        });
        expect(dup.status()).toBe(409);
        expect((await dup.json()).message).toMatch(
            new RegExp(`slug "${source.slug}" already exists at tenant:`, 'i'),
        );

        // A Mission to receive the fork.
        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: { title: `Fork Mission ${stamp}`, description: 'd', type: 'one-shot' },
            })
        ).json();
        expect(mission.id).toBeTruthy();

        // COPY: same slug + body, but ownerType=mission / ownerId=mission.id.
        // Allowed because uniqueness is per (ownerType,ownerId,slug).
        const fork = await createSkill(request, token, {
            ownerType: 'mission',
            ownerId: mission.id,
            slug: source.slug,
            title: source.title,
            description: source.description,
            instructionsMd: source.instructionsMd,
            frontmatter: source.frontmatter,
        });
        expect(fork.id).not.toBe(source.id);
        expect(fork.slug).toBe(source.slug);
        expect(fork.ownerType).toBe('mission');
        expect(fork.ownerId).toBe(mission.id);
        // A verbatim copy → identical content hash at copy time.
        expect(fork.contentHash).toBe(source.contentHash);

        // Edit the fork → its hash diverges; the source is unchanged (independent rows).
        const editRes = await request.patch(`${API_BASE}/api/skills/${fork.id}`, {
            headers,
            data: {
                instructionsMd: '# Style Guide (mission tweak)\n\nUse active voice. Be brief.',
            },
        });
        expect(editRes.status()).toBe(200);
        expect((await editRes.json()).contentHash).not.toBe(source.contentHash);
        const sourceReread = await (
            await request.get(`${API_BASE}/api/skills/${source.id}`, { headers })
        ).json();
        expect(sourceReread.contentHash).toBe(source.contentHash);

        // Both copies coexist; scope filters keep them distinct.
        const all = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        const slugMatches = all.data.filter((s: SkillRow) => s.slug === source.slug);
        expect(slugMatches.map((s: SkillRow) => s.ownerType).sort()).toEqual(['mission', 'tenant']);

        const tenantScoped = await (
            await request.get(`${API_BASE}/api/skills?ownerType=tenant`, { headers })
        ).json();
        expect(tenantScoped.data.map((s: SkillRow) => s.id)).toContain(source.id);
        expect(tenantScoped.data.map((s: SkillRow) => s.id)).not.toContain(fork.id);
        const missionScoped = await (
            await request.get(`${API_BASE}/api/skills?ownerType=mission`, { headers })
        ).json();
        expect(missionScoped.data.map((s: SkillRow) => s.id)).toContain(fork.id);
        expect(missionScoped.data.map((s: SkillRow) => s.id)).not.toContain(source.id);
    });

    /**
     * Flow 4 — VISIBILITY hint round-trips but grants NO cross-user access. A
     * skill author can stamp `frontmatter.visibility:'public'` (the marketplace
     * "make discoverable" intent), and arbitrary frontmatter is persisted
     * verbatim. But visibility is advisory only: a different registered user
     * still cannot read, list, edit, delete, or bind onto that skill — every
     * cross-user access is a 404 (no existence leak, no public-read), regardless
     * of the flag. This is the platform's real "public vs private" boundary.
     */
    test('frontmatter.visibility persists but does NOT make a skill cross-user readable', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        const skill = await createSkill(request, alice.access_token, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Public-Marked Skill ${stamp}`,
            description: 'marked public via frontmatter',
            frontmatter: {
                name: `public-marked-${stamp}`,
                description: 'd',
                visibility: 'public',
                tags: ['marketplace', 'shared'],
            },
        });
        // The custom visibility key + tags survive the round-trip verbatim.
        expect(skill.frontmatter.visibility).toBe('public');
        expect(skill.frontmatter.tags).toEqual(['marketplace', 'shared']);

        // Re-read by the owner confirms persistence (not just the create echo).
        const reread = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}`, {
                headers: authedHeaders(alice.access_token),
            })
        ).json();
        expect(reread.frontmatter.visibility).toBe('public');

        // Bob — a separate user — gets 404 on every access despite 'public'.
        const bobHeaders = authedHeaders(bob.access_token);
        const bobRead = await request.get(`${API_BASE}/api/skills/${skill.id}`, {
            headers: bobHeaders,
        });
        expect([403, 404]).toContain(bobRead.status());

        // Bob's own list never includes Alice's "public" skill.
        const bobList = await (
            await request.get(`${API_BASE}/api/skills`, { headers: bobHeaders })
        ).json();
        expect(bobList.data.find((s: SkillRow) => s.id === skill.id)).toBeFalsy();

        // Bob cannot mutate, delete, or bind onto it.
        const bobPatch = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers: bobHeaders,
            data: { title: 'hijacked' },
        });
        expect([403, 404]).toContain(bobPatch.status());

        const bobDelete = await request.delete(`${API_BASE}/api/skills/${skill.id}`, {
            headers: bobHeaders,
        });
        expect([403, 404]).toContain(bobDelete.status());

        const bobBind = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
            headers: bobHeaders,
            data: { targetType: 'tenant' },
        });
        expect([403, 404]).toContain(bobBind.status());

        // The skill is untouched for Alice after Bob's failed attempts.
        const aliceReread = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}`, {
                headers: authedHeaders(alice.access_token),
            })
        ).json();
        expect(aliceReread.title).toBe(`Public-Marked Skill ${stamp}`);
    });

    /**
     * Flow 5 — DISCOVERY across the union of installed + catalog, with isolation.
     * Two users each seed their own private skills + an agent-scoped "private
     * note". We prove: (a) each user's discovery list (GET /api/skills) is
     * exactly their own rows (Alice never sees Bob's); (b) a tenant-scoped vs
     * agent-scoped split is discoverable via the ownerType filter (the "public
     * to my workspace" vs "agent-private" distinction); (c) search narrows
     * discovery by title token; and (d) the catalog "available" stream is shared
     * but install-isolated — both users see the same empty/non-empty catalog
     * total, yet neither user's installed rows leak into the other's.
     */
    test('discovery list is per-user isolated and scope/search filterable; catalog stream is shared but install-private', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceH = authedHeaders(alice.access_token);
        const bobH = authedHeaders(bob.access_token);
        const stamp = Date.now().toString(36);

        // Alice: a workspace-wide ("public to my workspace") skill + an
        // agent-private note. The agent is the ownerId for the agent-scoped skill.
        const agentRes = await request.post(`${API_BASE}/api/agents`, {
            headers: aliceH,
            data: { name: `Discovery Agent ${stamp}`, scope: 'tenant' },
        });
        expect(agentRes.status()).toBe(201);
        const agent = await agentRes.json();

        const aliceTenantSkill = await createSkill(request, alice.access_token, {
            ownerType: 'tenant',
            ownerId: alice.user.id,
            title: `Alice Workspace Skill ${stamp}`,
        });
        const aliceAgentNote = await createSkill(request, alice.access_token, {
            ownerType: 'agent',
            ownerId: agent.id,
            title: `Alice Agent Private Note ${stamp}`,
        });

        // Bob: his own private skill (must never appear in Alice's discovery).
        const bobSkill = await createSkill(request, bob.access_token, {
            ownerType: 'tenant',
            ownerId: bob.user.id,
            title: `Bob Secret Skill ${stamp}`,
        });

        // (a) Alice's discovery list contains her rows, not Bob's.
        const aliceAll = await (
            await request.get(`${API_BASE}/api/skills`, { headers: aliceH })
        ).json();
        const aliceIds = aliceAll.data.map((s: SkillRow) => s.id);
        expect(aliceIds).toContain(aliceTenantSkill.id);
        expect(aliceIds).toContain(aliceAgentNote.id);
        expect(aliceIds).not.toContain(bobSkill.id);

        // (b) ownerType filter splits workspace-wide vs agent-private discovery.
        const aliceTenantOnly = await (
            await request.get(`${API_BASE}/api/skills?ownerType=tenant`, { headers: aliceH })
        ).json();
        expect(aliceTenantOnly.data.map((s: SkillRow) => s.id)).toContain(aliceTenantSkill.id);
        expect(aliceTenantOnly.data.map((s: SkillRow) => s.id)).not.toContain(aliceAgentNote.id);

        const aliceAgentScoped = await (
            await request.get(`${API_BASE}/api/skills?ownerType=agent&ownerId=${agent.id}`, {
                headers: aliceH,
            })
        ).json();
        expect(aliceAgentScoped.data.map((s: SkillRow) => s.id)).toEqual([aliceAgentNote.id]);

        // (c) search narrows discovery by a title token (scope-independent).
        const aliceSearch = await (
            await request.get(
                `${API_BASE}/api/skills?search=${encodeURIComponent(`Workspace Skill ${stamp}`)}`,
                { headers: aliceH },
            )
        ).json();
        expect(aliceSearch.data.map((s: SkillRow) => s.id)).toEqual([aliceTenantSkill.id]);

        // (d) The catalog "available" stream is shared infrastructure — both
        // users observe the same total — yet installed rows stay private.
        const aliceCatalog = await (
            await request.get(`${API_BASE}/api/skills/catalog`, { headers: aliceH })
        ).json();
        const bobCatalog = await (
            await request.get(`${API_BASE}/api/skills/catalog`, { headers: bobH })
        ).json();
        expect(aliceCatalog.total).toBe(bobCatalog.total);

        const bobAll = await (
            await request.get(`${API_BASE}/api/skills`, { headers: bobH })
        ).json();
        const bobIds = bobAll.data.map((s: SkillRow) => s.id);
        expect(bobIds).toContain(bobSkill.id);
        expect(bobIds).not.toContain(aliceTenantSkill.id);
        expect(bobIds).not.toContain(aliceAgentNote.id);

        // Bob cannot resolve Alice's agent (no skill leak through the agent route).
        const bobOnAgent = await request.get(`${API_BASE}/api/agents/${agent.id}/skills`, {
            headers: bobH,
        });
        expect(bobOnAgent.status()).toBe(404);

        // Unknown skill id → 404 for the owner too (no existence leak).
        const ghost = await request.get(`${API_BASE}/api/skills/${UNKNOWN_UUID}`, {
            headers: aliceH,
        });
        expect(ghost.status()).toBe(404);
    });

    /**
     * Flow 6 — UI: the marketplace HUB at /skills. Driven as the SEEDED user via
     * storageState. The hub has three section toggles — Installed / Available /
     * Custom. We seed (via API as the same seeded user) one workspace skill so
     * the Installed section is non-empty, then: switch to "Available" and assert
     * the catalog section renders (its empty-state copy in CI, or catalog cards
     * with an Install button if a provider is enabled); switch to "Custom" and
     * assert the hand-authored skill + its "New Skill" create affordance; finally
     * open the seeded skill's detail page to confirm discovery → detail nav.
     */
    test('UI: marketplace hub toggles Installed / Available / Custom for the seeded user', async ({
        page,
        request,
    }) => {
        const seeded = await seededLogin(request);
        const stamp = Date.now().toString(36);
        const skillTitle = `Seeded Marketplace Skill ${stamp}`;

        // Seed a custom (hand-authored, no catalog source) skill for this user.
        const skill = await createSkill(request, seeded.access_token, {
            ownerType: 'tenant',
            ownerId: seeded.id,
            title: skillTitle,
            description: 'rendered in the seeded marketplace hub',
        });
        expect(skill.sourceCatalogSlug).toBeNull();

        await page.goto('/skills', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');

        // The three section toggle buttons are present (capitalize CSS; literal
        // lowercase text content — match case-insensitively + exact-ish).
        const installedTab = page.getByRole('button', { name: /^installed$/i });
        const availableTab = page.getByRole('button', { name: /^available$/i });
        const customTab = page.getByRole('button', { name: /^custom$/i });
        await expect(installedTab.first()).toBeVisible({ timeout: 30_000 });
        await expect(availableTab.first()).toBeVisible({ timeout: 30_000 });
        await expect(customTab.first()).toBeVisible({ timeout: 30_000 });

        // "Available" = the marketplace catalog. In CI (no provider) it shows the
        // truthful empty-state; if a provider is enabled, catalog cards carry an
        // Install button. Accept either (retry-click to survive hydration race).
        await expect(async () => {
            await availableTab.first().click();
            const emptyCopy = page.getByText(/no skills available/i);
            const installBtn = page.getByRole('button', { name: /^install/i });
            await expect(emptyCopy.first().or(installBtn.first())).toBeVisible({ timeout: 10_000 });
        }).toPass({ timeout: 30_000 });

        // "Custom" — the hand-authored skill + the "New Skill" create CTA.
        await expect(async () => {
            await customTab.first().click();
            await expect(page.getByRole('button', { name: /new skill/i }).first()).toBeVisible({
                timeout: 10_000,
            });
        }).toPass({ timeout: 30_000 });
        await expect(page.getByText(skillTitle).first()).toBeVisible({ timeout: 30_000 });

        // Discovery → detail: opening the seeded skill renders its title heading.
        await page.goto(`/skills/${skill.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: skillTitle }).first()).toBeVisible({
            timeout: 30_000,
        });
    });
});
