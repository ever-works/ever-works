import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: UPLOADS VALIDATION + AUTHZ MATRIX — pins the corners of the
 * UploadsController that the two existing deep uploads specs deliberately
 * leave uncovered:
 *
 *   1. The ENTIRE `POST /api/uploads/presign` DTO validation matrix
 *      (PresignUploadDto: filename / mimeType / size / correlationId) — a
 *      surface NEITHER sibling spec touches. On the live local-fs backend a
 *      VALID body reaches the handler and returns 501 PresignNotSupported;
 *      an INVALID body is rejected by the global ValidationPipe with a 400
 *      BEFORE the backend check, so this file pins one assertion cluster per
 *      class-validator decorator (@IsString / @MaxLength / @IsMimeType /
 *      @IsInt / @Min / @Max / @IsOptional) plus forbidNonWhitelisted and the
 *      no-@IsNotEmpty edge (an empty-string filename is VALID → 501).
 *   2. The EW-644 workId gate REJECT variants that sec-pin-uploads-auth does
 *      NOT cover: a MALFORMED (non-uuid) workId on both POST routes, and the
 *      workId gate on the SERVE route (GET) — sec-pin only exercised workId
 *      on POST, and only with foreign/unknown *valid* uuids.
 *   3. Serve-route filename + ownership EDGES distinct from both siblings:
 *      the `auth.userId !== :userId` short-circuit fired with NO stored file
 *      (pure path-segment mismatch → 404 "Not found"), a canonical-shape
 *      filename with an out-of-allow-list extension (<hex64>.exe → 400
 *      InvalidFilename), and a too-short hash (63 chars → 400 InvalidFilename).
 *   4. The ANONYMOUS upload routes' VALIDATION (rejects, not the happy mint
 *      sec-pin already owns): image-only allow-list, magic-byte mismatch,
 *      empty/missing file on `/anonymous`, the broader allow-list + reject on
 *      `/anonymous/file`, and per-mint owner ISOLATION (two credential-less
 *      uploads mint two DISTINCT anon owners; one's token can't read the
 *      other's file).
 *
 * GROUNDING — every status/body/message below was probed against the LIVE
 * stack (API :3100 sqlite in-memory, all flags ON,
 * REQUIRE_EMAIL_VERIFICATION=false, keyless, STORAGE_BACKEND=local-fs) with
 * curl + throwaway users on 2026-07-21, then cross-checked against source:
 *   - apps/api/src/uploads/uploads.controller.ts
 *       POST /presign            @Public, @Body(PresignUploadDto); backend has
 *                                no presignPut on local-fs → 501 for VALID body
 *       POST /?workId= , /file?workId=   assertWorkAccess → 404 "Work not found"
 *       GET  :userId/:filename   auth.userId!==userId → 404 "Not found";
 *                                workId present → assertWorkAccess (before read)
 *       POST /anonymous , /anonymous/file   @Public anon-mint; saveImage/saveFile
 *   - apps/api/src/uploads/dto/presign-upload.dto.ts
 *       filename  @IsString @MaxLength(256)          (NO @IsNotEmpty)
 *       mimeType  @IsString @IsMimeType
 *       size      @IsInt @Min(1) @Max(2*1024*1024*1024 = 2147483648)
 *       correlationId  @IsOptional @IsString @MaxLength(128)
 *   - apps/api/src/uploads/uploads.service.ts
 *       assertValidFilename → <hex64>.<ext-in-union> else 400 InvalidFilename;
 *       saveImage ALLOWED_MIME (image-only); saveFile broad allow-list.
 *
 * PROBED CONTRACTS (live, 2026-07-21):
 *   POST /api/uploads/presign  VALID body (authed) → 501
 *       { status:'error', code:'PresignNotSupported', message:'Active storage
 *         backend does not support presigned uploads — use POST /api/uploads
 *         with multipart form data instead.' }
 *   POST /api/uploads/presign  VALID body, NO auth → 501 (route is @Public;
 *       the 501 fires before the anon-mint, so no anonAccessToken)
 *   POST /api/uploads/presign  filename:"" (empty) + valid rest → 501
 *       (no @IsNotEmpty: an empty string passes @IsString + @MaxLength(256))
 *   presign field rejects (400 { error:'Bad Request', statusCode:400,
 *       message:[ … ] }, one+ messages per broken decorator):
 *       filename missing/number → "filename must be a string"
 *       filename len>256        → "filename must be shorter than or equal to 256 characters"
 *       mimeType "notamime"     → "mimeType must be MIME type format"
 *       mimeType missing        → "mimeType must be a string" / "…MIME type format"
 *       size 0 / -5             → "size must not be less than 1"
 *       size 12.5               → "size must be an integer number"
 *       size 2147483649         → "size must not be greater than 2147483648"
 *       size 2147483648 (==Max) → 501 (Max is inclusive)
 *       correlationId len>128   → "correlationId must be shorter than or equal to 128 characters"
 *       { evil:'x', … }         → "property evil should not exist" (forbidNonWhitelisted)
 *       {}                      → 400 with filename+mimeType+size messages
 *   POST /api/uploads?workId=not-a-uuid           → 404 { status:'error', message:'Work not found' }
 *   POST /api/uploads/file?workId=not-a-uuid      → 404 { status:'error', message:'Work not found' }
 *   GET  /api/uploads/<me>/<any-valid-name>?workId=<foreign-uuid>  → 404 "Work not found"
 *   GET  /api/uploads/<me>/<any-valid-name>?workId=xyz (malformed) → 404 "Work not found"
 *   GET  /api/uploads/<other-uuid>/<hex64>.png (as me, no file)    → 404 { status:'error', message:'Not found' }
 *   GET  /api/uploads/<me>/<hex64>.exe                             → 400 { code:'InvalidFilename' }
 *   GET  /api/uploads/<me>/<hex63>.png                             → 400 { code:'InvalidFilename' }
 *   POST /api/uploads/anonymous  (image-only saveImage path):
 *       missing 'file'      → 400 { message:"Multipart field 'file' is required" } (no code)
 *       0-byte file         → 400 { code:'EmptyFile', message:'No file content received' }
 *       image/svg+xml       → 400 { code:'MimeNotAllowed', "…not in the allow-list" }
 *       application/pdf     → 400 { code:'MimeNotAllowed', "…not in the allow-list" }
 *       text bytes as png   → 400 { code:'MimeMismatch' }
 *   POST /api/uploads/anonymous/file  (broad saveFile path):
 *       application/x-msdownload → 400 { code:'MimeNotAllowed', "…not accepted for file uploads" }
 *       text/markdown            → 201 { uploadId:'<anonUid>/<sha>.md', id:<sha>, url, filename,
 *                                        size, mimeType:'text/markdown', hash, expiresAt:<ISO ~3d>,
 *                                        anonAccessToken } (NO `key` field)
 *       two credential-less md uploads → two DISTINCT anon owners + tokens; token A reads
 *                                        file A (200) but NOT file B (404) — per-mint isolation
 *
 * NON-DUPLICATION:
 *   - flow-uploads-matrix-deep.spec.ts owns the AUTHED storage / sha256
 *     content-addressing / MIME-matrix / size-cap / serve-collapse contracts,
 *     the empty-file/missing-multipart/never-stored-key/malformed-filename
 *     envelopes on the AUTHED routes. This file adds the PRESIGN DTO matrix,
 *     the workId REJECT matrix (incl. serve+workId, unseen there), and the
 *     ANONYMOUS-route validation — none of which it touches.
 *   - sec-pin-uploads-auth.spec.ts owns the anon-401 matrix on the authed
 *     routes, the owner-200 serve round-trip + cross-user REAL-file 404 +
 *     anon-serve 401, the workId gate happy(201)+foreign(404) on POST, and the
 *     /anonymous (image) anon-mint happy path. This file does NOT re-pin any of
 *     those: its workId cases are the MALFORMED variant + the SERVE route; its
 *     serve cases need NO stored file (segment/filename shape only); its anon
 *     cases are VALIDATION rejects + /anonymous/file (broad) + per-mint
 *     isolation (anon-vs-anon, not anon-vs-registered).
 *   - flow-uploads-attachments-lifecycle-multistep.spec.ts CONSUMES uploads to
 *     drive agent/task attachment edges; it never probes presign, workId, or
 *     the anonymous routes.
 *
 * ADAPTIVITY / THROTTLE: pure authz/validation contracts — no LLM key, no
 * mail, no Redis, no search provider, no Trigger.dev. `POST /api/uploads/presign`
 * is @Throttle 20/60s and `/anonymous(/file)` are @Throttle 10/60s, both keyed
 * by IP and therefore SHARED across the whole suite; a saturated bucket returns
 * 429. Every throttle-sensitive assertion tolerates 429 (asserting the exact
 * envelope only when the request was actually served), so a busy shard degrades
 * gracefully instead of flaking. Genuinely-anonymous calls go through a FRESH
 * empty-storageState request context (house rule: the project fixture inherits
 * the seeded auth cookie for localhost).
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

// PresignUploadDto @Max — 2 GiB, inclusive.
const PRESIGN_MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2147483648

// 1x1 transparent PNG — minimum valid image bytes (shared with sibling specs).
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64',
);

// Per-test counter for unique-but-clock-free suffixes (house rule: never call a
// clock at module scope; the increment runs inside each test body).
let seq = 0;
function nextSuffix(): string {
    seq += 1;
    return `uva${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Fresh request context with NO cookies — genuinely anonymous. */
async function anonContext(): Promise<APIRequestContext> {
    return pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

type Json = Record<string, unknown>;

/** POST a presign body; return status + parsed json. */
async function presign(
    request: APIRequestContext,
    token: string | null,
    body: unknown,
): Promise<{ status: number; body: Json }> {
    const res = await request.post(`${API_BASE}/api/uploads/presign`, {
        headers: token ? authedHeaders(token) : undefined,
        data: body,
    });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as Json };
}

/** Pull the class-validator message array out of a 400 body. */
function messagesOf(body: Json): string[] {
    return Array.isArray(body.message) ? (body.message as string[]) : [];
}

test.describe('FLOW: uploads validation — POST /api/uploads/presign DTO matrix', () => {
    test('a VALID body reaches the handler and returns 501 PresignNotSupported on the local-fs backend', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: `${nextSuffix()}.png`,
            mimeType: 'image/png',
            size: 1234,
        });
        // Throttle-tolerant: assert the served contract, tolerate a 429 bucket.
        expect([501, 429]).toContain(status);
        if (status === 501) {
            expect(body.code).toBe('PresignNotSupported');
            expect(body.status).toBe('error');
            expect(String(body.message)).toContain('does not support presigned uploads');
        }
    });

    test('presign is @Public: a VALID body with NO auth also reaches 501 (not 401) — the 501 precedes any anon-mint', async () => {
        const anon = await anonContext();
        try {
            const { status, body } = await presign(anon, null, {
                filename: `${nextSuffix()}.png`,
                mimeType: 'image/png',
                size: 42,
            });
            expect([501, 429]).toContain(status);
            if (status === 501) {
                expect(body.code).toBe('PresignNotSupported');
                // No anon user is minted on the 501 path, so no token leaks.
                expect(body.anonAccessToken).toBeUndefined();
            }
        } finally {
            await anon.dispose();
        }
    });

    test('filename is @IsString: omitting it → 400 "filename must be a string"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            mimeType: 'image/png',
            size: 10,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(body.error).toBe('Bad Request');
            expect(messagesOf(body).some((m) => m.includes('filename must be a string'))).toBe(
                true,
            );
        }
    });

    test('filename wrong type (number) → 400 "filename must be a string"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 12345,
            mimeType: 'image/png',
            size: 10,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(messagesOf(body).some((m) => m.includes('filename must be a string'))).toBe(
                true,
            );
        }
    });

    test('filename has NO @IsNotEmpty: an EMPTY string passes validation → 501 (reaches the backend check)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // "" is a string of length 0 ≤ 256, so @IsString + @MaxLength both pass;
        // the DTO never enforces non-empty, so the request is VALID and the
        // handler's 501 fires — a deliberate edge distinct from the 400s above.
        const { status, body } = await presign(request, user.access_token, {
            filename: '',
            mimeType: 'image/png',
            size: 10,
        });
        expect([501, 429]).toContain(status);
        if (status === 501) {
            expect(body.code).toBe('PresignNotSupported');
        }
    });

    test('filename @MaxLength(256): a 300-char name → 400 "…shorter than or equal to 256 characters"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a'.repeat(300),
            mimeType: 'image/png',
            size: 10,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(
                messagesOf(body).some((m) =>
                    m.includes('filename must be shorter than or equal to 256 characters'),
                ),
            ).toBe(true);
        }
    });

    test('mimeType @IsMimeType: a non-MIME string → 400 "mimeType must be MIME type format"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'notamime',
            size: 10,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(
                messagesOf(body).some((m) => m.includes('mimeType must be MIME type format')),
            ).toBe(true);
        }
    });

    test('mimeType is required: omitting it → 400 with the string / MIME-format messages', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a.png',
            size: 10,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            const msgs = messagesOf(body);
            expect(
                msgs.some((m) => m.includes('mimeType must be a string')) ||
                    msgs.some((m) => m.includes('mimeType must be MIME type format')),
            ).toBe(true);
        }
    });

    test('size @Min(1): size 0 → 400 "size must not be less than 1"', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'image/png',
            size: 0,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(messagesOf(body).some((m) => m.includes('size must not be less than 1'))).toBe(
                true,
            );
        }
    });

    test('size @IsInt: a float (12.5) → 400 "size must be an integer number"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'image/png',
            size: 12.5,
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(messagesOf(body).some((m) => m.includes('size must be an integer number'))).toBe(
                true,
            );
        }
    });

    test('size @Max is 2 GiB inclusive: 2147483648 → 501, but 2147483649 → 400 "…not be greater than 2147483648"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Exactly at the cap: @Max is inclusive, so the body is VALID → 501.
        const atCap = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'image/png',
            size: PRESIGN_MAX_SIZE,
        });
        expect([501, 429]).toContain(atCap.status);
        if (atCap.status === 501) {
            expect(atCap.body.code).toBe('PresignNotSupported');
        }

        // One over the cap → 400.
        const overCap = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'image/png',
            size: PRESIGN_MAX_SIZE + 1,
        });
        expect([400, 429]).toContain(overCap.status);
        if (overCap.status === 400) {
            expect(
                messagesOf(overCap.body).some((m) =>
                    m.includes('size must not be greater than 2147483648'),
                ),
            ).toBe(true);
        }
    });

    test('correlationId @IsOptional @MaxLength(128): a 200-char value → 400 "…shorter than or equal to 128 characters"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'image/png',
            size: 10,
            correlationId: 'c'.repeat(200),
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(
                messagesOf(body).some((m) =>
                    m.includes('correlationId must be shorter than or equal to 128 characters'),
                ),
            ).toBe(true);
        }
    });

    test('forbidNonWhitelisted: an unknown extra field → 400 "property <field> should not exist"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {
            filename: 'a.png',
            mimeType: 'image/png',
            size: 10,
            evil: 'x',
        });
        expect([400, 429]).toContain(status);
        if (status === 400) {
            expect(messagesOf(body).some((m) => m.includes('property evil should not exist'))).toBe(
                true,
            );
        }
    });

    test('an empty body {} → 400 aggregating the filename, mimeType and size messages', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await presign(request, user.access_token, {});
        expect([400, 429]).toContain(status);
        if (status === 400) {
            const msgs = messagesOf(body);
            expect(msgs.some((m) => m.includes('filename'))).toBe(true);
            expect(msgs.some((m) => m.includes('mimeType'))).toBe(true);
            expect(msgs.some((m) => m.includes('size'))).toBe(true);
        }
    });
});

test.describe('FLOW: uploads authz — EW-644 workId gate rejects (POST + serve)', () => {
    test('a MALFORMED (non-uuid) workId on POST /api/uploads → 404 "Work not found" (anti-enumeration, never 400)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/uploads?workId=not-a-uuid`, {
            headers: authedHeaders(user.access_token),
            multipart: { file: { name: 'm.png', mimeType: 'image/png', buffer: TINY_PNG } },
        });
        // assertWorkAccess resolves the workId via WorkRepository.findById first;
        // a non-matching (malformed) id yields no row → NotFound, collapsed to the
        // same 404 a foreign/unknown workId gets so ownership can't be probed.
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ status: 'error', message: 'Work not found' });
    });

    test('a MALFORMED workId on POST /api/uploads/file → 404 "Work not found" (same gate, broader route)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/uploads/file?workId=not-a-uuid`, {
            headers: authedHeaders(user.access_token),
            multipart: {
                file: {
                    name: 'm.md',
                    mimeType: 'text/markdown',
                    buffer: Buffer.from(`# ${nextSuffix()}\n`, 'utf8'),
                },
            },
        });
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ status: 'error', message: 'Work not found' });
    });

    test('the workId gate also guards the SERVE route: own path + a FOREIGN (valid-uuid) workId → 404 "Work not found" (before any file read)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // assertWorkAccess runs before backend.getObject, so no stored file is
        // needed — any canonical-shape filename plus a workId the caller doesn't
        // own short-circuits to 404 "Work not found".
        const filename = `${'a'.repeat(64)}.png`;
        const res = await request.get(
            `${API_BASE}/api/uploads/${user.user.id}/${filename}?workId=00000000-0000-0000-0000-000000000000`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ status: 'error', message: 'Work not found' });
    });

    test('serve route + a MALFORMED workId on the own path → 404 "Work not found"', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const filename = `${'b'.repeat(64)}.png`;
        const res = await request.get(
            `${API_BASE}/api/uploads/${user.user.id}/${filename}?workId=xyz`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ status: 'error', message: 'Work not found' });
    });
});

