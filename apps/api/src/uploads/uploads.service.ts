import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';

export interface UploadResult {
    id: string;
    url: string;
    filename: string;
    size: number;
    mimeType: string;
    hash: string;
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

@Injectable()
export class UploadsService {
    private readonly logger = new Logger(UploadsService.name);
    private readonly storageRoot: string;
    private readonly maxSize: number;

    constructor() {
        // `UPLOADS_DIR` is an operator-controlled absolute path; default
        // to a per-process tmp dir so dev / CI work out of the box and
        // never collide with another instance.
        this.storageRoot = resolve(process.env.UPLOADS_DIR || join(tmpdir(), 'ever-works-uploads'));
        this.maxSize = Number(process.env.UPLOADS_MAX_BYTES) || DEFAULT_MAX_SIZE;
    }

    /**
     * Validate + persist an uploaded image. Returns the canonical
     * reference shape (id + url + metadata). Throws BadRequestException
     * for any validation failure — never lets bad bytes hit disk.
     *
     * Security properties pinned by the test suite:
     *  - MIME must be in the allow-list (no SVG, no octet-stream)
     *  - Magic bytes MUST match the declared MIME (no lying)
     *  - Size must be <= configured max
     *  - Storage path is user-scoped so a stranger can never see / overwrite
     *    another user's files even if they guess the filename
     *  - Filename is derived from the SHA-256 of the bytes; no part of
     *    the client-supplied originalname reaches disk (defeats path
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
        const userDir = this.userDir(userId);
        await fs.mkdir(userDir, { recursive: true });
        const absPath = this.resolveSafe(userDir, filename);
        await fs.writeFile(absPath, file.buffer, { flag: 'w' });

        const url = `/api/uploads/${encodeURIComponent(userId)}/${filename}`;
        return {
            id: hash,
            url,
            filename,
            size: file.size,
            mimeType: sniffed.mime,
            hash,
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
        const userDir = this.userDir(userId);
        const absPath = this.resolveSafe(userDir, filename);
        let buffer: Buffer;
        try {
            buffer = await fs.readFile(absPath);
        } catch (err) {
            // Either the user-scoped directory or the file inside it
            // doesn't exist — surface as 404 rather than letting ENOENT
            // bubble up as a 500.
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                throw new NotFoundException({ status: 'error', message: 'Upload not found' });
            }
            throw err;
        }
        const sniffed = this.sniffMagicBytes(buffer);
        const mimeType = sniffed?.mime ?? 'application/octet-stream';
        return { buffer, mimeType };
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

    private userDir(userId: string): string {
        return resolve(this.storageRoot, userId);
    }

    /**
     * Resolve `filename` under `userDir`, then re-check it really IS
     * still under `userDir`. Defeats `..` segments and absolute paths.
     */
    private resolveSafe(userDir: string, filename: string): string {
        const candidate = resolve(userDir, filename);
        const userDirNorm = normalize(userDir + sep);
        const candidateNorm = normalize(candidate);
        if (!candidateNorm.startsWith(userDirNorm)) {
            // Path traversal attempt — the resolve() output escaped the
            // user-scoped directory. Refuse loudly.
            throw new BadRequestException({
                status: 'error',
                code: 'InvalidPath',
                message: 'Resolved path escapes user storage root',
            });
        }
        return candidate;
    }

    private assertValidUserId(userId: string): void {
        // userIds are UUIDv4 in this codebase. Reject anything with path
        // separators / null bytes / control characters to keep the
        // resolveSafe check honest.
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
    }
}
