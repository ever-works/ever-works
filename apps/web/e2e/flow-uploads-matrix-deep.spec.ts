import {
    test,
    expect,
    request as pwRequest,
    type APIRequestContext,
} from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: UPLOADS MATRIX (DEEP) — deepens coverage of the thinly-tested
 * UploadsController/UploadsService beyond the auth/authz matrix that
 * sec-pin-uploads-auth.spec.ts (Batch 1) already pins. This file pins the
 * STORAGE + VALIDATION contracts: sha256 content-addressing
 * (id === hash === <sha256>, filename `<sha256>.<ext>`, deterministic key
 * `userId/filename`), determinism across the three accepted-MIME endpoints
 * (`POST /`, `/image`, `/file`), the image-vs-file allow-list split, the
 * magic-byte / declared-MIME mismatch matrix, the text-like UTF-8 shape
 * guard, the Office-Open-XML zip-magic + canonical-MIME echo, the
 * active-renderable-MIME collapse on serve, the per-route size caps
 * (413 vs 201), and the empty-file / invalid-filename / missing-multipart
 * 400/404 envelopes.
 *
 * GROUNDING — every status/body/header below was probed against the LIVE
 * stack (API :3100 sqlite in-memory, REQUIRE_EMAIL_VERIFICATION=false) with
 * curl + throwaway users on 2026-06-11, then cross-checked against source:
 *   - apps/api/src/uploads/uploads.controller.ts
 *       POST /            image-only (saveImage), Multer fileSize cap
 *       POST /image       alias of POST /
 *       POST /file        broad allow-list (saveFile), 50 MiB outer cap
 *       GET  :userId/:filename  owner-gated serve; ACTIVE_MIMES collapse
 *   - apps/api/src/uploads/uploads.service.ts
 *       saveImage/saveFile: createHash('sha256') -> id/hash/filename;
 *       ALLOWED_MIME (images, no SVG); ALLOWED_FILE_BINARY_MIME (+pdf/zip/
 *       gzip/Office); TEXT_LIKE_MIMES (utf8 shape check, NUL-byte reject);
 *       ACTIVE_RENDERABLE_MIMES collapse to application/octet-stream;
 *       assertValidFilename -> InvalidFilename 400; readFile 404 'Upload
 *       not found' for a valid-shape but absent key.
 *
 * PROBED CONTRACTS (live, 2026-06-11):
 *   POST /api/uploads        authed PNG -> 201 { id:<sha256>, hash:<sha256>,
 *       filename:'<sha256>.png', url:'/api/uploads/<uid>/<filename>',
 *       key:'<uid>/<filename>', size:68, mimeType:'image/png' }
 *   POST /api/uploads/image  identical body to POST /api/uploads (alias)
 *   same PNG bytes -> identical sha256 on /, /image AND /file (content-addr)
 *   POST /api/uploads/file   md  -> 201 .md  mimeType echoes text/markdown
 *                            json -> 201 .json mimeType application/json
 *                            pdf  -> 201 .pdf (sniffed application/pdf)
 *                            docx (PK magic) -> 201 .zip, mimeType echoes
 *                                 ...wordprocessingml.document (canonical)
 *   image-only allow-list:  PDF / SVG declared on POST /api/uploads -> 400
 *       { code:'MimeNotAllowed', message:'Content-Type "<m>" is not in the
 *         allow-list' }
 *   mime mismatch:  text bytes (or GIF bytes) declared image/png -> 400
 *       { code:'MimeMismatch', message:'Declared Content-Type "image/png"
 *         does not match the file\'s magic bytes' }
 *   file allow-list reject:  application/x-msdownload on /file -> 400
 *       { code:'MimeNotAllowed', message:'Content-Type "<m>" is not accepted
 *         for file uploads' }
 *   text NUL byte:  text/markdown w/ \x00 -> 400 { code:'NotTextContent' }
 *   empty file:  0 bytes -> 400 { code:'EmptyFile',
 *                                 message:'No file content received' }
 *   missing multipart 'file' -> 400 { status:'error',
 *       message:"Multipart field 'file' is required" } (no `code`)
 *   active-MIME serve collapse:  upload text/html|text/css via /file echoes
 *       the active MIME in the 201 body, but GET serve returns
 *       Content-Type: application/octet-stream (filename keeps .html/.css),
 *       plus CSP default-src 'none', X-Content-Type-Options nosniff,
 *       Cache-Control private max-age=300, Content-Disposition inline.
 *   size cap:  >=5 MiB PNG on POST /api/uploads -> 413
 *       { message:'File too large', error:'Payload Too Large',
 *         statusCode:413 } (Multer interceptor cap, fires before service);
 *       the SAME payload on /file -> 201 (its outer cap is 50 MiB).
 *   serve missing key (owner, valid-shape filename, never stored) -> 404
 *       { status:'error', message:'Upload not found' }
 *   serve invalid filename shape -> 400 { code:'InvalidFilename' }
 *
 * NON-DUPLICATION:
 *   - sec-pin-uploads-auth.spec.ts (Batch 1) owns: the anon-401 matrix on
 *     every authed route, the web-tier BFF proxy guard, the owner 200
 *     round-trip + hardening headers on an IMAGE, the cross-user serve 404
 *     ('Not found' — distinct from this file's missing-key 404 'Upload not
 *     found'), the EW-644 workId ownership gate, and the EW-637 anon-mint
 *     scoping. This file does NOT re-pin any of those; it pins the storage /
 *     content-addressing / MIME-matrix / size-cap contracts on AUTHED
 *     happy + reject paths instead.
 *   - image-uploads.spec.ts only loosely asserts `<500` / `[401,403]` via a
 *     path-walk; it never pins exact sha256 shapes, the /file allow-list,
 *     determinism, the size cap, or the active-MIME collapse.
 *   - media-mime-sniffing.spec.ts asserts only `<500` on a text-as-png lie;
 *     here we pin the EXACT MimeMismatch / MimeNotAllowed 400 envelopes.
 *   - flow-injection-xss.spec.ts pins the serve path-traversal allowlist on
 *     a SYNTHETIC path; here we pin a REAL active-MIME upload's serve
 *     collapse + the missing-key 404 + invalid-filename 400 envelopes.
 *
 * ADAPTIVITY: pure authz/storage/validation contracts — no LLM key, no
 * mail, no Redis, no search provider needed. Anonymous requests (none used
 * here) would go through a fresh empty-storageState context per the house
 * rule; this file is entirely authed-bearer over the API tier.
 *
 * NOT A CONTRACT (intentionally untested): the UploadsController exposes NO
 * @Delete / @Patch / @Put — there is no upload-deletion endpoint (anon
 * uploads are GC'd by TTL, not deleted via the API), so deletion is out of
 * scope here. DELETE /api/uploads/<uid>/<file> returns 404 (unrouted).
 */

// 1x1 transparent PNG — minimum valid bytes (shared with sibling specs).
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64',
);

const SHA256_HEX = /^[a-f0-9]{64}$/;
// PNG 8-byte signature, used to build over-cap payloads that still sniff
// as image/png so the 413 comes from the size cap, not a MIME reject.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The image-route Multer cap. Live env leaves UPLOADS_MAX_BYTES unset, so
// the controller's MAX_UPLOAD_BYTES falls back to the 5 MiB default — a
// payload AT or ABOVE this trips the interceptor 413 (probed: 5_242_880 and
// 5_242_881 both -> 413). We build comfortably over it to stay robust to a
// slightly larger configured cap while remaining a modest ~5 MiB payload.
const IMAGE_CAP_BYTES = 5 * 1024 * 1024;

// Per-test counter for unique-but-clock-free suffixes (house rule: never
// call a clock at module scope; the increment runs inside each test body).
let seq = 0;
function nextSuffix(): string {
    seq += 1;
    return `udm${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** sha256 hex of a buffer — to assert the server's content-address id. */
async function sha256Hex(buf: Buffer): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(buf).digest('hex');
}

type UploadBody = {
    id: string;
    url: string;
    filename: string;
    size: number;
    mimeType: string;
    hash: string;
    key: string;
};

/** POST a multipart file to an uploads endpoint and return status + json. */
async function postUpload(
    request: APIRequestContext,
    token: string,
    path: string,
    file: { name: string; mimeType: string; buffer: Buffer },
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}${path}`, {
        headers: authedHeaders(token),
        multipart: { file },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), body };
}

test.describe('FLOW: uploads matrix (deep) — sha256 content-addressing', () => {
    test('POST /api/uploads (image) -> 201 with id===hash===sha256(bytes), filename <sha256>.png, deterministic key userId/filename', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const expectedHash = await sha256Hex(TINY_PNG);

        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads', {
            name: `${nextSuffix()}.png`,
            mimeType: 'image/png',
            buffer: TINY_PNG,
        });
        expect(status, 'authed image upload -> 201').toBe(201);
        const up = body as unknown as UploadBody;

        // Content-addressing: the id IS the sha256 of the bytes, hash mirrors
        // it, and the originalname never reaches storage (filename is hash-
        // derived). This is the core EW-637 storage invariant.
        expect(up.id).toMatch(SHA256_HEX);
        expect(up.id, 'id is sha256 of the uploaded bytes').toBe(expectedHash);
        expect(up.hash, 'hash mirrors id').toBe(up.id);
        expect(up.filename, 'filename is <sha256>.png (originalname discarded)').toBe(
            `${up.id}.png`,
        );
        // Deterministic key path: <userId>/<filename> (local-fs layout).
        expect(up.key, 'storage key is userId/filename').toBe(`${owner.user.id}/${up.filename}`);
        expect(up.url, 'serve URL embeds owner userId + filename').toBe(
            `/api/uploads/${owner.user.id}/${up.filename}`,
        );
        expect(up.size).toBe(TINY_PNG.length);
        expect(up.mimeType).toBe('image/png');
    });

    test('POST /api/uploads/image is an exact alias of POST /api/uploads (identical body for identical bytes)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const file = { name: `${nextSuffix()}.png`, mimeType: 'image/png', buffer: TINY_PNG };

        const a = await postUpload(request, owner.access_token, '/api/uploads', file);
        const b = await postUpload(request, owner.access_token, '/api/uploads/image', file);
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        // Same user, same bytes -> byte-for-byte identical response shape;
        // /image is documented as a pure alias of the root handler.
        expect(b.body).toEqual(a.body);
    });

    test('identical PNG bytes content-address to the SAME sha256 across /, /image and /file (determinism)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const file = { name: `${nextSuffix()}.png`, mimeType: 'image/png', buffer: TINY_PNG };
        const expectedHash = await sha256Hex(TINY_PNG);

        const hashes: string[] = [];
        for (const path of ['/api/uploads', '/api/uploads/image', '/api/uploads/file']) {
            const { status, body } = await postUpload(request, owner.access_token, path, file);
            expect(status, `${path} accepts the PNG -> 201`).toBe(201);
            expect((body as UploadBody).filename, `${path} keyed by hash`).toBe(
                `${expectedHash}.png`,
            );
            hashes.push((body as UploadBody).hash);
        }
        // Content addressing is deterministic & endpoint-independent.
        expect(new Set(hashes).size, 'one distinct hash across all three endpoints').toBe(1);
        expect(hashes[0]).toBe(expectedHash);
    });

    test('two DIFFERENT users uploading identical bytes share the hash but get user-scoped keys/URLs', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const file = { name: `${nextSuffix()}.png`, mimeType: 'image/png', buffer: TINY_PNG };

        const ra = await postUpload(request, a.access_token, '/api/uploads', file);
        const rb = await postUpload(request, b.access_token, '/api/uploads', file);
        expect(ra.status).toBe(201);
        expect(rb.status).toBe(201);
        const ua = ra.body as unknown as UploadBody;
        const ub = rb.body as unknown as UploadBody;

        // Hash is purely content-derived -> equal for equal bytes…
        expect(ua.hash, 'same bytes -> same content hash').toBe(ub.hash);
        // …but the storage key + serve URL are owner-scoped, so the two
        // users never collide in storage and can't read each other's path.
        expect(ua.key).toBe(`${a.user.id}/${ua.filename}`);
        expect(ub.key).toBe(`${b.user.id}/${ub.filename}`);
        expect(ua.key).not.toBe(ub.key);
        expect(ua.url).not.toBe(ub.url);
    });
});