test.describe('FLOW: uploads authz — serve-route filename + ownership edges', () => {
    test('a userId path-segment that is not the caller → 404 "Not found" via the auth.userId!==userId short-circuit (no stored file involved)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // The controller compares auth.userId to the :userId segment BEFORE
        // touching storage, so a made-up owner segment 404s immediately — and it
        // 404s (not 403) to avoid leaking that "a file exists but isn't yours".
        const otherUserId = '22222222-2222-4222-8222-222222222222';
        const filename = `${'a'.repeat(64)}.png`;
        const res = await request.get(`${API_BASE}/api/uploads/${otherUserId}/${filename}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ status: 'error', message: 'Not found' });
    });

    test('a canonical <hex64> name with an OUT-OF-ALLOW-LIST extension (.exe) → 400 InvalidFilename', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // assertValidFilename requires <hex64>.<ext-in-union>; ".exe" is not in
        // the union, so the shape check rejects it before any storage lookup.
        const res = await request.get(
            `${API_BASE}/api/uploads/${user.user.id}/${'a'.repeat(64)}.exe`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(400);
        const body = (await res.json()) as Json;
        expect(body.code).toBe('InvalidFilename');
        expect(body.message).toBe('Invalid filename');
    });

    test('a too-short hash (63 hex chars) with a valid extension → 400 InvalidFilename', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(
            `${API_BASE}/api/uploads/${user.user.id}/${'a'.repeat(63)}.png`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe('InvalidFilename');
    });
});

test.describe('FLOW: uploads validation — anonymous routes (rejects + per-mint isolation)', () => {
    test('/anonymous rejects: missing file (400 field-required), empty file (400 EmptyFile), SVG + PDF (400 MimeNotAllowed, image-only), text-as-png (400 MimeMismatch)', async () => {
        const anon = await anonContext();
        try {
            // Missing multipart 'file' — the handler's own null-check (no `code`).
            const missing = await anon.post(`${API_BASE}/api/uploads/anonymous`, {
                multipart: { caption: `no-file-${nextSuffix()}` },
            });
            expect([400, 429]).toContain(missing.status());
            if (missing.status() === 400) {
                expect(await missing.json()).toEqual({
                    status: 'error',
                    message: "Multipart field 'file' is required",
                });
            }

            // 0-byte file → EmptyFile.
            const empty = await anon.post(`${API_BASE}/api/uploads/anonymous`, {
                multipart: {
                    file: { name: 'e.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
                },
            });
            expect([400, 429]).toContain(empty.status());
            if (empty.status() === 400) {
                const b = (await empty.json()) as Json;
                expect(b.code).toBe('EmptyFile');
                expect(b.message).toBe('No file content received');
            }

            // SVG is intentionally excluded from the image allow-list.
            const svg = await anon.post(`${API_BASE}/api/uploads/anonymous`, {
                multipart: {
                    file: {
                        name: 'x.svg',
                        mimeType: 'image/svg+xml',
                        buffer: Buffer.from(`<svg>${nextSuffix()}</svg>`, 'utf8'),
                    },
                },
            });
            expect([400, 429]).toContain(svg.status());
            if (svg.status() === 400) {
                const b = (await svg.json()) as Json;
                expect(b.code).toBe('MimeNotAllowed');
                expect(b.message).toBe('Content-Type "image/svg+xml" is not in the allow-list');
            }

            // PDF is valid on /anonymous/file but NOT on the image-only /anonymous.
            const pdf = await anon.post(`${API_BASE}/api/uploads/anonymous`, {
                multipart: {
                    file: {
                        name: 'x.pdf',
                        mimeType: 'application/pdf',
                        buffer: Buffer.from(`%PDF-1.4 ${nextSuffix()}`, 'utf8'),
                    },
                },
            });
            expect([400, 429]).toContain(pdf.status());
            if (pdf.status() === 400) {
                expect((await pdf.json()).code).toBe('MimeNotAllowed');
            }

            // Declared image/png but the bytes aren't a PNG → magic-byte mismatch.
            const lie = await anon.post(`${API_BASE}/api/uploads/anonymous`, {
                multipart: {
                    file: {
                        name: 'lie.png',
                        mimeType: 'image/png',
                        buffer: Buffer.from(`plain text not a png ${nextSuffix()}`, 'utf8'),
                    },
                },
            });
            expect([400, 429]).toContain(lie.status());
            if (lie.status() === 400) {
                expect((await lie.json()).code).toBe('MimeMismatch');
            }
        } finally {
            await anon.dispose();
        }
    });

    test('/anonymous/file uses the BROAD allow-list: an .exe → 400 MimeNotAllowed ("…not accepted for file uploads")', async () => {
        const anon = await anonContext();
        try {
            const res = await anon.post(`${API_BASE}/api/uploads/anonymous/file`, {
                multipart: {
                    file: {
                        name: 'evil.exe',
                        mimeType: 'application/x-msdownload',
                        buffer: Buffer.from(`MZ${nextSuffix()}`, 'utf8'),
                    },
                },
            });
            expect([400, 429]).toContain(res.status());
            if (res.status() === 400) {
                const b = (await res.json()) as Json;
                expect(b.code).toBe('MimeNotAllowed');
                expect(b.message).toBe(
                    'Content-Type "application/x-msdownload" is not accepted for file uploads',
                );
            }
        } finally {
            await anon.dispose();
        }
    });

    test('/anonymous/file accepts markdown → 201 anon-mint shape: uploadId "<anonUid>/<sha>.md", sha id, future expiresAt, anonAccessToken, and NO `key`', async () => {
        const anon = await anonContext();
        try {
            const bytes = `# anon file ${nextSuffix()}\n`;
            const res = await anon.post(`${API_BASE}/api/uploads/anonymous/file`, {
                multipart: {
                    file: { name: 'a.md', mimeType: 'text/markdown', buffer: Buffer.from(bytes) },
                },
            });
            expect([201, 429]).toContain(res.status());
            if (res.status() !== 201) return; // throttled bucket — nothing to assert
            const b = (await res.json()) as Json;
            expect(String(b.id)).toMatch(SHA256_HEX);
            expect(b.hash).toBe(b.id);
            expect(b.filename).toBe(`${b.id}.md`);
            expect(b.mimeType).toBe('text/markdown');
            // uploadId is "<anonOwnerUuid>/<sha>.md" — the owner segment is the
            // freshly minted anon user, NOT echoed as the authed `key` field.
            const [ownerSeg, fileSeg] = String(b.uploadId).split('/');
            expect(ownerSeg).toMatch(UUID_RE);
            expect(fileSeg).toBe(`${b.id}.md`);
            expect(b.url).toBe(`/api/uploads/${ownerSeg}/${b.id}.md`);
            expect(b.key, 'anon response echoes uploadId, not the authed `key`').toBeUndefined();
            // TTL contract: a future ISO timestamp (ANONYMOUS_USER_TTL_DAYS).
            expect(String(b.expiresAt)).toMatch(ISO_RE);
            expect(Date.parse(String(b.expiresAt))).toBeGreaterThan(Date.now());
            expect(String(b.anonAccessToken).length).toBeGreaterThan(10);
        } finally {
            await anon.dispose();
        }
    });

    test('per-mint isolation: two credential-less /anonymous/file uploads mint DISTINCT owners; owner A’s token reads file A (200) but NOT file B (404)', async () => {
        const anonA = await anonContext();
        const anonB = await anonContext();
        try {
            const upA = await anonA.post(`${API_BASE}/api/uploads/anonymous/file`, {
                multipart: {
                    file: {
                        name: 'a.md',
                        mimeType: 'text/markdown',
                        buffer: Buffer.from(`alpha ${nextSuffix()}`),
                    },
                },
            });
            const upB = await anonB.post(`${API_BASE}/api/uploads/anonymous/file`, {
                multipart: {
                    file: {
                        name: 'b.md',
                        mimeType: 'text/markdown',
                        buffer: Buffer.from(`beta ${nextSuffix()}`),
                    },
                },
            });
            expect([201, 429]).toContain(upA.status());
            expect([201, 429]).toContain(upB.status());
            if (upA.status() !== 201 || upB.status() !== 201) return; // throttled — skip the isolation arc

            const a = (await upA.json()) as Json;
            const b = (await upB.json()) as Json;
            // Each credential-less call minted a fresh anon user → distinct owners
            // and distinct bearer tokens.
            const ownerA = String(a.uploadId).split('/')[0];
            const ownerB = String(b.uploadId).split('/')[0];
            expect(ownerA).not.toBe(ownerB);
            expect(a.anonAccessToken).not.toBe(b.anonAccessToken);

            // Owner A's token reads A's own file back (owner-gated serve → 200)…
            const readOwn = await anonA.get(`${API_BASE}${String(a.url)}`, {
                headers: authedHeaders(String(a.anonAccessToken)),
            });
            expect(readOwn.status()).toBe(200);

            // …but is a stranger to B's file → 404 (anti-enumeration, not 403).
            const readOther = await anonA.get(`${API_BASE}${String(b.url)}`, {
                headers: authedHeaders(String(a.anonAccessToken)),
            });
            expect(readOther.status()).toBe(404);
            expect(await readOther.json()).toEqual({ status: 'error', message: 'Not found' });
        } finally {
            await anonA.dispose();
            await anonB.dispose();
        }
    });
});
