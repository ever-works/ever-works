import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-collections-deep — Works long-tail DEEP coverage for the per-work
 * COLLECTION taxonomy surface (the C in Categories/Tags/Collections). A
 * Collection in Ever Works is a per-work, data-repo-sourced taxonomy entry
 * (id = slugify(name), name, description, icon_url, icon_svg, priority). It is
 * READ ONLY through the combined `categories-tags` envelope and WRITTEN through
 * three dedicated git-gated endpoints — there is NO standalone GET collections
 * route, NO item↔collection membership endpoint, and NO reorder endpoint
 * (ordering is the `priority` field on the create/update DTO).
 *
 * EVERY status / message / shape below was LIVE-PROBED against the running
 * sqlite-in-memory CI driver (API 127.0.0.1:3100, REQUIRE_EMAIL_VERIFICATION=
 * false, keyless — no LLM, no connected git) on 2026-06-12, then cross-read
 * against the controller + service + DTO source:
 *   - apps/api/src/works/works.controller.ts
 *       @Post('works/:id/collections')        @HttpCode(OK)  CreateCollectionDto
 *       @Put('works/:id/collections/:cid')     @HttpCode(OK)  UpdateCollectionDto
 *       @Delete('works/:id/collections/:cid')  @HttpCode(OK)
 *       (there is NO @Get for collections at any level)
 *   - packages/agent/src/services/work-taxonomy.service.ts
 *       getCollections   → ensureAccess  (read path; surfaced via categories-tags)
 *       create/update/deleteCollection → ensureCanEdit → dataGenerator.save* (git-gated)
 *   - packages/agent/src/dto/taxonomy.dto.ts
 *       Create/UpdateCollectionDto: name @IsString @MaxLength(100) +
 *       @Transform(sanitizeName(_,100)); description @IsString? @MaxLength(500) +
 *       @Transform(sanitizeDescription(_,500)); icon_url @MaxLength(500);
 *       icon_svg @MaxLength(4000); priority @IsNumber? @Min(0). Update = all optional.
 *
 * PROBED CONTRACTS (collection-specific):
 *   - GET  /works/:id/categories-tags (owner)          → 200 { status:'success',
 *       categories:[], tags:[], collections:[] }  (the ONLY collection read)
 *   - GET  /works/:id/collections                      → 404 { error:'Not Found',
 *       message:"Cannot GET …/collections", statusCode:404 }  (ROUTING 404 — the
 *       route does not exist; a DIFFERENT shape from the ownership 404 below)
 *   - GET  /works/:id/collections/:cid                 → 404 routing-404 (no GET child)
 *   - PATCH /works/:id/collections/:cid                → 404 routing-404 (only PUT/DELETE)
 *   - POST /works/:id/collections (owner, DTO-valid)   → 409 { statusCode:409,
 *       error:'NoGitCredentialsError' }  (git-gated save on a non-connected work;
 *       FacadeExceptionFilter maps NoGitCredentialsError → 409; was 500 pre-filter)
 *   - PUT/DELETE /works/:id/collections/:cid (owner)   → 409 git-gate (the gated read
 *       inside the service fires before the per-child not-found check)
 *   - POST collections, name a NUMBER                  → 400 ["name must be shorter than
 *       or equal to 100 characters","name must be a string"]
 *   - POST collections, name '' (empty string)         → 409 (passes @IsString+@MaxLength,
 *       no @IsNotEmpty → falls through to the git-gate)
 *   - POST collections, name 'z'×101 (STRING)          → 409 (sanitize @Transform truncates
 *       to 100 BEFORE @MaxLength → valid → git-gate; contrast the NUMBER probe's 400)
 *   - POST collections, description a NUMBER            → 400 [both 500-char + must-be-string]
 *   - POST collections, icon_url 'h'×501               → 400 ["icon_url must be shorter than
 *       or equal to 500 characters"]
 *   - POST collections, priority -1                    → 400 ["priority must not be less than 0"]
 *   - POST collections, priority 'high'                → 400 [must-not-be-less-than-0 + must-be-number]
 *   - POST collections, priority 0 (inclusive bound)   → 409 (valid → git-gate)
 *   - POST collections, unknown prop                   → 400 ["property <x> should not exist"]
 *   - anon POST collections                            → 401 { statusCode:401 }
 *   - stranger POST/PUT/DELETE collections             → 403 { status:'error', message:
 *       'You do not have permission to access this work' }
 *   - owner POST/PUT/DELETE collections to a GHOST work → 404 { status:'error', message:
 *       "Work with id '…' not found" }  (work-row lookup precedes the git save)
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 * The sibling taxonomy specs already own a LARGE shared slice — this file does
 * NOT repeat them, it pins the COLLECTION-ONLY long tail they leave open:
 *   · flow-work-taxonomy-deep.spec.ts — the owner EMPTY read envelope + count↔read
 *       invariant, the gate-ORDER walk on CATEGORIES, stranger-403/ghost-404 on the
 *       categories-tags READ, PUT/DELETE git-gate on categories/tags, submit-item 400.
 *   · flow-taxonomy-git-gating-deep.spec.ts — the per-KIND name/desc/icon/priority
 *       DTO bound matrix (mostly probed on `categories`, with `collections` touched
 *       only for icon_svg + name + the all-three git-gate), stranger-403 POST on
 *       collections, the sanitize-truncate, the whitelist, the Idea→Work chain.
 * THIS file pins what BOTH lack, scoped to collections:
 *   1. Collections have NO read route of their own (routing-404 on GET list AND GET
 *      child) — they are visible ONLY inside the categories-tags envelope; and the
 *      routing-404 shape is provably DISTINCT from the ownership-404 shape.
 *   2. The collection CHILD route exposes ONLY PUT + DELETE — PATCH is a routing-404.
 *   3. The collection-specific optional-field gradient (description NUMBER, icon_url
 *      501, priority -1 / 'high' / 0) — pinned on `collections`, not borrowed from
 *      the categories probes.
 *   4. Stranger 403 on collection PUT *and* DELETE (siblings pin POST only on
 *      collections, PUT on categories, DELETE on tags) + ghost-404 on all three verbs.
 *   5. The empty-string-vs-number name distinction *on collections* (sanitize-vs-
 *      required), and the priority:0 inclusive boundary reaching the git-gate.
 *   6. A gated collection write persists NOTHING into the `collections` array, is
 *      idempotent under repeats, and is isolated per-work (a gated write on work A
 *      never materialises a collection on work B).
 *
 * ISOLATION: every mutating flow runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded storageState user — no seeded read here at all). Unique
 * suffixes come from a per-test counter + the test title, NOT a module-scope
 * clock. No module-scope await. List assertions use length/contents of the
 * per-work collections array, never global counts. Filename uses the safe
 * `flow-` prefix. TS strict.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT_WORK_ID = '00000000-0000-0000-0000-000000000000';
const PERMISSION_RE = /do not have permission to access this work/i;
const WORK_NOT_FOUND_RE = /Work with id '.*' not found/i;

interface ErrorEnvelope {
    status?: string;
    statusCode?: number;
    message?: unknown;
    error?: string;
}
interface TaxonomyEnvelope {
    status?: string;
    categories?: unknown[];
    tags?: unknown[];
    collections?: Array<{ id?: string; name?: string; priority?: number }>;
}

let counter = 0;
function uniq(title: string): string {
    counter += 1;
    const slug = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 20);
    return `${slug}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Flatten the class-validator message (string | string[]) for matching. */
function msgOf(body: ErrorEnvelope): string {
    return Array.isArray(body.message)
        ? (body.message as string[]).join(' ')
        : String(body.message);
}

async function readJson<T>(res: { text(): Promise<string> }): Promise<T> {
    const text = await res.text().catch(() => '');
    try {
        return JSON.parse(text || '{}') as T;
    } catch {
        return {} as T;
    }
}

/** POST /api/works/:id/collections — the dedicated collection create. */
async function postCollection(
    request: APIRequestContext,
    token: string | null,
    workId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: ErrorEnvelope }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/collections`, {
        headers: token ? authedHeaders(token) : undefined,
        data,
    });
    return { status: res.status(), body: await readJson<ErrorEnvelope>(res) };
}

