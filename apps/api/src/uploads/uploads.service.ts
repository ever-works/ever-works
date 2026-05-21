import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { IStoragePlugin } from '@ever-works/plugin';
import { getActiveStorageBackend } from './storage-backend.factory';

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
];

/**
 * Allow-list of accepted MIME families. Anything outside this list is
 * rejected unconditionally. SVG is INTENTIONALLY excluded — it can
 * carry inline `<script>` payloads that would execute if a downstream
 * tier ever serves it inline with `Content-Type: image/svg+xml` to a
 * browser. If you need SVG support, route through a sanitizer (DOMPurify
 * with `USE_PROFILES: { svg: true }`) and add a `image/svg+xml`
 * `sanitized` variant — do NOT just add it here.
 */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MiB

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

    constructor(backend?: IStoragePlugin) {
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
            this.backendPromise = getActiveStorageBackend();
        }
        return this.backendPromise;
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
        const { key } = await backend.putObject({
            buffer: file.buffer,
            filename,
            mimeType: sniffed.mime,
            size: file.size,
            ownerId: userId,
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
        return {
            // `id` historically was the sha256 (object segment of the key).
            // Keep that shape for existing callers.
            id: hash,
            url: `/api/uploads/${encodeURIComponent(userId)}/${filename}`,
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
     * Read a stored file's bytes + metadata for the file-serve route.
     * Refuses to serve outside the configured storage root even if the
     * caller hands us a path-traversal `..` segment.
     */
    async readFile(
        userId: string,
        filename: string,
    ): Promise<{ buffer: Buffer; mimeType: string }> {
        this.assertValidUserId(userId);
        this.assertValidFilename(filename);
        const backend = await this.getBackend();

        // Codex P1 finding on PR #890: don't hardcode the storage key
        // shape — each backend layers its own path prefix on top of
        // `<ownerId>/<filename>` (`uploads/...` for S3/MinIO/GitHub;
        // bare `<ownerId>/<filename>` for local-fs). Ask the plugin to
        // reconstruct its own canonical key from the URL segments. If
        // the plugin doesn't implement `deriveKey` (older third-party
        // backends, in-test mocks), fall back to the legacy shape so
        // existing local-fs setups keep working unchanged.
        const key = backend.deriveKey
            ? backend.deriveKey(userId, filename)
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
        const mimeType = sniffed?.mime ?? result.mimeType ?? 'application/octet-stream';
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
        // Only allow `<hex64>.<ext>` shapes — same format saveImage
        // writes. Anything else is invalid by construction.
        if (!filename || !/^[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/.test(filename)) {
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidFilename',
                message: 'Invalid filename',
            });
        }
        // Defensive: although the regex above already restricts to
        // canonical hash-named files, extract the extension here as a
        // belt-and-suspenders check — the spec uses both alphanumeric and
        // dot characters and a malicious key would have to slip past the
        // regex to reach this point. Throw on anything unexpected.
        const ext = extname(filename).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidFilename',
                message: 'Invalid filename',
            });
        }
    }
}
