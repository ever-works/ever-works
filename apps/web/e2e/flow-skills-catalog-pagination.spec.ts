/**
 * Skills — installed-list {data,meta} + catalog {entries,total}: PAGINATION,
 * ORDERING, FILTERING & EDGES (deep, API-orchestrated). #e2e-1000
 *
 * The Skills read API has three list-ish surfaces, each with distinct paging
 * contracts. This file pins the *real* shapes/status/ordering observed live
 * against the sqlite in-memory stack (http://127.0.0.1:3100) — it deliberately
 * avoids happy-path CRUD (covered by skills.spec.ts / flow-skill-crud-scoping)
 * and the shallow ownerType/search smoke in skills-list-filter.spec.ts, going
 * deep on the paging math + edge behavior instead.
 *
 *   GET /api/skills                → { data: Skill[], meta:{ total, limit, offset } }
 *       • DB-backed, per-user scoped, ORDER BY updatedAt DESC (second-granular
 *         ties → order among ties is stable-within-a-request but unspecified).
 *       • limit ∈ [1,200] default 50 (0→400, 201→400, non-int→400);
 *         offset ≥ 0 default 0 (−1→400, non-int→400); offset-past-end → [] with
 *         total preserved. meta echoes the *requested* limit/offset.
 *       • filters: ownerType (enum; bogus→400), ownerId (UUID; non-uuid→400,
 *         foreign/nil uuid → empty 200), search (title|slug|description,
 *         case-insensitive contains, LIKE-metachar `%` escaped, ≤500 chars).
 *
 *   GET /api/skills/catalog        → { entries: SkillCatalogEntry[], total }
 *       • plugin-backed union (provider `everworks-skills`), deterministic
 *         insertion order, entry keys {slug,title,description,frontmatter,body,
 *         version,tags,sourceUrl}. Same limit/offset bounds; NO meta echo.
 *         search narrows; tags = OR/any-of union (each ≤80 chars).
 *
 *   GET /api/skills/catalog/:slug  → { entry, providerId } | 404
 *       • slug must match /^[a-z0-9-]{1,80}$/ (else 400 "Invalid skill slug.").
 *
 *   GET /api/skills/:id            → full Skill | 404 (ParseUUIDPipe → 400).
 *
 * Robustness discipline: every test registers a FRESH owner, so per-user totals
 * are deterministic; ids are asserted via set-membership (never global counts);
 * updatedAt ordering is asserted non-increasing WITH tie tolerance; the catalog
 * is treated as a captured baseline (order/total read once, paging math checked
 * against it) with a handful of stable slugs pinned by containment.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Slugs the everworks-skills provider ships in this stack; stable, pinned by containment. */
const KNOWN_CATALOG_SLUGS = [
    'skill-creator',
    'mcp-builder',
    'webapp-testing',
    'frontend-design',
    'brand-guidelines',
    'internal-comms',
    'claude-api',
    'check-pr',
    'pr-report',
    'doc-maintenance',
] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SeededSkill {
    id: string;
    slug: string;
    title: string;
}

/**
 * Register a fresh owner and create `n` tenant-scoped skills. Every title
 * carries a shared MARK token and every description a shared DESCTOK token so
 * search over title/description returns the whole set for this (isolated) user;
 * slugs are unique per index for single-match search.
 */
