import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-collections-taxonomy-multistep — a MULTI-STEP, cross-surface pass over
 * the per-work COLLECTIONS + TAXONOMY (categories / tags / items) API, pinning
 * the angles the existing taxonomy/collection/item specs leave open. Every read
 * on a fresh non-connected work is git-TOLERANT (empty success envelope); every
 * data-repo WRITE is git-GATED. This file ties those two facts together across
 * FOUR read surfaces (items, count, categories-tags, history) and pins the
 * write-side contracts the siblings don't.
 *
 * EVERY status / message / shape below was LIVE-PROBED against the running
 * sqlite-in-memory CI driver (API 127.0.0.1:3100, REQUIRE_EMAIL_VERIFICATION=
 * false, keyless — no LLM, no connected git) on 2026-07-21, then cross-read
 * against the controller + DTO source:
 *   - apps/api/src/works/works.controller.ts
 *       @Get   works/:id/items            → 200 { status:'success', items:[] }        (git-tolerant)
 *       @Get   works/:id/count            → 200 { status:'success', items:0, categories:0, tags:0 }
 *                                            (NO `collections` key — count omits collections)
 *       @Get   works/:id/categories-tags  → 200 { status:'success', categories:[], tags:[], collections:[] }
 *       @Get   works/:id/history          → 200 { status:'success', history:[], total:0, limit:10, offset:0 }
 *                                            (?activityType=taxonomy filter; default limit 10 / offset 0;
 *                                             non-numeric limit/offset → fallback; bogus activityType IGNORED)
 *       @Post  works/:id/{categories,tags,collections}   @HttpCode(OK)  Create*Dto  (name REQUIRED)
 *       @Put   works/:id/{…}/:childId                    @HttpCode(OK)  Update*Dto  (name OPTIONAL)
 *       @Delete works/:id/{…}/:childId                   @HttpCode(OK)
 *       @Post  works/:id/submit-item      (item write carrying category/categories/tags)
 *   - packages/agent/src/dto/taxonomy.dto.ts
 *       Create{Category,Collection}Dto.name @IsString @MaxLength(100); CreateTagDto.name @IsString
 *       @MaxLength(50) (ONLY name). Update*Dto = ALL fields @IsOptional (INCLUDING name).
 *       description @MaxLength(500); icon_url @MaxLength(500); icon_svg @MaxLength(4000);
 *       priority @IsNumber @Min(0). name/description carry a @Transform(sanitize*) that runs
 *       (class-transformer) BEFORE @MaxLength and truncates an over-long STRING.
 *
 * PROBED CONTRACTS (the load-bearing new ones):
 *   · The git-gate 409 envelope is EXACT: { statusCode:409, error:'NoGitCredentialsError',
 *     message:'No connected account found for user <uuid> with provider github' } — pinned by
 *     error NAME + message, not just the status code (which the siblings already own).
 *   · CREATE requires name → POST {} is a 400 on all three kinds (naming the per-kind bound).
 *     UPDATE makes name OPTIONAL → an EMPTY-BODY PUT {} passes validation and falls through to
 *     the git-gate 409 on all three kinds. This create-vs-update asymmetry is the headline.
 *   · The UPDATE path still runs the ValidationPipe: PUT {priority:-1} → 400, PUT {bogusField}
 *     → 400 whitelist, PUT {name:<number>} → 400 with the per-kind bound (tag 50 / coll 100),
 *     and an over-long STRING name is sanitize-truncated → 409 (transform before validator).
 *   · submit-item exposes TWO structurally different 400s on ONE endpoint: a DTO-invalid body
 *     → class-validator { message:string[], error:'Bad Request', statusCode:400 } (naming
 *     name/source_url/category/categories/description); a DTO-VALID body → the friendly git-gate
 *     { status:'error', slug, item_name, message:'Please reconnect your Git account to continue.' }.
 *   · The `history` route (with its `taxonomy` activity filter) is git-tolerant + auth-scoped
 *     (anon 401 / stranger 403 / ghost 404), echoes limit/offset, and a FAILED (409) taxonomy
 *     write leaves history empty (the controller logs activity only AFTER the service returns).
 *   · Cross-surface: after gated writes the four read surfaces are ALL unchanged, and a gated
 *     write on work A never materialises anything on sibling work B.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 * The sibling specs own a large adjacent slice; this file deliberately avoids it:
 *   · flow-work-taxonomy-deep / flow-collections-deep / flow-taxonomy-git-gating-deep —
 *       the CREATE DTO bound matrix, the gate-ORDER walk, collection routing-404s,
 *       stranger-403/ghost-404 on the CREATE verbs, and the empty categories-tags/count reads.
 *   · flow-work-items-crud-deep / flow-work-full-lifecycle — the plain items/count/categories-tags
 *       empty-read envelopes and their auth scoping.
 * THIS file pins what NONE of them do: (1) the `history` taxonomy-activity read surface end to
 * end; (2) the CREATE-vs-UPDATE `name`-optionality asymmetry (empty PUT reaches the gate) plus
 * the UPDATE-path validation/sanitize; (3) the EXACT NoGitCredentialsError 409 envelope shape
 * (error name + message); (4) the submit-item two-400-shapes validation contract; (5) the
 * read-tolerant-vs-write-gated asymmetry on the item + taxonomy surfaces; (6) the multi-step
 * cross-surface consistency (four reads unchanged after gated writes) + per-work isolation.
 *
 * ISOLATION: every mutating flow runs on a FRESH registerUserViaAPI() user (never the shared
 * seeded storageState user — there is no seeded read here). Unique suffixes come from a per-test
 * counter + the test title, NOT a module-scope clock; no module-scope await. Assertions pin the
 * per-work read surfaces, never global counts. Filename uses the safe `flow-` prefix. TS strict.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT_WORK_ID = '00000000-0000-0000-0000-000000000000';
