import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Work taxonomy (categories / tags / collections) — COMPLEX, multi-step, cross-feature
 * INTEGRATION flows, anchored to the REAL per-work API surface.
 *
 * GROUND TRUTH — LIVE-PROBED against the running sqlite-in-memory CI driver on 2026-06-01
 * (register a throwaway owner A + stranger B, create a fresh work, curl every endpoint) and
 * cross-read against the controller + service source:
 *   - apps/api/src/works/works.controller.ts (@Controller('api'), global AuthSessionGuard)
 *   - packages/agent/src/services/work-taxonomy.service.ts (create/update/delete C/T/C)
 *   - packages/agent/src/services/work-ownership.service.ts (ensureAccess / ensureCanEdit)
 *   - packages/agent/src/dto/taxonomy.dto.ts (Create{Category,Tag,Collection}Dto)
 *
 * Taxonomy in Ever Works is PER-WORK and DATA-REPO-SOURCED. There is NO standalone
 * /api/categories|tags|collections and NO top-level /api/works/count. The surface is nested
 * under a Work:
 *
 *   READS (work-query.service, git-tolerant -> empty arrays for a fresh non-connected work):
 *     GET /api/works/:id/categories-tags
 *         owner    -> 200 { status:'success', categories:[], tags:[], collections:[] }
 *         anon     -> 401 { message:'Unauthorized', statusCode:401 }
 *         stranger -> 403 { status:'error', message:'You do not have permission to access this work' }
 *         ghost id -> 404 { status:'error', message:"Work with id '<id>' not found" }
 *     GET /api/works/:id/count
 *         owner    -> 200 { status:'success', items:0, categories:0, tags:0 }  (workCount())
 *         count.categories / count.tags ARE the per-work taxonomy counts and MIRROR the read.
 *         auth/ownership/ghost identical to categories-tags above.
 *
 *   WRITES (work-taxonomy.service -> dataGenerator.save*, git-gated on a non-connected work):
 *     POST /api/works/:id/categories  CreateCategoryDto  { name(@IsString @MaxLength 100), … }
 *     POST /api/works/:id/tags        CreateTagDto       { name(@IsString @MaxLength 50) }
 *     POST /api/works/:id/collections CreateCollectionDto{ name(@IsString @MaxLength 100), … }
 *       ORDER OF GATES (probed): ValidationPipe -> ownership(ensureCanEdit) -> data-repo save.
 *         DTO-invalid (missing name) -> 400 { message:string[], error:'Bad Request', statusCode:400 }
 *           (validation runs FIRST, before ownership, before git).
 *         anon                       -> 401 { message:'Unauthorized', statusCode:401 }
 *         stranger (DTO-valid)       -> 403 { status:'error', message:'You do not have permission…' }
 *         ghost id (DTO-valid)       -> 404 { status:'error', message:"Work with id '<id>' not found" }
 *         OWNER, DTO-valid, NON-git-connected work -> 500 { statusCode:500, message:'Internal server error' }
 *           — the dataGenerator save throws (no connected data repo); the dedicated taxonomy-write
 *             endpoints surface this as a GENERIC 500 (distinct from submit-item's 400 reconnect-git).
 *     PUT/DELETE /api/works/:id/{categories|tags|collections}/:childId
 *         OWNER on a real non-connected work -> 500 (the git-gated getCategoriesTags read inside the
 *         service fires BEFORE the per-child not-found check, so the gate dominates).
 *
 *   The legacy POST /api/works/:id/submit-item carries an item's category+tags; a DTO-VALID body
 *   on a non-connected work hits a 400 reconnect-git gate (asserted as a cross-write contrast).
 *
 *   Auth: register DTO { username(>=3), email, password }; login DTO ONLY { email, password }.
 *
 * NON-DUPLICATION: the sibling specs (work-items-crud, flow-work-items-crud-deep,
 * flow-work-full-lifecycle) assert the empty owner-side read envelope and the submit-item gate.
 * These 6 flows add the surface they LACK: the DEDICATED taxonomy-WRITE endpoints
 * (categories/tags/collections) and their exact 500 git-gate, the gate-ORDER invariant
 * (validation -> ownership -> git, asserted by switching one variable at a time), stranger-403
 * and ghost-404 on BOTH reads AND writes with their precise envelopes, the count<->read accuracy
 * invariant after a NO-OP gated write, PUT/DELETE git-gate dominance, and per-work isolation.
 *
 * Cross-spec isolation: every mutation runs on a FRESH registerUserViaAPI() user; the seeded
 * storageState user is touched ONLY for read-only assertions. List assertions use toContain on
 * ids, never exact global counts. Filename uses the safe `flow-` prefix.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT_WORK_ID = '00000000-0000-0000-0000-000000000000';
const PERMISSION_RE = /do not have permission to access this work/i;
const NOT_FOUND_RE = /not found/i;
const GIT_GATE_MESSAGE = 'Please reconnect your Git account to continue.';

const TAXONOMY_KINDS = ['categories', 'tags', 'collections'] as const;
type TaxonomyKind = (typeof TAXONOMY_KINDS)[number];

interface TaxonomyEnvelope {
    status?: string;
    categories?: unknown[];
    tags?: unknown[];
    collections?: unknown[];
}
interface CountEnvelope {
    status?: string;
    items?: number;
    categories?: number;
    tags?: number;
}
interface ErrorEnvelope {
    status?: string;
    statusCode?: number;
    message?: unknown;
    error?: string;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function readJson<T>(res: { json(): Promise<unknown>; text(): Promise<string> }): Promise<T> {
    try {
        return (await res.json()) as T;
    } catch {
        return {} as T;
    }
}

/** GET /api/works (owner-scoped). Returns { works, total }. */
async function listWorks(
    request: APIRequestContext,
    token: string,
): Promise<{ works: Array<{ id: string; name?: string; slug?: string }>; total: number }> {
    const res = await request.get(`${API_BASE}/api/works`, { headers: authedHeaders(token) });
    expect(res.status(), `list works body=${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as { works?: unknown[]; items?: unknown[]; total?: number };
    const works = (body.works ?? body.items ?? (Array.isArray(body) ? body : [])) as Array<{
        id: string;
        name?: string;
        slug?: string;
    }>;
    return { works, total: body.total ?? works.length };
}

/** GET /api/works/:id/categories-tags — the per-work taxonomy read endpoint. */
async function getTaxonomy(
    request: APIRequestContext,
    token: string | null,
    workId: string,
): Promise<{ status: number; body: TaxonomyEnvelope & ErrorEnvelope }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/categories-tags`, {
        headers: token ? authedHeaders(token) : undefined,
    });
    return { status: res.status(), body: await readJson<TaxonomyEnvelope & ErrorEnvelope>(res) };
}

/** GET /api/works/:id/count — the per-work taxonomy count endpoint. */
async function getCount(
    request: APIRequestContext,
    token: string | null,
    workId: string,
): Promise<{ status: number; body: CountEnvelope & ErrorEnvelope }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/count`, {
        headers: token ? authedHeaders(token) : undefined,
    });
    return { status: res.status(), body: await readJson<CountEnvelope & ErrorEnvelope>(res) };
}

/** POST /api/works/:id/{kind} — a dedicated taxonomy write. */
async function postTaxonomy(
    request: APIRequestContext,
    token: string | null,
    workId: string,
    kind: TaxonomyKind,
    data: Record<string, unknown>,
): Promise<{ status: number; body: ErrorEnvelope; text: string }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/${kind}`, {
        headers: token ? authedHeaders(token) : undefined,
        data,
    });
    const text = await res.text().catch(() => '');
    let body: ErrorEnvelope = {};
    try {
        body = JSON.parse(text || '{}') as ErrorEnvelope;
    } catch {
        body = {};
    }
    return { status: res.status(), body, text };
}

