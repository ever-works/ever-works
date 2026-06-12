import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-taxonomy-git-gating-deep — DEEP per-work taxonomy DTO-validation +
 * git-gate matrix for the Missions/Ideas/Works surface. Every per-work
 * taxonomy WRITE (POST/PUT/DELETE /api/works/:id/{categories,tags,collections})
 * commits to the work's data repo; on a fresh work with NO connected git
 * provider the save throws and the dedicated endpoints surface a 409 (NoGitCredentialsError via the FacadeExceptionFilter; was a generic 500).
 * BEFORE that git-gate fire, three layers are exercised independently: the
 * class-validator DTO (ValidationPipe), the AuthSessionGuard (401), and the
 * ownership guard (403 stranger / 404 ghost). This file pins the DTO BOUND
 * MATRIX and the per-kind 403/404/401 surface that the sibling specs leave
 * unpinned.
 *
 * EVERY status / message / shape below was LIVE-PROBED against the running
 * sqlite-in-memory CI driver (API 127.0.0.1:3100, REQUIRE_EMAIL_VERIFICATION=
 * false, keyless — no LLM, no connected git) on 2026-06-12, then cross-read
 * against the controller + DTO source:
 *   - apps/api/src/works/works.controller.ts
 *       POST/PUT/DELETE works/:id/{categories,tags,collections}, submit-item
 *   - packages/agent/src/dto/taxonomy.dto.ts
 *       Create{Category,Collection}Dto.name @IsString @MaxLength(100);
 *       CreateTagDto.name @IsString @MaxLength(50) (NO other fields);
 *       description @MaxLength(500); icon_url @MaxLength(500);
 *       icon_svg @MaxLength(4000); priority @IsNumber @Min(0);
 *       name/description carry a @Transform(sanitizeName/Description) that runs
 *       (class-transformer) BEFORE @MaxLength (class-validator) and TRUNCATES a
 *       too-long STRING so it passes validation and falls through to the gate.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────
 * The sibling taxonomy/git specs already own a DIFFERENT slice:
 *   · flow-work-taxonomy-deep.spec.ts — the owner-side EMPTY read envelope
 *       (categories-tags + count), the gate-ORDER walk (validation → auth →
 *       ownership → git) demonstrated with category-missing-name + tag-NON-
 *       string-50, stranger-403/ghost-404 on the CATEGORIES write only, the
 *       count↔read invariant, PUT/DELETE git-gate 409, and the submit-item 400
 *       reconnect-git contrast.
 *   · flow-git-provider-connection.spec.ts — that a disconnected user's
 *       categories AND tags AND collections writes are all >=400 git-gated
 *       (status-class only, no DTO matrix), connection isolation, sanitized
 *       sub-resource errors.
 *   · flow-idea-lifecycle-deep.spec.ts — Idea/Mission create DTO bounds
 *       (description 10–5000, title ≤120), the accept FK/ownership/rollback
 *       edges, the Mission cap/type lattice + budget shape.
 *
 * THIS file pins the surface those LACK — the FULL per-kind DTO bound matrix:
 *   1. name @IsString+@MaxLength: category & collection report the 100-char
 *      bound, tag the tighter 50-char bound (the SAME non-string probe, three
 *      different messages) — and a missing name is the same 400, while an
 *      EMPTY-STRING name passes validation and reaches the git-gate (a subtle
 *      sanitize-vs-required distinction).
 *   2. The optional CATEGORY/COLLECTION fields: description @MaxLength(500)+
 *      @IsString, icon_url @MaxLength(500), icon_svg @MaxLength(4000),
 *      priority @IsNumber+@Min(0) — each over-bound / wrong-type body is a 400
 *      naming THAT field, before any ownership/git work.
 *   3. The whitelist: an unknown property on ANY kind is 400 "property <x>
 *      should not exist", and a CATEGORY-only field (description) on a TAG is
 *      rejected because CreateTagDto carries ONLY name.
 *   4. The sanitize @Transform truncates an over-long STRING name to the bound
 *      so it PASSES validation and falls through to the git-gate 409 (proving
 *      the transform runs before the validator) — for all three kinds.
 *   5. Cross-user isolation on EACH write verb/kind: a DTO-valid stranger
 *      POST/PUT/DELETE is 403 (ownership precedes the git save) for tags AND
 *      collections (not just categories), and a ghost work id is 404 — and a
 *      PUT with an INVALID body is a 400 (validation precedes ownership) even
 *      for the legit owner.
 *   6. The Missions/Ideas taxonomy CHAIN: an Idea accepted onto an owner's own
 *      Work leaves that Work's taxonomy git-gated all the same (accept stamps a
 *      pointer, it does NOT connect git), and the read stays the empty success
 *      envelope.
 *
 * ISOLATION: every mutating flow runs on a FRESH registerUserViaAPI() user
 * (never the shared seeded user). Unique suffixes come from a per-test counter
 * + the test title, NOT a module-scope clock. List assertions (none here) would
 * use toContain. Filename uses the safe `flow-` prefix.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT_WORK_ID = '00000000-0000-0000-0000-000000000000';