test.describe('FLOW: uploads matrix (deep) — /file broad allow-list', () => {
    test('POST /api/uploads/file accepts text/markdown -> 201 .md, echoes declared mimeType, hash-addressed', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const buffer = Buffer.from(`# deep matrix ${nextSuffix()}\nbody text\n`, 'utf8');
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'doc.md',
            mimeType: 'text/markdown',
            buffer,
        });
        expect(status, 'markdown -> 201').toBe(201);
        const up = body as unknown as UploadBody;
        expect(up.hash).toBe(await sha256Hex(buffer));
        expect(up.filename, 'text-like MIME maps to canonical .md ext').toBe(`${up.hash}.md`);
        // Text formats can't be magic-sniffed, so mimeType echoes the
        // DECLARED type (not octet-stream).
        expect(up.mimeType).toBe('text/markdown');
        expect(up.size).toBe(buffer.length);
        expect(up.key).toBe(`${owner.user.id}/${up.filename}`);
    });

    test('POST /api/uploads/file accepts a real PDF (sniffed application/pdf) -> 201 .pdf', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // "%PDF-" magic so the byte-sniff matches the declared MIME.
        const buffer = Buffer.from(`%PDF-1.4 deep-matrix ${nextSuffix()}`, 'utf8');
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'doc.pdf',
            mimeType: 'application/pdf',
            buffer,
        });
        expect(status, 'pdf -> 201').toBe(201);
        const up = body as unknown as UploadBody;
        expect(up.hash).toBe(await sha256Hex(buffer));
        expect(up.filename).toBe(`${up.hash}.pdf`);
        expect(up.mimeType).toBe('application/pdf');
    });

    test('POST /api/uploads/file accepts an Office Open XML docx: ZIP magic stored as .zip, body echoes canonical Office MIME', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // PK\x03\x04 is the ZIP/OOXML container magic; the declared MIME is
        // the canonical wordprocessingml type, which the service treats as a
        // ZIP-family match (sniffedFamily application/zip == declaredFamily).
        const buffer = Buffer.concat([
            Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            Buffer.from(`docx-body-${nextSuffix()}`, 'utf8'),
        ]);
        const docxMime =
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'report.docx',
            mimeType: docxMime,
            buffer,
        });
        expect(status, 'docx -> 201').toBe(201);
        const up = body as unknown as UploadBody;
        // Stored under the ZIP container ext…
        expect(up.filename, 'OOXML stored under .zip container ext').toBe(`${up.hash}.zip`);
        // …but the response echoes the canonical Office MIME so the UI can
        // still render "Word document", not "ZIP archive".
        expect(up.mimeType, 'response echoes the canonical Office MIME').toBe(docxMime);
    });
});