async function seedTenantSkills(
    request: APIRequestContext,
    n: number,
): Promise<{
    u: RegisteredUser;
    headers: { Authorization: string };
    suffix: string;
    created: SeededSkill[];
    mark: string;
    descTok: string;
}> {
    const u = await registerUserViaAPI(request);
    const headers = authedHeaders(u.access_token);
    const suffix = stamp();
    const mark = `MARK${suffix.replace(/-/g, '')}`;
    const descTok = `DESCTOK${suffix.replace(/-/g, '')}`;
    const created: SeededSkill[] = [];
    for (let i = 0; i < n; i++) {
        const slug = `pgn-${i}-${suffix}`;
        const title = `Skill ${i} ${mark}`;
        const res = await request.post(`${API_BASE}/api/skills`, {
            headers,
            data: {
                ownerType: 'tenant',
                ownerId: u.user.id,
                title,
                description: `seed ${i} ${descTok}`,
                instructionsMd: `# body ${i}\n\nskill instructions ${suffix}`,
                slug,
            },
        });
        expect(res.status(), `seed create #${i}`).toBe(201);
        const body = await res.json();
        created.push({ id: body.id, slug, title });
    }
    return { u, headers, suffix, created, mark, descTok };
}

async function listSkills(
    request: APIRequestContext,
    headers: { Authorization: string },
    query = '',
): Promise<{
    status: number;
    data: any[];
    meta: { total: number; limit: number; offset: number };
}> {
    const res = await request.get(`${API_BASE}/api/skills${query}`, { headers });
    const status = res.status();
    if (status !== 200) return { status, data: [], meta: { total: -1, limit: -1, offset: -1 } };
    const json = await res.json();
    return { status, data: json.data, meta: json.meta };
}

async function getCatalog(
    request: APIRequestContext,
    headers: { Authorization: string },
    query = '',
): Promise<{ status: number; entries: any[]; total: number }> {
    const res = await request.get(`${API_BASE}/api/skills/catalog${query}`, { headers });
    const status = res.status();
    if (status !== 200) return { status, entries: [], total: -1 };
    const json = await res.json();
    return { status, entries: json.entries, total: json.total };
}

// ─── GET /api/skills — installed list: shape, projection & meta ──────────────

test.describe('GET /api/skills — installed list shape & meta', () => {
    test('default list returns {data,meta} with the full Skill projection and self-owned tenant rows', async ({
        request,
    }) => {
        const { u, headers, created } = await seedTenantSkills(request, 6);
        const { status, data, meta } = await listSkills(request, headers);

        expect(status).toBe(200);
        expect(meta).toEqual({ total: created.length, limit: 50, offset: 0 });
        expect(data).toHaveLength(created.length);

        const returnedIds = data.map((r) => r.id).sort();
        expect(returnedIds).toEqual(created.map((c) => c.id).sort());

        for (const row of data) {
            // Full entity projection (list is not a thin summary).
            for (const key of [
                'id',
                'userId',
                'ownerType',
                'ownerId',
                'slug',
                'title',
                'description',
                'frontmatter',
                'instructionsMd',
                'contentHash',
                'version',
                'createdAt',
                'updatedAt',
            ]) {
                expect(row, `row missing ${key}`).toHaveProperty(key);
            }
            expect(row.id).toMatch(UUID_RE);
            expect(row.userId).toBe(u.user.id);
            expect(row.ownerType).toBe('tenant');
            expect(row.ownerId).toBe(u.user.id);
            expect(row.version).toBe('1.0.0');
        }
    });

    test('meta.total is independent of limit and offset', async ({ request }) => {
        const { headers, created } = await seedTenantSkills(request, 8);
        const total = created.length;
        for (const q of ['', '?limit=1', '?limit=200', '?limit=2&offset=4', '?offset=1000']) {
            const { meta } = await listSkills(request, headers, q);
            expect(meta.total, `total for ${q || '(default)'}`).toBe(total);
        }
    });
});

// ─── GET /api/skills — pagination arithmetic ─────────────────────────────────

