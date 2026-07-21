/**
 * Org-wide Memory (Cortex P1) — GET /api/memory aggregation + consolidation, DEEP (#1674).
 *
 * The Memory page is a NEW read-mostly surface that fans the per-Work Knowledge
 * Base in across the active Organization. It shipped with no dedicated e2e
 * coverage. This file drives the real API against a live stack and pins the
 * true response shapes + status codes, covering:
 *
 *   • empty aggregation for a user with no active Organization (never a
 *     cross-tenant scan) — { documents:[], counts:{documents:0,indexed:0}, facets:{...[]} }
 *   • a KB document authored in an org's Work surfaces in the feed with the full
 *     OrgMemoryDocumentItem projection (id/title/description/path/workId/workName/
 *     class/status/source/updatedAt/lastIndexedAt/consolidation)
 *   • counts semantics: counts.documents = match total (respects filters + q),
 *     counts.indexed = org-wide total IGNORING filters + q (stable header); facets
 *     are computed over the FULL org scope so chip counts don't collapse as you filter
 *   • facet filters: type / status / source (single, comma-joined, and repeated),
 *     combined filters intersect (AND)
 *   • lexical q matches title + description but NOT the document body
 *   • work facet: real work id narrows to that Work; a foreign/unknown work id is
 *     intersected server-side to nothing (never leaks another org) and drops org-scoped rows
 *   • pagination: limit caps the page (documents stays the true total); offset pages;
 *     offset beyond total → empty page, total unchanged
 *   • validation (400): bad facet enum values, limit 0 / >200 / non-numeric,
 *     offset <0 / non-numeric, q >200 chars, work id >64 chars
 *   • auth 401 (GET + consolidate); cross-org isolation walled off (403/404);
 *     unknown scope slug → 404
 *   • POST /api/memory/consolidate: dry-run default (writes nothing, markers stay null),
 *     apply=true stamps a consolidation marker { state, score, reason, runAt },
 *     no-org → zeroed report + "No active Organization" note, non-boolean apply → 400
 *   • GET /api/plugins exposes the `agentmemory` plugin (category utility,
 *     capabilities ⊇ ['agent-memory']); top-level capabilities array carries 'agent-memory'
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before assertions were written. The Organization is taken from the
 *    request scope context: on these legacy un-prefixed routes it is seeded from
 *    the user's last-active Org, or resolved from the `X-Scope-Slug` header. We
 *    drive the header explicitly so scope is deterministic.
 *
 * Isolation discipline: every test builds a FRESH registerUserViaAPI() owner +
 * a lazily-minted org. Fully API-orchestrated (safe `flow-` prefix, not matched
 * by the no-auth testIgnore regex), so it never contends on the UI.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KB_CLASSES = [
    'brand',
    'legal',
    'seo',
    'style',
    'glossary',
    'competitors',
    'personas',
    'research',
    'output',
    'freeform',
] as const;
const KB_STATUSES = ['draft', 'active', 'archived'] as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * An owner + their org, with both a plain-authed header set and a
 * scope-pinned header set (`X-Scope-Slug`) so the legacy /api/memory route
 * resolves this exact org regardless of the user's last-active pointer.
 */
interface OrgCtx {
    user: RegisteredUser;
    token: string;
    orgId: string;
    orgSlug: string;
    /** Auth only — no scope pin. */
    headers: Record<string, string>;
    /** Auth + X-Scope-Slug pin at this org. */
    scoped: Record<string, string>;
}

async function buildOrgCtx(request: APIRequestContext): Promise<OrgCtx> {
    const user = await registerUserViaAPI(request);
    const org = await createOrganizationViaAPI(request, user.access_token, `Mem Org ${stamp()}`);
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

/** Create a Work stamped to the ctx's org (scope pinned via header). Returns the work id. */
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
    class: (typeof KB_CLASSES)[number];
    body?: string;
    description?: string | null;
    status?: (typeof KB_STATUSES)[number];
}