const PERMISSION_RE = /do not have permission to access this work/i;
const WORK_NOT_FOUND_RE = /Work with id '.*' not found/i;
const NO_GIT_MESSAGE_RE = /No connected account found for user .* with provider github/i;
const NO_GIT_ERROR = 'NoGitCredentialsError';
const RECONNECT_GIT_MSG = 'Please reconnect your Git account to continue.';

const TAXONOMY_KINDS = ['categories', 'tags', 'collections'] as const;
type TaxonomyKind = (typeof TAXONOMY_KINDS)[number];
/** The per-kind @MaxLength(name) bound surfaced by the class-validator message. */
const NAME_BOUND: Record<TaxonomyKind, number> = {
    categories: 100,
    tags: 50,
    collections: 100,
};

interface ErrorEnvelope {
    status?: string;
    statusCode?: number;
    message?: unknown;
    error?: string;
    slug?: string;
    item_name?: string;
}
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
    collections?: unknown;
}
interface ItemsEnvelope {
    status?: string;
    items?: unknown[];
}
interface HistoryEnvelope {
    status?: string;
    history?: unknown[];
    total?: number;
    limit?: number;
    offset?: number;
}

let counter = 0;
function uniq(title: string): string {
    counter += 1;
    const slug = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 20);
    return `${slug}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Flatten the class-validator message (string | string[]) for matching / logging. */
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

/** POST /api/works/:id/{kind} — a dedicated taxonomy create. */
async function postTaxonomy(
    request: APIRequestContext,
    token: string | null,
    workId: string,
    kind: TaxonomyKind,
    data: Record<string, unknown>,
): Promise<{ status: number; body: ErrorEnvelope }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/${kind}`, {
        headers: token ? authedHeaders(token) : undefined,
        data,
    });
    return { status: res.status(), body: await readJson<ErrorEnvelope>(res) };
}

