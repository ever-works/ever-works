import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

/**
 * KB → Memory → Consolidation CROSS-FEATURE CHAIN, end-to-end — the vertical
 * stitch that follows ONE Knowledge-Base document from its per-Work birth,
 * through live edits, lock/restore, org-wide Memory aggregation, and the
 * Consolidation curation pass, asserting that the SAME row projects
 * COHERENTLY across every surface it touches. Every status code, body shape,
 * and marker asserted below was probed against the LIVE API at
 * http://127.0.0.1:3100 (sqlite in-memory, keyless — no LLM provider,
 * Trigger.dev unbound, git NOT connected) BEFORE the assertions were written.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 * The sibling specs each own ONE surface in isolation; THIS file owns the
 * CROSS-SURFACE coherence none of them assert:
 *   - flow-memory-consolidation-deep.spec.ts — consolidation dry-run/apply/
 *     validation/isolation reading ONLY the Memory feed. THIS file adds the
 *     per-Work DTO cross-check (the consolidation marker surfaces on the
 *     Memory item but is ABSENT from GET /works/:id/kb/documents/:docId), the
 *     "loser still GET-able per-Work after supersede", and marker survival
 *     across an unrelated per-Work edit.
 *   - flow-org-memory-page-deep.spec.ts / -facets-pagination-2.spec.ts — own
 *     the Memory feed's facets/filters/pagination/q in isolation. THIS file
 *     uses the feed only to prove per-Work KB edits (title/class/status)
 *     RE-PROJECT into it.
 *   - flow-kb-document-lock-restore.spec.ts / -locking-history.spec.ts — own
 *     the lock/restore/history verb contracts. THIS file uses them only as
 *     chain hops (a locked / git-gated doc STILL surfaces in Memory).
 *   - flow-kb-inherited-overrides-deep.spec.ts — owns the override lifecycle.
 *     THIS file only asserts the DUAL PROJECTION (one org doc appears in both
 *     GET /api/memory with workId null AND GET /works/:id/kb/inheritable).
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────
 *  A fresh POST /api/organizations becomes the caller's active scope; a Work
 *    created afterward (organization:false) inherits `work.organizationId` =
 *    that org, so its KB docs fan into GET /api/memory.
 *  POST /api/works/:id/kb/documents {path,title,class,body,...} → 201 full
 *    KbDocumentBodyDto { id, workId, organizationId:null, path, slug, title,
 *    class, tags, categories, status:'active', locked:false, lockMode:null,
 *    language:'en', wordCount, tokenCount, source:'user', body, assets:[], … }.
 *    `path` MUST start with a known class folder (brand|legal|seo|style|
 *    glossary|competitors|personas|research|output|freeform) else 400.
 *  POST /api/organizations/:orgId/kb/documents — inheritable classes only
 *    (legal|style|seo); other class → 400; org doc has workId:null,
 *    organizationId set.
 *  GET /api/memory → { documents:OrgMemoryDocumentItem[], counts:{documents,
 *    indexed}, facets:{types,works,statuses,sources} }. Item = { id,title,
 *    description,path,workId,workName,class,status,source,updatedAt,
 *    lastIndexedAt,consolidation } — NO body / locked / tags fields. Facet =
 *    {value,label,count}; works facet resolves workId→Work name. ?work drops
 *    org-level rows; ?type/?status/?source are multi-value; bad enum→400;
 *    limit<1 or >200→400 (items capped, counts.documents = true total).
 *  POST /api/memory/consolidate {apply?} → 200 report { scanned,promoted,
 *    synthesized,superseded,dryRun,notes[],details:{promotedIds,
 *    supersededPairs:[loser,survivor][],synthesizedIds} }. apply defaults
 *    false (dry-run writes nothing). Applied markers land ONLY on the Memory
 *    item.consolidation: promoted={state:'promoted',score:number,reason,runAt};
 *    superseded={state:'superseded',supersededById,reason,runAt}. A non-
 *    inheritable-class 3-cluster → 2 superseded + an "inheritable classes"
 *    note, synthesized:0 (keyless). No active org → zeroed report + no-org note.
 *    Bad `apply` type / unknown prop → 400.
 *  Lock: full → PATCH/DELETE gated 403; additions-only → PATCH 200; bad mode
 *    →400. Restore + history are git-gated → 409 NoGitCredentials in this
 *    repoless env; non-hex commitSha → 400 (DTO) before the git hop.
 *  Isolation tri-state: foreign per-Work KB list → 403; foreign per-Org KB
 *    → 404; cross-tenant Memory → EMPTY (no error). anon → 401.
 *
 * Cross-spec isolation: EVERY test builds its chain on FRESH
 * registerUserViaAPI() users (unique stamps), a lazily-minted Org + Work.
 * List/feed assertions use toContain/not.toContain on the caller's OWN ids —
 * never global counts. No module-scope data loading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

interface KbDoc {
    id: string;
    workId: string | null;
    organizationId: string | null;
    path: string;
    slug: string;
    title: string;
    description: string | null;
    class: string;
    tags: string[];
    categories: string[];
    status: string;
    locked: boolean;
    lockMode: string | null;
    language: string;
    source: string;
    body: string;
    assets: unknown[];
    createdAt: string;
    updatedAt: string;
    // Deliberately optional: the aggregation-only marker must NOT appear here.
    consolidation?: unknown;
}

interface ConsolMarker {
    state: string;
    score?: number;
    supersededById?: string;
    reason: string;
    runAt: string;
}

interface MemoryItem {
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
    consolidation: ConsolMarker | null;
}

interface Facet {
    value: string;
    label: string;
    count: number;
}

interface MemoryResult {
    documents: MemoryItem[];
    counts: { documents: number; indexed: number };
    facets: { types: Facet[]; works: Facet[]; statuses: Facet[]; sources: Facet[] };
}

interface ConsolReport {
    scanned: number;
    promoted: number;
    synthesized: number;
    superseded: number;
    dryRun: boolean;
    notes: string[];
    details: {
        promotedIds: string[];
        supersededPairs: [string, string][];
        synthesizedIds: string[];
    };
}

interface Chain {
    token: string;
    userId: string;
    orgId: string;
    workId: string;
}

/** Register a fresh user, mint an Org (→ active scope), and a Work in it. */
async function buildChain(request: APIRequestContext): Promise<Chain> {
    const user = await registerUserViaAPI(request);
    const org = await createOrganizationViaAPI(request, user.access_token, `Cortex Org ${stamp()}`);
    const work = await createWorkViaAPI(request, user.access_token, {
        name: `Cortex Work ${stamp()}`,
        slug: `cortex-work-${stamp()}`,
    });
    expect(work.id).toMatch(UUID_RE);
    // The Work must join the active Org, else its KB docs never surface.
    const workRead = await request.get(`${API_BASE}/api/works/${work.id}`, {
        headers: authedHeaders(user.access_token),
    });
    const wb = (await workRead.json()) as {
        work?: { organizationId?: string };
        organizationId?: string;
    };
    expect((wb.work ?? wb).organizationId).toBe(org.id);
    return { token: user.access_token, userId: user.user.id, orgId: org.id, workId: work.id };
}