/** Author a KB document inside a Work (scope pinned). Returns the created doc row. */
async function createKbDoc(
    request: APIRequestContext,
    ctx: OrgCtx,
    workId: string,
    input: KbDocInput,
): Promise<{ id: string; workId: string; class: string; status: string; source: string }> {
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

/** GET /api/memory pinned to the ctx's org, with an optional query string. */
async function getMemory(request: APIRequestContext, ctx: OrgCtx, qs = '') {
    const res = await request.get(`${API_BASE}/api/memory${qs}`, { headers: ctx.scoped });
    expect(res.status(), `getMemory body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Seed a ctx's org with a Work carrying three docs: brand/active, legal/draft, seo/active. */
async function seedThreeDocs(
    request: APIRequestContext,
    ctx: OrgCtx,
): Promise<{ workId: string; ids: string[] }> {
    const workId = await createScopedWork(request, ctx, 'Mem Work');
    const brand = await createKbDoc(request, ctx, workId, {
        path: 'brand/tone.md',
        title: 'Brand Tone Guide',
        class: 'brand',
        description: 'tone doc',
        body: 'Our tone is warm.',
        status: 'active',
    });
    const legal = await createKbDoc(request, ctx, workId, {
        path: 'legal/tos.md',
        title: 'Terms of Service',
        class: 'legal',
        description: 'legal doc',
        body: 'Legal text about privacy.',
        status: 'draft',
    });
    const seo = await createKbDoc(request, ctx, workId, {
        path: 'seo/keywords.md',
        title: 'SEO Keywords',
        class: 'seo',
        body: 'keyword research notes',
        status: 'active',
    });
    return { workId, ids: [brand.id, legal.id, seo.id] };
}

test.describe('Org Memory — aggregation & shape', () => {
    test('a user with no active Organization gets an EMPTY aggregation (never a cross-tenant scan)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/memory`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.documents).toEqual([]);
        expect(body.counts).toEqual({ documents: 0, indexed: 0 });
        expect(body.facets).toEqual({ types: [], works: [], statuses: [], sources: [] });
    });

    test('a KB document authored in an org Work surfaces with the full OrgMemoryDocumentItem shape', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const workId = await createScopedWork(request, ctx, 'Mem Work');
        const doc = await createKbDoc(request, ctx, workId, {
            path: 'brand/tone.md',
            title: 'Brand Tone Guide',
            class: 'brand',
            description: 'tone doc',
            status: 'active',
        });

        const body = await getMemory(request, ctx);
        const row = body.documents.find((d: { id: string }) => d.id === doc.id);
        expect(row, 'authored doc appears in the feed').toBeTruthy();
        expect(row.id).toMatch(UUID_RE);
        expect(row.title).toBe('Brand Tone Guide');
        expect(row.description).toBe('tone doc');
        expect(row.path).toBe('brand/tone.md');
        expect(row.workId).toBe(workId);
        expect(row.workName).toBe('Mem Work');
        expect(row.class).toBe('brand');
        expect(row.status).toBe('active');
        expect(row.source).toBe('user');
        expect(typeof row.updatedAt).toBe('string');
        // A freshly-authored doc is not yet embedded, and carries no consolidation marker.
        expect(row.lastIndexedAt).toBeNull();
        expect(row.consolidation).toBeNull();
    });

    test('counts + facets: documents respects filters, indexed is the org-wide stable total, facets span full scope', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        const all = await getMemory(request, ctx);
        expect(all.counts.documents).toBe(3);
        expect(all.counts.indexed).toBe(3);
        // Facets bucket every class/status/source across the org — three distinct types.
        expect(all.facets.types.map((f: { value: string }) => f.value).sort()).toEqual([
            'brand',
            'legal',
            'seo',
        ]);
        expect(all.facets.statuses.map((f: { value: string }) => f.value).sort()).toEqual([
            'active',
            'draft',
        ]);
        expect(all.facets.sources.map((f: { value: string }) => f.value)).toEqual(['user']);

        // Filtering to one type narrows counts.documents but NOT counts.indexed,
        // and the facets stay computed over the full org scope (still all three types).
        const legalOnly = await getMemory(request, ctx, '?type=legal');
        expect(legalOnly.counts.documents).toBe(1);
        expect(legalOnly.counts.indexed).toBe(3);
        expect(legalOnly.facets.types.map((f: { value: string }) => f.value).sort()).toEqual([
            'brand',
            'legal',
            'seo',
        ]);
    });

    test('the work facet resolves each workId to its source Work display name', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const workId = await createScopedWork(request, ctx, 'Named Work');
        await createKbDoc(request, ctx, workId, {
            path: 'freeform/a.md',
            title: 'A',
            class: 'freeform',
        });

        const body = await getMemory(request, ctx);
        const bucket = body.facets.works.find((f: { value: string }) => f.value === workId);
        expect(bucket, 'work facet bucket exists').toBeTruthy();
        expect(bucket.label).toBe('Named Work');
        expect(bucket.count).toBe(1);
    });
});