test.describe('GET /api/skills — pagination', () => {
    test('limit caps the page and meta echoes the REQUESTED limit/offset', async ({ request }) => {
        const { headers, created } = await seedTenantSkills(request, 7);

        const p = await listSkills(request, headers, '?limit=3&offset=2');
        expect(p.status).toBe(200);
        expect(p.data).toHaveLength(3);
        expect(p.meta).toEqual({ total: created.length, limit: 3, offset: 2 });
    });

    test('offset paging fully reconstructs the set with no duplicate id across pages', async ({
        request,
    }) => {
        const { headers, created } = await seedTenantSkills(request, 9);
        const pageSize = 2;
        const seen: string[] = [];
        for (let offset = 0; offset < created.length + pageSize; offset += pageSize) {
            const { data, meta } = await listSkills(
                request,
                headers,
                `?limit=${pageSize}&offset=${offset}`,
            );
            expect(meta.total).toBe(created.length);
            // Non-final pages are full; the tail page holds the remainder.
            const expectedLen = Math.max(0, Math.min(pageSize, created.length - offset));
            expect(data.length, `page @${offset}`).toBe(expectedLen);
            seen.push(...data.map((r) => r.id));
        }
        // No id appears twice, and the union covers exactly the created set.
        expect(new Set(seen).size).toBe(seen.length);
        expect([...new Set(seen)].sort()).toEqual(created.map((c) => c.id).sort());
    });

    test('offset beyond total → empty page, total preserved, offset echoed', async ({
        request,
    }) => {
        const { headers, created } = await seedTenantSkills(request, 4);
        const { status, data, meta } = await listSkills(request, headers, '?offset=999');
        expect(status).toBe(200);
        expect(data).toEqual([]);
        expect(meta.total).toBe(created.length);
        expect(meta.offset).toBe(999);
    });

    test('limit=200 (upper bound) returns all rows for a small owner', async ({ request }) => {
        const { headers, created } = await seedTenantSkills(request, 5);
        const { status, data, meta } = await listSkills(request, headers, '?limit=200');
        expect(status).toBe(200);
        expect(meta.limit).toBe(200);
        expect(data).toHaveLength(created.length);
    });
});

// ─── GET /api/skills — ordering (updatedAt DESC, tie-tolerant) ───────────────

test.describe('GET /api/skills — ordering', () => {
    test('rows are ordered updatedAt DESC (non-increasing, equal timestamps tolerated)', async ({
        request,
    }) => {
        const { headers } = await seedTenantSkills(request, 8);
        const { data } = await listSkills(request, headers, '?limit=200');
        for (let i = 1; i < data.length; i++) {
            const prev = new Date(data[i - 1].updatedAt).getTime();
            const cur = new Date(data[i].updatedAt).getTime();
            expect(prev, `row ${i - 1} vs ${i}`).toBeGreaterThanOrEqual(cur);
        }
    });

    test('PATCH bumps updatedAt so the touched skill sorts to the newest tier', async ({
        request,
    }) => {
        const { headers, created } = await seedTenantSkills(request, 5);
        const target = created[0];
        const before = await request.get(`${API_BASE}/api/skills/${target.id}`, { headers });
        const beforeUpdatedAt = (await before.json()).updatedAt;

        // Cross a whole-second boundary so the bump is strictly newer than the
        // (second-granular) seed timestamps, making the reorder deterministic.
        await new Promise((r) => setTimeout(r, 1100));
        const patch = await request.patch(`${API_BASE}/api/skills/${target.id}`, {
            headers,
            data: { description: `touched ${stamp()}` },
        });
        expect(patch.status()).toBe(200);
        expect(new Date((await patch.json()).updatedAt).getTime()).toBeGreaterThanOrEqual(
            new Date(beforeUpdatedAt).getTime(),
        );

        const { data } = await listSkills(request, headers, '?limit=200');
        // Uniquely-newest → it leads the list, and nothing is strictly newer.
        expect(data[0].id).toBe(target.id);
        const patchedTs = new Date(data[0].updatedAt).getTime();
        expect(data.every((r) => new Date(r.updatedAt).getTime() <= patchedTs)).toBe(true);
    });
});

// ─── GET /api/skills — filters ───────────────────────────────────────────────