/** Assert the OWNER-side success taxonomy envelope on a fresh non-connected work. */
function assertEmptyTaxonomy(body: TaxonomyEnvelope, label: string): void {
    expect(body.status, `${label}: categories-tags envelope is success`).toBe('success');
    expect(Array.isArray(body.categories), `${label}: categories is an array`).toBe(true);
    expect(Array.isArray(body.tags), `${label}: tags is an array`).toBe(true);
    expect(Array.isArray(body.collections), `${label}: collections is an array`).toBe(true);
    expect(body.categories!.length, `${label}: fresh work has no categories`).toBe(0);
    expect(body.tags!.length, `${label}: fresh work has no tags`).toBe(0);
    expect(body.collections!.length, `${label}: fresh work has no collections`).toBe(0);
}

/** Assert the canonical { status:'error', message } denial envelope used by the ownership guard. */
function assertDenialEnvelope(body: ErrorEnvelope, messageRe: RegExp, label: string): void {
    // The ownership guard throws ForbiddenException/NotFoundException with a { status:'error',
    // message } payload. When a JSON body is present it MUST carry that shape; the status code is
    // the load-bearing invariant and is asserted separately by the caller.
    if (body && (body.status !== undefined || body.message !== undefined)) {
        expect(body.status, `${label}: denial uses the error envelope`).toBe('error');
        expect(String(body.message), `${label}: denial message`).toMatch(messageRe);
    }
}