test.describe('Org Memory — facets & filters', () => {
    test('status filter partitions the feed (draft vs active) while indexed stays constant', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        const active = await getMemory(request, ctx, '?status=active');
        expect(active.counts.documents).toBe(2); // brand + seo
        expect(active.counts.indexed).toBe(3);
        expect(active.documents.every((d: { status: string }) => d.status === 'active')).toBe(true);

        const draft = await getMemory(request, ctx, '?status=draft');
        expect(draft.counts.documents).toBe(1); // legal
        expect(draft.documents.every((d: { status: string }) => d.status === 'draft')).toBe(true);
    });

    test('source filter narrows to user-authored docs; every seeded doc is source=user', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedThreeDocs(request, ctx);

        const body = await getMemory(request, ctx, '?source=user');
        expect(body.counts.documents).toBe(3);
        const returned = body.documents.map((d: { id: string }) => d.id);
        for (const id of ids) {
            expect(returned).toContain(id);
        }
        expect(body.documents.every((d: { source: string }) => d.source === 'user')).toBe(true);
    });

    test('multi-value type filter accepts both comma-joined and repeated params', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        const comma = await getMemory(request, ctx, '?type=brand,legal');
        expect(comma.counts.documents).toBe(2);
        expect(comma.documents.map((d: { class: string }) => d.class).sort()).toEqual([
            'brand',
            'legal',
        ]);

        const repeated = await getMemory(request, ctx, '?type=brand&type=seo');
        expect(repeated.counts.documents).toBe(2);
        expect(repeated.documents.map((d: { class: string }) => d.class).sort()).toEqual([
            'brand',
            'seo',
        ]);
    });

    test('combined type + status filters intersect (AND semantics)', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        // legal is a DRAFT — matches type=legal&status=draft…
        const hit = await getMemory(request, ctx, '?type=legal&status=draft');
        expect(hit.counts.documents).toBe(1);
        expect(hit.documents[0].class).toBe('legal');

        // …but NOT type=legal&status=active (the legal doc is not active).
        const miss = await getMemory(request, ctx, '?type=legal&status=active');
        expect(miss.counts.documents).toBe(0);
        expect(miss.documents).toEqual([]);
        // indexed remains the org-wide total regardless.
        expect(miss.counts.indexed).toBe(3);
    });

    test('lexical q matches title + description, NOT the document body', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        // "Terms" is in the legal doc's TITLE → matches.
        const byTitle = await getMemory(request, ctx, '?q=Terms');
        expect(byTitle.counts.documents).toBe(1);
        expect(byTitle.documents[0].title).toBe('Terms of Service');

        // "tone doc" is the brand doc's DESCRIPTION → matches.
        const byDesc = await getMemory(request, ctx, '?q=tone%20doc');
        expect(byDesc.counts.documents).toBe(1);
        expect(byDesc.documents[0].class).toBe('brand');

        // "privacy" lives only in the legal doc's BODY → no match (body is not searched).
        const byBody = await getMemory(request, ctx, '?q=privacy');
        expect(byBody.counts.documents).toBe(0);
        expect(byBody.counts.indexed).toBe(3); // header stays stable even with zero matches
    });

    test('work facet: a real work id narrows the feed; a foreign work id is ignored (never leaks another org)', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { workId } = await seedThreeDocs(request, ctx);

        const mine = await getMemory(request, ctx, `?work=${workId}`);
        expect(mine.counts.documents).toBe(3);
        expect(mine.documents.every((d: { workId: string }) => d.workId === workId)).toBe(true);

        // A work id that does not belong to this org intersects to nothing, and because a
        // specific-work selection excludes org-scoped rows the feed is empty — but the
        // org-wide indexed total is untouched, proving no cross-org widening happened.
        const foreign = await getMemory(request, ctx, '?work=11111111-1111-4111-8111-111111111111');
        expect(foreign.counts.documents).toBe(0);
        expect(foreign.documents).toEqual([]);
        expect(foreign.counts.indexed).toBe(3);
    });
});