/** GET /api/works/:id/categories-tags — the ONLY way to read collections. */
async function readTaxonomy(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; body: TaxonomyEnvelope }> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/categories-tags`, {
        headers: authedHeaders(token),
    });
    return { status: res.status(), body: await readJson<TaxonomyEnvelope>(res) };
}

/** Register a fresh owner + a work in one step (every mutating test is isolated). */
async function freshWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const s = uniq(label);
    const { id: workId } = await createWorkViaAPI(request, u.access_token, {
        name: `Coll ${s}`,
        slug: `coll-${s}`,
    });
    expect(workId, `created work id for ${label}`).toMatch(UUID_RE);
    return { token: u.access_token, workId };
}

/**
 * The git-gate signature for the dedicated collection endpoints: a DTO-valid
 * write on a work whose owner has NOT connected a git provider fails when the
 * data-generator calls `gitFacade.cloneOrPull` → `NoGitCredentialsError`. The
 * global FacadeExceptionFilter maps that to a clean 409 precondition — it was
 * a generic 500 before that filter (see apps/api/src/common/filters).
 */
function expectGitGate409(status: number, body: ErrorEnvelope, label: string): void {
    expect(status, `${label} hits the git-gate → 409 (no git provider connected)`).toBe(409);
    expect(body.statusCode, `${label} 409 carries statusCode`).toBe(409);
    expect(body.status, `${label} 409 is NOT a success envelope`).not.toBe('success');
}

/** A class-validator 400 envelope naming a field. */
function expectValidation400(
    status: number,
    body: ErrorEnvelope,
    fieldRe: RegExp,
    label: string,
): void {
    expect(status, `${label} → 400 validation`).toBe(400);
    expect(body.error, `${label} validation error label`).toBe('Bad Request');
    expect(Array.isArray(body.message), `${label} message is a string[]`).toBe(true);
    expect(
        (body.message as string[]).some((m) => fieldRe.test(m)),
        `${label} names the field; got ${msgOf(body)}`,
    ).toBe(true);
}

/** A ROUTING 404 ("Cannot <VERB> <path>") — the route does not exist. DISTINCT from
 *  the ownership 404, which is { status:'error', message:"Work with id '…' not found" }. */
function expectRoutingNotFound(
    status: number,
    body: ErrorEnvelope,
    verb: string,
    label: string,
): void {
    expect(status, `${label} → routing 404`).toBe(404);
    expect(body.statusCode, `${label} routing-404 statusCode`).toBe(404);
    expect(body.error, `${label} routing-404 error label`).toBe('Not Found');
    expect(String(body.message), `${label} routing-404 message`).toMatch(
        new RegExp(`Cannot ${verb} `, 'i'),
    );
    // It must NOT masquerade as the ownership/work-not-found envelope.
    expect(body.status, `${label} routing-404 has no error-envelope status`).not.toBe('error');
}

test.describe('flow: collection READ surface — collections are read-only via categories-tags, with NO route of their own', () => {
    test('a fresh work exposes collections ONLY inside the categories-tags envelope (empty array), and there is NO standalone GET collections route', async ({
        request,
    }) => {
        // The combined read is the sole collection read path. There is no
        // @Get('works/:id/collections'), so hitting it is a ROUTING 404 whose shape
        // ("Cannot GET …", error:'Not Found') is provably DISTINCT from the ownership
        // 404 — confirming the collection surface is the combined envelope, not a
        // dedicated sub-resource.
        const { token, workId } = await freshWork(request, 'read-surface');

        const read = await readTaxonomy(request, token, workId);
        expect(read.status, `combined read body=${JSON.stringify(read.body)}`).toBe(200);
        expect(read.body.status, 'combined read envelope is success').toBe('success');
        expect(Array.isArray(read.body.collections), 'collections is an array').toBe(true);
        expect(read.body.collections!.length, 'fresh work has no collections').toBe(0);

        const listRes = await request.get(`${API_BASE}/api/works/${workId}/collections`, {
            headers: authedHeaders(token),
        });
        expectRoutingNotFound(
            listRes.status(),
            await readJson<ErrorEnvelope>(listRes),
            'GET',
            'GET collections list (no route)',
        );
    });

    test('the collection CHILD path has NO GET route and NO PATCH route — only PUT + DELETE are registered (every other verb is a routing-404)', async ({
        request,
    }) => {
        // The controller registers @Put and @Delete for the child id, but no @Get and
        // no @Patch. So a GET or a PATCH on a child id is a ROUTING 404 ("Cannot GET/
        // PATCH"), NOT an ownership/work-not-found or a method-not-allowed. This pins
        // the exact verb surface of the collection sub-resource.
        const { token, workId } = await freshWork(request, 'child-verbs');
        const headers = authedHeaders(token);

        const getChild = await request.get(
            `${API_BASE}/api/works/${workId}/collections/some-collection`,
            { headers },
        );
        expectRoutingNotFound(
            getChild.status(),
            await readJson<ErrorEnvelope>(getChild),
            'GET',
            'GET collection child (no route)',
        );

        const patchChild = await request.patch(
            `${API_BASE}/api/works/${workId}/collections/some-collection`,
            { headers, data: { name: 'Patched' } },
        );
        expectRoutingNotFound(
            patchChild.status(),
            await readJson<ErrorEnvelope>(patchChild),
            'PATCH',
            'PATCH collection child (no route)',
        );
    });
});

test.describe('flow: collection CREATE validation gradient — the per-field DTO bounds, pinned on collections', () => {
    test('the name field: a NUMBER trips @IsString and reports the 100-char bound (400), a MISSING name is the same 400, but an EMPTY-STRING name passes validation and falls through to the git-gate', async ({
        request,
    }) => {
        // Create*CollectionDto.name is @IsString @MaxLength(100) with NO @IsNotEmpty.
        // A number can't be sanitized → both @IsString and @MaxLength(100) fire (400).
        // `{}` (undefined) → @IsString fails (400). But `''` is a length-0 STRING → it
        // passes type + length and the DTO-valid write reaches the git-gated save (409).
        const { token, workId } = await freshWork(request, 'name-field');

        const numberName = await postCollection(request, token, workId, { name: 98765 });
        expectValidation400(
            numberName.status,
            numberName.body,
            /name must be a string/i,
            'collection number name',
        );
        expect(
            (numberName.body.message as string[]).some((m) =>
                /shorter than or equal to 100/i.test(m),
            ),
            `collection name reports the 100-char bound; got ${msgOf(numberName.body)}`,
        ).toBe(true);

        const missingName = await postCollection(request, token, workId, { priority: 1 });
        expectValidation400(
            missingName.status,
            missingName.body,
            /name must be a string/i,
            'collection missing name',
        );

        const emptyName = await postCollection(request, token, workId, { name: '' });
        expectGitGate409(emptyName.status, emptyName.body, 'collection empty-string name');
    });

    test('the optional fields on a collection: description NON-STRING (400 both messages), icon_url over-500 (400), and the priority gradient (-1 → 400, "high" → 400, 0 → valid git-gate)', async ({
        request,
    }) => {
        // The collection optional fields carry their own bounds. description has a
        // sanitize @Transform so a too-long STRING truncates, but a NON-STRING can't be
        // sanitized → @IsString + @MaxLength(500) BOTH fire. icon_url has no transform →
        // an over-500 STRING trips @MaxLength directly. priority @IsNumber @Min(0):
        // -1 trips @Min, a string trips @IsNumber (and @Min), but 0 is the INCLUSIVE
        // floor → valid → git-gate 409.
        const { token, workId } = await freshWork(request, 'opt-fields');

        const badDesc = await postCollection(request, token, workId, {
            name: 'Coll',
            description: 12345,
        });
        expectValidation400(
            badDesc.status,
            badDesc.body,
            /description must be a string/i,
            'collection non-string description',
        );
        expect(
            (badDesc.body.message as string[]).some((m) => /shorter than or equal to 500/i.test(m)),
            `collection description reports the 500-char bound; got ${msgOf(badDesc.body)}`,
        ).toBe(true);

        const longIconUrl = await postCollection(request, token, workId, {
            name: 'Coll',
            icon_url: 'h'.repeat(501),
        });
        expectValidation400(
            longIconUrl.status,
            longIconUrl.body,
            /icon_url must be shorter than or equal to 500/i,
            'collection over-long icon_url',
        );

        const negative = await postCollection(request, token, workId, {
            name: 'Coll',
            priority: -1,
        });
        expectValidation400(
            negative.status,
            negative.body,
            /priority must not be less than 0/i,
            'collection negative priority',
        );

        const nonNumeric = await postCollection(request, token, workId, {
            name: 'Coll',
            priority: 'high',
        });
        expectValidation400(
            nonNumeric.status,
            nonNumeric.body,
            /priority must be a number/i,
            'collection non-numeric priority',
        );

        const zero = await postCollection(request, token, workId, { name: 'Coll', priority: 0 });
        expectGitGate409(zero.status, zero.body, 'collection priority:0 inclusive boundary');
    });

    test('an over-bound STRING name on a collection is sanitize-truncated to 100 (so it PASSES @MaxLength) and falls through to the git-gate 409 — the @Transform runs before the validator', async ({
        request,
    }) => {
        // CreateCollectionDto.name carries @Transform(sanitizeName(_,100)) which runs
        // (class-transformer) BEFORE @MaxLength (class-validator). A raw STRING longer
        // than 100 is truncated to 100 → validation passes → the DTO-valid write reaches
        // the git-gated save → 409. This is the load-bearing contrast with the NUMBER
        // probe above (which can't be truncated and so 400s on @IsString + @MaxLength).
        const { token, workId } = await freshWork(request, 'sanitize-name');

        const overLong = await postCollection(request, token, workId, { name: 'z'.repeat(101) });
        expectGitGate409(overLong.status, overLong.body, 'collection over-length STRING name');
    });

    test('the create whitelist rejects an unknown property on a collection by name (forbidNonWhitelisted), before any ownership/git work', async ({
        request,
    }) => {
        // The global ValidationPipe runs whitelist + forbidNonWhitelisted, so a property
        // absent from CreateCollectionDto is a 400 "property <x> should not exist" — and
        // this fires before the ownership guard or the git-gated save.
        const { token, workId } = await freshWork(request, 'whitelist');

        const bogus = await postCollection(request, token, workId, {
            name: 'Coll',
            collectionId: 'inject',
        });
        expectValidation400(
            bogus.status,
            bogus.body,
            /property collectionId should not exist/i,
            'collection unknown field',
        );
    });
});

test.describe('flow: collection WRITE git-gate — every verb 409s on a non-connected work and persists NOTHING', () => {
    test('a DTO-valid owner CREATE/UPDATE/DELETE on a collection each hits the git-gate (409), and the collections array stays empty (no partial state leaked)', async ({
        request,
    }) => {
        // All three collection write verbs route through ensureCanEdit → the data-repo
        // save (create) or the git-gated taxonomy READ (update/delete, which fires
        // BEFORE the per-child not-found check). On a non-connected work each surfaces
        // the git-gate 409. After all three blocked writes the combined read still shows
        // collections:[] — nothing was half-committed.
        const { token, workId } = await freshWork(request, 'gate-all-verbs');
        const s = uniq('gate');
        const headers = authedHeaders(token);

        const created = await postCollection(request, token, workId, { name: `Gated Coll ${s}` });
        expectGitGate409(created.status, created.body, 'collection CREATE');

        const updated = await request.put(
            `${API_BASE}/api/works/${workId}/collections/ghost-${s}`,
            { headers, data: { name: `Renamed ${s}` } },
        );
        expectGitGate409(
            updated.status(),
            await readJson<ErrorEnvelope>(updated),
            'collection UPDATE (non-existent child → gate dominates)',
        );

        const deleted = await request.delete(
            `${API_BASE}/api/works/${workId}/collections/ghost-${s}`,
            { headers },
        );
        expectGitGate409(
            deleted.status(),
            await readJson<ErrorEnvelope>(deleted),
            'collection DELETE (non-existent child → gate dominates)',
        );

        const read = await readTaxonomy(request, token, workId);
        expect(read.status, 'read after blocked writes → 200').toBe(200);
        expect(read.body.status, 'read envelope still success').toBe('success');
        expect(read.body.collections!.length, 'no collection persisted by the gated writes').toBe(
            0,
        );
    });

    test('repeated gated collection CREATEs are idempotent against state — each 409s and the collections array is STILL empty (no accumulation)', async ({
        request,
    }) => {
        // A gated write that 409s must not partially commit, so retrying it can never
        // accumulate collections. Fire the SAME create three times; each 409s and the
        // read stays empty — proving the failure is atomic at the data-repo boundary.
        const { token, workId } = await freshWork(request, 'idempotent');
        const s = uniq('retry');

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const write = await postCollection(request, token, workId, {
                name: `Retry Coll ${s}`,
                priority: attempt,
            });
            expectGitGate409(write.status, write.body, `collection create attempt ${attempt}`);
        }

        const read = await readTaxonomy(request, token, workId);
        expect(read.status).toBe(200);
        expect(read.body.collections!.length, 'no accumulation across retries').toBe(0);
    });

    test('collection writes are isolated PER-WORK — a gated CREATE on work A never materialises a collection on work B (same owner)', async ({
        request,
    }) => {
        // One owner, TWO works. A gated collection create on work A is a 409 and leaves
        // A's collections empty; crucially it also leaves work B's collections empty —
        // the per-(workId,userId) data path does not bleed a half-committed taxonomy
        // across sibling works.
        const u = await registerUserViaAPI(request);
        const s = uniq('per-work-iso');
        const { id: workA } = await createWorkViaAPI(request, u.access_token, {
            name: `Coll A ${s}`,
            slug: `coll-a-${s}`,
        });
        const { id: workB } = await createWorkViaAPI(request, u.access_token, {
            name: `Coll B ${s}`,
            slug: `coll-b-${s}`,
        });
        expect(workA).toMatch(UUID_RE);
        expect(workB).toMatch(UUID_RE);
        expect(workA).not.toBe(workB);

        const gated = await postCollection(request, u.access_token, workA, {
            name: `Iso Coll ${s}`,
        });
        expectGitGate409(gated.status, gated.body, 'collection create on work A');

        const readA = await readTaxonomy(request, u.access_token, workA);
        expect(readA.body.collections!.length, 'work A has no collection').toBe(0);

        const readB = await readTaxonomy(request, u.access_token, workB);
        expect(readB.status, 'work B read → 200').toBe(200);
        expect(readB.body.collections!.length, 'work B is unaffected by the gated write on A').toBe(
            0,
        );
    });
});

test.describe('flow: collection WRITE authz — auth + ownership precede the git-gate on every verb', () => {
    test('an ANON DTO-valid collection CREATE is 401 (AuthSessionGuard before ownership/git), and ANON PUT/DELETE child writes are 401 too', async ({
        request,
    }) => {
        const { workId } = await freshWork(request, 'anon');

        const anonCreate = await postCollection(request, null, workId, { name: 'Anon Coll' });
        expect(anonCreate.status, 'anon collection create → 401').toBe(401);
        expect(anonCreate.body.statusCode, 'anon create 401 envelope').toBe(401);

        const anonPut = await request.put(`${API_BASE}/api/works/${workId}/collections/x`, {
            data: { name: 'Anon Rename' },
        });
        expect(anonPut.status(), 'anon collection PUT → 401').toBe(401);
        expect((await readJson<ErrorEnvelope>(anonPut)).statusCode, 'anon PUT 401 envelope').toBe(
            401,
        );

        const anonDel = await request.delete(`${API_BASE}/api/works/${workId}/collections/x`);
        expect(anonDel.status(), 'anon collection DELETE → 401').toBe(401);
        expect(
            (await readJson<ErrorEnvelope>(anonDel)).statusCode,
            'anon DELETE 401 envelope',
        ).toBe(401);
    });

    test('a STRANGER is 403 on collection CREATE *and* PUT *and* DELETE (ownership precedes the git save), with the exact permission envelope — cross-user collection access never reaches the gate', async ({
        request,
    }) => {
        // ensureCanEdit fires before the data-repo save, so a non-member's DTO-valid
        // write to every collection verb is a 403 with the canonical { status:'error',
        // message:'You do not have permission…' } envelope — NOT the git-gate 409 (it never reaches
        // the git-gate) and NOT a 404 (the work exists). The siblings pin stranger-403
        // for collection POST only; here we pin PUT and DELETE on collections too.
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = uniq('stranger');
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `Owner Coll ${s}`,
            slug: `owner-coll-${s}`,
        });
        expect(workId).toMatch(UUID_RE);
        const strangerH = authedHeaders(stranger.access_token);

        const create = await postCollection(request, stranger.access_token, workId, {
            name: `Stranger Coll ${s}`,
        });
        expect(create.status, 'stranger collection create → 403').toBe(403);
        expect(create.body.status, 'stranger create denial envelope').toBe('error');
        expect(String(create.body.message), 'stranger create permission message').toMatch(
            PERMISSION_RE,
        );

        const put = await request.put(`${API_BASE}/api/works/${workId}/collections/ghost-${s}`, {
            headers: strangerH,
            data: { name: `Stranger Rename ${s}` },
        });
        expect(put.status(), 'stranger collection PUT → 403').toBe(403);
        expect(
            String((await readJson<ErrorEnvelope>(put)).message),
            'stranger PUT message',
        ).toMatch(PERMISSION_RE);

        const del = await request.delete(`${API_BASE}/api/works/${workId}/collections/ghost-${s}`, {
            headers: strangerH,
        });
        expect(del.status(), 'stranger collection DELETE → 403').toBe(403);
        expect(
            String((await readJson<ErrorEnvelope>(del)).message),
            'stranger DELETE message',
        ).toMatch(PERMISSION_RE);
    });

    test('an owner CREATE/PUT/DELETE on a collection of a GHOST (well-formed but absent) work is a precise 404 (the work-row lookup precedes the git save), NOT the git-gate 409 or a leak', async ({
        request,
    }) => {
        // ensureCanEdit looks up the work row before the data-repo save, so a DTO-valid
        // OWNER write to a non-existent work id is the ownership 404 — { status:'error',
        // message:"Work with id '…' not found" } — on ALL THREE collection verbs, never
        // the owner's own git-gate 409 and never a 200 leak.
        const owner = await registerUserViaAPI(request);
        const s = uniq('ghost');
        const headers = authedHeaders(owner.access_token);

        const create = await postCollection(request, owner.access_token, ABSENT_WORK_ID, {
            name: `Ghost Coll ${s}`,
        });
        expect(create.status, 'ghost-work collection create → 404').toBe(404);
        expect(create.body.status, 'ghost create is the ownership error envelope').toBe('error');
        expect(String(create.body.message), 'ghost create work-not-found message').toMatch(
            WORK_NOT_FOUND_RE,
        );

        const put = await request.put(
            `${API_BASE}/api/works/${ABSENT_WORK_ID}/collections/ghost-${s}`,
            { headers, data: { name: `Ghost Rename ${s}` } },
        );
        const putBody = await readJson<ErrorEnvelope>(put);
        expect(put.status(), 'ghost-work collection PUT → 404').toBe(404);
        expect(String(putBody.message), 'ghost PUT work-not-found message').toMatch(
            WORK_NOT_FOUND_RE,
        );

        const del = await request.delete(
            `${API_BASE}/api/works/${ABSENT_WORK_ID}/collections/ghost-${s}`,
            { headers },
        );
        const delBody = await readJson<ErrorEnvelope>(del);
        expect(del.status(), 'ghost-work collection DELETE → 404').toBe(404);
        expect(String(delBody.message), 'ghost DELETE work-not-found message').toMatch(
            WORK_NOT_FOUND_RE,
        );
    });
});