test.describe('FLOW: uploads matrix (deep) — MIME validation matrix', () => {
    test('text bytes declared image/png -> 400 MimeMismatch on POST /api/uploads', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads', {
            name: 'fake.png',
            mimeType: 'image/png',
            buffer: Buffer.from(`plain text not a png ${nextSuffix()}`, 'utf8'),
        });
        expect(status, 'declared-vs-bytes lie -> 400').toBe(400);
        expect(body.code).toBe('MimeMismatch');
        expect(body.message).toBe(
            'Declared Content-Type "image/png" does not match the file\'s magic bytes',
        );
    });

    test('GIF magic declared as image/png -> 400 MimeMismatch (valid magic, wrong family)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // "GIF89a" is a recognized signature, but it sniffs to image/gif,
        // which != the declared image/png -> mismatch (not "no signature").
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads', {
            name: 'g.png',
            mimeType: 'image/png',
            buffer: Buffer.from(`GIF89a${nextSuffix()}`, 'utf8'),
        });
        expect(status).toBe(400);
        expect(body.code).toBe('MimeMismatch');
    });

    test('image-only allow-list: SVG and PDF declared on POST /api/uploads -> 400 MimeNotAllowed (..."not in the allow-list")', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        const svg = await postUpload(request, owner.access_token, '/api/uploads', {
            name: 'x.svg',
            mimeType: 'image/svg+xml',
            buffer: Buffer.from(`<svg>${nextSuffix()}</svg>`, 'utf8'),
        });
        expect(svg.status, 'SVG is intentionally excluded from images').toBe(400);
        expect(svg.body.code).toBe('MimeNotAllowed');
        expect(svg.body.message).toBe(
            'Content-Type "image/svg+xml" is not in the allow-list',
        );

        // PDF is valid on /file but NOT on the image-only root endpoint.
        const pdf = await postUpload(request, owner.access_token, '/api/uploads', {
            name: 'd.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(`%PDF-1.4 ${nextSuffix()}`, 'utf8'),
        });
        expect(pdf.status, 'PDF not accepted on the image route').toBe(400);
        expect(pdf.body.code).toBe('MimeNotAllowed');
        expect(pdf.body.message).toBe(
            'Content-Type "application/pdf" is not in the allow-list',
        );
    });

    test('/file rejects an out-of-allow-list MIME -> 400 MimeNotAllowed (..."not accepted for file uploads")', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'evil.exe',
            mimeType: 'application/x-msdownload',
            buffer: Buffer.from(`MZ${nextSuffix()}`, 'utf8'),
        });
        expect(status).toBe(400);
        expect(body.code).toBe('MimeNotAllowed');
        // Distinct message from the image route's allow-list reject — pins
        // that saveFile (not saveImage) produced the error.
        expect(body.message).toBe(
            'Content-Type "application/x-msdownload" is not accepted for file uploads',
        );
    });

    test('text-like MIME with embedded NUL byte -> 400 NotTextContent', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        // looksLikeUtf8Text rejects any NUL in the first 8 KiB — binaries
        // mislabeled as text are caught here.
        const buffer = Buffer.concat([
            Buffer.from(`hello ${nextSuffix()}`, 'utf8'),
            Buffer.from([0x00]),
            Buffer.from('world', 'utf8'),
        ]);
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'n.md',
            mimeType: 'text/markdown',
            buffer,
        });
        expect(status).toBe(400);
        expect(body.code).toBe('NotTextContent');
    });

    test('empty (0-byte) upload -> 400 EmptyFile on both /api/uploads and /api/uploads/file', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        for (const [path, mime, name] of [
            ['/api/uploads', 'image/png', 'empty.png'],
            ['/api/uploads/file', 'application/json', 'empty.json'],
        ] as const) {
            const { status, body } = await postUpload(request, owner.access_token, path, {
                name,
                mimeType: mime,
                buffer: Buffer.alloc(0),
            });
            expect(status, `${path} empty -> 400`).toBe(400);
            expect(body.code, `${path} EmptyFile`).toBe('EmptyFile');
            expect(body.message).toBe('No file content received');
        }
    });

    test('missing multipart "file" field -> 400 with the field-required message (no error code)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // Send a multipart body with ONLY a plain text field (no file part):
        // the FileInterceptor leaves `file` undefined, so the handler's own
        // null-check fires (a misnamed FILE part would instead trip Multer's
        // "Unexpected field" — a different envelope we deliberately avoid).
        const res = await request.post(`${API_BASE}/api/uploads`, {
            headers: authedHeaders(owner.access_token),
            multipart: { caption: `no-file-${nextSuffix()}` },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual({
            status: 'error',
            message: "Multipart field 'file' is required",
        });
    });
});