async function createKbDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: {
        path: string;
        title: string;
        class: string;
        body: string;
        tags?: string[];
        status?: string;
    },
): Promise<KbDoc> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `kb create body=${await res.text().catch(() => '')}`).toBe(201);
    const doc = (await res.json()) as KbDoc;
    expect(doc.id).toMatch(UUID_RE);
    return doc;
}

async function createOrgDoc(
    request: APIRequestContext,
    token: string,
    orgId: string,
    body: { path: string; title: string; class: string; body: string },
): Promise<KbDoc> {
    const res = await request.post(`${API_BASE}/api/organizations/${orgId}/kb/documents`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `org kb create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function getMemory(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<MemoryResult> {
    const res = await request.get(`${API_BASE}/api/memory${query ? `?${query}` : ''}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `memory body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function consolidate(
    request: APIRequestContext,
    token: string,
    apply?: boolean,
): Promise<ConsolReport> {
    const res = await request.post(`${API_BASE}/api/memory/consolidate`, {
        headers: authedHeaders(token),
        data: apply === undefined ? {} : { apply },
    });
    expect(res.status(), `consolidate body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

function itemById(result: MemoryResult, id: string): MemoryItem | undefined {
    return result.documents.find((d) => d.id === id);
}

async function getWorkDocRaw(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
        headers: authedHeaders(token),
    });
    const body = res.status() === 200 ? ((await res.json()) as Record<string, unknown>) : {};
    return { status: res.status(), body };
}

const DUP_BODY =
    'The quick brown fox jumps over the lazy dog many times in the meadow near the ' +
    'river bank at dawn each and every single morning without fail or exception here.';