test.describe('Org Memory — pagination', () => {
    test('limit caps the returned page while counts.documents stays the true match total', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        const page = await getMemory(request, ctx, '?limit=2');
        expect(page.documents.length).toBe(2);
        expect(page.counts.documents).toBe(3);
        expect(page.counts.indexed).toBe(3);
    });

    test('offset pages through the feed; an offset past the end yields an empty page but the same total', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        await seedThreeDocs(request, ctx);

        const page1 = await getMemory(request, ctx, '?limit=2&offset=0');
        expect(page1.documents.length).toBe(2);
        const page2 = await getMemory(request, ctx, '?limit=2&offset=2');
        expect(page2.documents.length).toBe(1);

        // The two pages together cover distinct rows (no overlap).
        const page1Ids = new Set(page1.documents.map((d: { id: string }) => d.id));
        expect(page2.documents.every((d: { id: string }) => !page1Ids.has(d.id))).toBe(true);

        // Beyond the end → empty page, total unchanged.
        const beyond = await getMemory(request, ctx, '?offset=99');
        expect(beyond.documents).toEqual([]);
        expect(beyond.counts.documents).toBe(3);
    });
});

test.describe('Org Memory — validation (400)', () => {
    test('unknown facet enum values (type / status / source) are rejected with 400', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        for (const qs of ['?type=nonsense', '?status=badstatus', '?source=madeup']) {
            const res = await request.get(`${API_BASE}/api/memory${qs}`, { headers: ctx.scoped });
            expect(res.status(), `expected 400 for ${qs}`).toBe(400);
        }
    });

    test('limit / offset bounds and non-numeric values are rejected with 400', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        for (const qs of ['?limit=0', '?limit=201', '?limit=abc', '?offset=-1', '?offset=abc']) {
            const res = await request.get(`${API_BASE}/api/memory${qs}`, { headers: ctx.scoped });
            expect(res.status(), `expected 400 for ${qs}`).toBe(400);
        }
        // A limit inside [1, 200] is accepted.
        const ok = await request.get(`${API_BASE}/api/memory?limit=50`, { headers: ctx.scoped });
        expect(ok.status()).toBe(200);
    });

    test('an over-long q (>200 chars) and an over-long work id (>64 chars) are rejected with 400', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const longQ = 'x'.repeat(201);
        const badQ = await request.get(`${API_BASE}/api/memory?q=${longQ}`, {
            headers: ctx.scoped,
        });
        expect(badQ.status()).toBe(400);

        const longWork = 'a'.repeat(65);
        const badWork = await request.get(`${API_BASE}/api/memory?work=${longWork}`, {
            headers: ctx.scoped,
        });
        expect(badWork.status()).toBe(400);
    });

    test('benign edge params (empty q, empty type, non-uuid work string) are accepted with 200', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        for (const qs of ['?q=', '?type=', '?work=not-a-uuid']) {
            const res = await request.get(`${API_BASE}/api/memory${qs}`, { headers: ctx.scoped });
            expect(res.status(), `expected 200 for ${qs}`).toBe(200);
        }
    });
});

