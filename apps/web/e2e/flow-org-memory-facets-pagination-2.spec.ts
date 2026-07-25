/**
 * Org-wide Memory (Cortex P1) — GET /api/memory DEEPER facet + pagination matrix (#1674, wave 2).
 *
 * A second, non-overlapping cut over `GET /api/memory` that pins the finer-grained
 * multi-value facet parsing, the lexical `q` engine, the counts.documents vs
 * counts.indexed split, org-scoped (workId IS NULL) rows, and the pagination /
 * ordering clamps. Complements `flow-org-memory-page-deep.spec.ts` — every angle
 * here is DISTINCT from that file (which covers the happy-path shape, single-value
 * filters, basic paging and auth/isolation). New ground covered:
 *
 *   MULTI-VALUE FACET PARSING (controller `toStringArray`):
 *     • comma-joined values with surrounding whitespace are trimmed (`type=brand, legal`)
 *     • a duplicated value collapses to a single IN member (no double-count)
 *     • comma-joined AND repeated params combine into one union (`type=a,b&type=c`)
 *     • multi-value status / source unions
 *     • degenerate empty segments (`type=,,`, `status=`, `source=,`, `work=,`) → 200 no-op
 *
 *   LEXICAL q (repo LIKE, escape-only, no LOWER()):
 *     • q is CASE-INSENSITIVE (sqlite LIKE default) — lower/UPPER both match a mixed-case title
 *     • q matches title AND description but NOT the body
 *     • q LIKE wildcards are ESCAPED — a literal `%` / `_` matches nothing (no wildcard scan)
 *     • facets are RECOMPUTED under q (q narrows the chip buckets) while counts.indexed holds
 *     • q composes with a facet chip as AND for counts, while facets track only q
 *     • q composes with limit/offset (paging applies to the q-match set)
 *
 *   counts.documents vs counts.indexed:
 *     • counts.indexed ignores every chip + q (constant across a whole query matrix)
 *     • a triple type∧status∧source intersects to the single matching row
 *     • a valid-but-absent source → 0 documents, yet the source facet still advertises the
 *       present value (facets ignore chip selection) and indexed is untouched
 *
 *   WORK facet + org-scoped rows:
 *     • an org-scoped doc (workId null) surfaces with workName null, is counted in the TYPE
 *       facet, but is EXCLUDED from the WORKS facet
 *     • a specific `work=` selection DROPS org-scoped rows; indexed is unchanged
 *     • multi-work `work=a,b` unions the two Works; a mixed real+foreign id keeps only the
 *       org-owned Work (foreign intersected away); repeated form == comma form
 *     • the works facet spans the FULL org even under a single-work selection
 *
 *   PAGINATION clamps + ordering:
 *     • limit boundary 200 ok / 201 → 400 / 0 → 400; a valid page caps length, total holds
 *     • offset paging is disjoint + exhaustive (id-set) and the feed is updatedAt DESC
 *       (asserted non-increasing, tolerant of equal-timestamp ties)
 *     • offset == total and offset ≫ total → empty page, total unchanged
 *     • non-integer / negative limit & offset → 400; omitting limit returns the full match set
 *     • a `;DROP`-style limit → 400; an unknown junk param is ignored (200, order intact)
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI driver)
 *    before any assertion was written. The Organization is resolved from the request
 *    scope context; we pin it deterministically with the `X-Scope-Slug` header.
 *
 * Isolation discipline: every test builds a FRESH registerUserViaAPI() owner + a
 * lazily-minted org, so per-org counts are deterministic even though the shard DB
 * accumulates rows across the suite. Fully API-orchestrated (safe `flow-` prefix).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * An owner + their org, with a plain-authed header set and a scope-pinned header
 * set (`X-Scope-Slug`) so the legacy /api/memory route resolves this exact org.
 */
interface OrgCtx {
    user: RegisteredUser;
    token: string;
    orgId: string;
    orgSlug: string;
    headers: Record<string, string>;
    scoped: Record<string, string>;
}