// ────────────────────────────────────────────────────────────────────────
test.describe('KB → Memory chain — one document across surfaces', () => {
    test('a per-Work KB doc surfaces in org Memory with a coherent id and the aggregation-only projection (no body / no locked)', async ({
        request,
    }) => {
        const { token, orgId, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'research/notes.md',
            title: `Research Notes ${stamp()}`,
            class: 'research',
            body: 'A knowledge base note about widgets and gadgets and their many uses.',
            tags: ['alpha', 'beta'],
        });
        // The create DTO is the full body shape.
        expect(doc.workId).toBe(workId);
        expect(doc.organizationId).toBeNull();
        expect(doc.status).toBe('active');
        expect(doc.source).toBe('user');
        expect(doc.locked).toBe(false);
        expect(typeof doc.body).toBe('string');

        // The org Memory item is the SAME row, projected as an aggregation item.
        const mem = await getMemory(request, token);
        const item = itemById(mem, doc.id);
        expect(item, 'the Work KB doc must surface in org Memory').toBeTruthy();
        expect(item!.title).toBe(doc.title);
        expect(item!.class).toBe('research');
        expect(item!.status).toBe('active');
        expect(item!.source).toBe('user');
        expect(item!.workId).toBe(workId);
        expect(typeof item!.workName).toBe('string');
        expect(item!.consolidation).toBeNull();
        // The aggregation projection intentionally omits the heavy body + the
        // per-Work lock fields — those live only on the per-Work DTO.
        expect('body' in item!).toBe(false);
        expect('locked' in item!).toBe(false);

        // counts + facets reflect exactly this one-doc chain.
        expect(mem.counts.documents).toBe(1);
        expect(mem.counts.indexed).toBe(1);
        expect(mem.facets.types).toContainEqual({ value: 'research', label: 'research', count: 1 });
        expect(mem.facets.works.map((f) => f.value)).toContain(workId);
        expect(mem.facets.works.find((f) => f.value === workId)!.label).toBe(item!.workName);
        expect(orgId).toMatch(UUID_RE);
    });

    test('an org-level inheritable doc is DUAL-projected: Memory (workId null) + the Work inheritable resolution; a non-inheritable org class is rejected and never surfaces', async ({
        request,
    }) => {
        const { token, orgId, workId } = await buildChain(request);
        const orgDoc = await createOrgDoc(request, token, orgId, {
            path: 'legal/privacy.md',
            title: `Privacy ${stamp()}`,
            class: 'legal',
            body: 'We respect your privacy. All rights reserved to the organization.',
        });
        expect(orgDoc.workId).toBeNull();
        expect(orgDoc.organizationId).toBe(orgId);

        // Projection 1: the org doc appears in Memory with a null Work.
        const mem = await getMemory(request, token, 'type=legal');
        const memItem = itemById(mem, orgDoc.id);
        expect(memItem, 'org doc must surface in Memory').toBeTruthy();
        expect(memItem!.workId).toBeNull();
        expect(memItem!.workName).toBeNull();
        expect(memItem!.class).toBe('legal');

        // Projection 2: the SAME org doc resolves as an inheritable doc for
        // the Work in that org (full KbDocumentDto array).
        const inh = await request.get(
            `${API_BASE}/api/works/${workId}/kb/inheritable?orgId=${orgId}`,
            { headers: authedHeaders(token) },
        );
        expect(inh.status()).toBe(200);
        const inherited = (await inh.json()) as Array<{
            id: string;
            workId: string | null;
            class: string;
            path: string;
        }>;
        const inhItem = inherited.find((d) => d.id === orgDoc.id);
        expect(inhItem, 'org doc must resolve as inheritable for the Work').toBeTruthy();
        expect(inhItem!.workId).toBeNull();
        expect(inhItem!.path).toBe('legal/privacy.md');

        // A foreign orgId on the inheritable route is walled off (403).
        const foreign = await request.get(
            `${API_BASE}/api/works/${workId}/kb/inheritable?orgId=${UNKNOWN_UUID}`,
            { headers: authedHeaders(token) },
        );
        expect(foreign.status()).toBe(403);

        // A non-inheritable org class is rejected outright and never surfaces.
        const bad = await request.post(`${API_BASE}/api/organizations/${orgId}/kb/documents`, {
            headers: authedHeaders(token),
            data: { path: 'research/x.md', title: 'X', class: 'research', body: 'nope' },
        });
        expect(bad.status()).toBe(400);
        const memAfter = await getMemory(request, token);
        expect(memAfter.documents.every((d) => d.class !== 'research')).toBe(true);
    });

    test('the ?work filter isolates the Work rows and DROPS org-level rows, while the per-Work KB list shows only that Work — the chain projected two ways', async ({
        request,
    }) => {
        const { token, orgId, workId } = await buildChain(request);
        const workDoc = await createKbDoc(request, token, workId, {
            path: 'research/w.md',
            title: `WorkDoc ${stamp()}`,
            class: 'research',
            body: 'work scoped document body with several distinct words in it here now',
        });
        const orgDoc = await createOrgDoc(request, token, orgId, {
            path: 'seo/meta.md',
            title: `OrgSeo ${stamp()}`,
            class: 'seo',
            body: 'organization seo meta body words',
        });

        // Unfiltered: both the Work doc and the org doc are present.
        const all = await getMemory(request, token);
        expect(all.documents.map((d) => d.id)).toEqual(
            expect.arrayContaining([workDoc.id, orgDoc.id]),
        );

        // ?work=WORK: the org-level row is DROPPED (a Work selection is about
        // Work documents), leaving only the Work doc.
        const byWork = await getMemory(request, token, `work=${workId}`);
        expect(byWork.documents.map((d) => d.id)).toContain(workDoc.id);
        expect(byWork.documents.map((d) => d.id)).not.toContain(orgDoc.id);

        // The per-Work KB list shows the Work's own doc (never the org row,
        // which has workId null).
        const list = await request.get(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(token),
        });
        expect(list.status()).toBe(200);
        const listed = (await list.json()) as
            | { items: Array<{ id: string }> }
            | Array<{ id: string }>;
        const ids = Array.isArray(listed) ? listed.map((d) => d.id) : listed.items.map((d) => d.id);
        expect(ids).toContain(workDoc.id);
        expect(ids).not.toContain(orgDoc.id);
    });
});