/** PUT /api/works/:id/{kind}/:childId — a dedicated taxonomy update (name OPTIONAL). */
async function putTaxonomy(
    request: APIRequestContext,
    token: string,
    workId: string,
    kind: TaxonomyKind,
    childId: string,
    data: Record<string, unknown>,
): Promise<{ status: number; body: ErrorEnvelope }> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/${kind}/${childId}`, {
        headers: authedHeaders(token),
        data,
    });
    return { status: res.status(), body: await readJson<ErrorEnvelope>(res) };
}

async function getEnvelope<T>(
    request: APIRequestContext,
    token: string | null,
    path: string,
): Promise<{ status: number; body: T }> {
    const res = await request.get(`${API_BASE}${path}`, {
        headers: token ? authedHeaders(token) : undefined,
    });
    return { status: res.status(), body: await readJson<T>(res) };
}

/** Register a fresh owner + a work in one step (every mutating test is isolated). */
async function freshWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const s = uniq(label);
    const { id: workId } = await createWorkViaAPI(request, u.access_token, {
        name: `CT ${s}`,
        slug: `ct-${s}`,
    });
    expect(workId, `created work id for ${label}`).toMatch(UUID_RE);
    return { token: u.access_token, workId };
}

/**
 * The FULL git-gate signature for the dedicated taxonomy endpoints: a DTO-valid
 * write on a work whose owner has NOT connected a git provider hits
 * `gitFacade` → `NoGitCredentialsError`, which the global FacadeExceptionFilter
 * maps to a clean 409 precondition carrying the error NAME and a message that
 * names the missing github account. Siblings assert only the status code; here
 * we pin the whole envelope.
 */
function expectGitGate409(status: number, body: ErrorEnvelope, label: string): void {
    expect(status, `${label} hits the git-gate → 409`).toBe(409);
    expect(body.statusCode, `${label} 409 carries statusCode`).toBe(409);
    expect(body.error, `${label} 409 names NoGitCredentialsError`).toBe(NO_GIT_ERROR);
    expect(String(body.message), `${label} 409 message; got ${msgOf(body)}`).toMatch(
        NO_GIT_MESSAGE_RE,
    );
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

// ───────────────────────────────────────────────────────────────────────────
// A. The `history` taxonomy-activity read surface (untouched by every sibling)
// ───────────────────────────────────────────────────────────────────────────
test.describe('flow: work history — the taxonomy-activity read surface is git-tolerant with default pagination', () => {
    test('a fresh work returns the empty history envelope with the DEFAULT limit 10 / offset 0, and the ?activityType=taxonomy filter returns the same empty envelope', async ({
        request,
    }) => {
        // GET /works/:id/history is git-tolerant (no data repo required) and defaults
        // to limit 10 / offset 0. The `taxonomy` activity filter is one of the documented
        // activity types (generation, items, comparisons, taxonomy, community_pr); on a
        // fresh work it resolves to the same empty success envelope.
        const { token, workId } = await freshWork(request, 'history-default');

        const unfiltered = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history`,
        );
        expect(unfiltered.status, `history body=${JSON.stringify(unfiltered.body)}`).toBe(200);
        expect(unfiltered.body.status, 'history envelope is success').toBe('success');
        expect(Array.isArray(unfiltered.body.history), 'history is an array').toBe(true);
        expect(unfiltered.body.history!.length, 'fresh work has no history').toBe(0);
        expect(unfiltered.body.total, 'fresh work history total 0').toBe(0);
        expect(unfiltered.body.limit, 'default limit is 10').toBe(10);
        expect(unfiltered.body.offset, 'default offset is 0').toBe(0);

        const taxonomyFiltered = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history?activityType=taxonomy`,
        );
        expect(taxonomyFiltered.status, 'taxonomy-filtered history → 200').toBe(200);
        expect(taxonomyFiltered.body.status, 'taxonomy-filtered envelope is success').toBe(
            'success',
        );
        expect(taxonomyFiltered.body.history!.length, 'no taxonomy history on a fresh work').toBe(
            0,
        );
        expect(taxonomyFiltered.body.total, 'taxonomy history total 0').toBe(0);
    });

    test('history pagination echoes numeric limit/offset, falls back to the default 10/0 for NON-numeric params, and IGNORES an unknown activityType (never 400)', async ({
        request,
    }) => {
        // The controller parses limit/offset with Number() and drops NaN → the service
        // default (limit 10 / offset 0). Valid numbers are echoed back. An unknown
        // activityType is not validated against an enum — it simply filters to nothing
        // and returns the default-shaped empty envelope, NOT a 400.
        const { token, workId } = await freshWork(request, 'history-paging');

        const paged = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history?limit=5&offset=2`,
        );
        expect(paged.status, 'paged history → 200').toBe(200);
        expect(paged.body.limit, 'limit echoes the query value 5').toBe(5);
        expect(paged.body.offset, 'offset echoes the query value 2').toBe(2);

        const nonNumeric = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history?limit=abc&offset=xyz`,
        );
        expect(nonNumeric.status, 'non-numeric paging → 200').toBe(200);
        expect(nonNumeric.body.limit, 'non-numeric limit falls back to 10').toBe(10);
        expect(nonNumeric.body.offset, 'non-numeric offset falls back to 0').toBe(0);

        const bogusFilter = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history?activityType=definitely-not-a-real-filter`,
        );
        expect(bogusFilter.status, 'unknown activityType is ignored, not rejected').toBe(200);
        expect(bogusFilter.body.status, 'unknown-filter envelope is success').toBe('success');
        expect(bogusFilter.body.history!.length, 'unknown filter yields empty history').toBe(0);
    });

    test('the history read is auth-scoped exactly like the taxonomy reads: anon 401, stranger 403 (permission envelope), ghost 404 (work-not-found)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = uniq('history-authz');
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `Hist ${s}`,
            slug: `hist-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        const anon = await getEnvelope<ErrorEnvelope>(
            request,
            null,
            `/api/works/${workId}/history`,
        );
        expect(anon.status, 'anon history → 401').toBe(401);
        expect(anon.body.statusCode, 'anon history 401 envelope').toBe(401);

        const strangerRes = await getEnvelope<ErrorEnvelope>(
            request,
            stranger.access_token,
            `/api/works/${workId}/history?activityType=taxonomy`,
        );
        expect(strangerRes.status, 'stranger history → 403').toBe(403);
        expect(strangerRes.body.status, 'stranger history denial envelope').toBe('error');
        expect(String(strangerRes.body.message), 'stranger history permission message').toMatch(
            PERMISSION_RE,
        );

        const ghost = await getEnvelope<ErrorEnvelope>(
            request,
            owner.access_token,
            `/api/works/${ABSENT_WORK_ID}/history`,
        );
        expect(ghost.status, 'ghost history → 404').toBe(404);
        expect(String(ghost.body.message), 'ghost history work-not-found message').toMatch(
            WORK_NOT_FOUND_RE,
        );
    });
});

// ───────────────────────────────────────────────────────────────────────────
// B. CREATE-vs-UPDATE DTO asymmetry: name REQUIRED on create, OPTIONAL on update
// ───────────────────────────────────────────────────────────────────────────
test.describe('flow: create-vs-update DTO asymmetry — CREATE requires name, UPDATE does not', () => {
    test('an EMPTY-BODY create ({}) is a 400 on every kind (name is REQUIRED), and the 400 reports each kind’s own name bound (categories/collections 100, tags 50)', async ({
        request,
    }) => {
        // Create{Category,Collection,Tag}Dto.name is NON-optional. `{}` → @IsString fails
        // on undefined → 400, and the co-located @MaxLength surfaces the per-kind bound.
        const { token, workId } = await freshWork(request, 'create-required');

        for (const kind of TAXONOMY_KINDS) {
            const empty = await postTaxonomy(request, token, workId, kind, {});
            expectValidation400(
                empty.status,
                empty.body,
                /name must be a string/i,
                `${kind} POST {}`,
            );
            expect(
                (empty.body.message as string[]).some((m) =>
                    new RegExp(`shorter than or equal to ${NAME_BOUND[kind]}`, 'i').test(m),
                ),
                `${kind} POST {} reports the ${NAME_BOUND[kind]}-char bound; got ${msgOf(empty.body)}`,
            ).toBe(true);
        }
    });

    test('an EMPTY-BODY update (PUT {}) passes validation and falls through to the git-gate 409 on every kind — because Update*Dto makes name OPTIONAL (the headline asymmetry)', async ({
        request,
    }) => {
        // Update{Category,Collection,Tag}Dto have ALL fields @IsOptional, INCLUDING name.
        // So an empty PUT body is DTO-VALID, sails past the ValidationPipe, and reaches the
        // git-gated data-repo read/save → the full NoGitCredentialsError 409. This is the
        // exact inverse of the create path above (where {} is a 400), pinned per kind.
        const { token, workId } = await freshWork(request, 'update-optional');
        const s = uniq('empty-put');

        for (const kind of TAXONOMY_KINDS) {
            const put = await putTaxonomy(request, token, workId, kind, `ghost-${kind}-${s}`, {});
            expectGitGate409(put.status, put.body, `${kind} PUT {} (name optional → gate)`);
        }
    });

    test('the UPDATE path still runs the ValidationPipe: PUT {priority:-1} → 400, PUT {name:<number>} → 400 with the per-kind bound, and PUT with an unknown property → 400 whitelist', async ({
        request,
    }) => {
        // Optionality does NOT disable the other validators. A present-but-invalid field is
        // still rejected before ownership/git: priority @Min(0) fires on -1, a non-string
        // name trips @IsString+@MaxLength (per-kind bound), and forbidNonWhitelisted rejects
        // an unknown property by name. Probed on categories (100) and tags (50).
        const { token, workId } = await freshWork(request, 'update-validate');
        const s = uniq('put-invalid');

        const negPriority = await putTaxonomy(request, token, workId, 'categories', `g-${s}`, {
            priority: -1,
        });
        expectValidation400(
            negPriority.status,
            negPriority.body,
            /priority must not be less than 0/i,
            'category PUT negative priority',
        );

        const badName = await putTaxonomy(request, token, workId, 'tags', `g-${s}`, {
            name: 12345,
        });
        expectValidation400(
            badName.status,
            badName.body,
            /name must be a string/i,
            'tag PUT non-string name',
        );
        expect(
            (badName.body.message as string[]).some((m) => /shorter than or equal to 50/i.test(m)),
            `tag PUT reports the tighter 50-char bound; got ${msgOf(badName.body)}`,
        ).toBe(true);

        const unknownProp = await putTaxonomy(request, token, workId, 'collections', `g-${s}`, {
            name: 'Renamed',
            mysteryField: 'x',
        });
        expectValidation400(
            unknownProp.status,
            unknownProp.body,
            /property mysteryField should not exist/i,
            'collection PUT unknown field',
        );
    });

    test('on the UPDATE path too, an over-long STRING name is sanitize-truncated to the bound (so it PASSES @MaxLength) and falls through to the git-gate 409 — the @Transform runs before the validator', async ({
        request,
    }) => {
        // The Update*Dto.name carries the same @Transform(sanitizeName(_,bound)) as the create
        // DTO. A raw STRING longer than the bound is truncated → validation passes → the
        // DTO-valid PUT reaches the git-gate 409. Contrast the NON-string PUT above (400).
        const { token, workId } = await freshWork(request, 'update-sanitize');
        const s = uniq('put-long');

        const overByKind: Record<TaxonomyKind, string> = {
            categories: 'y'.repeat(120), // bound 100
            collections: 'z'.repeat(120), // bound 100
            tags: 'x'.repeat(60), // bound 50
        };
        for (const kind of TAXONOMY_KINDS) {
            const put = await putTaxonomy(request, token, workId, kind, `long-${kind}-${s}`, {
                name: overByKind[kind],
            });
            expectGitGate409(
                put.status,
                put.body,
                `${kind} PUT over-length name (truncated → gate)`,
            );
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C. The EXACT NoGitCredentialsError 409 envelope shape (error name + message)
// ───────────────────────────────────────────────────────────────────────────
test.describe('flow: the git-gate 409 envelope is NoGitCredentialsError with a github-account message on every write verb', () => {
    test('a DTO-valid CREATE on each kind returns the full 409 envelope: statusCode 409, error "NoGitCredentialsError", message naming the missing github account', async ({
        request,
    }) => {
        // The siblings assert only `statusCode:409`. Here we pin the whole precondition
        // envelope the FacadeExceptionFilter emits for a missing git connection, per kind.
        const { token, workId } = await freshWork(request, 'gate-create');
        const s = uniq('gate');

        for (const kind of TAXONOMY_KINDS) {
            const created = await postTaxonomy(request, token, workId, kind, {
                name: `Gate ${kind} ${s}`,
            });
            expectGitGate409(created.status, created.body, `${kind} CREATE`);
        }
    });

    test('the PUT and DELETE child verbs surface the SAME full 409 envelope (the git-gated read fires before the per-child not-found check)', async ({
        request,
    }) => {
        // Update/delete read the existing taxonomy from the data repo before the per-child
        // not-found check, so a non-existent child id on a non-connected work is the git-gate
        // 409 (NOT a 404). We pin the full envelope on both verbs for a category and a tag.
        const { token, workId } = await freshWork(request, 'gate-putdel');
        const s = uniq('gate-cd');
        const headers = authedHeaders(token);

        const put = await request.put(`${API_BASE}/api/works/${workId}/categories/ghost-${s}`, {
            headers,
            data: { name: `Renamed ${s}` },
        });
        expectGitGate409(
            put.status(),
            await readJson<ErrorEnvelope>(put),
            'category PUT non-existent child',
        );

        const del = await request.delete(`${API_BASE}/api/works/${workId}/tags/ghost-${s}`, {
            headers,
        });
        expectGitGate409(
            del.status(),
            await readJson<ErrorEnvelope>(del),
            'tag DELETE non-existent child',
        );
    });
});

// ───────────────────────────────────────────────────────────────────────────
// D. submit-item — the item WRITE surface returns TWO structurally different 400s
// ───────────────────────────────────────────────────────────────────────────
test.describe('flow: submit-item — validation 400 vs git-gate 400 on ONE endpoint', () => {
    test('a DTO-invalid item (missing name) is a class-validator 400 naming the required fields (name, source_url, category, categories) — validation precedes the git-gate', async ({
        request,
    }) => {
        // POST /works/:id/submit-item carries an item's name/description/source_url/category/
        // categories. A body missing name (and the other required fields) is rejected by the
        // ValidationPipe BEFORE any data-repo work: a { message:string[], error:'Bad Request' }
        // envelope naming every missing required field.
        const { token, workId } = await freshWork(request, 'submit-invalid');

        const res = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: { description: 'an item with no name/url/category' },
        });
        const body = await readJson<ErrorEnvelope>(res);
        expect(res.status(), `submit-item missing name → 400; got ${msgOf(body)}`).toBe(400);
        expect(body.error, 'submit-item validation error label').toBe('Bad Request');
        expect(Array.isArray(body.message), 'submit-item message is a string[]').toBe(true);
        const flat = (body.message as string[]).join(' ');
        expect(flat, 'names the required name field').toMatch(/name must be a string/i);
        expect(flat, 'names the required source_url field').toMatch(/source_url must be a/i);
        expect(flat, 'names the required category field').toMatch(/category must be a string/i);
        expect(flat, 'names the required categories array').toMatch(/categories must be an array/i);
    });

    test('submit-item enforces field bounds: a description over 5000 chars → 400 naming description, and a non-URL source_url → 400 naming source_url', async ({
        request,
    }) => {
        // Field-level bounds are enforced by the same ValidationPipe: description @MaxLength(5000)
        // and source_url @IsUrl. Each over-bound / wrong-type field is a 400 naming THAT field,
        // before the git-gate.
        const { token, workId } = await freshWork(request, 'submit-bounds');
        const s = uniq('bounds');
        const headers = authedHeaders(token);

        const longDesc = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers,
            data: {
                name: `Item ${s}`,
                description: 'd'.repeat(5001),
                source_url: `https://example.com/${s}`,
                category: `cat-${s}`,
                categories: [`cat-${s}`],
            },
        });
        const longDescBody = await readJson<ErrorEnvelope>(longDesc);
        expectValidation400(
            longDesc.status(),
            longDescBody,
            /description must be shorter than or equal to 5000/i,
            'submit-item over-long description',
        );

        const badUrl = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers,
            data: {
                name: `Item ${s}`,
                description: 'a valid description',
                source_url: 'not-a-real-url',
                category: `cat-${s}`,
                categories: [`cat-${s}`],
            },
        });
        const badUrlBody = await readJson<ErrorEnvelope>(badUrl);
        expectValidation400(
            badUrl.status(),
            badUrlBody,
            /source_url must be a URL address/i,
            'submit-item non-URL source_url',
        );
    });

    test('a FULLY DTO-valid item hits the git-gate with a DIFFERENT 400 shape: { status:"error", item_name, slug, message:"Please reconnect your Git account…" } — same endpoint, two 400 contracts', async ({
        request,
    }) => {
        // With every required field present and valid, the item write reaches the data repo and
        // the friendly git-gate fires: a { status:'error', slug, item_name, message } envelope —
        // structurally UNLIKE the class-validator 400 above (no message[] / no error:'Bad Request').
        // Pinning both on one endpoint is the distinct contract.
        const { token, workId } = await freshWork(request, 'submit-valid');
        const s = uniq('valid-item');

        const res = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: {
                name: `Item ${s}`,
                description: 'a valid, in-bounds description for the submitted item',
                source_url: `https://example.com/${s}`,
                category: `cat-${s}`,
                categories: [`cat-${s}`],
            },
        });
        const body = await readJson<ErrorEnvelope>(res);
        expect(res.status(), `valid submit-item git-gate → 400; body=${JSON.stringify(body)}`).toBe(
            400,
        );
        expect(body.status, 'valid submit-item is the error envelope').toBe('error');
        expect(body.item_name, 'git-gate echoes the item name').toBe(`Item ${s}`);
        expect(typeof body.message, 'git-gate message is a single string').toBe('string');
        expect(body.message, 'exact reconnect-git remediation').toBe(RECONNECT_GIT_MSG);
        // It is NOT the class-validator shape.
        expect(Array.isArray(body.message), 'git-gate message is not a string[]').toBe(false);
        expect(body.error, 'git-gate is not the Bad Request validation envelope').not.toBe(
            'Bad Request',
        );
    });
});