test.describe('GET /api/skills — filters', () => {
    test('ownerType filter: tenant returns all seed rows, agent returns none', async ({
        request,
    }) => {
        const { headers, created } = await seedTenantSkills(request, 4);

        const tenant = await listSkills(request, headers, '?ownerType=tenant');
        expect(tenant.meta.total).toBe(created.length);
        expect(tenant.data.every((r) => r.ownerType === 'tenant')).toBe(true);

        const agent = await listSkills(request, headers, '?ownerType=agent');
        expect(agent.status).toBe(200);
        expect(agent.meta.total).toBe(0);
        expect(agent.data).toEqual([]);
    });

    test('ownerId filter: self → all, foreign/nil uuid → empty 200', async ({ request }) => {
        const { u, headers, created } = await seedTenantSkills(request, 4);

        const self = await listSkills(request, headers, `?ownerId=${u.user.id}`);
        expect(self.meta.total).toBe(created.length);

        const foreign = await listSkills(
            request,
            headers,
            `?ownerId=${'6c3e821d-c67e-452a-a80e-7481c2855468'}`,
        );
        expect(foreign.status).toBe(200);
        expect(foreign.meta.total).toBe(0);

        const nil = await listSkills(request, headers, `?ownerId=${NIL_UUID}`);
        expect(nil.status).toBe(200);
        expect(nil.meta.total).toBe(0);
    });

    test('combined ownerType + ownerId: matching narrows, mismatched scope → empty', async ({
        request,
    }) => {
        const { u, headers, created } = await seedTenantSkills(request, 4);

        const match = await listSkills(request, headers, `?ownerType=tenant&ownerId=${u.user.id}`);
        expect(match.meta.total).toBe(created.length);

        // Right owner, wrong scope → the AND leaves nothing.
        const mismatch = await listSkills(
            request,
            headers,
            `?ownerType=agent&ownerId=${u.user.id}`,
        );
        expect(mismatch.meta.total).toBe(0);
    });

    test('search matches title case-insensitively', async ({ request }) => {
        const { headers, created, mark } = await seedTenantSkills(request, 5);

        const exact = await listSkills(request, headers, `?search=${mark}`);
        expect(exact.meta.total).toBe(created.length);

        const upper = await listSkills(request, headers, `?search=${mark.toUpperCase()}`);
        const lower = await listSkills(request, headers, `?search=${mark.toLowerCase()}`);
        expect(upper.meta.total).toBe(created.length);
        expect(lower.meta.total).toBe(created.length);
    });

    test('search matches description and slug, not just title', async ({ request }) => {
        const { headers, created, descTok, suffix } = await seedTenantSkills(request, 5);

        const byDesc = await listSkills(request, headers, `?search=${descTok}`);
        expect(byDesc.meta.total).toBe(created.length);

        // A unique slug fragment → exactly one row.
        const bySlug = await listSkills(request, headers, `?search=pgn-2-${suffix}`);
        expect(bySlug.meta.total).toBe(1);
        expect(bySlug.data[0].slug).toBe(`pgn-2-${suffix}`);
    });

    test('search LIKE-metachar `%` is escaped and injection-style input is inert', async ({
        request,
    }) => {
        const { headers } = await seedTenantSkills(request, 5);

        // `%` would be a wildcard-match-all if unescaped; escaped → literal → 0.
        const pct = await listSkills(request, headers, `?search=${encodeURIComponent('%')}`);
        expect(pct.status).toBe(200);
        expect(pct.meta.total).toBe(0);

        // Classic tautology payload matched literally: no rows, no 5xx.
        const inj = await listSkills(
            request,
            headers,
            `?search=${encodeURIComponent("' OR 1=1 --")}`,
        );
        expect(inj.status).toBe(200);
        expect(inj.meta.total).toBe(0);
    });

    test('search with no match → empty page, total 0', async ({ request }) => {
        const { headers } = await seedTenantSkills(request, 3);
        const { status, data, meta } = await listSkills(
            request,
            headers,
            '?search=zzz-no-such-token-zzz',
        );
        expect(status).toBe(200);
        expect(data).toEqual([]);
        expect(meta.total).toBe(0);
    });

    test('search + pagination: total is the match count, limit caps the page', async ({
        request,
    }) => {
        const { headers, created, mark } = await seedTenantSkills(request, 7);
        const page = await listSkills(request, headers, `?search=${mark}&limit=2`);
        expect(page.meta.total).toBe(created.length);
        expect(page.data).toHaveLength(2);
        expect(page.meta.limit).toBe(2);
    });
});