const PERMISSION_RE = /do not have permission to access this work/i;
const NOT_FOUND_RE = /not found/i;

const TAXONOMY_KINDS = ['categories', 'tags', 'collections'] as const;
type TaxonomyKind = (typeof TAXONOMY_KINDS)[number];

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
    collections?: unknown[];
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

/** Register a fresh owner + a work in one step (every mutating test is isolated). */
async function freshWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const s = uniq(label);
    const { id: workId } = await createWorkViaAPI(request, u.access_token, {
        name: `Taxo ${s}`,
        slug: `taxo-${s}`,
    });
    expect(workId, `created work id for ${label}`).toMatch(UUID_RE);
    return { token: u.access_token, workId };
}

/**
 * The git-gate signature for the dedicated taxonomy endpoints: a DTO-valid op
 * on a work whose owner has NOT connected a git provider hits
 * `gitFacade.cloneOrPull` → `NoGitCredentialsError`, which the global
 * FacadeExceptionFilter maps to a clean 409 precondition (was a generic 500
 * before that filter — see apps/api/src/common/filters).
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

test.describe('flow: taxonomy WRITE — the per-kind name @IsString+@MaxLength bound matrix', () => {
    test('a NON-STRING name is a 400 that reports each kind’s own length bound (category/collection 100, tag 50), before any ownership/git work', async ({
        request,
    }) => {
        // The SAME malformed name (a number) trips @IsString on all three kinds,
        // but the co-located @MaxLength differs per DTO, so the message naming the
        // bound is the per-kind fingerprint. Validation runs FIRST (before the
        // ownership guard and the git-gated save), so even the legit owner sees it.
        const { token, workId } = await freshWork(request, 'name-bound');

        const category = await postTaxonomy(request, token, workId, 'categories', { name: 98765 });
        expectValidation400(
            category.status,
            category.body,
            /name must be a string/i,
            'category non-string name',
        );
        expect(
            (category.body.message as string[]).some((m) =>
                /shorter than or equal to 100/i.test(m),
            ),
            `category reports the 100-char bound; got ${msgOf(category.body)}`,
        ).toBe(true);

        const collection = await postTaxonomy(request, token, workId, 'collections', {
            name: 98765,
        });
        expectValidation400(
            collection.status,
            collection.body,
            /name must be a string/i,
            'collection non-string name',
        );
        expect(
            (collection.body.message as string[]).some((m) =>
                /shorter than or equal to 100/i.test(m),
            ),
            `collection reports the 100-char bound; got ${msgOf(collection.body)}`,
        ).toBe(true);

        const tag = await postTaxonomy(request, token, workId, 'tags', { name: 98765 });
        expectValidation400(tag.status, tag.body, /name must be a string/i, 'tag non-string name');
        expect(
            (tag.body.message as string[]).some((m) => /shorter than or equal to 50/i.test(m)),
            `tag reports the TIGHTER 50-char bound; got ${msgOf(tag.body)}`,
        ).toBe(true);
        // And the tag bound is strictly tighter than category/collection — no 100 leak.
        expect(
            (tag.body.message as string[]).some((m) => /shorter than or equal to 100/i.test(m)),
            'tag NEVER reports the 100-char category bound',
        ).toBe(false);
    });

    test('a MISSING name is the same 400 (required), but an EMPTY-STRING name passes validation and falls through to the git-gate (the sanitize-vs-required distinction)', async ({
        request,
    }) => {
        // Probed: `{}` → 400 (@IsString fails on undefined). But `{ name: '' }` is a
        // STRING of length 0 — it passes @IsString + @MaxLength, so the DTO is valid
        // and the request reaches the git-gated save → 409. This pins that the name
        // is validated for TYPE/length, NOT for non-emptiness (no @IsNotEmpty).
        const { token, workId } = await freshWork(request, 'name-required');

        const missing = await postTaxonomy(request, token, workId, 'categories', {});
        expectValidation400(
            missing.status,
            missing.body,
            /name must be a string/i,
            'missing category name',
        );

        const empty = await postTaxonomy(request, token, workId, 'categories', { name: '' });
        expectGitGate409(empty.status, empty.body, 'empty-string category name');
    });
});

test.describe('flow: taxonomy WRITE — the optional category/collection field bounds', () => {
    test('description @MaxLength(500)+@IsString, icon_url @MaxLength(500), and icon_svg @MaxLength(4000) each 400 naming THAT field', async ({
        request,
    }) => {
        // The optional fields carry their own bounds. description has a sanitize
        // @Transform (so a too-long STRING truncates), but a NON-STRING description
        // can't be sanitized → @IsString + @MaxLength both fire. icon_url / icon_svg
        // have NO transform, so an over-long STRING trips @MaxLength directly.
        const { token, workId } = await freshWork(request, 'opt-fields');

        const badDesc = await postTaxonomy(request, token, workId, 'categories', {
            name: 'Cat',
            description: 55555,
        });
        expectValidation400(
            badDesc.status,
            badDesc.body,
            /description must be a string/i,
            'category non-string description',
        );
        expect(
            (badDesc.body.message as string[]).some((m) => /shorter than or equal to 500/i.test(m)),
            `description reports the 500-char bound; got ${msgOf(badDesc.body)}`,
        ).toBe(true);

        const longIconUrl = await postTaxonomy(request, token, workId, 'categories', {
            name: 'Cat',
            icon_url: 'h'.repeat(501),
        });
        expectValidation400(
            longIconUrl.status,
            longIconUrl.body,
            /icon_url must be shorter than or equal to 500/i,
            'category over-long icon_url',
        );

        const longIconSvg = await postTaxonomy(request, token, workId, 'collections', {
            name: 'Coll',
            icon_svg: 's'.repeat(4001),
        });
        expectValidation400(
            longIconSvg.status,
            longIconSvg.body,
            /icon_svg must be shorter than or equal to 4000/i,
            'collection over-long icon_svg',
        );
    });

    test('priority @IsNumber+@Min(0): a NEGATIVE priority and a NON-NUMERIC priority each 400, while priority:0 (the boundary) is VALID and reaches the git-gate', async ({
        request,
    }) => {
        // priority floors at 0. -1 trips @Min(0); a string trips @IsNumber (and the
        // @Min comparison too). priority:0 is the inclusive boundary → it passes
        // validation and the DTO-valid write falls through to the git-gate 409.
        const { token, workId } = await freshWork(request, 'priority');

        const negative = await postTaxonomy(request, token, workId, 'categories', {
            name: 'Cat',
            priority: -1,
        });
        expectValidation400(
            negative.status,
            negative.body,
            /priority must not be less than 0/i,
            'category negative priority',
        );

        const nonNumeric = await postTaxonomy(request, token, workId, 'categories', {
            name: 'Cat',
            priority: 'high',
        });
        expectValidation400(
            nonNumeric.status,
            nonNumeric.body,
            /priority must be a number/i,
            'category non-numeric priority',
        );

        const zero = await postTaxonomy(request, token, workId, 'categories', {
            name: 'Cat',
            priority: 0,
        });
        expectGitGate409(zero.status, zero.body, 'priority:0 boundary write');
    });
});

test.describe('flow: taxonomy WRITE — the create whitelist (forbidNonWhitelisted)', () => {
    test('an unknown property is rejected by name on EVERY kind, and a CATEGORY-only field (description) on a TAG is rejected because CreateTagDto carries ONLY name', async ({
        request,
    }) => {
        // The global ValidationPipe runs with whitelist + forbidNonWhitelisted, so a
        // property absent from the DTO is a 400 "property <x> should not exist". The
        // tag DTO is the strictest — `description` (legal on category/collection) is
        // an unknown field for a tag and is rejected.
        const { token, workId } = await freshWork(request, 'whitelist');

        for (const kind of TAXONOMY_KINDS) {
            const bogus = await postTaxonomy(request, token, workId, kind, {
                name: 'Thing',
                bogusField: 'x',
            });
            expectValidation400(
                bogus.status,
                bogus.body,
                /property bogusField should not exist/i,
                `${kind} unknown field`,
            );
        }

        // `description` is valid for category/collection but NOT for a tag.
        const tagWithDesc = await postTaxonomy(request, token, workId, 'tags', {
            name: 'Tag',
            description: 'tags have no description',
        });
        expectValidation400(
            tagWithDesc.status,
            tagWithDesc.body,
            /property description should not exist/i,
            'tag with a category-only description field',
        );
    });
});

test.describe('flow: taxonomy WRITE — the sanitize @Transform truncates an over-long STRING name through to the git-gate', () => {
    test('an over-bound STRING name on each kind is sanitize-truncated to the bound (so it PASSES @MaxLength) and falls through to the git-gate 409 — proving the transform runs before the validator', async ({
        request,
    }) => {
        // CreateTagDto.name / Create{Category,Collection}Dto.name carry a
        // @Transform(sanitizeName(value, bound)) that runs (class-transformer)
        // BEFORE @MaxLength (class-validator). A raw STRING longer than the bound is
        // truncated to the bound → validation passes → the DTO-valid write reaches
        // the git-gated save → 409. Contrast with the NON-string probe above, which
        // can't be truncated and so trips @IsString+@MaxLength → 400.
        const { token, workId } = await freshWork(request, 'sanitize');

        const overByKind: Record<TaxonomyKind, string> = {
            categories: 'y'.repeat(101), // bound 100
            collections: 'z'.repeat(101), // bound 100
            tags: 'x'.repeat(51), // bound 50
        };
        for (const kind of TAXONOMY_KINDS) {
            const over = await postTaxonomy(request, token, workId, kind, {
                name: overByKind[kind],
            });
            expectGitGate409(over.status, over.body, `${kind} over-length STRING name (truncated)`);
        }
    });
});

test.describe('flow: taxonomy WRITE — the INCLUSIVE @MaxLength boundaries are valid and reach the git-gate', () => {
    test('a tag name of EXACTLY 50 chars and a category description of EXACTLY 500 chars (the inclusive bounds) both PASS validation and fall through to the git-gate 409', async ({
        request,
    }) => {
        // @MaxLength(n) is INCLUSIVE: a value of exactly n passes. We assert the
        // boundary is valid (not a 400) by observing it reach the git-gate — the
        // DTO-valid write hits the data-repo save and 500s. This pins that the
        // rejection above is for length > bound, not >= bound.
        const { token, workId } = await freshWork(request, 'boundary');

        const tag50 = await postTaxonomy(request, token, workId, 'tags', { name: 't'.repeat(50) });
        expectGitGate409(tag50.status, tag50.body, 'tag name exactly 50 chars');

        const desc500 = await postTaxonomy(request, token, workId, 'categories', {
            name: 'Cat',
            description: 'd'.repeat(500),
        });
        expectGitGate409(desc500.status, desc500.body, 'category description exactly 500 chars');
    });
});

test.describe('flow: taxonomy WRITE — the dedicated endpoints are git-gated for a DTO-valid owner on every kind', () => {
    test('a DTO-valid create for categories AND tags AND collections each 500s on a non-connected work and persists NOTHING (the read stays the empty success envelope)', async ({
        request,
    }) => {
        // The core git-gate, asserted per kind with the git-gate 409 envelope (distinct
        // from submit-item's friendly 400). After all three blocked writes the
        // categories-tags read still reports the empty success envelope — no partial
        // taxonomy leaked from a half-committed save.
        const { token, workId } = await freshWork(request, 'gated-create');
        const s = uniq('gated');

        for (const kind of TAXONOMY_KINDS) {
            const write = await postTaxonomy(request, token, workId, kind, {
                name: `Gated ${kind} ${s}`,
            });
            expectGitGate409(write.status, write.body, `${kind} create`);
        }

        const read = await request.get(`${API_BASE}/api/works/${workId}/categories-tags`, {
            headers: authedHeaders(token),
        });
        expect(read.status(), 'read after gated writes → 200').toBe(200);
        const body = await readJson<TaxonomyEnvelope>(read);
        expect(body.status, 'read envelope is success').toBe('success');
        expect((body.categories ?? []).length, 'no categories persisted').toBe(0);
        expect((body.tags ?? []).length, 'no tags persisted').toBe(0);
        expect((body.collections ?? []).length, 'no collections persisted').toBe(0);
    });
});

test.describe('flow: taxonomy WRITE — auth + ownership precede the git-gate on every kind/verb', () => {
    test('an ANON DTO-valid create on every kind is 401, and ANON PUT/DELETE child writes are 401 too (AuthSessionGuard before ownership/git)', async ({
        request,
    }) => {
        const { workId } = await freshWork(request, 'anon-create');
        for (const kind of TAXONOMY_KINDS) {
            const anon = await postTaxonomy(request, null, workId, kind, { name: `Anon ${kind}` });
            expect(anon.status, `anon ${kind} create → 401`).toBe(401);
            expect(anon.body.statusCode, `anon ${kind} 401 envelope`).toBe(401);
        }

        // The child PUT/DELETE verbs are equally auth-gated (no bearer → 401, before
        // the ownership guard or the git-gated read).
        const anonPut = await request.put(`${API_BASE}/api/works/${workId}/categories/x`, {
            data: { name: 'Anon Rename' },
        });
        expect(anonPut.status(), 'anon PUT category → 401').toBe(401);
        expect((await readJson<ErrorEnvelope>(anonPut)).statusCode, 'anon PUT 401 envelope').toBe(
            401,
        );

        const anonDel = await request.delete(`${API_BASE}/api/works/${workId}/tags/x`);
        expect(anonDel.status(), 'anon DELETE tag → 401').toBe(401);
        expect(
            (await readJson<ErrorEnvelope>(anonDel)).statusCode,
            'anon DELETE 401 envelope',
        ).toBe(401);
    });

    test('a STRANGER’s DTO-valid create is 403 on tags AND collections (ownership precedes the git save), and a ghost work id is 404 — neither reaches the gate', async ({
        request,
    }) => {
        // The sibling deep spec pins stranger-403 on CATEGORIES only. Here we pin the
        // tags + collections write paths too: ownership(ensureCanEdit) fires before
        // the data-repo save, so a non-member never reaches the git-gate (403, not
        // 500), and an absent work 404s (the row lookup precedes the save).
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = uniq('stranger-create');
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `Owner Taxo ${s}`,
            slug: `owner-taxo-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        for (const kind of ['tags', 'collections'] as const) {
            const stranger403 = await postTaxonomy(request, stranger.access_token, workId, kind, {
                name: `Stranger ${kind}`,
            });
            expect(stranger403.status, `stranger ${kind} create → 403`).toBe(403);
            expect(stranger403.body.status, `stranger ${kind} denial envelope`).toBe('error');
            expect(String(stranger403.body.message), `stranger ${kind} permission message`).toMatch(
                PERMISSION_RE,
            );
        }

        // A DTO-valid OWNER write to an ABSENT work is 404 (not the owner's 500 gate).
        const ghost = await postTaxonomy(request, owner.access_token, ABSENT_WORK_ID, 'tags', {
            name: 'Ghost Tag',
        });
        expect(ghost.status, 'ghost work tag create → 404').toBe(404);
        expect(String(ghost.body.message), 'ghost denial message').toMatch(NOT_FOUND_RE);
    });

    test('PUT/DELETE child writes: a STRANGER is 403 (ownership before git), but an INVALID PUT body from the OWNER is a 400 (validation before ownership)', async ({
        request,
    }) => {
        // The child update/delete endpoints are gated identically. A stranger PUT/
        // DELETE is 403 (ownership precedes the git-gated read inside the service).
        // But the ValidationPipe still runs FIRST: an owner PUT with a non-string
        // name is a 400 (the body never reaches ownership/git), while an owner PUT
        // with a VALID body reaches the git-gate → 409.
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = uniq('putdel');
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `PutDel Taxo ${s}`,
            slug: `putdel-taxo-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        const ownerH = authedHeaders(owner.access_token);
        const strangerH = authedHeaders(stranger.access_token);

        // Stranger PUT category (DTO-valid) → 403 (ownership precedes git).
        const strangerPut = await request.put(
            `${API_BASE}/api/works/${workId}/categories/ghost-${s}`,
            {
                headers: strangerH,
                data: { name: `Renamed ${s}` },
            },
        );
        expect(strangerPut.status(), 'stranger PUT category → 403').toBe(403);
        expect(String((await readJson<ErrorEnvelope>(strangerPut)).message)).toMatch(PERMISSION_RE);

        // Stranger DELETE tag → 403.
        const strangerDel = await request.delete(
            `${API_BASE}/api/works/${workId}/tags/ghost-${s}`,
            {
                headers: strangerH,
            },
        );
        expect(strangerDel.status(), 'stranger DELETE tag → 403').toBe(403);
        expect(String((await readJson<ErrorEnvelope>(strangerDel)).message)).toMatch(PERMISSION_RE);

        // Owner PUT with an INVALID (non-string) name → 400 (validation precedes ownership/git).
        const ownerBadPut = await request.put(
            `${API_BASE}/api/works/${workId}/categories/ghost-${s}`,
            {
                headers: ownerH,
                data: { name: 12345 },
            },
        );
        const ownerBadBody = await readJson<ErrorEnvelope>(ownerBadPut);
        expectValidation400(
            ownerBadPut.status(),
            ownerBadBody,
            /name must be a string/i,
            'owner PUT invalid name',
        );

        // Owner PUT with a VALID name → reaches the git-gate → 409.
        const ownerGoodPut = await request.put(
            `${API_BASE}/api/works/${workId}/categories/ghost-${s}`,
            {
                headers: ownerH,
                data: { name: `Renamed ${s}` },
            },
        );
        expectGitGate409(
            ownerGoodPut.status(),
            await readJson<ErrorEnvelope>(ownerGoodPut),
            'owner PUT valid name',
        );

        // Owner DELETE a non-existent tag id → git-gate 409 (the gated read fires
        // before the per-child not-found check, so it's a 500, not a 404).
        const ownerDel = await request.delete(`${API_BASE}/api/works/${workId}/tags/ghost-${s}`, {
            headers: ownerH,
        });
        expectGitGate409(
            ownerDel.status(),
            await readJson<ErrorEnvelope>(ownerDel),
            'owner DELETE non-existent tag',
        );
    });
});

test.describe('flow: Missions/Ideas taxonomy CHAIN — accepting an Idea onto a Work does NOT lift the work’s git-gate', () => {
    test('an Idea accepted onto the owner’s own Work leaves that Work’s taxonomy writes git-gated, and the read stays the empty success envelope', async ({
        request,
    }) => {
        // An Idea (WorkProposal) becomes a Work via accept; accept stamps the
        // acceptedWorkId pointer but does NOT connect a git provider. So the linked
        // Work's taxonomy writes are STILL git-gated (409) and its read is STILL the
        // empty success envelope — proving the gate is about the git connection, not
        // the Idea→Work linkage state.
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);
        const s = uniq('idea-chain');

        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: {
                description: `A curated directory of AI dev tools ${s} for the taxonomy chain`,
            },
        });
        expect(ideaRes.status(), `create idea body=${await ideaRes.text()}`).toBe(201);
        const ideaId = (await ideaRes.json()).id as string;
        expect(ideaId).toMatch(UUID_RE);

        const { id: workId } = await createWorkViaAPI(request, user.access_token, {
            name: `Chain Work ${s}`,
            slug: `chain-work-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        const accept = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers,
            data: { workId },
        });
        expect(accept.status(), `accept body=${await accept.text()}`).toBe(200);
        expect(await accept.json()).toEqual({ ok: true });

        // The accepted-linked Work is still git-gated for taxonomy writes.
        const write = await postTaxonomy(request, user.access_token, workId, 'categories', {
            name: `Chain Cat ${s}`,
        });
        expectGitGate409(write.status, write.body, 'taxonomy write on accepted-linked work');

        // And its read is still the empty success envelope (no taxonomy materialized
        // by the accept).
        const read = await request.get(`${API_BASE}/api/works/${workId}/categories-tags`, {
            headers,
        });
        expect(read.status(), 'accepted-work read → 200').toBe(200);
        const body = await readJson<TaxonomyEnvelope>(read);
        expect(body.status, 'accepted-work read envelope is success').toBe('success');
        expect((body.categories ?? []).length, 'accepted work has no categories').toBe(0);
        expect((body.tags ?? []).length, 'accepted work has no tags').toBe(0);
        expect((body.collections ?? []).length, 'accepted work has no collections').toBe(0);
    });
});