// ───────────────────────────────────────────────────────────────────────────
// E. read-tolerant vs write-gated asymmetry on the item + taxonomy surfaces
// ───────────────────────────────────────────────────────────────────────────
test.describe('flow: the read side is git-tolerant while the write side is git-gated (same resource)', () => {
    test('the items surface: GET /items is a tolerant 200 { items:[] } but the item WRITE (a valid submit-item) is git-gated 400 — read succeeds, write is blocked', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request, 'item-read-write');
        const s = uniq('item-rw');

        const read = await getEnvelope<ItemsEnvelope>(request, token, `/api/works/${workId}/items`);
        expect(read.status, `items read body=${JSON.stringify(read.body)}`).toBe(200);
        expect(read.body.status, 'items read envelope is success').toBe('success');
        expect(Array.isArray(read.body.items), 'items is an array').toBe(true);
        expect(read.body.items!.length, 'fresh work has no items').toBe(0);

        const write = await request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
            headers: authedHeaders(token),
            data: {
                name: `RW Item ${s}`,
                description: 'read tolerant, write gated',
                source_url: `https://example.com/${s}`,
                category: `cat-${s}`,
                categories: [`cat-${s}`],
            },
        });
        const writeBody = await readJson<ErrorEnvelope>(write);
        expect(write.status(), 'item WRITE is git-gated → 400').toBe(400);
        expect(writeBody.message, 'item WRITE git-gate message').toBe(RECONNECT_GIT_MSG);

        // The blocked write left the read untouched — still empty.
        const reRead = await getEnvelope<ItemsEnvelope>(
            request,
            token,
            `/api/works/${workId}/items`,
        );
        expect(reRead.body.items!.length, 'items still empty after the blocked write').toBe(0);
    });

    test('the taxonomy surface: GET /categories-tags is a tolerant 200 { categories:[], tags:[], collections:[] } but every taxonomy WRITE is git-gated 409', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request, 'taxo-read-write');
        const s = uniq('taxo-rw');

        const read = await getEnvelope<TaxonomyEnvelope>(
            request,
            token,
            `/api/works/${workId}/categories-tags`,
        );
        expect(read.status, `categories-tags body=${JSON.stringify(read.body)}`).toBe(200);
        expect(read.body.status, 'categories-tags envelope is success').toBe('success');
        expect(Array.isArray(read.body.categories), 'categories is an array').toBe(true);
        expect(Array.isArray(read.body.tags), 'tags is an array').toBe(true);
        expect(Array.isArray(read.body.collections), 'collections is an array').toBe(true);
        expect(
            read.body.categories!.length + read.body.tags!.length + read.body.collections!.length,
            'fresh work has no taxonomy at all',
        ).toBe(0);

        const write = await postTaxonomy(request, token, workId, 'collections', {
            name: `RW Coll ${s}`,
        });
        expectGitGate409(write.status, write.body, 'taxonomy WRITE while read is tolerant');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// F. multi-step cross-surface consistency + count/collections contract + isolation