test.describe('Org Memory — auth & cross-org isolation', () => {
    test('unauthenticated GET and consolidate are rejected with 401', async ({ request }) => {
        const getRes = await request.get(`${API_BASE}/api/memory`);
        expect(getRes.status()).toBe(401);
        const postRes = await request.post(`${API_BASE}/api/memory/consolidate`, { data: {} });
        expect(postRes.status()).toBe(401);
    });

    test('one org cannot read another org’s Memory, and pinning a foreign org slug is walled off', async ({
        request,
    }) => {
        const a = await buildOrgCtx(request);
        const b = await buildOrgCtx(request);
        const workA = await createScopedWork(request, a, 'A Work');
        const aDoc = await createKbDoc(request, a, workA, {
            path: 'brand/a.md',
            title: 'A Secret',
            class: 'brand',
        });
        const workB = await createScopedWork(request, b, 'B Work');
        const bDoc = await createKbDoc(request, b, workB, {
            path: 'brand/b.md',
            title: 'B Secret',
            class: 'brand',
        });

        // Each owner sees only their own document.
        const aFeed = await getMemory(request, a);
        expect(aFeed.documents.map((d: { id: string }) => d.id)).toContain(aDoc.id);
        expect(aFeed.documents.map((d: { id: string }) => d.id)).not.toContain(bDoc.id);
        const bFeed = await getMemory(request, b);
        expect(bFeed.documents.map((d: { id: string }) => d.id)).toContain(bDoc.id);
        expect(bFeed.documents.map((d: { id: string }) => d.id)).not.toContain(aDoc.id);

        // B pins A's org slug → the scope-ownership guard walls B off before the
        // aggregation runs (403 here; a membership miss deeper in would 404 — accept both).
        const cross = await request.get(`${API_BASE}/api/memory`, {
            headers: { ...b.headers, 'X-Scope-Slug': a.orgSlug },
        });
        expect([403, 404]).toContain(cross.status());
    });

    test('filtering by another org’s work id from your own scope never surfaces their docs', async ({
        request,
    }) => {
        const a = await buildOrgCtx(request);
        const b = await buildOrgCtx(request);
        const workA = await createScopedWork(request, a, 'A Work');
        await createKbDoc(request, a, workA, {
            path: 'brand/a.md',
            title: 'A Only',
            class: 'brand',
        });
        // B seeds one doc so B's org has a real indexed total to compare against.
        const workB = await createScopedWork(request, b, 'B Work');
        await createKbDoc(request, b, workB, {
            path: 'brand/b.md',
            title: 'B Only',
            class: 'brand',
        });

        // B filters by A's work id — intersected to nothing within B's own org scope.
        const body = await getMemory(request, b, `?work=${workA}`);
        expect(body.counts.documents).toBe(0);
        expect(body.documents).toEqual([]);
        expect(body.counts.indexed).toBe(1); // B's own org total, A's doc never counted
    });

    test('an unknown scope slug resolves to 404 at the middleware', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const res = await request.get(`${API_BASE}/api/memory`, {
            headers: { ...ctx.headers, 'X-Scope-Slug': `ghost-${stamp()}` },
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Org Memory — consolidation', () => {
    test('a bare POST is a dry-run: it returns the report shape and writes NO markers', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedThreeDocs(request, ctx);

        const res = await request.post(`${API_BASE}/api/memory/consolidate`, {
            headers: ctx.scoped,
            data: {},
        });
        expect(res.status()).toBe(200);
        const report = await res.json();
        expect(report.dryRun).toBe(true);
        expect(report.scanned).toBe(3);
        expect(typeof report.promoted).toBe('number');
        expect(typeof report.synthesized).toBe('number');
        expect(typeof report.superseded).toBe('number');
        expect(Array.isArray(report.notes)).toBe(true);
        expect(Array.isArray(report.details.promotedIds)).toBe(true);
        expect(Array.isArray(report.details.supersededPairs)).toBe(true);
        expect(Array.isArray(report.details.synthesizedIds)).toBe(true);

        // Nothing was persisted — every doc's consolidation marker is still null.
        const feed = await getMemory(request, ctx);
        const seeded = feed.documents.filter((d: { id: string }) => ids.includes(d.id));
        expect(seeded.length).toBe(3);
        expect(seeded.every((d: { consolidation: unknown }) => d.consolidation === null)).toBe(
            true,
        );
    });

    test('apply=true persists consolidation markers with { state, score, reason, runAt }', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const { ids } = await seedThreeDocs(request, ctx);

        const res = await request.post(`${API_BASE}/api/memory/consolidate`, {
            headers: ctx.scoped,
            data: { apply: true },
        });
        expect(res.status()).toBe(200);
        const report = await res.json();
        expect(report.dryRun).toBe(false);
        expect(report.scanned).toBe(3);
        expect(report.promoted).toBeGreaterThan(0);
        expect(report.details.promotedIds.length).toBe(report.promoted);

        // At least one seeded doc now carries a promotion marker.
        const feed = await getMemory(request, ctx);
        const promoted = feed.documents.filter(
            (d: { id: string; consolidation: unknown }) =>
                ids.includes(d.id) && d.consolidation !== null,
        );
        expect(promoted.length).toBeGreaterThan(0);
        const marker = promoted[0].consolidation;
        expect(marker.state).toBe('promoted');
        expect(typeof marker.score).toBe('number');
        expect(typeof marker.reason).toBe('string');
        expect(typeof marker.runAt).toBe('string');
    });

    test('consolidate with no active Organization returns a zeroed report + the no-org note', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/memory/consolidate`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        expect(res.status()).toBe(200);
        const report = await res.json();
        expect(report).toMatchObject({
            scanned: 0,
            promoted: 0,
            synthesized: 0,
            superseded: 0,
            dryRun: true,
        });
        expect(report.notes.join(' ')).toContain('No active Organization');
        expect(report.details).toEqual({
            promotedIds: [],
            supersededPairs: [],
            synthesizedIds: [],
        });
    });

    test('a non-boolean apply is rejected with 400', async ({ request }) => {
        const ctx = await buildOrgCtx(request);
        const res = await request.post(`${API_BASE}/api/memory/consolidate`, {
            headers: ctx.scoped,
            data: { apply: 'yes' },
        });
        expect(res.status()).toBe(400);
    });
});

test.describe('Org Memory — the agent-memory plugin', () => {
    test('GET /api/plugins exposes the agentmemory plugin (utility / agent-memory capability)', async ({
        request,
    }) => {
        const ctx = await buildOrgCtx(request);
        const res = await request.get(`${API_BASE}/api/plugins`, { headers: ctx.headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.plugins)).toBe(true);
        expect(typeof body.total).toBe('number');

        const mem = body.plugins.find((p: { id: string }) => p.id === 'agentmemory');
        expect(mem, 'agentmemory plugin present').toBeTruthy();
        expect(mem.category).toBe('utility');
        expect(mem.capabilities).toContain('agent-memory');
        expect(mem.builtIn).toBe(true);

        // The registry's aggregate capability index also advertises agent-memory.
        expect(body.capabilities).toContain('agent-memory');
    });

    test('the plugins registry is auth-gated (401 without a token)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/plugins`);
        expect(res.status()).toBe(401);
    });
});