async function buildOrgCtx(request: APIRequestContext): Promise<OrgCtx> {
    const user = await registerUserViaAPI(request);
    const org = await createOrganizationViaAPI(request, user.access_token, `Mem2 Org ${stamp()}`);
    const headers = authedHeaders(user.access_token);
    return {
        user,
        token: user.access_token,
        orgId: org.id,
        orgSlug: org.slug,
        headers,
        scoped: { ...headers, 'X-Scope-Slug': org.slug },
    };
}

/** Create a Work stamped to the ctx's org (scope pinned). Returns the work id. */
async function createScopedWork(
    request: APIRequestContext,
    ctx: OrgCtx,
    name: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: ctx.scoped,
        data: {
            name,
            slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp()}`,
            description: 'org memory work',
            organization: false,
        },
    });
    expect([200, 201], `createScopedWork body=${await res.text().catch(() => '')}`).toContain(
        res.status(),
    );
    const json = await res.json();
    const id = json?.work?.id ?? json?.id;
    expect(id, 'work id present').toMatch(UUID_RE);
    return id as string;
}

interface KbDocInput {
    path: string;
    title: string;
    class: string;
    body?: string;
    description?: string | null;
    status?: 'draft' | 'active' | 'archived';
}

interface KbDocRow {
    id: string;
    workId: string | null;
    class: string;
    status: string;
    source: string;
}

/** Author a KB document inside a Work (scope pinned). */
async function createKbDoc(
    request: APIRequestContext,
    ctx: OrgCtx,
    workId: string,
    input: KbDocInput,
): Promise<KbDocRow> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
        headers: ctx.scoped,
        data: {
            path: input.path,
            title: input.title,
            class: input.class,
            body: input.body ?? 'body content',
            description: input.description ?? null,
            status: input.status ?? 'active',
        },
    });
    expect(res.status(), `createKbDoc body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/**
 * Author an ORG-SCOPED KB document (workId IS NULL) via the org-KB route.
 * Restricted to inheritable classes (legal / style / seo); requires org-admin,
 * which the org owner is.
 */
async function createOrgScopedDoc(
    request: APIRequestContext,
    ctx: OrgCtx,
    input: KbDocInput,
): Promise<KbDocRow> {
    const res = await request.post(`${API_BASE}/api/organizations/${ctx.orgId}/kb/documents`, {
        headers: ctx.scoped,
        data: {
            path: input.path,
            title: input.title,
            class: input.class,
            body: input.body ?? 'org body',
            description: input.description ?? null,
            status: input.status ?? 'active',
        },
    });
    expect(res.status(), `createOrgScopedDoc body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

interface MemoryFacet {
    value: string;
    label: string;
    count: number;
}
interface MemoryDoc {
    id: string;
    title: string;
    description: string | null;
    path: string;
    workId: string | null;
    workName: string | null;
    class: string;
    status: string;
    source: string;
    updatedAt: string;
    lastIndexedAt: string | null;
    consolidation: unknown;
}
interface MemoryResponse {
    documents: MemoryDoc[];
    counts: { documents: number; indexed: number };
    facets: {
        types: MemoryFacet[];
        works: MemoryFacet[];
        statuses: MemoryFacet[];
        sources: MemoryFacet[];
    };
}

/** GET /api/memory pinned to the ctx's org; asserts 200 and returns the typed body. */
async function getMemory(
    request: APIRequestContext,
    ctx: OrgCtx,
    qs = '',
): Promise<MemoryResponse> {
    const res = await request.get(`${API_BASE}/api/memory${qs}`, { headers: ctx.scoped });
    expect(res.status(), `getMemory ${qs} body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Bare status probe (no 200 assertion) for validation cases. */
async function memoryStatus(request: APIRequestContext, ctx: OrgCtx, qs: string): Promise<number> {
    const res = await request.get(`${API_BASE}/api/memory${qs}`, { headers: ctx.scoped });
    return res.status();
}

const facetValues = (facets: MemoryFacet[]): string[] => facets.map((f) => f.value).sort();
const facetCount = (facets: MemoryFacet[], value: string): number | undefined =>
    facets.find((f) => f.value === value)?.count;

/**
 * Seed a Work with the canonical 4-doc mix used across these tests:
 *   brand/active "Alpha Brand Guide"   (desc: first brand desc, body: secretbodyword)
 *   legal/draft  "Terms Legal"         (desc: legal description, body: privacyonlybody)
 *   seo/active   "SEO Keywords Sheet"  (desc: seo desc)
 *   brand/archived "Beta Brand Notes"  (desc: another brand)
 */
async function seedMix(
    request: APIRequestContext,
    ctx: OrgCtx,
): Promise<{ workId: string; ids: Record<string, string> }> {
    const workId = await createScopedWork(request, ctx, `Mix Work ${stamp()}`);
    const alpha = await createKbDoc(request, ctx, workId, {
        path: 'brand/a.md',
        title: 'Alpha Brand Guide',
        class: 'brand',
        description: 'first brand desc',
        body: 'secretbodyword here',
        status: 'active',
    });
    const terms = await createKbDoc(request, ctx, workId, {
        path: 'legal/b.md',
        title: 'Terms Legal',
        class: 'legal',
        description: 'legal description text',
        body: 'privacyonlybody',
        status: 'draft',
    });
    const seo = await createKbDoc(request, ctx, workId, {
        path: 'seo/c.md',
        title: 'SEO Keywords Sheet',
        class: 'seo',
        description: 'seo desc',
        status: 'active',
    });
    const beta = await createKbDoc(request, ctx, workId, {
        path: 'brand/d.md',
        title: 'Beta Brand Notes',
        class: 'brand',
        description: 'another brand',
        status: 'archived',
    });
    return { workId, ids: { alpha: alpha.id, terms: terms.id, seo: seo.id, beta: beta.id } };
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Org Memory — multi-value facet parsing', () => {
    test('comma-joined type values with surrounding whitespace are trimmed and matched', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        // "brand,%20legal" → the space after the comma is trimmed by toStringArray.
        const body = await getMemory(request, ctx, '?type=brand,%20legal');
        expect(body.counts.documents).toBe(3); // 2 brand + 1 legal
        expect(body.documents.map((d) => d.class).sort()).toEqual(['brand', 'brand', 'legal']);
    });

    test('a duplicated facet value collapses to one IN member (no double-count)', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        const dup = await getMemory(request, ctx, '?type=brand,brand');
        const single = await getMemory(request, ctx, '?type=brand');
        expect(dup.counts.documents).toBe(2);
        expect(dup.counts.documents).toBe(single.counts.documents);
        expect(dup.documents.every((d) => d.class === 'brand')).toBe(true);
    });

    test('comma-joined AND repeated params combine into a single union', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        // "type=brand,legal&type=seo" → { brand, legal, seo } (all three seeded classes).
        const body = await getMemory(request, ctx, '?type=brand,legal&type=seo');
        expect(body.counts.documents).toBe(4); // brand x2 + legal + seo
        expect(new Set(body.documents.map((d) => d.class))).toEqual(
            new Set(['brand', 'legal', 'seo']),
        );
    });

    test('multi-value status and source filters union their members', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        const status = await getMemory(request, ctx, '?status=active,archived');
        expect(status.counts.documents).toBe(3); // alpha + seo (active) + beta (archived)
        expect(status.documents.every((d) => d.status !== 'draft')).toBe(true);

        // source=user,agent — every seeded doc is user; agent contributes nothing.
        const source = await getMemory(request, ctx, '?source=user,agent');
        expect(source.counts.documents).toBe(4);
        expect(source.documents.every((d) => d.source === 'user')).toBe(true);
    });

    test('degenerate empty facet segments are accepted as a no-op (200, unfiltered)', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        for (const qs of ['?type=,,', '?status=', '?source=,', '?work=,']) {
            const body = await getMemory(request, ctx, qs);
            // An all-empty facet array filters nothing — the full feed comes back.
            expect(body.counts.documents, `unfiltered for ${qs}`).toBe(4);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Org Memory — lexical q engine', () => {
    test('q is case-insensitive: lower- and upper-case both match a mixed-case title', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx); // title "Alpha Brand Guide"

        const lower = await getMemory(request, ctx, '?q=alpha');
        const upper = await getMemory(request, ctx, '?q=ALPHA');
        expect(lower.counts.documents).toBe(1);
        expect(upper.counts.documents).toBe(1);
        expect(lower.documents[0].title).toBe('Alpha Brand Guide');
        expect(upper.documents[0].id).toBe(lower.documents[0].id);
    });

    test('q matches title and description but never the body', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedMix(request, ctx);

        // "legal description" lives in the Terms doc DESCRIPTION → matches.
        const byDesc = await getMemory(request, ctx, '?q=legal%20description');
        expect(byDesc.counts.documents).toBe(1);
        expect(byDesc.documents[0].id).toBe(ids.terms);

        // "secretbodyword" lives ONLY in the Alpha doc BODY → no match (body is not indexed).
        const byBody = await getMemory(request, ctx, '?q=secretbodyword');
        expect(byBody.counts.documents).toBe(0);
        expect(byBody.documents).toEqual([]);
        expect(byBody.counts.indexed).toBe(4); // header stays stable on a zero-match search
    });

    test('q LIKE wildcards are escaped — a literal % or _ matches nothing', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        // If % were an active wildcard, "%" would match every row; escaped it matches
        // only titles/descriptions containing a literal percent — none here.
        const pct = await getMemory(request, ctx, '?q=%25');
        expect(pct.counts.documents).toBe(0);

        // Same for the single-char wildcard "_".
        const underscore = await getMemory(request, ctx, '?q=_');
        expect(underscore.counts.documents).toBe(0);

        // Sanity: the org still has its full complement of rows.
        expect(pct.counts.indexed).toBe(4);
        expect(underscore.counts.indexed).toBe(4);
    });

    test('facets are recomputed under q (q narrows the chip buckets) while indexed holds', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        // "Terms" is only in the legal/draft doc's title → the q-scoped facets collapse
        // to just that document's buckets, but counts.indexed is the org-wide total.
        const body = await getMemory(request, ctx, '?q=Terms');
        expect(body.counts.documents).toBe(1);
        expect(body.counts.indexed).toBe(4);
        expect(facetValues(body.facets.types)).toEqual(['legal']);
        expect(facetValues(body.facets.statuses)).toEqual(['draft']);
        // contrast: the unfiltered feed exposes all three types.
        const all = await getMemory(request, ctx);
        expect(facetValues(all.facets.types)).toEqual(['brand', 'legal', 'seo']);
    });

    test('q composes with a facet chip: counts intersect (AND), facets track only q', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        // "Brand" hits both brand docs (title + desc). Facets reflect that q-scope.
        const q = await getMemory(request, ctx, '?q=Brand');
        expect(q.counts.documents).toBe(2);
        expect(facetValues(q.facets.types)).toEqual(['brand']);

        // Adding type=brand cannot widen the q-match set — counts stay 2, facets unchanged.
        const both = await getMemory(request, ctx, '?q=Brand&type=brand');
        expect(both.counts.documents).toBe(2);
        expect(facetValues(both.facets.types)).toEqual(['brand']);

        // A chip that is disjoint from the q-set yields zero docs but leaves q-facets intact.
        const disjoint = await getMemory(request, ctx, '?q=Brand&type=legal');
        expect(disjoint.counts.documents).toBe(0);
        expect(facetValues(disjoint.facets.types)).toEqual(['brand']);
        expect(disjoint.counts.indexed).toBe(4);
    });

    test('q composes with limit/offset — paging applies over the q-match set', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx); // two brand docs match "Brand"

        const first = await getMemory(request, ctx, '?q=Brand&limit=1&offset=0');
        const second = await getMemory(request, ctx, '?q=Brand&limit=1&offset=1');
        expect(first.documents.length).toBe(1);
        expect(second.documents.length).toBe(1);
        // counts.documents is the FULL q-match total on both pages.
        expect(first.counts.documents).toBe(2);
        expect(second.counts.documents).toBe(2);
        // The two single-row pages are disjoint and together cover both brand docs.
        expect(first.documents[0].id).not.toBe(second.documents[0].id);

        // offset past the q-match total → empty page, total unchanged.
        const beyond = await getMemory(request, ctx, '?q=Brand&offset=2');
        expect(beyond.documents).toEqual([]);
        expect(beyond.counts.documents).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Org Memory — counts.documents vs counts.indexed', () => {
    test('counts.indexed is invariant across a whole filter + q matrix', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        const queries = [
            '',
            '?type=brand',
            '?status=draft',
            '?source=user',
            '?q=Terms',
            '?q=nomatchxyz',
            '?type=legal&status=draft',
            '?limit=1',
            '?offset=3',
        ];
        for (const qs of queries) {
            const body = await getMemory(request, ctx, qs);
            expect(body.counts.indexed, `indexed stable for '${qs}'`).toBe(4);
        }
    });

    test('a triple type∧status∧source intersects to the single matching row', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedMix(request, ctx);

        // brand + active + user is satisfied only by the Alpha doc.
        const hit = await getMemory(request, ctx, '?type=brand&status=active&source=user');
        expect(hit.counts.documents).toBe(1);
        expect(hit.documents[0].id).toBe(ids.alpha);

        // brand + draft + user has no member (the only draft is legal).
        const miss = await getMemory(request, ctx, '?type=brand&status=draft&source=user');
        expect(miss.counts.documents).toBe(0);
        expect(miss.documents).toEqual([]);
        expect(miss.counts.indexed).toBe(4);
    });

    test('a valid-but-absent source yields 0 docs yet the source facet still lists the present value', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx);

        const body = await getMemory(request, ctx, '?source=agent');
        expect(body.counts.documents).toBe(0);
        expect(body.documents).toEqual([]);
        // Facets ignore the chip selection — the present 'user' bucket is still advertised.
        expect(facetValues(body.facets.sources)).toEqual(['user']);
        expect(facetCount(body.facets.sources, 'user')).toBe(4);
        expect(body.counts.indexed).toBe(4);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Org Memory — work facet & org-scoped rows', () => {
    test('an org-scoped doc surfaces with null work, counts in the TYPE facet, absent from WORKS facet', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedMix(request, ctx); // 1 work, 4 docs, legal count = 1
        const orgDoc = await createOrgScopedDoc(request, ctx, {
            path: 'legal/org-privacy.md',
            title: 'Org Privacy Policy',
            class: 'legal',
            description: 'org level legal',
            status: 'active',
        });

        const body = await getMemory(request, ctx);
        expect(body.counts.documents).toBe(5);
        expect(body.counts.indexed).toBe(5);

        const row = body.documents.find((d) => d.id === orgDoc.id);
        expect(row, 'org-scoped row present in feed').toBeTruthy();
        expect(row!.workId).toBeNull();
        expect(row!.workName).toBeNull();

        // TYPE facet counts the org row (legal now 2: the Terms draft + the org policy).
        expect(facetCount(body.facets.types, 'legal')).toBe(2);
        // WORKS facet excludes workId-null rows → only the single seeded Work appears,
        // carrying all 4 of its documents (the org-level row is not attributed to it).
        expect(body.facets.works.length).toBe(1);
        expect(body.facets.works[0].value).toMatch(UUID_RE);
        expect(body.facets.works[0].count).toBe(4);
    });

    test('a specific work selection DROPS org-scoped rows; indexed is unchanged', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { workId } = await seedMix(request, ctx);
        await createOrgScopedDoc(request, ctx, {
            path: 'legal/org-privacy.md',
            title: 'Org Privacy Policy',
            class: 'legal',
            status: 'active',
        });

        // Selecting the Work returns only its 4 docs — the org-level row is excluded.
        const body = await getMemory(request, ctx, `?work=${workId}`);
        expect(body.counts.documents).toBe(4);
        expect(body.documents.every((d) => d.workId === workId)).toBe(true);
        expect(body.documents.some((d) => d.workId === null)).toBe(false);
        // The org-wide indexed header still counts the org row (5 total).
        expect(body.counts.indexed).toBe(5);
    });

    test('multi-work selection unions two Works; a mixed real+foreign id keeps only the org-owned Work', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const workA = await createScopedWork(request, ctx, `Work A ${stamp()}`);
        const workB = await createScopedWork(request, ctx, `Work B ${stamp()}`);
        await createKbDoc(request, ctx, workA, { path: 'brand/a.md', title: 'A1', class: 'brand' });
        await createKbDoc(request, ctx, workA, { path: 'seo/a.md', title: 'A2', class: 'seo' });
        await createKbDoc(request, ctx, workB, { path: 'brand/b.md', title: 'B1', class: 'brand' });

        const both = await getMemory(request, ctx, `?work=${workA},${workB}`);
        expect(both.counts.documents).toBe(3);
        expect(new Set(both.documents.map((d) => d.workId))).toEqual(new Set([workA, workB]));

        // A foreign uuid alongside a real one is intersected away — only workB survives.
        const FOREIGN = '11111111-1111-4111-8111-111111111111';
        const mixed = await getMemory(request, ctx, `?work=${workB},${FOREIGN}`);
        expect(mixed.counts.documents).toBe(1);
        expect(mixed.documents.every((d) => d.workId === workB)).toBe(true);
        expect(mixed.counts.indexed).toBe(3); // org-wide total is untouched
    });

    test('the repeated work param form equals the comma form', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const workA = await createScopedWork(request, ctx, `Work A ${stamp()}`);
        const workB = await createScopedWork(request, ctx, `Work B ${stamp()}`);
        await createKbDoc(request, ctx, workA, { path: 'brand/a.md', title: 'A1', class: 'brand' });
        await createKbDoc(request, ctx, workB, { path: 'brand/b.md', title: 'B1', class: 'brand' });

        const comma = await getMemory(request, ctx, `?work=${workA},${workB}`);
        const repeated = await getMemory(request, ctx, `?work=${workA}&work=${workB}`);
        expect(comma.counts.documents).toBe(2);
        expect(repeated.counts.documents).toBe(comma.counts.documents);
        expect(new Set(repeated.documents.map((d) => d.id))).toEqual(
            new Set(comma.documents.map((d) => d.id)),
        );
    });

    test('the works facet spans the FULL org even under a single-work selection', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const workA = await createScopedWork(request, ctx, `Facet A ${stamp()}`);
        const workB = await createScopedWork(request, ctx, `Facet B ${stamp()}`);
        await createKbDoc(request, ctx, workA, { path: 'brand/a.md', title: 'A1', class: 'brand' });
        await createKbDoc(request, ctx, workB, { path: 'brand/b.md', title: 'B1', class: 'brand' });

        // Feed narrows to workB, but the facet buckets are computed over the whole org,
        // so BOTH Works remain visible in the works facet (stable chip counts).
        const body = await getMemory(request, ctx, `?work=${workB}`);
        expect(body.documents.every((d) => d.workId === workB)).toBe(true);
        expect(new Set(body.facets.works.map((f) => f.value))).toEqual(new Set([workA, workB]));
        expect(facetCount(body.facets.works, workA)).toBe(1);
        expect(facetCount(body.facets.works, workB)).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Org Memory — pagination clamps & ordering', () => {
    /** Seed one Work with `n` freeform docs; returns the work id + created doc ids. */
    async function seedN(
        request: APIRequestContext,
        ctx: OrgCtx,
        n: number,
    ): Promise<{ workId: string; ids: string[] }> {
        const workId = await createScopedWork(request, ctx, `Page Work ${stamp()}`);
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
            const doc = await createKbDoc(request, ctx, workId, {
                path: `freeform/${i}.md`,
                title: `Doc ${String(i).padStart(2, '0')}`,
                class: 'freeform',
                description: `desc ${i}`,
            });
            ids.push(doc.id);
        }
        return { workId, ids };
    }

    test('limit boundary: 200 ok, 201 → 400, 0 → 400; a valid page caps length while total holds', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedN(request, ctx, 5);

        expect(await memoryStatus(request, ctx, '?limit=200')).toBe(200);
        expect(await memoryStatus(request, ctx, '?limit=201')).toBe(400);
        expect(await memoryStatus(request, ctx, '?limit=0')).toBe(400);

        const page = await getMemory(request, ctx, '?limit=2');
        expect(page.documents.length).toBe(2);
        expect(page.counts.documents).toBe(ids.length); // true match total, not the page size
        expect(page.counts.indexed).toBe(ids.length);
    });

    test('offset paging is disjoint + exhaustive and the feed is ordered updatedAt DESC', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedN(request, ctx, 7);

        const p1 = await getMemory(request, ctx, '?limit=3&offset=0');
        const p2 = await getMemory(request, ctx, '?limit=3&offset=3');
        const p3 = await getMemory(request, ctx, '?limit=3&offset=6');
        expect(p1.documents.length).toBe(3);
        expect(p2.documents.length).toBe(3);
        expect(p3.documents.length).toBe(1);

        const paged = [...p1.documents, ...p2.documents, ...p3.documents];
        // Disjoint pages...
        expect(new Set(paged.map((d) => d.id)).size).toBe(7);
        // ...that exhaustively cover every seeded id.
        for (const id of ids) {
            expect(paged.map((d) => d.id)).toContain(id);
        }

        // Ordering is updatedAt DESC — assert non-increasing across the whole concatenation,
        // tolerant of equal-timestamp ties (docs created within the same clock tick).
        const times = paged.map((d) => Date.parse(d.updatedAt));
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }
    });

    test('offset == total and offset ≫ total both return an empty page with the total unchanged', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedN(request, ctx, 4);

        const atEnd = await getMemory(request, ctx, `?offset=${ids.length}`);
        expect(atEnd.documents).toEqual([]);
        expect(atEnd.counts.documents).toBe(ids.length);

        const wayPast = await getMemory(request, ctx, '?offset=99');
        expect(wayPast.documents).toEqual([]);
        expect(wayPast.counts.documents).toBe(ids.length);
        expect(wayPast.counts.indexed).toBe(ids.length);
    });

    test('non-integer and negative limit / offset are rejected with 400', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedN(request, ctx, 2);

        for (const qs of ['?limit=1.5', '?offset=1.5', '?limit=-5', '?offset=-1', '?limit=abc']) {
            expect(await memoryStatus(request, ctx, qs), `expected 400 for ${qs}`).toBe(400);
        }
    });

    test('omitting limit returns the full match set (server-side default cap)', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedN(request, ctx, 6);

        const body = await getMemory(request, ctx);
        // Fewer than the 200 cap → every row comes back in one page.
        expect(body.documents.length).toBe(ids.length);
        expect(body.counts.documents).toBe(ids.length);
        for (const id of ids) {
            expect(body.documents.map((d) => d.id)).toContain(id);
        }
    });

    test('an injection-style limit AND an unknown junk param are both rejected (400)', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedN(request, ctx, 3);

        // "1;DROP" is not a number → 400 (never reaches the DB).
        expect(await memoryStatus(request, ctx, '?limit=1%3BDROP')).toBe(400);

        // The list query DTO runs under forbidNonWhitelisted, so unknown params
        // are not silently ignored — they are hard-rejected before the DB is hit
        // ("property sortBy should not exist" / "property bogus should not exist").
        expect(await memoryStatus(request, ctx, '?sortBy=title%3B--&bogus=1')).toBe(400);

        // The canonical feed (no junk params) still returns the seeded set, ordered.
        const clean = await getMemory(request, ctx);
        expect(clean.counts.documents).toBe(3);
        const times = clean.documents.map((d) => Date.parse(d.updatedAt));
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }
    });
});
