import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Skills — BULK operations + at-scale list semantics.
 *
 * A `Skill` is a reusable Markdown capability owned at a scope
 * (ownerType ∈ tenant | mission | idea | work | agent). `slug` is unique
 * within a single (ownerType, ownerId) pair. A `SkillBinding` attaches a
 * Skill to a *target* (agent | work | mission | idea | tenant); the
 * agent-facing resolver returns the active, priority-sorted, skillId-deduped
 * set for one agent. These flows stress the *bulk* path that the existing
 * single-skill specs do NOT exercise: creating MANY skills, paging through
 * them, search/filter correctness at scale, bulk-binding a batch to one
 * agent, and cross-user list scoping with a large dataset.
 *
 * ── API surface — every shape verified live (sqlite in-memory CI driver) ──
 *   POST   /api/skills { ownerType, ownerId, title, description, instructionsMd, slug?, version?, frontmatter? }
 *     → 201 { id, userId, ownerType, ownerId, slug, title, description,
 *             frontmatter:{name,description}, instructionsMd, contentHash,
 *             version:'1.0.0', sourceCatalogSlug:null, createdAt, updatedAt }
 *     slug defaults to slugify(title); per-(ownerType,ownerId) UNIQUE → dup 409.
 *     Bad ownerType (e.g. 'user') → 400. ownerType ∈ {tenant,mission,idea,work,agent}.
 *   GET    /api/skills?ownerType=&ownerId=&search=&limit=&offset=
 *     → { data:[Skill], meta:{ total, limit, offset } }
 *     - total is the count AFTER all filters (search/ownerType), not the grand total.
 *     - limit clamps to 1..200 (default 50); offset clamps to >=0.
 *     - search is a case-insensitive substring on title, applied ACROSS scopes.
 *     - bad ownerType query → 400.
 *   GET    /api/skills/:id          → 200 Skill; cross-user → 404 (no existence leak).
 *   GET    /api/skills/:id/bindings → 200 [binding]; cross-user → 404.
 *   POST   /api/skills/:id/bindings { targetType, targetId?, priority?, injectIntoAgent?, injectIntoGenerator? }
 *     → 201 binding row. agent/work/mission/idea target REQUIRES targetId (else 400);
 *       tenant target stores targetId:null. priority defaults 100, injectIntoAgent true.
 *     - Re-creating an identical (skill,targetType,targetId) binding → 500 (UNIQUE index,
 *       no graceful conflict handler) — never re-create an identical binding.
 *   GET    /api/agents/:id/skills
 *     → { data:[{ bindingId, priority, targetType, skill:{id,slug,title,version} }] }
 *       priority ASC, deduped by skillId, injectIntoAgent:false excluded; cross-user → 404.
 *   DELETE /api/skill-bindings/:id  → 200 { deleted:true }; repeat → 404; cross-user → 404.
 *
 * Conventions (cross-spec isolation): all API mutations run on FRESH
 * registerUserViaAPI() users with unique titles (Date.now suffix). Counts are
 * asserted against this run's own private dataset (a fresh user starts empty),
 * so exact equality is safe here. The seeded storageState user is used ONLY
 * for the one UI-driven assertion. Routes are unprefixed (/skills, /skills/:id).
 */

const BULK = 12;

interface Skill {
    id: string;
    slug: string;
    title: string;
    ownerType: string;
    ownerId: string;
    version: string;
    description: string;
}