test.describe('Work taxonomy (deep) — per-work categories / tags / collections', () => {
    test('per-work taxonomy READS (categories-tags + count) are auth-gated and return the canonical owner envelopes', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const s = stamp();
        const { id: workId, raw } = await createWorkViaAPI(request, u.access_token, {
            name: `Taxo Read ${s}`,
            slug: `taxo-read-${s}`,
        });
        expect(workId, `created work id from ${JSON.stringify(raw)}`).toMatch(UUID_RE);
        expect((raw as { status?: string }).status).toBe('success');

        // 1) Unauthenticated reads -> 401 (AuthSessionGuard, before any ownership/taxonomy work).
        const anonTax = await getTaxonomy(request, null, workId);
        expect(anonTax.status, 'anon categories-tags must be 401').toBe(401);
        expect((anonTax.body as { statusCode?: number }).statusCode).toBe(401);
        const anonCount = await getCount(request, null, workId);
        expect(anonCount.status, 'anon count must be 401').toBe(401);
        expect((anonCount.body as { statusCode?: number }).statusCode).toBe(401);

        // 2) Authenticated owner -> canonical success envelopes (fresh non-connected work is empty).
        const ownerTax = await getTaxonomy(request, u.access_token, workId);
        expect(
            ownerTax.status,
            `owner categories-tags (body=${JSON.stringify(ownerTax.body)})`,
        ).toBe(200);
        assertEmptyTaxonomy(ownerTax.body, 'owner fresh work');

        const ownerCount = await getCount(request, u.access_token, workId);
        expect(ownerCount.status, `owner count (body=${JSON.stringify(ownerCount.body)})`).toBe(
            200,
        );
        expect(ownerCount.body.status, 'count envelope is success').toBe('success');
        expect(ownerCount.body.items, 'fresh work has 0 items').toBe(0);
        expect(ownerCount.body.categories, 'fresh work has 0 categories').toBe(0);
        expect(ownerCount.body.tags, 'fresh work has 0 tags').toBe(0);
    });

    test('both taxonomy reads are OWNER-scoped (stranger 403) and ghost-safe (404) with their exact envelopes', async ({
        request,
    }) => {
        // Owner A creates a work; stranger B must be DENIED both reads with the permission envelope,
        // and a well-formed-but-absent work id must 404 (not leak / not 200) for the OWNER too.
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const { id: workId } = await createWorkViaAPI(request, a.access_token, {
            name: `Owner Taxo ${s}`,
            slug: `owner-taxo-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        // A (owner) sees the success envelope on both reads.
        assertEmptyTaxonomy(
            (await getTaxonomy(request, a.access_token, workId)).body,
            'owner read',
        );
        expect((await getCount(request, a.access_token, workId)).body.status).toBe('success');

        // B (stranger) is denied BOTH reads via ensureAccess -> 403 + permission string.
        const strangerTax = await getTaxonomy(request, b.access_token, workId);
        expect(
            strangerTax.status,
            `stranger categories-tags; body=${JSON.stringify(strangerTax.body)}`,
        ).toBe(403);
        assertDenialEnvelope(strangerTax.body, PERMISSION_RE, 'stranger categories-tags');

        const strangerCount = await getCount(request, b.access_token, workId);
        expect(
            strangerCount.status,
            `stranger count; body=${JSON.stringify(strangerCount.body)}`,
        ).toBe(403);
        assertDenialEnvelope(strangerCount.body, PERMISSION_RE, 'stranger count');

        // A well-formed but non-existent work id is a precise 404 (NotFound precedes Forbidden in
        // ensureAccess: the work-row lookup happens first), NEVER a 200 leak.
        const ghostTax = await getTaxonomy(request, a.access_token, ABSENT_WORK_ID);
        expect(
            ghostTax.status,
            `ghost categories-tags; body=${JSON.stringify(ghostTax.body)}`,
        ).toBe(404);
        assertDenialEnvelope(ghostTax.body, NOT_FOUND_RE, 'ghost categories-tags');

        const ghostCount = await getCount(request, a.access_token, ABSENT_WORK_ID);
        expect(ghostCount.status, `ghost count; body=${JSON.stringify(ghostCount.body)}`).toBe(404);
        assertDenialEnvelope(ghostCount.body, NOT_FOUND_RE, 'ghost count');
    });

    test('dedicated taxonomy WRITES (categories/tags/collections) are git-gated: a DTO-valid owner write 500s on a non-connected work and persists NOTHING', async ({
        request,
    }) => {
        // THE uncovered surface: the dedicated POST /works/:id/{categories,tags,collections} endpoints.
        // On a work with no connected data repo, an owner DTO-VALID write reaches the dataGenerator
        // save which throws -> the controller surfaces a GENERIC 500 (distinct from submit-item's 400
        // reconnect-git gate). We assert the 500 for ALL THREE kinds, then prove the gated writes
        // committed NOTHING: the read + count still report the empty envelope (no partial taxonomy).
        const u = await registerUserViaAPI(request);
        const s = stamp();
        const { id: workId } = await createWorkViaAPI(request, u.access_token, {
            name: `Gated Write ${s}`,
            slug: `gated-write-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        for (const kind of TAXONOMY_KINDS) {
            const write = await postTaxonomy(request, u.access_token, workId, kind, {
                name: `Gated ${kind} ${s}`,
            });
            expect(write.status, `git-gated ${kind} write -> 500; body=${write.text}`).toBe(500);
            // Generic Nest 500 envelope: a statusCode (no success status, no validator array).
            expect(write.body.statusCode, `${kind} write 500 carries statusCode`).toBe(500);
            expect(write.body.status, `${kind} write 500 is NOT a success envelope`).not.toBe(
                'success',
            );
        }

        // The gated writes persisted nothing — the read still shows the empty envelope, AND the
        // count endpoint still reports zero categories/tags (no partial taxonomy leaked).
        const tax = await getTaxonomy(request, u.access_token, workId);
        expect(tax.status).toBe(200);
        assertEmptyTaxonomy(tax.body, 'after gated writes');

        const count = await getCount(request, u.access_token, workId);
        expect(count.status).toBe(200);
        expect(count.body.categories, 'count.categories still 0 after gated writes').toBe(0);
        expect(count.body.tags, 'count.tags still 0 after gated writes').toBe(0);
    });

    test('taxonomy-write gate ORDER is validation → ownership → git: each layer fires for the right caller/body', async ({
        request,
    }) => {
        // Prove the request-pipeline ordering by switching exactly ONE variable at a time on the SAME
        // write endpoint (POST /works/:id/categories). The ValidationPipe runs before guards/handler,
        // the ownership guard before the git-gated data save, and an absent work 404s before either
        // the owner reaches the git-gate or a non-member is told "forbidden".
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const s = stamp();
        const { id: workId } = await createWorkViaAPI(request, a.access_token, {
            name: `Gate Order ${s}`,
            slug: `gate-order-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        // (a) VALIDATION first — a DTO-invalid body (missing required name) 400s BEFORE ownership/git,
        //     even for the legitimate owner. The body is the class-validator string[] envelope.
        const invalid = await postTaxonomy(request, a.access_token, workId, 'categories', {});
        expect(invalid.status, `DTO-invalid owner write -> 400; body=${invalid.text}`).toBe(400);
        expect(invalid.body.error, 'validation envelope error label').toBe('Bad Request');
        expect(Array.isArray(invalid.body.message), 'validation message is a string[]').toBe(true);
        expect(
            (invalid.body.message as string[]).some((m) => /name/i.test(m)),
            `validation complains about name; got ${JSON.stringify(invalid.body.message)}`,
        ).toBe(true);

        // The tag DTO carries a tighter cap (50) than category/collection (100), surfaced by the
        // SAME validation layer. We can't probe it with an over-long STRING: CreateTagDto.name has a
        // @Transform(sanitizeName(value, 50)) that runs (class-transformer) BEFORE @MaxLength (class-
        // validator), truncating 'x'.repeat(51) to 50 chars so it passes validation and falls through
        // to the git-gated save -> 500 (live-probed 2026-06-01). A NON-string name (12345) can't be
        // truncated, so @IsString + @MaxLength(50) both fire -> 400 with the tighter 50-char message
        // — proving the per-kind tag DTO with its 50-bound is the FIRST gate, before ownership/git.
        const tooLong = await postTaxonomy(request, a.access_token, workId, 'tags', {
            name: 12345 as unknown as string,
        });
        expect(tooLong.status, `non-string tag -> 400; body=${tooLong.text}`).toBe(400);
        expect(Array.isArray(tooLong.body.message)).toBe(true);
        expect(
            (tooLong.body.message as string[]).some((m) => /shorter than or equal to 50/i.test(m)),
            `tag validation reports the tighter 50-char bound; got ${JSON.stringify(tooLong.body.message)}`,
        ).toBe(true);

        // (b) AUTH second — a DTO-valid body with NO bearer is 401, before ownership can run.
        const anon = await postTaxonomy(request, null, workId, 'categories', { name: `Anon ${s}` });
        expect(anon.status, 'anon DTO-valid write -> 401').toBe(401);
        expect((anon.body as { statusCode?: number }).statusCode).toBe(401);

        // (c) OWNERSHIP third — a DTO-valid body from a NON-member (stranger B) is 403 with the
        //     permission envelope, before the git-gated save would have run.
        const stranger = await postTaxonomy(request, b.access_token, workId, 'categories', {
            name: `Stranger ${s}`,
        });
        expect(stranger.status, `stranger DTO-valid write -> 403; body=${stranger.text}`).toBe(403);
        assertDenialEnvelope(stranger.body, PERMISSION_RE, 'stranger write');

        // (d) NOT-FOUND beats the git-gate — a DTO-valid OWNER write to an absent work id is 404
        //     (the work-row lookup in ensureAccess precedes the data-repo save), NOT a 500.
        const ghost = await postTaxonomy(request, a.access_token, ABSENT_WORK_ID, 'categories', {
            name: `Ghost ${s}`,
        });
        expect(ghost.status, `ghost DTO-valid write -> 404; body=${ghost.text}`).toBe(404);
        assertDenialEnvelope(ghost.body, NOT_FOUND_RE, 'ghost write');

        // (e) GIT last — only when validation+ownership+existence all pass does the owner reach the
        //     git-gated save -> 500 on this non-connected work.
        const gated = await postTaxonomy(request, a.access_token, workId, 'categories', {
            name: `Gated ${s}`,
        });
        expect(gated.status, `owner DTO-valid write hits git-gate -> 500; body=${gated.text}`).toBe(
            500,
        );
        expect(gated.body.statusCode).toBe(500);
    });

    test('PUT/DELETE taxonomy writes are equally git-gated, and submit-item exposes the DISTINCT reconnect-git 400 contract', async ({
        request,
    }) => {
        // The update/delete child endpoints read the existing taxonomy from the data repo BEFORE the
        // per-child not-found check, so on a non-connected work the git-gated read dominates -> 500
        // (NOT a 404 for the bogus child id). Contrast with the legacy submit-item write, which
        // surfaces the human-readable reconnect-git 400 — proving two write paths, two gate shapes.
        const u = await registerUserViaAPI(request);
        const s = stamp();
        const { id: workId } = await createWorkViaAPI(request, u.access_token, {
            name: `PutDel Taxo ${s}`,
            slug: `putdel-taxo-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        // PUT a (necessarily) non-existent category id with a DTO-valid body -> git-gate 500.
        const put = await request.put(`${API_BASE}/api/works/${workId}/categories/ghost-${s}`, {
            headers: authedHeaders(u.access_token),
            data: { name: `Renamed ${s}` },
        });
        expect(
            put.status(),
            `PUT category git-gate -> 500; body=${await put.text().catch(() => '')}`,
        ).toBe(500);

        // DELETE a non-existent tag id -> git-gate 500 (the read fires before the not-found check).
        const del = await request.delete(`${API_BASE}/api/works/${workId}/tags/ghost-${s}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(
            del.status(),
            `DELETE tag git-gate -> 500; body=${await del.text().catch(() => '')}`,
        ).toBe(500);

        // submit-item: a DTO-VALID, taxonomy-bearing item on the same non-connected work returns the
        // DISTINCT reconnect-git 400 (validation passes -> reaches the git gate with a friendly msg).
        const validItem = {
            name: `Taxo Item ${s}`,
            description: 'taxonomy-bearing item submitted by flow-work-taxonomy-deep',
            source_url: `https://example.com/taxo-${s}`,
            category: `cat-${s}`,
            categories: [`cat-${s}`, `cat-${s}-b`],
        };
        const submit = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(u.access_token),
            data: validItem,
        });
        const submitText = await submit.text().catch(() => '');
        expect(submit.status(), `submit-item git-gate -> 400; body=${submitText}`).toBe(400);
        const submitBody = JSON.parse(submitText || '{}') as ErrorEnvelope & { item_name?: string };
        expect(submitBody.status, 'submit-item git-gate is the error envelope').toBe('error');
        expect(typeof submitBody.message, 'submit-item git-gate message is a single string').toBe(
            'string',
        );
        expect(submitBody.message, 'exact reconnect-git remediation').toBe(GIT_GATE_MESSAGE);
        expect(submitBody.item_name, 'submit-item git-gate echoes the item name').toBe(
            validItem.name,
        );

        // After all four blocked writes the taxonomy + count are STILL empty (nothing persisted).
        assertEmptyTaxonomy(
            (await getTaxonomy(request, u.access_token, workId)).body,
            'after blocked PUT/DELETE/submit',
        );
        const count = await getCount(request, u.access_token, workId);
        expect(count.body.categories).toBe(0);
        expect(count.body.tags).toBe(0);
    });

    test('taxonomy + count are isolated PER-WORK and the count↔read invariant holds; seeded user browses read-only end-to-end', async ({
        request,
    }) => {
        // One owner, TWO works: each resolves its own taxonomy + count independently (per-(workId,
        // userId) cache key), both empty, and BOTH endpoints agree (count.categories === read length,
        // count.tags === read length) — the cross-endpoint accuracy invariant. Then drive the SHARED
        // seeded user through the read-only browse path the work-detail UI uses (pure reads, safe for
        // the shared account).
        const u = await registerUserViaAPI(request);
        const s = stamp();
        const { id: workOne } = await createWorkViaAPI(request, u.access_token, {
            name: `Iso One ${s}`,
            slug: `iso-one-${s}`,
        });
        const { id: workTwo } = await createWorkViaAPI(request, u.access_token, {
            name: `Iso Two ${s}`,
            slug: `iso-two-${s}`,
        });
        expect(workOne).toMatch(UUID_RE);
        expect(workTwo).toMatch(UUID_RE);
        expect(workOne).not.toBe(workTwo);

        for (const [label, workId] of [
            ['work one', workOne],
            ['work two', workTwo],
        ] as const) {
            const tax = await getTaxonomy(request, u.access_token, workId);
            const cnt = await getCount(request, u.access_token, workId);
            expect(tax.status, `${label} tax body=${JSON.stringify(tax.body)}`).toBe(200);
            expect(cnt.status, `${label} count body=${JSON.stringify(cnt.body)}`).toBe(200);
            assertEmptyTaxonomy(tax.body, label);
            // Cross-endpoint accuracy: the count mirrors the read lengths exactly.
            expect(cnt.body.categories, `${label}: count.categories mirrors the read`).toBe(
                (tax.body.categories ?? []).length,
            );
            expect(cnt.body.tags, `${label}: count.tags mirrors the read`).toBe(
                (tax.body.tags ?? []).length,
            );
        }

        // Both works are distinct, real rows in the owner's scoped list (no cross-work bleed).
        const ids = (await listWorks(request, u.access_token)).works.map((w) => w.id);
        expect(ids).toContain(workOne);
        expect(ids).toContain(workTwo);

        // Seeded user (storageState owner) — read-only browse chain (login -> list -> tax -> count),
        // no mutation that could shadow sibling specs.
        const seeded = loadSeededTestUser();
        const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
            // LOGIN DTO is whitelisted to ONLY { email, password } — sending the seeded name -> 400.
            data: { email: seeded.email, password: seeded.password },
        });
        expect(
            loginRes.ok(),
            `seed login body=${await loginRes.text().catch(() => '')}`,
        ).toBeTruthy();
        const seededToken = (await loginRes.json()).access_token as string;
        const seededList = await listWorks(request, seededToken);
        expect(Array.isArray(seededList.works)).toBe(true);
        // If the seeded account owns a work, its taxonomy + count reads succeed with the success
        // envelope (CI seed may have none — tolerate empty by browsing the fresh owner's work below).
        if (seededList.works.length > 0) {
            const seededWorkId = seededList.works[0].id;
            const seededTax = await getTaxonomy(request, seededToken, seededWorkId);
            expect(seededTax.status, `seeded tax body=${JSON.stringify(seededTax.body)}`).toBe(200);
            expect(seededTax.body.status).toBe('success');
            const seededCount = await getCount(request, seededToken, seededWorkId);
            expect(seededCount.status).toBe(200);
            expect(seededCount.body.status).toBe('success');
        }

        // And the fresh owner's full browse chain (detail -> taxonomy -> count) all succeed.
        const detail = await request.get(`${API_BASE}/api/works/${workOne}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detail.status()).toBe(200);
        const detailBody = (await detail.json()) as { work?: { id?: string }; id?: string };
        expect(detailBody.work?.id ?? detailBody.id, 'detail exposes the work id').toBeTruthy();
    });
});