// ────────────────────────────────────────────────────────────────────────
test.describe('Per-Work KB edits re-project into Memory', () => {
    test('a PATCH title on the per-Work doc relabels the Memory item (q finds the new title, misses the old)', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const oldTitle = `OldName ${stamp()}`;
        const doc = await createKbDoc(request, token, workId, {
            path: 'research/t.md',
            title: oldTitle,
            class: 'research',
            body: 'body text that is unrelated to the title tokens entirely here',
        });
        const newTitle = `Renamed ${stamp()}`;
        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`,
            {
                headers: authedHeaders(token),
                data: { title: newTitle },
            },
        );
        expect(patch.status()).toBe(200);
        expect((await patch.json()).title).toBe(newTitle);

        // The Memory feed relabels: a lexical q on the new title finds it…
        const hit = await getMemory(
            request,
            token,
            `q=${encodeURIComponent(newTitle.split(' ')[0])}`,
        );
        expect(hit.documents.map((d) => d.id)).toContain(doc.id);
        expect(itemById(hit, doc.id)!.title).toBe(newTitle);
        // …and the old title no longer matches.
        const miss = await getMemory(
            request,
            token,
            `q=${encodeURIComponent(oldTitle.split(' ')[0])}`,
        );
        expect(miss.documents.map((d) => d.id)).not.toContain(doc.id);
    });

    test('a PATCH class re-buckets the Memory TYPE facet and the item agrees on the new class', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'research/c.md',
            title: `Classy ${stamp()}`,
            class: 'research',
            body: 'a document that will be reclassified from research to glossary soon',
        });
        expect((await getMemory(request, token)).facets.types).toContainEqual({
            value: 'research',
            label: 'research',
            count: 1,
        });

        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`,
            {
                headers: authedHeaders(token),
                data: { class: 'glossary' },
            },
        );
        expect(patch.status()).toBe(200);
        expect((await patch.json()).class).toBe('glossary');

        const mem = await getMemory(request, token);
        expect(mem.facets.types).toContainEqual({ value: 'glossary', label: 'glossary', count: 1 });
        expect(mem.facets.types.map((f) => f.value)).not.toContain('research');
        expect(itemById(mem, doc.id)!.class).toBe('glossary');
    });

    test('a PATCH status active→archived keeps the doc in the feed (no default status gate) and moves the status facet + filters', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'style/s.md',
            title: `Styleful ${stamp()}`,
            class: 'style',
            body: 'a style guide document that will be archived but must still surface',
        });
        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`,
            {
                headers: authedHeaders(token),
                data: { status: 'archived' },
            },
        );
        expect(patch.status()).toBe(200);

        // Default feed has NO status gate: the archived doc still surfaces.
        const mem = await getMemory(request, token);
        expect(itemById(mem, doc.id)!.status).toBe('archived');
        expect(mem.facets.statuses).toContainEqual({
            value: 'archived',
            label: 'archived',
            count: 1,
        });
        // ?status=archived finds it; ?status=draft does not.
        expect(
            (await getMemory(request, token, 'status=archived')).documents.map((d) => d.id),
        ).toContain(doc.id);
        expect(
            (await getMemory(request, token, 'status=draft')).documents.map((d) => d.id),
        ).not.toContain(doc.id);
    });
});

// ────────────────────────────────────────────────────────────────────────
test.describe('Lock / restore / history as chain hops', () => {
    test('full-lock a surfaced doc → it STILL surfaces in Memory; PATCH+DELETE gate 403; unlock reopens PATCH; the Memory item never carries a lock field', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'research/lock.md',
            title: `Lockable ${stamp()}`,
            class: 'research',
            body: 'a document that will be fully locked but keeps surfacing in memory',
        });

        const lock = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/lock`,
            { headers: authedHeaders(token), data: { mode: 'full' } },
        );
        expect(lock.status()).toBe(200);
        const locked = (await lock.json()) as KbDoc;
        expect(locked.locked).toBe(true);
        expect(locked.lockMode).toBe('full');

        // Still in Memory (no locked facet), and the item exposes no lock field.
        const mem = await getMemory(request, token);
        const item = itemById(mem, doc.id);
        expect(item).toBeTruthy();
        expect('locked' in item!).toBe(false);
        expect('lockMode' in item!).toBe(false);

        // Full lock gates content mutations.
        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`,
            {
                headers: authedHeaders(token),
                data: { body: 'blocked edit' },
            },
        );
        expect(patch.status()).toBe(403);
        const del = await request.delete(`${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(403);

        // Unlock reopens editing.
        const unlock = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/unlock`,
            { headers: authedHeaders(token) },
        );
        expect(unlock.status()).toBe(200);
        expect((await unlock.json()).locked).toBe(false);
        const patch2 = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`,
            { headers: authedHeaders(token), data: { title: `Reopened ${stamp()}` } },
        );
        expect(patch2.status()).toBe(200);
    });

    test('additions-only lock still allows a body PATCH and the doc keeps surfacing; an off-enum mode → 400; a non-UUID docId → 400', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'glossary/g.md',
            title: `Additive ${stamp()}`,
            class: 'glossary',
            body: 'original glossary body content that additions-only should still allow editing',
        });
        const lock = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/lock`,
            { headers: authedHeaders(token), data: { mode: 'additions-only' } },
        );
        expect(lock.status()).toBe(200);
        expect((await lock.json()).lockMode).toBe('additions-only');

        // additions-only does NOT pre-empt an update (only full does).
        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}`,
            {
                headers: authedHeaders(token),
                data: { body: 'appended body under additions-only lock' },
            },
        );
        expect(patch.status()).toBe(200);
        expect((await getMemory(request, token)).documents.map((d) => d.id)).toContain(doc.id);

        // Off-enum lock mode → 400 with the enum message.
        const badMode = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/lock`,
            { headers: authedHeaders(token), data: { mode: 'nonsense' } },
        );
        expect(badMode.status()).toBe(400);
        // Non-UUID docId is rejected at the ParseUUIDPipe.
        const badId = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/not-a-uuid/lock`,
            { headers: authedHeaders(token), data: { mode: 'full' } },
        );
        expect(badId.status()).toBe(400);
    });

    test('restore + history are git-gated (repoless) → 409, yet the doc + its Memory surfacing survive; a non-hex commitSha → 400 before the git hop', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'research/r.md',
            title: `Restorable ${stamp()}`,
            class: 'research',
            body: 'a document whose git history is unavailable without a connected repo',
        });

        // A valid-hex SHA reaches the git mirror, which has no connected
        // account → NoGitCredentials 409 (tolerate the repoless failure band).
        const restore = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/restore`,
            { headers: authedHeaders(token), data: { commitSha: 'abc1234' } },
        );
        expect([409, 400, 404, 500, 503]).toContain(restore.status());
        expect(restore.status()).toBe(409);

        // The history read is git-gated the same way.
        const history = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/history`,
            { headers: authedHeaders(token) },
        );
        expect([409, 400, 404, 500, 503]).toContain(history.status());

        // A symbolic / non-hex ref is rejected at the DTO BEFORE the git hop.
        const badSha = await request.post(
            `${API_BASE}/api/works/${workId}/kb/documents/${doc.id}/restore`,
            { headers: authedHeaders(token), data: { commitSha: 'HEAD~1' } },
        );
        expect(badSha.status()).toBe(400);

        // The failed git hops changed nothing: the doc still reads (200) and
        // still surfaces in Memory.
        const read = await getWorkDocRaw(request, token, workId, doc.id);
        expect(read.status).toBe(200);
        expect((await getMemory(request, token)).documents.map((d) => d.id)).toContain(doc.id);
    });
});