test.describe('FLOW: uploads matrix (deep) — serve-side MIME hardening + size caps', () => {
    test('active-renderable MIME (text/html) is collapsed to application/octet-stream on serve, with full hardening headers', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const buffer = Buffer.from(`<html><body>hi ${nextSuffix()}</body></html>`, 'utf8');
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'page.html',
            mimeType: 'text/html',
            buffer,
        });
        expect(status, 'html upload accepted -> 201').toBe(201);
        const up = body as unknown as UploadBody;
        // The 201 body still echoes the declared active MIME…
        expect(up.mimeType).toBe('text/html');
        expect(up.filename).toBe(`${up.hash}.html`);

        // …but SERVING it neutralizes the active Content-Type so a browser
        // can never execute attacker-uploaded HTML.
        const res = await request.get(`${API_BASE}${up.url}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), 'owner reads own html -> 200').toBe(200);
        const h = res.headers();
        expect(h['content-type'], 'active MIME collapsed on serve').toBe(
            'application/octet-stream',
        );
        expect(h['x-content-type-options']).toBe('nosniff');
        expect(h['content-security-policy']).toContain("default-src 'none'");
        expect(h['cache-control']).toBe('private, max-age=300');
        // Disposition keeps the stored hash-named .html filename.
        expect(h['content-disposition']).toBe(`inline; filename="${up.filename}"`);
        const bytes = await res.body();
        expect(Buffer.compare(bytes, buffer), 'served bytes identical to upload').toBe(0);
    });

    test('text/css is likewise served as application/octet-stream (second active-MIME family)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const buffer = Buffer.from(`body{color:red} /* ${nextSuffix()} */`, 'utf8');
        const { status, body } = await postUpload(request, owner.access_token, '/api/uploads/file', {
            name: 'style.css',
            mimeType: 'text/css',
            buffer,
        });
        expect(status).toBe(201);
        const up = body as unknown as UploadBody;
        expect(up.mimeType).toBe('text/css');

        const res = await request.get(`${API_BASE}${up.url}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status()).toBe(200);
        expect(res.headers()['content-type']).toBe('application/octet-stream');
    });

    test('size cap: a >=5 MiB PNG is 413 on the image route (Multer cap) but 201 on /file (50 MiB outer cap)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        // Valid PNG signature + padding so it sniffs as image/png and the
        // ONLY reason for rejection is the size cap, not a MIME mismatch.
        const oversize = Buffer.concat([
            PNG_SIG,
            Buffer.alloc(IMAGE_CAP_BYTES + 64 - PNG_SIG.length, 0),
        ]);

        const img = await request.post(`${API_BASE}/api/uploads`, {
            headers: authedHeaders(owner.access_token),
            multipart: { file: { name: 'big.png', mimeType: 'image/png', buffer: oversize } },
        });
        expect(img.status(), 'oversize image -> 413 from the Multer interceptor').toBe(413);
        const imgBody = (await img.json()) as Record<string, unknown>;
        expect(imgBody).toEqual({
            message: 'File too large',
            error: 'Payload Too Large',
            statusCode: 413,
        });

        // The SAME payload is comfortably under /file's 50 MiB outer cap, so
        // it is accepted there — proving the caps are per-route, not global.
        const filed = await request.post(`${API_BASE}/api/uploads/file`, {
            headers: authedHeaders(owner.access_token),
            multipart: { file: { name: 'big.png', mimeType: 'image/png', buffer: oversize } },
        });
        expect(filed.status(), 'same payload accepted on the broader /file route').toBe(201);
        const filedBody = (await filed.json()) as unknown as UploadBody;
        expect(filedBody.size).toBe(oversize.length);
        expect(filedBody.mimeType).toBe('image/png');
    });

    test('serve a valid-shape but never-stored filename (owner) -> 404 "Upload not found"; malformed filename -> 400 InvalidFilename', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);

        // Valid <hex64>.png shape, but no such object was ever stored ->
        // the backend getObject misses and the service maps it to a 404
        // 'Upload not found' (distinct from Batch 1's cross-user 'Not found').
        const ghost = `${'0'.repeat(64)}.png`;
        const missing = await request.get(`${API_BASE}/api/uploads/${owner.user.id}/${ghost}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(missing.status(), 'owner reading a never-stored key -> 404').toBe(404);
        expect(await missing.json()).toEqual({ status: 'error', message: 'Upload not found' });

        // A filename that doesn't match the canonical <hex64>.<ext> shape is
        // rejected by assertValidFilename BEFORE any storage lookup.
        const bad = await request.get(
            `${API_BASE}/api/uploads/${owner.user.id}/not-a-valid-name.txt`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(bad.status(), 'malformed filename -> 400').toBe(400);
        const badBody = (await bad.json()) as Record<string, unknown>;
        expect(badBody.code).toBe('InvalidFilename');
    });
});
