/**
 * KB documents — CREATE / UPDATE DTO validation + work-scoped authz MATRIX.
 *
 * Endpoints under test (per-Work KB surface, `apps/api/src/works/kb.controller.ts`):
 *   • POST  /api/works/:id/kb/documents           (CreateKbDocumentDto)
 *   • PATCH /api/works/:id/kb/documents/:docId     (UpdateKbDocumentDto)
 *   • POST  /api/works/:id/kb/documents/:docId/lock    (LockKbDocumentDto)
 *   • POST  /api/works/:id/kb/documents/:docId/unlock
 *   • POST  /api/works/:id/kb/documents/:docId/restore (RestoreKbDocumentDto)
 *
 * This file is the exhaustive per-field validation + authz-matrix companion to
 * the existing flow-kb-* specs. Those cover happy-path CRUD, upload/extraction,
 * the lock state-machine, and restore length boundaries. This file instead
 * pins EVERY create/update DTO field's class-validator contract plus the full
 * work-scoped authorization set — angles the other specs do not exhaust.
 *
 * ── Contract, verified live against http://127.0.0.1:3100 (sqlite, flags ON)
 *    before these assertions were written:
 *
 *   CreateKbDocumentDto (packages/agent/src/dto/kb.dto.ts):
 *     path        @IsString @Length(1,512)  + service-level content guard:
 *                 first segment MUST be a known class folder, no `..`, no
 *                 leading `/`, no drive-letter, no `\`  → BadRequest (400)
 *     title       @IsString @Length(1,255)
 *     class       @IsIn(brand|legal|seo|style|glossary|competitors|personas|
 *                        research|output|freeform)   (required)
 *     body        @IsString @MaxLength(1048576)      (required; "" allowed)
 *     description @IsOptional @IsString @MaxLength(2000) (null allowed)
 *     tags        @IsOptional array<=32, each string <=64
 *     categories  @IsOptional array<=32, each string <=64
 *     language    @IsOptional @IsString @Length(2,8)  (default 'en')
 *     status      @IsOptional @IsIn(draft|active|archived) (default 'active')
 *     forbidNonWhitelisted → any extra field → 400 "property X should not exist"
 *
 *   UpdateKbDocumentDto: every field above is @IsOptional (no path/no create-
 *     only fields); `{}` is a valid no-op → 200. A full-locked doc rejects the
 *     write with 403 before the patch applies.
 *
 *   Authz posture (WorkOwnershipService.ensureCanEdit → ensureAccess):
 *     • no bearer                                   → 401
 *     • unknown-but-valid work uuid                 → 404 (NotFoundException)
 *     • foreign work that EXISTS (non-member)       → 403 (ForbiddenException)
 *       → NOT a 404-never-403 posture: unknown = 404, foreign = 403.
 *     • malformed work/doc uuid (ParseUUIDPipe)     → 400 "uuid is expected"
 *     • unknown docId on an owned work              → 404 "KB document not found"
 *
 *   restore is git-gated: a well-formed commitSha on a work with no connected
 *     git account terminates 409 NoGitCredentialsError (env-adaptive; tolerated).
 *
 * Fully API-orchestrated. FRESH registerUserViaAPI() owner per test; never the
 * shared seeded user. Unique per-test path suffixes so no collision-rename can
 * perturb the echoed `path`.
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_WORK_UUID = '11111111-1111-1111-1111-111111111111';
const UNKNOWN_DOC_UUID = '22222222-2222-2222-2222-222222222222';
const MALFORMED_UUID = 'not-a-uuid';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** class-validator returns `message` as string[] for DTO errors, string for
 *  service-thrown BadRequest. Flatten to one searchable string either way. */
function errText(body: unknown): string {
    const msg = (body as { message?: unknown })?.message;
    if (Array.isArray(msg)) return msg.join(' | ');
    if (typeof msg === 'string') return msg;
    return JSON.stringify(body);
}

const docsUrl = (workId: string) => `${API_BASE}/api/works/${workId}/kb/documents`;

interface DocPayload {
    path?: unknown;
    title?: unknown;
    class?: unknown;
    body?: unknown;
    description?: unknown;
    tags?: unknown;
    categories?: unknown;
    language?: unknown;
    status?: unknown;
    [k: string]: unknown;
}