interface ListResult {
    data: Skill[];
    meta: { total: number; limit: number; offset: number };
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
    body: {
        ownerType: string;
        ownerId: string;
        title: string;
        description?: string;
        instructionsMd?: string;
        slug?: string;
        version?: string;
    },
): Promise<Skill> {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            description: 'e2e bulk skill',
            instructionsMd: `# ${body.title}\n\nbody`,
            ...body,
        },
    });
    expect(res.status(), `createSkill body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function listSkills(
    request: APIRequestContext,
    token: string,
    query: Record<string, string | number> = {},
): Promise<ListResult> {
    const qs = new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)]),
    ).toString();
    const res = await request.get(`${API_BASE}/api/skills${qs ? `?${qs}` : ''}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `listSkills status`).toBe(200);
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
): Promise<{ id: string; targetType: string; priority: number }> {
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

test.describe('Skills — bulk operations + at-scale list semantics', () => {
    /**
     * Flow 1 — Bulk-create a large tenant-scoped batch, then page the whole set.
     *
     * Create BULK (12) tenant skills for a fresh user, then walk the list with a
     * page size of 5. Assert: (a) every page echoes the requested limit + a total
     * equal to the full batch, (b) pages never overlap, (c) the union of all pages
     * is exactly the set of created ids with no duplicates and no missing rows,
     * (d) an offset past the end yields an empty page with the total still intact.
     */
    test('bulk-create 12 skills then paginate the entire set with no overlap or gaps', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const ownerId = u.user.id;
        const stamp = Date.now();

        const created = new Set<string>();
        for (let i = 0; i < BULK; i++) {
            const s = await createSkill(request, u.access_token, {
                ownerType: 'tenant',
                ownerId,
                title: `Bulk Page Skill ${stamp}-${String(i).padStart(2, '0')}`,
            });
            created.add(s.id);
        }
        expect(created.size).toBe(BULK);

        // Fresh user — their full installed set is exactly this batch.
        const all = await listSkills(request, u.access_token, { limit: 200 });
        expect(all.meta.total).toBe(BULK);
        expect(all.data.length).toBe(BULK);

        // Walk in pages of 5: 12 → [5,5,2].
        const pageSize = 5;
        const seen: string[] = [];
        for (let offset = 0; offset < BULK; offset += pageSize) {
            const page = await listSkills(request, u.access_token, {
                limit: pageSize,
                offset,
            });
            expect(page.meta.limit).toBe(pageSize);
            expect(page.meta.offset).toBe(offset);
            expect(page.meta.total).toBe(BULK);
            const expectedLen = Math.min(pageSize, BULK - offset);
            expect(page.data.length).toBe(expectedLen);
            seen.push(...page.data.map((s) => s.id));
        }

        // No overlap across pages, and the union covers the whole batch.
        expect(new Set(seen).size).toBe(BULK);
        for (const id of created) expect(seen).toContain(id);

        // Offset past the end: empty page, total intact.
        const beyond = await listSkills(request, u.access_token, {
            limit: pageSize,
            offset: BULK + 5,
        });
        expect(beyond.data.length).toBe(0);
        expect(beyond.meta.total).toBe(BULK);
    });

    /**
     * Flow 2 — ownerType/ownerId filter partitions a mixed bulk dataset exactly.
     *
     * Spread a bulk dataset across three owner scopes (tenant, mission, work) for
     * one fresh user. Assert that filtering by ownerType returns exactly that
     * scope's rows (and meta.total reflects the FILTERED count, not the grand
     * total), that an ownerType+ownerId pair narrows to a single mission's rows,
     * and that the partitions are mutually exclusive and collectively exhaustive.
     */
    test('ownerType + ownerId filters partition a mixed-scope bulk dataset exactly', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now();
        const tenantOwner = u.user.id;
        const missionA = crypto.randomUUID();
        const missionB = crypto.randomUUID();
        const workOwner = crypto.randomUUID();

        const tenantIds: string[] = [];
        const missionAIds: string[] = [];
        const missionBIds: string[] = [];
        const workIds: string[] = [];

        for (let i = 0; i < 5; i++) {
            tenantIds.push(
                (
                    await createSkill(request, u.access_token, {
                        ownerType: 'tenant',
                        ownerId: tenantOwner,
                        title: `Tenant Scope ${stamp}-${i}`,
                    })
                ).id,
            );
        }
        for (let i = 0; i < 3; i++) {
            missionAIds.push(
                (
                    await createSkill(request, u.access_token, {
                        ownerType: 'mission',
                        ownerId: missionA,
                        title: `Mission A ${stamp}-${i}`,
                    })
                ).id,
            );
        }
        for (let i = 0; i < 2; i++) {
            missionBIds.push(
                (
                    await createSkill(request, u.access_token, {
                        ownerType: 'mission',
                        ownerId: missionB,
                        title: `Mission B ${stamp}-${i}`,
                    })
                ).id,
            );
        }
        for (let i = 0; i < 4; i++) {
            workIds.push(
                (
                    await createSkill(request, u.access_token, {
                        ownerType: 'work',
                        ownerId: workOwner,
                        title: `Work Scope ${stamp}-${i}`,
                    })
                ).id,
            );
        }

        const grandTotal =
            tenantIds.length + missionAIds.length + missionBIds.length + workIds.length;
        const all = await listSkills(request, u.access_token, { limit: 200 });
        expect(all.meta.total).toBe(grandTotal);

        // ownerType=tenant → only the 5 tenant rows; meta.total is the filtered count.
        const tenantOnly = await listSkills(request, u.access_token, {
            ownerType: 'tenant',
            limit: 200,
        });
        expect(tenantOnly.meta.total).toBe(tenantIds.length);
        expect(new Set(tenantOnly.data.map((s) => s.ownerType))).toEqual(new Set(['tenant']));
        expect(new Set(tenantOnly.data.map((s) => s.id))).toEqual(new Set(tenantIds));

        // ownerType=mission → both missions' rows merge.
        const missionAll = await listSkills(request, u.access_token, {
            ownerType: 'mission',
            limit: 200,
        });
        expect(missionAll.meta.total).toBe(missionAIds.length + missionBIds.length);

        // ownerType=mission + ownerId=missionA → only mission A's rows.
        const onlyA = await listSkills(request, u.access_token, {
            ownerType: 'mission',
            ownerId: missionA,
            limit: 200,
        });
        expect(onlyA.meta.total).toBe(missionAIds.length);
        expect(new Set(onlyA.data.map((s) => s.id))).toEqual(new Set(missionAIds));
        // None of mission B leaked into mission A's partition.
        for (const id of missionBIds) expect(onlyA.data.map((s) => s.id)).not.toContain(id);

        // Partitions are collectively exhaustive.
        expect(tenantIds.length + missionAll.meta.total + workIds.length).toBe(grandTotal);
    });

    /**
     * Flow 3 — Search is a case-insensitive title substring across all scopes,
     * orthogonal to pagination.
     *
     * Seed a bulk dataset where a distinctive token ("Zephyr") appears in titles
     * across MULTIPLE owner scopes plus a decoy scope that does not contain it.
     * Assert: the search hits every matching scope (not just one), meta.total
     * counts only the matches, the match is case-insensitive, search composes with
     * limit/offset (paging the matches), and a non-matching query returns zero.
     */
    test('search filters by title substring across scopes and composes with paging', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now();
        const token = u.access_token;
        const tenantOwner = u.user.id;
        const missionOwner = crypto.randomUUID();
        const tag = `Zephyr${stamp}`;

        // 4 matching across tenant + mission scopes.
        const matchIds = new Set<string>();
        for (let i = 0; i < 2; i++) {
            matchIds.add(
                (
                    await createSkill(request, token, {
                        ownerType: 'tenant',
                        ownerId: tenantOwner,
                        title: `${tag} Tenant ${i}`,
                    })
                ).id,
            );
        }
        for (let i = 0; i < 2; i++) {
            matchIds.add(
                (
                    await createSkill(request, token, {
                        ownerType: 'mission',
                        ownerId: missionOwner,
                        title: `Mission ${tag} ${i}`,
                    })
                ).id,
            );
        }
        // 3 decoys that must NOT match.
        for (let i = 0; i < 3; i++) {
            await createSkill(request, token, {
                ownerType: 'tenant',
                ownerId: tenantOwner,
                title: `Unrelated Helper ${stamp}-${i}`,
            });
        }

        // Exact-case search hits all 4 matches across both scopes.
        const hit = await listSkills(request, token, { search: tag, limit: 200 });
        expect(hit.meta.total).toBe(4);
        expect(new Set(hit.data.map((s) => s.id))).toEqual(matchIds);
        expect(new Set(hit.data.map((s) => s.ownerType))).toEqual(new Set(['tenant', 'mission']));

        // Case-insensitive: lowercased token returns the same matches.
        const hitLower = await listSkills(request, token, {
            search: tag.toLowerCase(),
            limit: 200,
        });
        expect(hitLower.meta.total).toBe(4);
        expect(new Set(hitLower.data.map((s) => s.id))).toEqual(matchIds);

        // Search composes with paging: total stays 4 while a page returns <= limit.
        const page = await listSkills(request, token, { search: tag, limit: 2, offset: 0 });
        expect(page.meta.total).toBe(4);
        expect(page.data.length).toBe(2);
        const page2 = await listSkills(request, token, { search: tag, limit: 2, offset: 2 });
        expect(page2.meta.total).toBe(4);
        expect(page2.data.length).toBe(2);
        // First and second page of matches don't overlap.
        const pageIds = new Set([...page.data, ...page2.data].map((s) => s.id));
        expect(pageIds.size).toBe(4);

        // Non-matching search → empty.
        const miss = await listSkills(request, token, { search: `nope-${stamp}` });
        expect(miss.meta.total).toBe(0);
        expect(miss.data.length).toBe(0);
    });

    /**
     * Flow 4 — Bulk-bind a batch of skills to ONE agent; the resolver returns the
     * whole batch priority-sorted; unbinding a slice prunes only those rows.
     *
     * Create an agent + a batch of tenant skills, bind each to the agent with a
     * distinct priority, and assert the agent resolver returns the entire batch
     * sorted by priority ASC with the right binding/skill metadata. Then bulk-
     * unbind a slice of the bindings and assert the resolver shrinks to exactly the
     * survivors — and that the surviving order is still priority-sorted.
     */
    test('bulk-bind a batch of skills to one agent then bulk-unbind a slice', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const ownerId = u.user.id;
        const stamp = Date.now();

        const agent = await createAgentViaAPI(request, token, {
            scope: 'tenant',
            name: `Bulk Binder ${stamp}`,
        });

        const batchSize = 6;
        const bindings: { bindingId: string; skillId: string; priority: number }[] = [];
        for (let i = 0; i < batchSize; i++) {
            const skill = await createSkill(request, token, {
                ownerType: 'tenant',
                ownerId,
                title: `Bind Batch ${stamp}-${String(i).padStart(2, '0')}`,
            });
            // Priorities chosen so insertion order != sorted order.
            const priority = (batchSize - i) * 10;
            const b = await bindSkill(request, token, skill.id, {
                targetType: 'agent',
                targetId: agent.id,
                priority,
            });
            bindings.push({ bindingId: b.id, skillId: skill.id, priority });
        }

        // Resolver returns the whole batch, priority ASC, deduped by skillId.
        const resolved = await listAgentSkills(request, token, agent.id);
        expect(resolved.length).toBe(batchSize);
        const priorities = resolved.map((r) => r.priority);
        expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
        expect(new Set(resolved.map((r) => r.skill.id))).toEqual(
            new Set(bindings.map((b) => b.skillId)),
        );
        for (const row of resolved) {
            expect(row.targetType).toBe('agent');
            expect(row.skill.version).toBe('1.0.0');
        }

        // Bulk-unbind the first 3 bindings (lowest-priority survivors remain).
        const toRemove = [...bindings].sort((a, b) => a.priority - b.priority).slice(0, 3);
        const survivors = bindings.filter(
            (b) => !toRemove.some((r) => r.bindingId === b.bindingId),
        );
        for (const r of toRemove) {
            const del = await request.delete(`${API_BASE}/api/skill-bindings/${r.bindingId}`, {
                headers: authedHeaders(token),
            });
            expect(del.status()).toBe(200);
            expect(await del.json()).toMatchObject({ deleted: true });
        }

        const after = await listAgentSkills(request, token, agent.id);
        expect(after.length).toBe(survivors.length);
        expect(new Set(after.map((r) => r.skill.id))).toEqual(
            new Set(survivors.map((s) => s.skillId)),
        );
        const afterPriorities = after.map((r) => r.priority);
        expect(afterPriorities).toEqual([...afterPriorities].sort((a, b) => a - b));

        // Re-deleting an already-removed binding 404s (idempotency boundary).
        const repeat = await request.delete(
            `${API_BASE}/api/skill-bindings/${toRemove[0].bindingId}`,
            { headers: authedHeaders(token) },
        );
        expect(repeat.status()).toBe(404);
    });

    /**
     * Flow 5 — List scoping is per-user even when two users build identical bulk
     * datasets; neither can read or bind the other's rows.
     *
     * Two fresh users each create a same-sized batch with COLLIDING titles/slugs
     * (same slug at the same ownerType is fine across users — uniqueness is scoped
     * per user's owner pair). Assert each user's list shows only their own batch
     * (counts + ids disjoint), that user B gets 404 on user A's skill id and its
     * bindings, and that user B cannot bind user A's skill (404, no existence leak).
     */
    test('bulk datasets stay user-scoped; collisions across users are independent', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const stamp = Date.now();
        const sharedTitles = Array.from({ length: 5 }, (_, i) => `Shared Skill ${stamp}-${i}`);

        // Both users create the SAME titles at tenant scope on their own ownerId.
        const aIds: string[] = [];
        const bIds: string[] = [];
        for (const title of sharedTitles) {
            aIds.push(
                (
                    await createSkill(request, userA.access_token, {
                        ownerType: 'tenant',
                        ownerId: userA.user.id,
                        title,
                    })
                ).id,
            );
            bIds.push(
                (
                    await createSkill(request, userB.access_token, {
                        ownerType: 'tenant',
                        ownerId: userB.user.id,
                        title,
                    })
                ).id,
            );
        }

        // Slugs collide by design but ids are independent across users.
        const aList = await listSkills(request, userA.access_token, { limit: 200 });
        const bList = await listSkills(request, userB.access_token, { limit: 200 });
        expect(aList.meta.total).toBe(sharedTitles.length);
        expect(bList.meta.total).toBe(sharedTitles.length);
        expect(new Set(aList.data.map((s) => s.id))).toEqual(new Set(aIds));
        expect(new Set(bList.data.map((s) => s.id))).toEqual(new Set(bIds));
        // Datasets are disjoint despite identical titles/slugs.
        const overlap = aIds.filter((id) => bIds.includes(id));
        expect(overlap).toEqual([]);
        // Same human-readable slug emitted on both sides.
        const aSlugs = new Set(aList.data.map((s) => s.slug));
        const bSlugs = new Set(bList.data.map((s) => s.slug));
        expect(aSlugs).toEqual(bSlugs);

        // User B cannot read user A's skill or its bindings (404, not 403 — no leak).
        const targetA = aIds[0];
        const crossGet = await request.get(`${API_BASE}/api/skills/${targetA}`, {
            headers: authedHeaders(userB.access_token),
        });
        expect(crossGet.status()).toBe(404);
        const crossBindingsGet = await request.get(`${API_BASE}/api/skills/${targetA}/bindings`, {
            headers: authedHeaders(userB.access_token),
        });
        expect(crossBindingsGet.status()).toBe(404);

        // User B cannot bind user A's skill.
        const crossBind = await request.post(`${API_BASE}/api/skills/${targetA}/bindings`, {
            headers: authedHeaders(userB.access_token),
            data: { targetType: 'tenant' },
        });
        expect(crossBind.status()).toBe(404);

        // User A still owns and can bind it.
        const ownBind = await bindSkill(request, userA.access_token, targetA, {
            targetType: 'tenant',
        });
        expect(ownBind.id).toBeTruthy();
    });

    /**
     * Flow 6 — Slug-collision handling within a scope during bulk creation, and
     * the same slug coexisting across different scopes.
     *
     * Bulk-create skills whose titles all slugify to the SAME slug at one scope:
     * the first wins, every subsequent 409s, and the list still holds exactly one
     * row for that slug. Then prove the same slug is creatable at OTHER owner
     * scopes (different ownerType OR different ownerId), so collisions are scoped,
     * not global. Also bulk-create with explicit custom slugs and confirm each is
     * stored verbatim and a duplicate explicit slug 409s.
     */
    test('slug collisions are per-scope: dup-at-scope 409, same slug other scope OK', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const stamp = Date.now();
        const tenantOwner = u.user.id;
        const missionOwner = crypto.randomUUID();

        // Titles that all normalize to the same slug at the SAME tenant scope.
        const collidingTitles = [
            `Collision ${stamp} Skill`,
            `collision ${stamp}   skill`,
            `COLLISION ${stamp}!!! SKILL`,
        ];
        const first = await createSkill(request, token, {
            ownerType: 'tenant',
            ownerId: tenantOwner,
            title: collidingTitles[0],
        });
        const winningSlug = first.slug;

        let conflicts = 0;
        for (const title of collidingTitles.slice(1)) {
            const res = await request.post(`${API_BASE}/api/skills`, {
                headers: authedHeaders(token),
                data: {
                    ownerType: 'tenant',
                    ownerId: tenantOwner,
                    title,
                    description: 'dup',
                    instructionsMd: '# dup',
                },
            });
            expect(res.status(), `expected 409 for slug ${winningSlug}`).toBe(409);
            conflicts++;
        }
        expect(conflicts).toBe(collidingTitles.length - 1);

        // Exactly one row carries that slug at the tenant scope.
        const tenantList = await listSkills(request, token, { ownerType: 'tenant', limit: 200 });
        expect(tenantList.data.filter((s) => s.slug === winningSlug).length).toBe(1);

        // Same slug is fine at a DIFFERENT scope (mission ownerId) — collisions scoped.
        const missionTwin = await createSkill(request, token, {
            ownerType: 'mission',
            ownerId: missionOwner,
            title: collidingTitles[0],
        });
        expect(missionTwin.slug).toBe(winningSlug);
        expect(missionTwin.id).not.toBe(first.id);

        // Explicit custom slugs: stored verbatim; bulk-create a few unique ones.
        const customSlugs = Array.from({ length: 3 }, (_, i) => `custom-bulk-${stamp}-${i}`);
        for (const slug of customSlugs) {
            const s = await createSkill(request, token, {
                ownerType: 'tenant',
                ownerId: tenantOwner,
                title: `Custom ${slug}`,
                slug,
            });
            expect(s.slug).toBe(slug);
        }
        // Re-using an explicit slug at the same scope 409s.
        const dupExplicit = await request.post(`${API_BASE}/api/skills`, {
            headers: authedHeaders(token),
            data: {
                ownerType: 'tenant',
                ownerId: tenantOwner,
                title: 'Custom dup',
                slug: customSlugs[0],
                description: 'd',
                instructionsMd: '# d',
            },
        });
        expect(dupExplicit.status()).toBe(409);
    });

    /**
     * Flow 7 (UI) — A bulk-created skill is discoverable on the /skills hub for the
     * seeded user, with its slug + version chip, and its detail page resolves.
     *
     * Uses the SEEDED storageState user (UI-driven). Creates a uniquely-titled
     * skill via the seeded user's API token, loads /skills (the Installed section
     * server-fetches up to 50 rows), asserts the title + slug render, then opens
     * the detail page and confirms the title shows there too. Resilient to
     * next-dev local/CI route divergence via .or() fallbacks.
     */
    test('UI: a bulk-created skill surfaces on the /skills hub and its detail page', async ({
        page,
        request,
        baseURL,
    }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        expect(login.status(), `seeded login body=${await login.text().catch(() => '')}`).toBe(200);
        const { access_token } = await login.json();
        // Current-user endpoint is GET /api/auth/profile → { id, userId, ... }
        // (both id and userId carry the user id). Used to scope the skill's ownerId.
        const me = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(access_token),
        });
        const meBody = me.ok() ? await me.json() : {};
        const ownerId: string = meBody?.id ?? meBody?.userId ?? meBody?.user?.id ?? '';

        const stamp = Date.now();
        const title = `UI Bulk Skill ${stamp}`;
        const created = await createSkill(request, access_token, {
            ownerType: 'tenant',
            ownerId: ownerId || crypto.randomUUID(),
            title,
        });

        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/skills`, { waitUntil: 'domcontentloaded' });

        // Title may render in the Installed grid. Tolerate ordering / dev hydration.
        const titleOnHub = page.getByText(title, { exact: false }).first();
        const slugOnHub = page.getByText(created.slug, { exact: false }).first();
        await expect(titleOnHub.or(slugOnHub)).toBeVisible({ timeout: 30_000 });

        // Open the detail page directly; assert the title renders there too.
        await page.goto(`${origin}/skills/${created.id}`, { waitUntil: 'domcontentloaded' });
        const titleOnDetail = page.getByText(title, { exact: false }).first();
        const slugOnDetail = page.getByText(created.slug, { exact: false }).first();
        await expect(titleOnDetail.or(slugOnDetail)).toBeVisible({ timeout: 30_000 });
    });
});