// ────────────────────────────────────────────────────────────────────────
test.describe('Consolidation markers project onto Memory, not the per-Work DTO', () => {
    test('a bare POST is a dry-run: it COMPUTES the supersede pair it would create, yet writes NOTHING (every feed marker stays null)', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const a = await createKbDoc(request, token, workId, {
            path: 'research/d1.md',
            title: `Twin ${stamp()}`,
            class: 'research',
            body: DUP_BODY,
        });
        const b = await createKbDoc(request, token, workId, {
            path: 'research/d2.md',
            title: 'Twin',
            class: 'research',
            body: DUP_BODY,
        });

        const report = await consolidate(request, token); // bare POST
        expect(report.dryRun).toBe(true);
        expect(report.scanned).toBe(2);
        expect(report.superseded).toBe(1);
        // The preview ALREADY lists the pair it would supersede…
        expect(report.details.supersededPairs).toHaveLength(1);
        const [loser, survivor] = report.details.supersededPairs[0];
        expect([a.id, b.id]).toContain(loser);
        expect([a.id, b.id]).toContain(survivor);
        expect(loser).not.toBe(survivor);
        expect(report.notes.some((n) => /dry run/i.test(n))).toBe(true);

        // …but NO marker is persisted — the feed stays clean.
        const mem = await getMemory(request, token);
        expect(mem.documents.every((d) => d.consolidation === null)).toBe(true);
    });

    test('apply persists the report’s markers ONLY on the Memory item (loser superseded → survivor; survivor promoted with a numeric score); the per-Work DTO carries no marker', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        const a = await createKbDoc(request, token, workId, {
            path: 'research/e1.md',
            title: `Echo ${stamp()}`,
            class: 'research',
            body: DUP_BODY,
        });
        const b = await createKbDoc(request, token, workId, {
            path: 'research/e2.md',
            title: 'Echo',
            class: 'research',
            body: DUP_BODY,
        });

        const report = await consolidate(request, token, true);
        expect(report.dryRun).toBe(false);
        expect(report.superseded).toBe(1);
        const [loserId, survivorId] = report.details.supersededPairs[0];
        expect(report.details.promotedIds).toContain(survivorId);

        const mem = await getMemory(request, token);
        const loser = itemById(mem, loserId)!;
        const survivor = itemById(mem, survivorId)!;

        // Superseded marker shape.
        expect(loser.consolidation).toBeTruthy();
        expect(loser.consolidation!.state).toBe('superseded');
        expect(loser.consolidation!.supersededById).toBe(survivorId);
        expect(loser.consolidation!.reason).toMatch(/near-duplicate/i);
        expect(typeof loser.consolidation!.runAt).toBe('string');

        // Promoted marker shape (regular promotion carries a numeric score).
        expect(survivor.consolidation!.state).toBe('promoted');
        expect(typeof survivor.consolidation!.score).toBe('number');
        expect(survivor.consolidation!.score!).toBeGreaterThanOrEqual(0);
        expect(survivor.consolidation!.reason).toMatch(/promotion score/i);

        // The marker lives ONLY on the aggregation projection — the per-Work
        // KB doc DTO exposes no `consolidation` key on either row.
        const loserRaw = await getWorkDocRaw(request, token, workId, loserId);
        const survivorRaw = await getWorkDocRaw(request, token, workId, survivorId);
        expect(loserRaw.status).toBe(200);
        expect('consolidation' in loserRaw.body).toBe(false);
        expect('consolidation' in survivorRaw.body).toBe(false);
        // Ids are stable across both surfaces.
        expect([a.id, b.id].sort()).toEqual([loserId, survivorId].sort());
    });

    test('the superseded loser is NEVER deleted: still in the feed (state superseded), still GET-able per-Work (200), and an unrelated edit leaves the marker intact', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        await createKbDoc(request, token, workId, {
            path: 'research/f1.md',
            title: `Fox ${stamp()}`,
            class: 'research',
            body: DUP_BODY,
        });
        await createKbDoc(request, token, workId, {
            path: 'research/f2.md',
            title: 'Fox',
            class: 'research',
            body: DUP_BODY,
        });
        const report = await consolidate(request, token, true);
        const [loserId] = report.details.supersededPairs[0];

        // Still surfaced with the superseded state.
        const before = itemById(await getMemory(request, token), loserId)!;
        expect(before.consolidation!.state).toBe('superseded');
        const runAtBefore = before.consolidation!.runAt;

        // Still fully readable via the per-Work route (never hard-deleted).
        const read = await getWorkDocRaw(request, token, workId, loserId);
        expect(read.status).toBe(200);
        expect(read.body.id).toBe(loserId);

        // An unrelated per-Work metadata edit does not disturb the marker.
        const patch = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${loserId}`,
            { headers: authedHeaders(token), data: { title: `Fox Renamed ${stamp()}` } },
        );
        expect(patch.status()).toBe(200);
        const after = itemById(await getMemory(request, token), loserId)!;
        expect(after.consolidation!.state).toBe('superseded');
        expect(after.consolidation!.supersededById).toBe(before.consolidation!.supersededById);
        expect(after.consolidation!.runAt).toBe(runAtBefore);
    });

    test('apply is idempotent (a re-run supersedes 0 and the marker is stable); distinct docs apply to all-promoted / none-superseded', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        await createKbDoc(request, token, workId, {
            path: 'research/g1.md',
            title: `Golf ${stamp()}`,
            class: 'research',
            body: DUP_BODY,
        });
        await createKbDoc(request, token, workId, {
            path: 'research/g2.md',
            title: 'Golf',
            class: 'research',
            body: DUP_BODY,
        });
        const first = await consolidate(request, token, true);
        expect(first.superseded).toBe(1);
        const [loserId, survivorId] = first.details.supersededPairs[0];

        // Re-apply: the already-superseded loser is left alone (0 new
        // supersedes), the survivor stays promoted.
        const second = await consolidate(request, token, true);
        expect(second.superseded).toBe(0);
        const after = itemById(await getMemory(request, token), loserId)!;
        expect(after.consolidation!.state).toBe('superseded');
        expect(after.consolidation!.supersededById).toBe(survivorId);

        // A chain of two DISTINCT docs → both promoted, none superseded.
        const distinct = await buildChain(request);
        await createKbDoc(request, distinct.token, distinct.workId, {
            path: 'research/h1.md',
            title: `Alpha ${stamp()}`,
            class: 'research',
            body: 'astronomy and stars in the deep night sky above the quiet ocean',
        });
        await createKbDoc(request, distinct.token, distinct.workId, {
            path: 'glossary/h2.md',
            title: `Beta ${stamp()}`,
            class: 'glossary',
            body: 'geology and tectonic plates shifting beneath the vast continents',
        });
        const distinctReport = await consolidate(request, distinct.token, true);
        expect(distinctReport.superseded).toBe(0);
        expect(distinctReport.promoted).toBe(2);
        const distinctMem = await getMemory(request, distinct.token);
        expect(distinctMem.documents.every((d) => d.consolidation?.state === 'promoted')).toBe(
            true,
        );
    });

    test('a 3-cluster of a non-inheritable class supersedes 2 with an “inheritable classes” note and synthesized:0 (keyless-safe)', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        for (const n of ['x1', 'x2', 'x3']) {
            await createKbDoc(request, token, workId, {
                path: `research/${n}.md`,
                title: `Cluster ${stamp()}`,
                class: 'research',
                body: DUP_BODY,
            });
        }
        const report = await consolidate(request, token); // dry-run is enough
        expect(report.scanned).toBe(3);
        // survivor + 2 losers → 2 supersede pairs sharing one survivor.
        expect(report.superseded).toBe(2);
        const survivors = new Set(report.details.supersededPairs.map(([, s]) => s));
        expect(survivors.size).toBe(1);
        // Synthesis is skipped for the non-inheritable class (env-independent),
        // and never yields a synthesized doc in the keyless stack.
        expect(report.synthesized).toBe(0);
        expect(report.notes.some((n) => /inheritable classes/i.test(n))).toBe(true);
    });

    test('no active Organization → the Memory feed AND consolidate (dry-run + apply) all return the zeroed / empty payload with the no-org note', async ({
        request,
    }) => {
        // A fresh user with NO Organization has no active scope.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const mem = await getMemory(request, token);
        expect(mem.documents).toEqual([]);
        expect(mem.counts).toEqual({ documents: 0, indexed: 0 });
        expect(mem.facets).toEqual({ types: [], works: [], statuses: [], sources: [] });

        for (const apply of [undefined, false, true] as const) {
            const report = await consolidate(request, token, apply);
            expect(report.scanned).toBe(0);
            expect(report.promoted).toBe(0);
            expect(report.superseded).toBe(0);
            expect(report.details.supersededPairs).toEqual([]);
            expect(report.notes.some((n) => /no active organization/i.test(n))).toBe(true);
        }
    });
});

// ────────────────────────────────────────────────────────────────────────
test.describe('Cross-surface isolation + scope stability', () => {
    test('a stranger’s Memory never contains the chain, and a stranger consolidate runs only against their own empty org', async ({
        request,
    }) => {
        const owner = await buildChain(request);
        const ownerDoc = await createKbDoc(request, owner.token, owner.workId, {
            path: 'research/secret.md',
            title: `Secret ${stamp()}`,
            class: 'research',
            body: 'confidential research the stranger must never see in their feed',
        });
        // Owner applies markers.
        await createKbDoc(request, owner.token, owner.workId, {
            path: 'research/secret2.md',
            title: 'Secret',
            class: 'research',
            body: DUP_BODY,
        });
        await createKbDoc(request, owner.token, owner.workId, {
            path: 'research/secret3.md',
            title: 'Secret',
            class: 'research',
            body: DUP_BODY,
        });
        await consolidate(request, owner.token, true);

        // A stranger with their own org sees NONE of it.
        const stranger = await buildChain(request);
        const strangerMem = await getMemory(request, stranger.token);
        expect(strangerMem.documents.map((d) => d.id)).not.toContain(ownerDoc.id);

        // The stranger's consolidate is bounded to their own (single-doc,
        // no-dup) org — it never touches the owner's chain.
        await createKbDoc(request, stranger.token, stranger.workId, {
            path: 'research/mine.md',
            title: `Mine ${stamp()}`,
            class: 'research',
            body: 'the strangers own solitary document with unique content here',
        });
        const strangerReport = await consolidate(request, stranger.token, true);
        expect(strangerReport.superseded).toBe(0);
        expect(strangerReport.details.supersededPairs).toEqual([]);

        // The owner's markers are untouched by the stranger's run.
        const ownerMem = await getMemory(request, owner.token);
        expect(ownerMem.documents.some((d) => d.consolidation?.state === 'superseded')).toBe(true);
    });

    test('KB/Memory/Org security is a tri-state: foreign per-Work KB → 403, foreign per-Org KB → 404, cross-tenant Memory → empty', async ({
        request,
    }) => {
        const owner = await buildChain(request);
        await createKbDoc(request, owner.token, owner.workId, {
            path: 'research/o.md',
            title: `Owned ${stamp()}`,
            class: 'research',
            body: 'a document owned by the first user and walled off from the stranger',
        });
        const stranger = await registerUserViaAPI(request);
        const s = authedHeaders(stranger.access_token);

        // Per-Work KB list of a foreign Work → 403 (ensureCanView on works).
        const workKb = await request.get(`${API_BASE}/api/works/${owner.workId}/kb/documents`, {
            headers: s,
        });
        expect([403, 404]).toContain(workKb.status());
        expect(workKb.status()).toBe(403);

        // Per-Org KB list of a foreign Org → 404 (membership existence-leak
        // posture), and a write is 404 too.
        const orgKbList = await request.get(
            `${API_BASE}/api/organizations/${owner.orgId}/kb/documents`,
            { headers: s },
        );
        expect(orgKbList.status()).toBe(404);
        const orgKbWrite = await request.post(
            `${API_BASE}/api/organizations/${owner.orgId}/kb/documents`,
            { headers: s, data: { path: 'legal/x.md', title: 'x', class: 'legal', body: 'y' } },
        );
        expect(orgKbWrite.status()).toBe(404);

        // Cross-tenant Memory is EMPTY, not an error (the stranger with no org
        // gets the zeroed aggregation — never the owner's rows).
        const mem = await getMemory(request, stranger.access_token);
        expect(mem.documents).toEqual([]);
    });

    test('filtering your own Memory by another user’s Work id never widens scope; anon GET + consolidate → 401', async ({
        request,
    }) => {
        const owner = await buildChain(request);
        const ownerDoc = await createKbDoc(request, owner.token, owner.workId, {
            path: 'research/p.md',
            title: `Peer ${stamp()}`,
            class: 'research',
            body: 'a doc that must not leak into another users work-filtered memory feed',
        });

        // A different user filters THEIR memory by the owner's Work id → the
        // intersect drops it (never widens beyond the caller's own org).
        const other = await buildChain(request);
        await createKbDoc(request, other.token, other.workId, {
            path: 'research/mine.md',
            title: `OtherOwn ${stamp()}`,
            class: 'research',
            body: 'the other users own doc which is the only thing they may see here',
        });
        const filtered = await getMemory(request, other.token, `work=${owner.workId}`);
        expect(filtered.documents.map((d) => d.id)).not.toContain(ownerDoc.id);
        expect(filtered.documents).toEqual([]);

        // Anonymous → 401 on both surfaces.
        expect((await request.get(`${API_BASE}/api/memory`)).status()).toBe(401);
        expect(
            (
                await request.post(`${API_BASE}/api/memory/consolidate`, {
                    data: { apply: false },
                })
            ).status(),
        ).toBe(401);
    });

    test('creating a SECOND Organization does not flip the active Memory scope — the feed keeps surfacing the first org’s chain', async ({
        request,
    }) => {
        const { token, orgId, workId } = await buildChain(request);
        const doc = await createKbDoc(request, token, workId, {
            path: 'research/first.md',
            title: `FirstOrg ${stamp()}`,
            class: 'research',
            body: 'a document authored in the first organization that must stay visible',
        });
        expect((await getMemory(request, token)).documents.map((d) => d.id)).toContain(doc.id);

        // Mint a SECOND org (no docs). The active scope is the validated
        // last-active org (org #1), not the newest — so the feed is unchanged.
        const second = await createOrganizationViaAPI(request, token, `Second Org ${stamp()}`);
        expect(second.id).not.toBe(orgId);
        const mem = await getMemory(request, token);
        expect(mem.documents.map((d) => d.id)).toContain(doc.id);
        expect(mem.counts.documents).toBeGreaterThanOrEqual(1);
    });
});

// ────────────────────────────────────────────────────────────────────────
test.describe('Validation guards along the chain', () => {
    test('Memory query guards: unknown type/status/source enum → 400; limit 0 and limit 201 → 400; a valid limit caps the page while counts.documents holds', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);
        await createKbDoc(request, token, workId, {
            path: 'research/v1.md',
            title: `V1 ${stamp()}`,
            class: 'research',
            body: 'first document of two used to prove the limit caps the page not the count',
        });
        await createKbDoc(request, token, workId, {
            path: 'glossary/v2.md',
            title: `V2 ${stamp()}`,
            class: 'glossary',
            body: 'second document of two used to prove the limit caps the page not the count',
        });

        for (const bad of [
            'type=notaclass',
            'status=nope',
            'source=bogus',
            'limit=0',
            'limit=201',
        ]) {
            const res = await request.get(`${API_BASE}/api/memory?${bad}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `expected 400 for ?${bad}`).toBe(400);
        }

        // A valid limit caps the returned page while counts.documents stays
        // the TRUE match total (2), not the page length (1).
        const capped = await getMemory(request, token, 'limit=1');
        expect(capped.documents).toHaveLength(1);
        expect(capped.counts.documents).toBe(2);
    });

    test('Consolidate + KB body guards: apply string/number → 400, unknown property → 400, malformed workId → 400, unknown docId → 404', async ({
        request,
    }) => {
        const { token, workId } = await buildChain(request);

        for (const bad of [{ apply: 'yes' }, { apply: 1 }, { bogusField: true }]) {
            const res = await request.post(`${API_BASE}/api/memory/consolidate`, {
                headers: authedHeaders(token),
                data: bad,
            });
            expect(res.status(), `expected 400 for ${JSON.stringify(bad)}`).toBe(400);
        }

        // Malformed workId in a KB route → 400 at the ParseUUIDPipe.
        const malformed = await request.get(`${API_BASE}/api/works/not-a-uuid/kb/documents`, {
            headers: authedHeaders(token),
        });
        expect(malformed.status()).toBe(400);

        // A well-formed but unknown docId → 404.
        const unknown = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${UNKNOWN_UUID}`,
            { headers: authedHeaders(token) },
        );
        expect(unknown.status()).toBe(404);

        // A KB path that does not start with a known class folder → 400.
        const badPath = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(token),
            data: { path: 'toplevel.md', title: 'X', class: 'research', body: 'body' },
        });
        expect(badPath.status()).toBe(400);
        expect(msgOf(await badPath.json())).toMatch(/known class folder/i);
    });
});