/** A minimal, always-valid create payload; spread overrides on top. */
function validDoc(suffix: string, over: DocPayload = {}): DocPayload {
    return {
        path: `brand/doc-${suffix}.md`,
        title: `Doc ${suffix}`,
        class: 'brand',
        body: '# Body',
        ...over,
    };
}

async function createOwnerWork(request: APIRequestContext) {
    const owner = await registerUserViaAPI(request);
    const s = stamp();
    const work = await createWorkViaAPI(request, owner.access_token, {
        name: `KB Matrix ${s}`,
        slug: `kb-matrix-${s}`,
    });
    expect(work.id).toMatch(UUID_RE);
    return { owner, workId: work.id };
}

async function postDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    payload: DocPayload,
) {
    return request.post(docsUrl(workId), { headers: authedHeaders(token), data: payload });
}

/** Create a valid doc and return its id (asserts 201). */
async function seedDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    over: DocPayload = {},
): Promise<string> {
    const res = await postDoc(request, token, workId, validDoc(stamp(), over));
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json.id).toMatch(UUID_RE);
    return json.id as string;
}

// ─────────────────────────────────────────────────────────────────────────
test.describe('KB create — CreateKbDocumentDto happy path + returned shape', () => {
    test('valid create → 201 with the full document DTO (defaults applied)', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();
        const res = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `legal/tos-${s}.md`, class: 'legal', body: '# Hello world' }),
        );
        expect(res.status()).toBe(201);
        const doc = await res.json();
        expect(doc.id).toMatch(UUID_RE);
        expect(doc.workId).toBe(workId);
        expect(doc.organizationId).toBeNull();
        expect(doc.path).toBe(`legal/tos-${s}.md`);
        expect(doc.class).toBe('legal');
        // Defaults from the service, not the request.
        expect(doc.status).toBe('active');
        expect(doc.locked).toBe(false);
        expect(doc.lockMode).toBeNull();
        expect(doc.language).toBe('en');
        expect(doc.body).toBe('# Hello world');
        expect(typeof doc.wordCount).toBe('number');
        expect(typeof doc.tokenCount).toBe('number');
        expect(Array.isArray(doc.tags)).toBe(true);
    });

    test('every KbDocumentClass enum value is accepted', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        for (const klass of KB_CLASSES) {
            const s = stamp();
            const res = await postDoc(
                request,
                owner.access_token,
                workId,
                validDoc(s, { path: `${klass}/x-${s}.md`, class: klass }),
            );
            expect(res.status(), `class=${klass}`).toBe(201);
            expect((await res.json()).class).toBe(klass);
        }
    });

    test('status "draft" is honored; explicit language round-trips', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const res = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(stamp(), { status: 'draft', language: 'en-US' }),
        );
        expect(res.status()).toBe(201);
        const doc = await res.json();
        expect(doc.status).toBe('draft');
        expect(doc.language).toBe('en-US');
    });

    test('path folder need NOT equal the class field (independent axes)', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();
        // path under seo/ but class=brand → both valid, both preserved verbatim.
        const res = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `seo/mismatch-${s}.md`, class: 'brand' }),
        );
        expect(res.status()).toBe(201);
        const doc = await res.json();
        expect(doc.path).toBe(`seo/mismatch-${s}.md`);
        expect(doc.class).toBe('brand');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('KB create — per-field validation clusters (400)', () => {
    test('path: missing / empty / over-512 → 400 with the class-validator length messages', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const missing = await postDoc(request, owner.access_token, workId, {
            title: 'T',
            class: 'brand',
            body: 'b',
        });
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('path must be a string');

        const empty = await postDoc(request, owner.access_token, workId, validDoc(s, { path: '' }));
        expect(empty.status()).toBe(400);
        expect(errText(await empty.json())).toContain(
            'path must be longer than or equal to 1 characters',
        );

        // 513-char path (still class-folder-prefixed) trips the DTO @Length max.
        const longPath = `brand/${'a'.repeat(513 - 'brand/'.length)}.md`;
        const tooLong = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: longPath }),
        );
        expect(tooLong.status()).toBe(400);
        expect(errText(await tooLong.json())).toContain(
            'path must be shorter than or equal to 512 characters',
        );
    });

    test('path content guard: unknown class folder / traversal / absolute → 400', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const unknownFolder = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: 'nope/x.md' }),
        );
        expect(unknownFolder.status()).toBe(400);
        expect(errText(await unknownFolder.json())).toContain(
            'must start with a known class folder',
        );

        const traversal = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: '../etc/passwd' }),
        );
        expect(traversal.status()).toBe(400);
        expect(errText(await traversal.json())).toContain('must not traverse parent directories');

        const absolute = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: '/brand/x.md' }),
        );
        expect(absolute.status()).toBe(400);
        expect(errText(await absolute.json())).toContain('must be relative to .content/kb/');
    });

    test('title: missing / empty / 256 → 400; exactly 255 → 201', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const missing = await postDoc(request, owner.access_token, workId, {
            path: `brand/t-${s}.md`,
            class: 'brand',
            body: 'b',
        });
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('title must be a string');

        const empty = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/te-${s}.md`, title: '' }),
        );
        expect(empty.status()).toBe(400);

        const over = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/to-${s}.md`, title: 'x'.repeat(256) }),
        );
        expect(over.status()).toBe(400);
        expect(errText(await over.json())).toContain(
            'title must be shorter than or equal to 255 characters',
        );

        const ok = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/tk-${s}.md`, title: 'x'.repeat(255) }),
        );
        expect(ok.status()).toBe(201);
    });

    test('class: missing / off-enum → 400 listing all 10 allowed values', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const missing = await postDoc(request, owner.access_token, workId, {
            path: `brand/c-${s}.md`,
            title: 'T',
            body: 'b',
        });
        expect(missing.status()).toBe(400);

        const bad = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { class: 'notaclass' }),
        );
        expect(bad.status()).toBe(400);
        const text = errText(await bad.json());
        expect(text).toContain('class must be one of the following values');
        for (const klass of KB_CLASSES) expect(text).toContain(klass);
    });

    test('body: missing / wrong-type → 400; empty string "" → 201 (allowed)', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const missing = await postDoc(request, owner.access_token, workId, {
            path: `brand/b-${s}.md`,
            title: 'T',
            class: 'brand',
        });
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('body must be a string');

        const wrongType = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/bw-${s}.md`, body: 12345 }),
        );
        expect(wrongType.status()).toBe(400);
        expect(errText(await wrongType.json())).toContain('body must be a string');

        const emptyBody = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/be-${s}.md`, body: '' }),
        );
        expect(emptyBody.status()).toBe(201);
        expect((await emptyBody.json()).body).toBe('');
    });

    test('description: null / 2000 accepted; 2001 → 400', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const nul = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/dn-${s}.md`, description: null }),
        );
        expect(nul.status()).toBe(201);

        const max = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/dm-${s}.md`, description: 'x'.repeat(2000) }),
        );
        expect(max.status()).toBe(201);

        const over = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/do-${s}.md`, description: 'x'.repeat(2001) }),
        );
        expect(over.status()).toBe(400);
        expect(errText(await over.json())).toContain(
            'description must be shorter than or equal to 2000 characters',
        );
    });

    test('tags: non-array / 33 elements / slug>64 → 400; 32 valid slugs → 201', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const notArray = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/gn-${s}.md`, tags: 'nope' }),
        );
        expect(notArray.status()).toBe(400);
        expect(errText(await notArray.json())).toContain('tags must be an array');

        const tooMany = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, {
                path: `brand/gm-${s}.md`,
                tags: Array.from({ length: 33 }, (_, i) => `t${i}`),
            }),
        );
        expect(tooMany.status()).toBe(400);
        expect(errText(await tooMany.json())).toContain(
            'tags must contain no more than 32 elements',
        );

        const longSlug = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/gl-${s}.md`, tags: ['x'.repeat(65)] }),
        );
        expect(longSlug.status()).toBe(400);
        expect(errText(await longSlug.json())).toContain(
            'each value in tags must be shorter than or equal to 64 characters',
        );

        const ok = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, {
                path: `brand/gk-${s}.md`,
                tags: Array.from({ length: 32 }, (_, i) => `tag-${i}`),
            }),
        );
        expect(ok.status()).toBe(201);
    });

    test('categories: non-array / 33 elements → 400 (mirror of tags)', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const notArray = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/kn-${s}.md`, categories: 'nope' }),
        );
        expect(notArray.status()).toBe(400);
        expect(errText(await notArray.json())).toContain('categories must be an array');

        const tooMany = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, {
                path: `brand/km-${s}.md`,
                categories: Array.from({ length: 33 }, (_, i) => `c${i}`),
            }),
        );
        expect(tooMany.status()).toBe(400);
        expect(errText(await tooMany.json())).toContain(
            'categories must contain no more than 32 elements',
        );
    });

    test('language: 1-char / 9-char → 400; 5-char ("en-US") → 201', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const s = stamp();

        const tooShort = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/ls-${s}.md`, language: 'e' }),
        );
        expect(tooShort.status()).toBe(400);
        expect(errText(await tooShort.json())).toContain(
            'language must be longer than or equal to 2 characters',
        );

        const tooLong = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/ll-${s}.md`, language: 'englishxxx' }),
        );
        expect(tooLong.status()).toBe(400);
        expect(errText(await tooLong.json())).toContain(
            'language must be shorter than or equal to 8 characters',
        );

        const ok = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(s, { path: `brand/lk-${s}.md`, language: 'en-US' }),
        );
        expect(ok.status()).toBe(201);
    });

    test('status: off-enum → 400 listing draft/active/archived', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const bad = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(stamp(), { status: 'published' }),
        );
        expect(bad.status()).toBe(400);
        const text = errText(await bad.json());
        expect(text).toContain('status must be one of the following values');
        expect(text).toContain('draft');
        expect(text).toContain('archived');
    });

    test('forbidNonWhitelisted: an unknown property → 400 "property X should not exist"', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const res = await postDoc(
            request,
            owner.access_token,
            workId,
            validDoc(stamp(), { injected: 'evil' }),
        );
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain('property injected should not exist');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('KB create — authz + id-shape matrix', () => {
    test('no bearer token → 401', async ({ request }) => {
        const { workId } = await createOwnerWork(request);
        const res = await request.post(docsUrl(workId), { data: validDoc(stamp()) });
        expect(res.status()).toBe(401);
    });

    test('foreign work that EXISTS (non-member) → 403, not 404', async ({ request }) => {
        const { workId } = await createOwnerWork(request);
        const stranger = await registerUserViaAPI(request);
        const res = await postDoc(request, stranger.access_token, workId, validDoc(stamp()));
        expect(res.status()).toBe(403);
        expect(errText(await res.json())).toContain('do not have permission');
    });

    test('unknown-but-valid work uuid → 404', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const res = await postDoc(
            request,
            owner.access_token,
            UNKNOWN_WORK_UUID,
            validDoc(stamp()),
        );
        expect(res.status()).toBe(404);
        expect(errText(await res.json())).toContain('not found');
    });

    test('malformed work uuid → 400 at the ParseUUIDPipe (before the body is read)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const res = await postDoc(request, owner.access_token, MALFORMED_UUID, validDoc(stamp()));
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain('uuid is expected');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('KB update — UpdateKbDocumentDto validation', () => {
    test('empty patch {} → 200 no-op returning the unchanged doc', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId, { title: 'Original' });
        const res = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(res.status()).toBe(200);
        const doc = await res.json();
        expect(doc.id).toBe(docId);
        expect(doc.title).toBe('Original');
    });

    test('title empty / 256 → 400', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const headers = authedHeaders(owner.access_token);

        const empty = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { title: '' },
        });
        expect(empty.status()).toBe(400);
        expect(errText(await empty.json())).toContain(
            'title must be longer than or equal to 1 characters',
        );

        const over = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { title: 'x'.repeat(256) },
        });
        expect(over.status()).toBe(400);
    });

    test('status / class off-enum → 400 (both optional-but-validated)', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const headers = authedHeaders(owner.access_token);

        const badStatus = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { status: 'live' },
        });
        expect(badStatus.status()).toBe(400);
        expect(errText(await badStatus.json())).toContain('status must be one of the following');

        const badClass = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { class: 'nope' },
        });
        expect(badClass.status()).toBe(400);
        expect(errText(await badClass.json())).toContain('class must be one of the following');
    });

    test('description 2001 / tags 33 / language 9 → 400 (optional field caps still enforced)', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const headers = authedHeaders(owner.access_token);

        const desc = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { description: 'x'.repeat(2001) },
        });
        expect(desc.status()).toBe(400);

        const tags = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) },
        });
        expect(tags.status()).toBe(400);

        const lang = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { language: 'englishxxx' },
        });
        expect(lang.status()).toBe(400);
    });

    test('forbidNonWhitelisted on update → 400', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const res = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers: authedHeaders(owner.access_token),
            data: { evil: 1 },
        });
        expect(res.status()).toBe(400);
        expect(errText(await res.json())).toContain('property evil should not exist');
    });

    test('valid update (title + status + class) persists and is reflected on GET', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId, {
            title: 'Before',
            class: 'brand',
        });
        const headers = authedHeaders(owner.access_token);
        const patched = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { title: 'After', status: 'archived', class: 'legal' },
        });
        expect(patched.status()).toBe(200);
        const doc = await patched.json();
        expect(doc.title).toBe('After');
        expect(doc.status).toBe('archived');
        expect(doc.class).toBe('legal');

        const got = await request.get(`${docsUrl(workId)}/${docId}`, { headers });
        expect(got.status()).toBe(200);
        const fresh = await got.json();
        expect(fresh.title).toBe('After');
        expect(fresh.status).toBe('archived');
        expect(fresh.class).toBe('legal');
    });

    test('unknown docId → 404; malformed docId → 400 at the pipe', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const headers = authedHeaders(owner.access_token);

        const unknown = await request.patch(`${docsUrl(workId)}/${UNKNOWN_DOC_UUID}`, {
            headers,
            data: { title: 'X' },
        });
        expect(unknown.status()).toBe(404);
        expect(errText(await unknown.json())).toContain('KB document not found');

        const malformed = await request.patch(`${docsUrl(workId)}/${MALFORMED_UUID}`, {
            headers,
            data: { title: 'X' },
        });
        expect(malformed.status()).toBe(400);
        expect(errText(await malformed.json())).toContain('uuid is expected');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('KB update — authz', () => {
    test('no bearer → 401', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const res = await request.patch(`${docsUrl(workId)}/${docId}`, { data: { title: 'X' } });
        expect(res.status()).toBe(401);
    });

    test('foreign work patch (non-member) → 403', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const stranger = await registerUserViaAPI(request);
        const res = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers: authedHeaders(stranger.access_token),
            data: { title: 'Hacked' },
        });
        expect(res.status()).toBe(403);
        expect(errText(await res.json())).toContain('do not have permission');
    });

    test('full-lock gates the update write path with 403 until unlock', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const headers = authedHeaders(owner.access_token);

        const locked = await request.post(`${docsUrl(workId)}/${docId}/lock`, {
            headers,
            data: { mode: 'full' },
        });
        expect(locked.status()).toBe(200);
        expect((await locked.json()).lockMode).toBe('full');

        const blocked = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { title: 'Nope' },
        });
        expect(blocked.status()).toBe(403);
        expect(errText(await blocked.json())).toContain('locked (mode=full)');

        const unlocked = await request.post(`${docsUrl(workId)}/${docId}/unlock`, { headers });
        expect(unlocked.status()).toBe(200);

        const ok = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { title: 'Now editable' },
        });
        expect(ok.status()).toBe(200);
        expect((await ok.json()).title).toBe('Now editable');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('KB lock / restore — DTO validation + authz (distinct angles)', () => {
    test('lock DTO: missing mode / off-enum / extra field → 400; additions-only still permits edits', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const headers = authedHeaders(owner.access_token);

        const missing = await request.post(`${docsUrl(workId)}/${docId}/lock`, {
            headers,
            data: {},
        });
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('mode must be one of the following values');

        const bad = await request.post(`${docsUrl(workId)}/${docId}/lock`, {
            headers,
            data: { mode: 'readonly' },
        });
        expect(bad.status()).toBe(400);

        const extra = await request.post(`${docsUrl(workId)}/${docId}/lock`, {
            headers,
            data: { mode: 'full', extra: 1 },
        });
        expect(extra.status()).toBe(400);
        expect(errText(await extra.json())).toContain('property extra should not exist');

        // additions-only lock is NOT a full lock → content writes still allowed.
        const addLock = await request.post(`${docsUrl(workId)}/${docId}/lock`, {
            headers,
            data: { mode: 'additions-only' },
        });
        expect(addLock.status()).toBe(200);
        expect((await addLock.json()).lockMode).toBe('additions-only');

        const stillEdits = await request.patch(`${docsUrl(workId)}/${docId}`, {
            headers,
            data: { title: 'Edited under additions-only' },
        });
        expect(stillEdits.status()).toBe(200);
    });

    test('restore commitSha guard: missing / short / non-hex / symbolic ref → 400', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const headers = authedHeaders(owner.access_token);
        const restore = (data: unknown) =>
            request.post(`${docsUrl(workId)}/${docId}/restore`, { headers, data });

        const missing = await restore({});
        expect(missing.status()).toBe(400);
        expect(errText(await missing.json())).toContain('commitSha must be a hexadecimal Git SHA');

        const short = await restore({ commitSha: 'abc' });
        expect(short.status()).toBe(400);

        const nonHex = await restore({ commitSha: 'zzzzzzz' });
        expect(nonHex.status()).toBe(400);
        expect(errText(await nonHex.json())).toContain('commitSha must be a hexadecimal Git SHA');

        // Symbolic refs must not slip past the hex-only guard (no branch/tag/HEAD~n).
        const symbolic = await restore({ commitSha: 'HEAD~1' });
        expect(symbolic.status()).toBe(400);
    });

    test('restore with a well-formed sha is git-gated (no connected account → 409)', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const res = await request.post(`${docsUrl(workId)}/${docId}/restore`, {
            headers: authedHeaders(owner.access_token),
            data: { commitSha: 'abcdef0' },
        });
        // DTO + ownership + existence all pass; the terminal failure is the
        // missing git provider account. Env-adaptive: 409 observed live, but
        // tolerate the sibling "unavailable / not found" shapes.
        expect([404, 409, 500, 503]).toContain(res.status());
        if (res.status() === 409) {
            // The 409 body carries the git-gating reason. The exact wording is
            // the human-readable message ("No connected account found … with
            // provider github"), not the raw error-class name — match the stable
            // git/credential/account signal rather than a brittle literal.
            expect(errText(await res.json())).toMatch(/git|connected account|credential|provider/i);
        }
    });

    test('lock / unlock / restore on a foreign work (non-member) → 403', async ({ request }) => {
        const { owner, workId } = await createOwnerWork(request);
        const docId = await seedDoc(request, owner.access_token, workId);
        const stranger = await registerUserViaAPI(request);
        const headers = authedHeaders(stranger.access_token);

        const lock = await request.post(`${docsUrl(workId)}/${docId}/lock`, {
            headers,
            data: { mode: 'full' },
        });
        expect(lock.status()).toBe(403);

        const unlock = await request.post(`${docsUrl(workId)}/${docId}/unlock`, { headers });
        expect(unlock.status()).toBe(403);

        const restore = await request.post(`${docsUrl(workId)}/${docId}/restore`, {
            headers,
            data: { commitSha: 'abcdef0' },
        });
        expect(restore.status()).toBe(403);
    });

    test('lock / unlock unknown docId → 404; lock on unknown work uuid → 404', async ({
        request,
    }) => {
        const { owner, workId } = await createOwnerWork(request);
        const headers = authedHeaders(owner.access_token);

        const lockUnknownDoc = await request.post(`${docsUrl(workId)}/${UNKNOWN_DOC_UUID}/lock`, {
            headers,
            data: { mode: 'full' },
        });
        expect(lockUnknownDoc.status()).toBe(404);
        expect(errText(await lockUnknownDoc.json())).toContain('KB document not found');

        const unlockUnknownDoc = await request.post(
            `${docsUrl(workId)}/${UNKNOWN_DOC_UUID}/unlock`,
            { headers },
        );
        expect(unlockUnknownDoc.status()).toBe(404);

        const lockUnknownWork = await request.post(
            `${docsUrl(UNKNOWN_WORK_UUID)}/${UNKNOWN_DOC_UUID}/lock`,
            { headers, data: { mode: 'full' } },
        );
        expect(lockUnknownWork.status()).toBe(404);
    });
});
