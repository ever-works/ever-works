import {
    Inject,
    Injectable,
    Logger,
    BadRequestException,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { IStoragePlugin } from '@ever-works/plugin';
import type { WorkRepoResolver } from '@ever-works/github-storage-plugin';
// Type-only import + Symbol token (mirrors WORK_REPO_RESOLVER below): pulling the
// `@ever-works/agent/database` VALUE barrel into UploadsService would drag TypeORM
// into the upload unit-test import graph (path-scurry-under-Jest crash). The
// UploadsModule binds the token to the real repo via `useExisting`.
import type { UserUploadRepository } from '@ever-works/agent/database';
import { getActiveStorageBackend } from './storage-backend.factory';

/**
 * DI token for the optional `UserUploadRepository`. The UploadsModule provides
 * this token via `{ provide: USER_UPLOAD_REPOSITORY, useExisting: ... }`.
 */
export const USER_UPLOAD_REPOSITORY = Symbol.for('ever-works:user-upload-repository');

/**
 * DI token for the optional `WorkRepoResolver` (EW-644).
 *
 * We inject via a token + `type`-only import rather than a direct class
 * import to keep `uploads.service.ts` from transitively pulling
 * `@ever-works/agent/database` + `@ever-works/agent/facades` into the
 * import graph — those modules use the `@src/*` path alias that
 * resolves only inside the agent package, and importing them from the
 * api's jest test runtime explodes on `@src/config`. The module
 * (`uploads.module.ts`) wires the concrete `WorkRepoResolverService` to
 * this token via `{ provide: WORK_REPO_RESOLVER, useExisting: ... }`.
 */
export const WORK_REPO_RESOLVER = Symbol.for('ever-works:upload-work-repo-resolver');

export interface UploadResult {
    id: string;
    url: string;
    filename: string;
    size: number;
    mimeType: string;
    hash: string;
    /**
     * Opaque storage-backend key. Same as `id` for the legacy local-fs
     * layout; for other backends (S3, MinIO, GitHub) this may differ.
     * The anonymous-upload flow returns it as `uploadId` so the website
     * can hand it back when submitting the prompt.
     */
    key?: string;
}

/**
 * Magic-byte signatures for the file types we accept. The client-declared
 * Content-Type is NOT trusted — an attacker can claim `image/png` on an
 * `.exe` payload. We sniff the first N bytes and reject when the buffer
 * does not match its declared family.
 *
 * Refs: https://en.wikipedia.org/wiki/List_of_file_signatures
 */
const MAGIC_BYTES: ReadonlyArray<{
    mime: string;
    ext: string;
    bytes: ReadonlyArray<number | null>;
    offset?: number;
}> = [
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    // JPEG: FF D8 FF
    { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    // GIF87a / GIF89a
    { mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    // WEBP: RIFF....WEBP (offset 8 == "WEBP")
    {
        mime: 'image/webp',
        ext: 'webp',
        bytes: [0x57, 0x45, 0x42, 0x50],
        offset: 8,
    },
    // PDF: "%PDF-"
    { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
    // ZIP family (covers .zip + Office Open XML .docx/.xlsx/.pptx — all are
    // ZIP archives under the hood). We store as plain `.zip` because the
    // outer container is a ZIP; the original filename / original MIME are
    // still echoed back to the caller so the UI knows what to show.
    { mime: 'application/zip', ext: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
    // GZIP: 1F 8B
    { mime: 'application/gzip', ext: 'gz', bytes: [0x1f, 0x8b] },
];

/**
 * Allow-list of accepted IMAGE MIME families. Anything outside this list is
 * rejected by `saveImage`. SVG is INTENTIONALLY excluded — it can carry
 * inline `<script>` payloads that would execute if a downstream tier ever
 * serves it inline with `Content-Type: image/svg+xml` to a browser. If
 * you need SVG support, route through a sanitizer (DOMPurify with
 * `USE_PROFILES: { svg: true }`) and add an `image/svg+xml` `sanitized`
 * variant — do NOT just add it here.
 */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Allow-list for the broader `saveFile` path — images PLUS documents,
 * archives, and text-like formats. PromptComposer's "Upload a file" /
 * "Upload a folder" affordances route here. Anything not in this set OR
 * not in `TEXT_LIKE_MIMES` below is rejected.
 *
 * Binary types here MUST have a matching magic-byte signature in
 * `MAGIC_BYTES`; the sniff still runs and the declared MIME must match
 * the bytes. Text-like types live in their own set (below) because they
 * have no canonical magic bytes and are validated via a content shape
 * heuristic instead.
 */
const ALLOWED_FILE_BINARY_MIME = new Set([
    ...ALLOWED_MIME, // images
    'application/pdf',
    'application/zip',
    'application/gzip',
    // Office Open XML — the bytes are ZIP, but browsers may declare these
    // canonical MIMEs. We accept the declaration AND require the magic
    // bytes to be ZIP. Stored as `.zip` (the container format).
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/**
 * Declared MIMEs that have no reliable magic byte signature — these are
 * text-like formats (plain text, markdown, CSV, JSON, code). The bytes
 * are validated via `looksLikeUtf8Text` (no NUL bytes in the first 8KiB,
 * mostly printable ASCII / valid UTF-8) rather than magic-byte sniffing.
 * The map value is the canonical extension we write to disk.
 */
const TEXT_LIKE_MIMES: ReadonlyMap<string, string> = new Map([
    ['text/plain', 'txt'],
    ['text/markdown', 'md'],
    ['text/x-markdown', 'md'],
    ['text/csv', 'csv'],
    ['text/tab-separated-values', 'tsv'],
    ['text/html', 'html'],
    ['text/css', 'css'],
    ['text/javascript', 'js'],
    ['application/javascript', 'js'],
    ['application/json', 'json'],
    ['application/xml', 'xml'],
    ['text/xml', 'xml'],
    ['application/x-yaml', 'yaml'],
    ['text/yaml', 'yaml'],
    ['text/x-yaml', 'yaml'],
]);

/**
 * Security: the subset of accepted MIME types whose bytes a browser would
 * render or execute if served inline with their real Content-Type
 * (HTML document, CSS that can exfiltrate via attribute selectors, and
 * JavaScript). These are stored (e.g. as LLM context) but must NEVER be
 * handed back to a browser with an active Content-Type. `readFile`
 * collapses them to `application/octet-stream`; the serve controller does
 * the same as an outer layer. Kept in sync with the controller's
 * `ACTIVE_MIMES`.
 */
const ACTIVE_RENDERABLE_MIMES: ReadonlySet<string> = new Set([
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
]);

/**
 * Union of all extensions writable by saveImage + saveFile. Used by
 * `assertValidFilename` to validate filenames on the serve path.
 */
const ALL_VALID_EXTS = [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'pdf',
    'zip',
    'gz',
    'txt',
    'md',
    'csv',
    'tsv',
    'html',
    'css',
    'js',
    'json',
    'xml',
    'yaml',
];

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MiB images
const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MiB non-image files

/**
 * Heuristic "is this UTF-8 text?" check for text-like uploads. Scans the
 * first 8KiB and rejects when:
 *   - any NUL byte (0x00) is present (binaries almost always have NULs;
 *     UTF-8 text never does)
 *   - the buffer is not a valid UTF-8 sequence
 *
 * This is intentionally simple — text files are bounded enough by the
 * declared MIME + no-NUL rule that we don't need a full encoding
 * detector. A malicious caller can still upload arbitrary "text" bytes,
 * but the storage backend serves them with the declared text MIME so
 * the only impact is the user re-downloading their own file.
 */
function looksLikeUtf8Text(buf: Buffer): boolean {
    const head = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
    if (head.length === 0) return false;
    for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) return false;
    }
    try {
        // Strict UTF-8 decode — throws on invalid sequences.
        new TextDecoder('utf-8', { fatal: true }).decode(head);
        return true;
    } catch {
        return false;
    }
}

/**
 * EW-637 — UploadsService is now the validation + dispatch layer in front
 * of an `IStoragePlugin`. The storage backend is selected at boot time by
 * `STORAGE_BACKEND` (default `local-fs`); the validation, MIME sniffing,
 * size cap, and user-scoping rules live HERE so they apply uniformly
 * regardless of the active backend.
 *
 * Backwards-compatibility:
 *  - `saveImage(userId, file)` and `readFile(userId, filename)` retain
 *    their original signatures + response shapes. The existing controller
 *    and unit tests don't need changes; `id`/`filename`/`url` keep the
 *    same look. Internally, `id` is now `<sha256>` (the storage key's
 *    object segment) — same as before for the disk backend.
 *  - The constructor takes an optional `IStoragePlugin`. The DI module
 *    wires in the env-selected backend; tests can pass a custom one or
 *    fall back to local-fs (default `STORAGE_BACKEND`).
 */
@Injectable()
export class UploadsService {
    private readonly logger = new Logger(UploadsService.name);
    private readonly maxSize: number;
    private backendPromise?: Promise<IStoragePlugin>;

    // EW-637 follow-up — `@Optional()` is REQUIRED here. `IStoragePlugin`
    // is a TypeScript interface (erased at runtime), so Nest can't tell
    // there's no provider it should try to resolve at index 0. Without
    // `@Optional()`, every API boot dies with `UnknownDependenciesException:
    // Nest can't resolve dependencies of the UploadsService (?)` — the
    // agent unit tests pass (they instantiate directly with `new
    // UploadsService(backend)`), but E2E / production boots crash. With
    // `@Optional()` Nest passes `undefined` when no provider matches and
    // the service falls back to `getActiveStorageBackend()` lazily on
    // the first call. Tests still inject the backend via the constructor.
    constructor(
        @Optional() backend?: IStoragePlugin,
        // EW-644: when present, threaded into the storage backend's
        // `PluginContext` so `github-storage` in `mode: 'data-repo'` can
        // resolve per-Work repo coordinates + token. Optional so unit
        // tests that don't exercise github-storage don't need it.
        @Optional()
        @Inject(WORK_REPO_RESOLVER)
        private readonly workRepoResolver?: WorkRepoResolver,
        // Ownership index for plain uploads. `@Optional()` so the unit tests
        // that construct `new UploadsService(backend)` still work; in
        // production / E2E the UploadsModule binds USER_UPLOAD_REPOSITORY to the
        // real repo, so every upload is recorded and attachments can validate
        // ownership.
        @Optional()
        @Inject(USER_UPLOAD_REPOSITORY)
        private readonly userUploads?: UserUploadRepository,
    ) {
        this.maxSize = Number(process.env.UPLOADS_MAX_BYTES) || DEFAULT_MAX_SIZE;
        if (backend) {
            this.backendPromise = Promise.resolve(backend);
        }
    }

    /**
     * Returns the active storage backend, instantiating it once and reusing
     * the same instance for the lifetime of the service. Exposed for the
     * controller's presign / availability checks.
     */
    async getBackend(): Promise<IStoragePlugin> {
        if (!this.backendPromise) {
            this.backendPromise = getActiveStorageBackend(
                this.workRepoResolver ? { workRepoResolver: this.workRepoResolver } : undefined,
            );
        }
        return this.backendPromise;
    }

    /**
     * Best-effort: index the upload's ownership (`userId`) + storage location in
     * `user_uploads` so an attachment can later validate that its `uploadId`
     * (the sha256) references a real, caller-owned upload. The bytes are already
     * stored when this runs, so a failure here MUST NOT fail the upload — log
     * and continue (deduped per `(userId, sha256)` in the repo).
     */
    private async recordUpload(input: {
        userId: string;
        sha256: string;
        key: string;
        originalFilename?: string;
        mimeType: string;
        fileSize: number;
        workId?: string;
    }): Promise<void> {
        if (!this.userUploads) return;
        try {
            await this.userUploads.record({
                userId: input.userId,
                sha256: input.sha256,
                workId: input.workId ?? null,
                storageProvider: (process.env.STORAGE_BACKEND || 'local-fs').toLowerCase(),
                storagePath: input.key,
                originalFilename: input.originalFilename ?? null,
                mimeType: input.mimeType,
                fileSize: input.fileSize,
            });
        } catch (err) {
            this.logger.warn(
                `Failed to record upload ownership (sha256=${input.sha256.slice(0, 12)}…): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    /**
     * Validate + persist an uploaded image. Returns the canonical
     * reference shape (id + url + metadata). Throws BadRequestException
     * for any validation failure — never lets bad bytes hit storage.
     *
     * Security properties pinned by the test suite:
     *  - MIME must be in the allow-list (no SVG, no octet-stream)
     *  - Magic bytes MUST match the declared MIME (no lying)
     *  - Size must be <= configured max
     *  - Storage is user-scoped via the active plugin so a stranger can never see /
     *    overwrite another user's files even if they guess the filename
     *  - Filename is derived from the SHA-256 of the bytes; no part of
     *    the client-supplied originalname reaches storage (defeats path
     *    traversal in `../../etc/passwd`-style payloads)
     */
    async saveImage(
        userId: string,
        file: Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'size' | 'originalname'>,
        opts?: { workId?: string },
    ): Promise<UploadResult> {
        this.assertValidUserId(userId);

        if (!file || !file.buffer || file.buffer.length === 0) {
            throw new BadRequestException({
                status: 'error',
                code: 'EmptyFile',
                message: 'No file content received',
            });
        }

        if (file.size > this.maxSize) {
            throw new BadRequestException({
                status: 'error',
                code: 'FileTooLarge',
                message: `File exceeds ${this.maxSize} byte cap`,
            });
        }

        const declared = (file.mimetype || '').toLowerCase();
        if (!ALLOWED_MIME.has(declared)) {
            throw new BadRequestException({
                status: 'error',
                code: 'MimeNotAllowed',
                message: `Content-Type ${JSON.stringify(declared)} is not in the allow-list`,
            });
        }

        const sniffed = this.sniffMagicBytes(file.buffer);
        if (!sniffed || sniffed.mime !== declared) {
            // Declared MIME doesn't match the magic bytes — the client
            // is either confused or lying. Reject loudly; do NOT trust
            // the declared type for storage / serving.
            throw new BadRequestException({
                status: 'error',
                code: 'MimeMismatch',
                message: `Declared Content-Type ${JSON.stringify(
                    declared,
                )} does not match the file's magic bytes`,
            });
        }

        const hash = createHash('sha256').update(file.buffer).digest('hex');
        const filename = `${hash}.${sniffed.ext}`;

        const backend = await this.getBackend();
        // EW-644: workId is threaded through to the backend so the
        // github-storage plugin in mode='data-repo' can resolve the
        // Work's data repo per upload. Other backends ignore it.
        const workId = opts?.workId;
        if (workId !== undefined) this.assertValidWorkId(workId);
        const { key } = await backend.putObject({
            buffer: file.buffer,
            filename,
            mimeType: sniffed.mime,
            size: file.size,
            ownerId: userId,
            ...(workId ? { workId } : {}),
        });

        await this.recordUpload({
            userId,
            sha256: hash,
            key,
            originalFilename: file.originalname,
            mimeType: sniffed.mime,
            fileSize: file.size,
            workId,
        });

        // Codex P1 finding on PR #890: returning the plugin's backend-native
        // URL (S3 / MinIO / raw.githubusercontent.com) directly broke two
        // invariants — (a) private buckets / private repos respond with
        // 401/404 because the URL isn't signed, and (b) it sidesteps the
        // owner-gated `UploadsController.serve` check that is the
        // documented access model. Always return the API-routed URL;
        // the controller reads through `backend.getObject(deriveKey(...))`
        // to do the actual fetch. Operators who want a CDN / public-bucket
        // direct URL can still introspect the active plugin themselves.
        // EW-644 (Codex P1, second-pass review): in `data-repo` mode the
        // backend encoded the resolved `workId` into the storage key
        // (`dr:<workId>:<path>`) and emitted a URL with `?workId=<id>`.
        // We override the backend URL to the canonical API route (above
        // PR #890 hardening), so we must propagate the `workId` query
        // string here — without it, the serve route's
        // `deriveKey(userId, filename, workId)` can't reconstruct the
        // `dr:<workId>:...` key and the upload's URL serves 500 / wrong
        // file. Backends that ignore `workId` (local-fs, S3, MinIO,
        // github-storage in mode `separate-repo`) are unaffected — the
        // query string is harmless extra metadata they don't read.
        const url = workId
            ? `/api/uploads/${encodeURIComponent(userId)}/${filename}?workId=${encodeURIComponent(workId)}`
            : `/api/uploads/${encodeURIComponent(userId)}/${filename}`;
        return {
            // `id` historically was the sha256 (object segment of the key).
            // Keep that shape for existing callers.
            id: hash,
            url,
            filename,
            size: file.size,
            mimeType: sniffed.mime,
            hash,
            // Keep the storage key around for callers that want to round-
            // trip via the IStoragePlugin abstraction (anonymous uploads
            // hand this back as `uploadId`).
            key,
        };
    }

    /**
     * Validate + persist an uploaded file of broader-than-image type.
     * Same security model as `saveImage` (magic-byte sniff for binaries,
     * UTF-8 shape check for text-like declared MIMEs, SHA-256 storage
     * naming, owner-scoped key, no part of the originalname reaches
     * storage) but the allow-list covers PDFs, ZIP / Office Open XML,
     * gzip, and the common text formats listed in `TEXT_LIKE_MIMES`.
     *
     * Used by `POST /api/uploads/file` (auth) and the PromptComposer's
     * "Upload a file" / "Upload a folder" affordances. Images can also
     * be uploaded here; they take the same magic-byte path saveImage
     * uses and end up at the same kind of storage key (just routed
     * through the broader allowlist).
     *
     * Returns the same `UploadResult` shape as `saveImage` so callers
     * can treat both endpoints uniformly. The `mimeType` field reflects
     * the **declared** MIME (since text formats can't be sniffed); the
     * `key` field is the backend-opaque storage key.
     */
    async saveFile(
        userId: string,
        file: Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'size' | 'originalname'>,
        opts?: { workId?: string },
    ): Promise<UploadResult> {
        this.assertValidUserId(userId);

        if (!file || !file.buffer || file.buffer.length === 0) {
            throw new BadRequestException({
                status: 'error',
                code: 'EmptyFile',
                message: 'No file content received',
            });
        }

        const maxFileSize = Number(process.env.UPLOADS_FILE_MAX_BYTES) || DEFAULT_MAX_FILE_SIZE;
        if (file.size > maxFileSize) {
            throw new BadRequestException({
                status: 'error',
                code: 'FileTooLarge',
                message: `File exceeds ${maxFileSize} byte cap`,
            });
        }

        const declared = (file.mimetype || '').toLowerCase();

        // Branch 1: binary type with a known magic-byte signature.
        // Includes images (delegated to the same path as saveImage for
        // uniformity) plus PDF / ZIP / gzip / Office Open XML.
        if (ALLOWED_FILE_BINARY_MIME.has(declared)) {
            const sniffed = this.sniffMagicBytes(file.buffer);
            if (!sniffed) {
                throw new BadRequestException({
                    status: 'error',
                    code: 'MimeMismatch',
                    message: `File has no recognized magic-byte signature`,
                });
            }
            // For Office Open XML, the underlying bytes are ZIP, so the
            // sniffed MIME is `application/zip` but the declared MIME is
            // the canonical Office MIME. Treat that as a match.
            const sniffedFamily = sniffed.mime;
            const declaredFamily = declared.startsWith(
                'application/vnd.openxmlformats-officedocument',
            )
                ? 'application/zip'
                : declared;
            if (sniffedFamily !== declaredFamily) {
                throw new BadRequestException({
                    status: 'error',
                    code: 'MimeMismatch',
                    message: `Declared Content-Type ${JSON.stringify(
                        declared,
                    )} does not match the file's magic bytes`,
                });
            }
            const hash = createHash('sha256').update(file.buffer).digest('hex');
            const filename = `${hash}.${sniffed.ext}`;
            const backend = await this.getBackend();
            const workId = opts?.workId;
            if (workId !== undefined) this.assertValidWorkId(workId);
            // For Office files the storage type is the ZIP (under-the-hood
            // format); the response echoes the declared MIME so the UI can
            // still show "Word document", not "ZIP archive".
            const { key } = await backend.putObject({
                buffer: file.buffer,
                filename,
                mimeType: sniffed.mime,
                size: file.size,
                ownerId: userId,
                ...(workId ? { workId } : {}),
            });
            await this.recordUpload({
                userId,
                sha256: hash,
                key,
                originalFilename: file.originalname,
                mimeType: declared,
                fileSize: file.size,
                workId,
            });
            const url = workId
                ? `/api/uploads/${encodeURIComponent(userId)}/${filename}?workId=${encodeURIComponent(workId)}`
                : `/api/uploads/${encodeURIComponent(userId)}/${filename}`;
            return {
                id: hash,
                url,
                filename,
                size: file.size,
                mimeType: declared, // echo declared MIME so Office docs read as such
                hash,
                key,
            };
        }

        // Branch 2: text-like declared MIME (no magic bytes to sniff).
        // Validate UTF-8 shape + absence of NUL bytes as a cheap "this
        // really is text" guard, then store under the canonical extension
        // mapped from the declared MIME.
        const textExt = TEXT_LIKE_MIMES.get(declared);
        if (textExt) {
            if (!looksLikeUtf8Text(file.buffer)) {
                throw new BadRequestException({
                    status: 'error',
                    code: 'NotTextContent',
                    message: `Declared Content-Type ${JSON.stringify(
                        declared,
                    )} but the buffer is not valid UTF-8 text (NUL bytes or invalid encoding)`,
                });
            }
            const hash = createHash('sha256').update(file.buffer).digest('hex');
            const filename = `${hash}.${textExt}`;
            const backend = await this.getBackend();
            const workId = opts?.workId;
            if (workId !== undefined) this.assertValidWorkId(workId);
            const { key } = await backend.putObject({
                buffer: file.buffer,
                filename,
                mimeType: declared,
                size: file.size,
                ownerId: userId,
                ...(workId ? { workId } : {}),
            });
            await this.recordUpload({
                userId,
                sha256: hash,
                key,
                originalFilename: file.originalname,
                mimeType: declared,
                fileSize: file.size,
                workId,
            });
            const url = workId
                ? `/api/uploads/${encodeURIComponent(userId)}/${filename}?workId=${encodeURIComponent(workId)}`
                : `/api/uploads/${encodeURIComponent(userId)}/${filename}`;
            return {
                id: hash,
                url,
                filename,
                size: file.size,
                mimeType: declared,
                hash,
                key,
            };
        }

        throw new BadRequestException({
            status: 'error',
            code: 'MimeNotAllowed',
            message: `Content-Type ${JSON.stringify(declared)} is not accepted for file uploads`,
        });
    }

    /**
     * Read a stored file's bytes + metadata for the file-serve route.
     * Refuses to serve outside the configured storage root even if the
     * caller hands us a path-traversal `..` segment.
     */
    async readFile(
        userId: string,
        filename: string,
        opts?: { workId?: string },
    ): Promise<{ buffer: Buffer; mimeType: string }> {
        this.assertValidUserId(userId);
        this.assertValidFilename(filename);
        const workId = opts?.workId;
        if (workId !== undefined) this.assertValidWorkId(workId);
        const backend = await this.getBackend();

        // Codex P1 finding on PR #890: don't hardcode the storage key
        // shape — each backend layers its own path prefix on top of
        // `<ownerId>/<filename>` (`uploads/...` for S3/MinIO/GitHub;
        // bare `<ownerId>/<filename>` for local-fs). Ask the plugin to
        // reconstruct its own canonical key from the URL segments. If
        // the plugin doesn't implement `deriveKey` (older third-party
        // backends, in-test mocks), fall back to the legacy shape so
        // existing local-fs setups keep working unchanged.
        //
        // EW-644: the optional `workId` arg is for backends that store
        // per-Work — `github-storage` in `data-repo` mode encodes it
        // into the key so `getObject` knows which Work's repo to read
        // from. Backends that don't care ignore it.
        const key = backend.deriveKey
            ? backend.deriveKey(userId, filename, workId)
            : `${userId}/${filename}`;

        let result: { buffer: Buffer; mimeType: string };
        try {
            result = await backend.getObject(key);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/not found/i.test(msg) || /ENOENT/i.test(msg)) {
                throw new NotFoundException({ status: 'error', message: 'Upload not found' });
            }
            throw err;
        }

        // Re-sniff the magic bytes on read — this is what the original
        // implementation did for all backends, and it's a defense against
        // a malicious storage backend (or operator misconfig) handing back
        // bytes whose Content-Type metadata doesn't match the payload.
        const sniffed = this.sniffMagicBytes(result.buffer);
        const rawMimeType = sniffed?.mime ?? result.mimeType ?? 'application/octet-stream';
        // Security: defense-in-depth against serving attacker-uploaded
        // active content with its renderable MIME. `saveFile`'s text
        // allow-list (TEXT_LIKE_MIMES) admits text/html, text/css and
        // (application/)javascript, which a browser would render / execute
        // if a downstream tier ever served them inline with their real
        // Content-Type. The serve controller already collapses these (and
        // pins a strict CSP + nosniff), but we also neutralize them at the
        // service boundary so NO caller of `readFile` can ever obtain an
        // active Content-Type for stored bytes. Images / JSON / markdown /
        // PDFs and every other type pass through untouched.
        const baseMime = rawMimeType.split(';')[0].trim().toLowerCase();
        const mimeType = ACTIVE_RENDERABLE_MIMES.has(baseMime)
            ? 'application/octet-stream'
            : rawMimeType;
        return { buffer: result.buffer, mimeType };
    }

    private sniffMagicBytes(buf: Buffer): { mime: string; ext: string } | null {
        for (const sig of MAGIC_BYTES) {
            const offset = sig.offset ?? 0;
            if (buf.length < offset + sig.bytes.length) continue;
            let ok = true;
            for (let i = 0; i < sig.bytes.length; i++) {
                const expected = sig.bytes[i];
                if (expected === null) continue;
                if (buf[offset + i] !== expected) {
                    ok = false;
                    break;
                }
            }
            if (ok) return { mime: sig.mime, ext: sig.ext };
        }
        return null;
    }

    private assertValidWorkId(workId: string): void {
        // Works use UUIDv4 — accept any UUID shape. Belt-and-suspenders
        // check: refuse anything with path separators or control chars
        // so a malicious caller can't smuggle a non-UUID through into
        // the backend layer.
        if (
            !workId ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workId)
        ) {
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidWorkId',
                message: 'Invalid workId',
            });
        }
    }

    private assertValidUserId(userId: string): void {
        // userIds are UUIDv4 in this codebase. Reject anything with path
        // separators / null bytes / control characters to keep the
        // storage-key construction honest.
        if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidUserId',
                message: 'Invalid user id',
            });
        }
    }

    private assertValidFilename(filename: string): void {
        // Only allow `<hex64>.<ext>` shapes — same format saveImage /
        // saveFile write. Anything else is invalid by construction. The
        // extension list is the union of image extensions (saveImage)
        // and file extensions (saveFile) since this method gates the
        // serve route for both.
        const extPattern = ALL_VALID_EXTS.join('|');
        const filenameRe = new RegExp(`^[a-f0-9]{64}\\.(${extPattern})$`);
        if (!filename || !filenameRe.test(filename)) {
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidFilename',
                message: 'Invalid filename',
            });
        }
        // Defensive: although the regex above already restricts to
        // canonical hash-named files, extract the extension here as a
        // belt-and-suspenders check — a malicious key would have to slip
        // past the regex to reach this point. Throw on anything unexpected.
        const ext = extname(filename).toLowerCase();
        if (!ALL_VALID_EXTS.map((e) => `.${e}`).includes(ext)) {
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidFilename',
                message: 'Invalid filename',
            });
        }
    }
}