// ─── GET /api/skills — validation & auth ─────────────────────────────────────

test.describe('GET /api/skills — validation & auth', () => {
    test('limit bounds: 0 → 400, 201 → 400, non-integer → 400', async ({ request }) => {
        const { headers } = await seedTenantSkills(request, 2);
        for (const bad of ['?limit=0', '?limit=201', '?limit=abc', '?limit=2.5']) {
            const res = await request.get(`${API_BASE}/api/skills${bad}`, { headers });
            expect(res.status(), `limit ${bad}`).toBe(400);
        }
    });

    test('offset bounds: negative → 400, non-integer → 400', async ({ request }) => {
        const { headers } = await seedTenantSkills(request, 2);
        for (const bad of ['?offset=-1', '?offset=abc']) {
            const res = await request.get(`${API_BASE}/api/skills${bad}`, { headers });
            expect(res.status(), `offset ${bad}`).toBe(400);
        }
    });

    test('bogus ownerType enum → 400, non-uuid ownerId → 400', async ({ request }) => {
        const { headers } = await seedTenantSkills(request, 1);
        const bogusType = await request.get(`${API_BASE}/api/skills?ownerType=bogus`, { headers });
        expect(bogusType.status()).toBe(400);

        const badId = await request.get(`${API_BASE}/api/skills?ownerId=not-a-uuid`, { headers });
        expect(badId.status()).toBe(400);
    });

    test('search length cap: 500 chars OK, 501 → 400', async ({ request }) => {
        const { headers } = await seedTenantSkills(request, 1);
        const ok = await request.get(`${API_BASE}/api/skills?search=${'a'.repeat(500)}`, {
            headers,
        });
        expect(ok.status()).toBe(200);
        const tooLong = await request.get(`${API_BASE}/api/skills?search=${'a'.repeat(501)}`, {
            headers,
        });
        expect(tooLong.status()).toBe(400);
    });

    test('unauthenticated and bad-token list requests → 401', async ({ request }) => {
        const noAuth = await request.get(`${API_BASE}/api/skills`);
        expect(noAuth.status()).toBe(401);
        const badToken = await request.get(`${API_BASE}/api/skills`, {
            headers: { Authorization: 'Bearer not-a-real-token' },
        });
        expect(badToken.status()).toBe(401);
    });
});

// ─── GET /api/skills/:id ─────────────────────────────────────────────────────

test.describe('GET /api/skills/:id', () => {
    test('own id → 200 full skill; non-uuid → 400; unknown uuid → 404', async ({ request }) => {
        const { headers, created } = await seedTenantSkills(request, 2);
        const one = created[0];

        const ok = await request.get(`${API_BASE}/api/skills/${one.id}`, { headers });
        expect(ok.status()).toBe(200);
        const body = await ok.json();
        expect(body.id).toBe(one.id);
        expect(body.slug).toBe(one.slug);
        expect(body).toHaveProperty('instructionsMd');

        const badFmt = await request.get(`${API_BASE}/api/skills/not-a-uuid`, { headers });
        expect(badFmt.status()).toBe(400); // ParseUUIDPipe

        const missing = await request.get(
            `${API_BASE}/api/skills/439b343e-a25a-47db-98a5-bd832ab7d937`,
            { headers },
        );
        expect(missing.status()).toBe(404);
    });

    test('cross-user isolation: B sees an empty list and 404s on A’s skill id', async ({
        request,
    }) => {
        const { created } = await seedTenantSkills(request, 3);
        const b = await registerUserViaAPI(request);
        const bHeaders = authedHeaders(b.access_token);

        const bList = await listSkills(request, bHeaders);
        expect(bList.meta.total).toBe(0);
        expect(bList.data).toEqual([]);

        // No existence leak via 403 — a foreign owner gets a flat 404.
        const leak = await request.get(`${API_BASE}/api/skills/${created[0].id}`, {
            headers: bHeaders,
        });
        expect(leak.status()).toBe(404);
    });
});