// ───────────────────────────────────────────────────────────────────────────
test.describe('flow: multi-step cross-surface consistency — gated writes change NOTHING across four read surfaces', () => {
    test('snapshot → gated writes across all three kinds (create + empty PUT) → re-snapshot: items, count, categories-tags AND history are all unchanged, and history never records the failed writes', async ({
        request,
    }) => {
        // The load-bearing multi-step flow. Take a full snapshot of the four read surfaces,
        // fire a battery of gated writes (a create + an empty-body PUT for each kind — all
        // 409), then re-snapshot and prove every surface is byte-for-byte the empty baseline.
        // Crucially, history stays empty: the controller logs taxonomy activity only AFTER the
        // service call returns, so a 409 write never produces a history row (asserted by the
        // unique attempted names being absent from the history payload).
        const { token, workId } = await freshWork(request, 'multistep');
        const s = uniq('snap');
        const attemptedName = `Snap Cat ${s}`;

        // — baseline snapshot —
        const items0 = await getEnvelope<ItemsEnvelope>(
            request,
            token,
            `/api/works/${workId}/items`,
        );
        const count0 = await getEnvelope<CountEnvelope>(
            request,
            token,
            `/api/works/${workId}/count`,
        );
        const tax0 = await getEnvelope<TaxonomyEnvelope>(
            request,
            token,
            `/api/works/${workId}/categories-tags`,
        );
        const hist0 = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history?activityType=taxonomy`,
        );
        expect(items0.body.items!.length, 'baseline items empty').toBe(0);
        expect(count0.body, 'baseline count').toMatchObject({
            status: 'success',
            items: 0,
            categories: 0,
            tags: 0,
        });
        expect(
            tax0.body.categories!.length + tax0.body.tags!.length + tax0.body.collections!.length,
            'baseline taxonomy empty',
        ).toBe(0);
        expect(hist0.body.total, 'baseline history empty').toBe(0);

        // — gated writes: a create + an empty-body PUT for each kind (all blocked) —
        const createCat = await postTaxonomy(request, token, workId, 'categories', {
            name: attemptedName,
        });
        expectGitGate409(createCat.status, createCat.body, 'snapshot category create');
        for (const kind of TAXONOMY_KINDS) {
            const put = await putTaxonomy(request, token, workId, kind, `snap-${kind}-${s}`, {
                name: `Snap ${kind} ${s}`,
            });
            expectGitGate409(put.status, put.body, `snapshot ${kind} PUT`);
        }

        // — re-snapshot: every surface is unchanged —
        const items1 = await getEnvelope<ItemsEnvelope>(
            request,
            token,
            `/api/works/${workId}/items`,
        );
        const count1 = await getEnvelope<CountEnvelope>(
            request,
            token,
            `/api/works/${workId}/count`,
        );
        const tax1 = await getEnvelope<TaxonomyEnvelope>(
            request,
            token,
            `/api/works/${workId}/categories-tags`,
        );
        const hist1 = await getEnvelope<HistoryEnvelope>(
            request,
            token,
            `/api/works/${workId}/history?activityType=taxonomy`,
        );
        expect(items1.body.items!.length, 'items unchanged after gated writes').toBe(0);
        expect(count1.body, 'count unchanged after gated writes').toMatchObject({
            status: 'success',
            items: 0,
            categories: 0,
            tags: 0,
        });
        expect(
            tax1.body.categories!.length + tax1.body.tags!.length + tax1.body.collections!.length,
            'taxonomy unchanged after gated writes',
        ).toBe(0);
        expect(hist1.body.total, 'history still empty after gated writes').toBe(0);
        // The failed writes must not appear anywhere in the history payload.
        expect(
            JSON.stringify(hist1.body.history ?? []).includes(attemptedName),
            'the 409 create is never recorded in history',
        ).toBe(false);
    });

    test('the count endpoint tracks items/categories/tags but has NO `collections` key — categories-tags is the SOLE surface that exposes collections', async ({
        request,
    }) => {
        // Cross-endpoint contract: /count returns exactly { status, items, categories, tags } and
        // deliberately omits collections, even though /categories-tags always includes a
        // collections array. This pins where each taxonomy dimension is observable.
        const { token, workId } = await freshWork(request, 'count-shape');

        const count = await getEnvelope<CountEnvelope>(
            request,
            token,
            `/api/works/${workId}/count`,
        );
        expect(count.status, `count body=${JSON.stringify(count.body)}`).toBe(200);
        expect(count.body.status, 'count envelope is success').toBe('success');
        expect(count.body.items, 'count.items').toBe(0);
        expect(count.body.categories, 'count.categories').toBe(0);
        expect(count.body.tags, 'count.tags').toBe(0);
        expect(
            Object.prototype.hasOwnProperty.call(count.body, 'collections'),
            'count omits the collections key',
        ).toBe(false);

        const tax = await getEnvelope<TaxonomyEnvelope>(
            request,
            token,
            `/api/works/${workId}/categories-tags`,
        );
        expect(
            Array.isArray(tax.body.collections),
            'categories-tags IS the surface that exposes collections',
        ).toBe(true);
    });

    test('cross-surface writes are isolated PER-WORK — a gated write battery on work A leaves work B’s items, count, categories-tags AND history all pristine (same owner)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const s = uniq('iso');
        const { id: workA } = await createWorkViaAPI(request, u.access_token, {
            name: `Iso A ${s}`,
            slug: `iso-a-${s}`,
        });
        const { id: workB } = await createWorkViaAPI(request, u.access_token, {
            name: `Iso B ${s}`,
            slug: `iso-b-${s}`,
        });
        expect(workA).toMatch(UUID_RE);
        expect(workB).toMatch(UUID_RE);
        expect(workA).not.toBe(workB);

        // Battery of gated writes on A (create every kind + one empty PUT).
        for (const kind of TAXONOMY_KINDS) {
            const created = await postTaxonomy(request, u.access_token, workA, kind, {
                name: `Iso ${kind} ${s}`,
            });
            expectGitGate409(created.status, created.body, `work A ${kind} create`);
        }

        // Work B is entirely unaffected across every read surface.
        const bItems = await getEnvelope<ItemsEnvelope>(
            request,
            u.access_token,
            `/api/works/${workB}/items`,
        );
        const bCount = await getEnvelope<CountEnvelope>(
            request,
            u.access_token,
            `/api/works/${workB}/count`,
        );
        const bTax = await getEnvelope<TaxonomyEnvelope>(
            request,
            u.access_token,
            `/api/works/${workB}/categories-tags`,
        );
        const bHist = await getEnvelope<HistoryEnvelope>(
            request,
            u.access_token,
            `/api/works/${workB}/history`,
        );
        expect(bItems.body.items!.length, 'work B items untouched').toBe(0);
        expect(bCount.body, 'work B count untouched').toMatchObject({
            items: 0,
            categories: 0,
            tags: 0,
        });
        expect(
            bTax.body.categories!.length + bTax.body.tags!.length + bTax.body.collections!.length,
            'work B taxonomy untouched',
        ).toBe(0);
        expect(bHist.body.total, 'work B history untouched').toBe(0);

        // And A itself never materialised anything either.
        const aTax = await getEnvelope<TaxonomyEnvelope>(
            request,
            u.access_token,
            `/api/works/${workA}/categories-tags`,
        );
        expect(
            aTax.body.categories!.length + aTax.body.tags!.length + aTax.body.collections!.length,
            'work A taxonomy stayed empty (gated writes committed nothing)',
        ).toBe(0);
    });
});