// ─── GET /api/skills/catalog — pagination ────────────────────────────────────

test.describe('GET /api/skills/catalog — pagination', () => {
    test('default catalog → {entries,total}, entry projection, known slugs present', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const { status, entries, total } = await getCatalog(request, headers);
        expect(status).toBe(200);
        expect(total).toBeGreaterThanOrEqual(KNOWN_CATALOG_SLUGS.length);
        // Default limit 50 ≥ total in this stack → the full union comes back.
        expect(entries).toHaveLength(Math.min(total, 50));

        const slugs = entries.map((e) => e.slug);
        for (const known of KNOWN_CATALOG_SLUGS) {
            expect(slugs, `missing catalog slug ${known}`).toContain(known);
        }
        for (const e of entries) {
            for (const key of [
                'slug',
                'title',
                'description',
                'frontmatter',
                'body',
                'version',
                'tags',
            ]) {
                expect(e, `catalog entry missing ${key}`).toHaveProperty(key);
            }
            expect(Array.isArray(e.tags)).toBe(true);
            // list-level entries carry no providerId (that's a per-entry lookup field).
            expect(e).not.toHaveProperty('providerId');
        }
    });

    test('catalog pages are contiguous slices of a stable baseline (no overlap, no gap)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const base = await getCatalog(request, headers, '?limit=200');
        const baseSlugs = base.entries.map((e) => e.slug);
        expect(baseSlugs.length).toBe(base.total);

        const first = await getCatalog(request, headers, '?limit=3&offset=0');
        expect(first.entries.map((e) => e.slug)).toEqual(baseSlugs.slice(0, 3));

        const second = await getCatalog(request, headers, '?limit=3&offset=3');
        expect(second.entries.map((e) => e.slug)).toEqual(baseSlugs.slice(3, 6));

        // Overlapping window is itself a contiguous slice (deterministic order).
        const shifted = await getCatalog(request, headers, '?limit=3&offset=1');
        expect(shifted.entries.map((e) => e.slug)).toEqual(baseSlugs.slice(1, 4));

        // Walking the whole catalog by pages reconstructs the baseline exactly.
        const walked: string[] = [];
        for (let offset = 0; offset < base.total; offset += 4) {
            const pg = await getCatalog(request, headers, `?limit=4&offset=${offset}`);
            walked.push(...pg.entries.map((e) => e.slug));
        }
        expect(walked).toEqual(baseSlugs);
    });

    test('catalog offset beyond total → empty entries, total unchanged', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const base = await getCatalog(request, headers);

        const past = await getCatalog(request, headers, '?offset=99999');
        expect(past.status).toBe(200);
        expect(past.entries).toEqual([]);
        expect(past.total).toBe(base.total);
    });

    test('catalog total is independent of limit/offset', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const base = await getCatalog(request, headers);
        for (const q of ['?limit=1', '?limit=2&offset=1', '?offset=5', '?limit=200']) {
            const r = await getCatalog(request, headers, q);
            expect(r.total, `catalog total for ${q}`).toBe(base.total);
        }
    });
});

// ─── GET /api/skills/catalog — search & tags ─────────────────────────────────

test.describe('GET /api/skills/catalog — search & tags', () => {
    test('catalog search narrows the union; no-match → 0', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const base = await getCatalog(request, headers);
        const hit = await getCatalog(request, headers, '?search=skill');
        expect(hit.status).toBe(200);
        expect(hit.total).toBeGreaterThanOrEqual(1);
        expect(hit.total).toBeLessThanOrEqual(base.total);
        expect(hit.entries.map((e) => e.slug)).toContain('skill-creator');

        const miss = await getCatalog(request, headers, '?search=zzz-no-such-catalog-token');
        expect(miss.status).toBe(200);
        expect(miss.total).toBe(0);
        expect(miss.entries).toEqual([]);
    });

    test('catalog tags filter is an OR-union; every hit carries the tag; unknown tag → 0', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const design = await getCatalog(request, headers, '?tags=design');
        expect(design.status).toBe(200);
        const designSlugs = design.entries.map((e) => e.slug);
        expect(designSlugs).toContain('frontend-design');
        expect(designSlugs).toContain('brand-guidelines');
        expect(design.entries.every((e) => (e.tags ?? []).includes('design'))).toBe(true);

        const eng = await getCatalog(request, headers, '?tags=engineering');
        const engSlugs = new Set(eng.entries.map((e) => e.slug));

        // Union of the two tag groups = OR semantics (a superset of both).
        const union = await getCatalog(request, headers, '?tags=design,engineering');
        const unionSlugs = new Set(union.entries.map((e) => e.slug));
        expect(union.total).toBe(design.total + eng.total);
        for (const s of [...designSlugs, ...engSlugs]) {
            expect(unionSlugs.has(s), `union missing ${s}`).toBe(true);
        }

        const none = await getCatalog(request, headers, '?tags=zzz-no-such-tag-xyz');
        expect(none.status).toBe(200);
        expect(none.total).toBe(0);
    });

    test('catalog validation: bad limit/offset/search/tags → 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const cases = [
            '?limit=0',
            '?limit=201',
            '?limit=abc',
            '?offset=-1',
            `?search=${'a'.repeat(501)}`,
            `?tags=${'t'.repeat(81)}`,
        ];
        for (const q of cases) {
            const res = await request.get(`${API_BASE}/api/skills/catalog${q}`, { headers });
            expect(res.status(), `catalog ${q}`).toBe(400);
        }
    });
});

// ─── GET /api/skills/catalog/:slug ───────────────────────────────────────────

test.describe('GET /api/skills/catalog/:slug', () => {
    test('valid slug → { entry, providerId }, entry echoes the slug + carries a body', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);

        const res = await request.get(`${API_BASE}/api/skills/catalog/skill-creator`, { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(['entry', 'providerId']);
        expect(body.providerId).toBe('everworks-skills');
        expect(body.entry.slug).toBe('skill-creator');
        expect(typeof body.entry.body).toBe('string');
        expect(body.entry).toHaveProperty('frontmatter');
    });

    test('malformed slug (uppercase / underscore / space) → 400 "Invalid skill slug."', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        for (const bad of ['Skill-Creator', 'foo_bar', encodeURIComponent('has space')]) {
            const res = await request.get(`${API_BASE}/api/skills/catalog/${bad}`, { headers });
            expect(res.status(), `slug ${bad}`).toBe(400);
        }
    });

    test('well-formed but unknown slug → 404', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const res = await request.get(`${API_BASE}/api/skills/catalog/does-not-exist-${stamp()}`, {
            headers,
        });
        expect(res.status()).toBe(404);
    });
});

// ─── catalog auth ────────────────────────────────────────────────────────────

test.describe('GET /api/skills/catalog — auth', () => {
    test('catalog list and single-entry require auth (401 without a token)', async ({
        request,
    }) => {
        const list = await request.get(`${API_BASE}/api/skills/catalog`);
        expect(list.status()).toBe(401);
        const entry = await request.get(`${API_BASE}/api/skills/catalog/skill-creator`);
        expect(entry.status()).toBe(401);
    });
});
