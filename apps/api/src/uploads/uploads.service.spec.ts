import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFsStoragePlugin } from '@ever-works/local-fs-plugin';
import type { PluginContext } from '@ever-works/plugin';
import { UploadsService } from './uploads.service';

// Minimal stub matching what the storage-backend factory hands plugins
// at boot — only the logger is read by LocalFsStoragePlugin.onLoad().
const stubContext = (id: string): PluginContext => {
    const log = new Logger(`StoragePlugin/${id}`);
    return {
        pluginId: id,
        logger: {
            log: (m: string) => log.log(m),
            error: (m: string) => log.error(m),
            warn: (m: string) => log.warn(m),
            debug: (m: string) => log.debug(m),
        },
    } as unknown as PluginContext;
};

const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64',
);
const TINY_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]);
const TINY_GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00]);
const TINY_WEBP = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x14, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 abcdefgh', 'ascii'),
]);

const fakeFile = (
    overrides: Partial<{ buffer: Buffer; mimetype: string; size: number; originalname: string }>,
): Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'size' | 'originalname'> => ({
    buffer: overrides.buffer ?? TINY_PNG,
    mimetype: overrides.mimetype ?? 'image/png',
    size: overrides.size ?? (overrides.buffer ?? TINY_PNG).length,
    originalname: overrides.originalname ?? 'probe.png',
});

describe('UploadsService', () => {
    let root: string;
    let service: UploadsService;
    const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    beforeEach(async () => {
        root = resolve(
            tmpdir(),
            `ever-works-uploads-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        process.env.UPLOADS_DIR = root;
        delete process.env.UPLOADS_MAX_BYTES;
        // EW-637 — inject a fresh local-fs storage plugin so each test
        // sees the new UPLOADS_DIR. Plugins are lazy in production via
        // getActiveStorageBackend(); tests skip the env-resolution cache
        // by passing the plugin directly to the service constructor.
        const backend = new LocalFsStoragePlugin();
        await backend.onLoad(stubContext('local-fs'));
        service = new UploadsService(backend);
    });

    afterEach(async () => {
        try {
            await fs.rm(root, { recursive: true, force: true });
        } catch {
            // tolerate cleanup failure on locked files
        }
        delete process.env.UPLOADS_DIR;
        delete process.env.UPLOADS_MAX_BYTES;
    });

    describe('saveImage — happy paths', () => {
        it('saves a PNG and returns canonical reference shape', async () => {
            const r = await service.saveImage(userId, fakeFile({}));
            expect(r).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    url: expect.stringContaining(`/api/uploads/${userId}/`),
                    filename: expect.stringMatching(/^[a-f0-9]{64}\.png$/),
                    size: TINY_PNG.length,
                    mimeType: 'image/png',
                    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
            );
            // The file should actually exist on disk.
            const stat = await fs.stat(join(root, userId, r.filename));
            expect(stat.size).toBe(TINY_PNG.length);
        });

        it('saves a JPEG', async () => {
            const r = await service.saveImage(
                userId,
                fakeFile({ buffer: TINY_JPEG, mimetype: 'image/jpeg' }),
            );
            expect(r.mimeType).toBe('image/jpeg');
            expect(r.filename).toMatch(/^[a-f0-9]{64}\.jpg$/);
        });

        it('saves a GIF', async () => {
            const r = await service.saveImage(
                userId,
                fakeFile({ buffer: TINY_GIF, mimetype: 'image/gif' }),
            );
            expect(r.mimeType).toBe('image/gif');
        });

        it('saves a WEBP', async () => {
            const r = await service.saveImage(
                userId,
                fakeFile({ buffer: TINY_WEBP, mimetype: 'image/webp' }),
            );
            expect(r.mimeType).toBe('image/webp');
        });

        it('produces deterministic filenames for identical inputs (sha256-keyed)', async () => {
            const r1 = await service.saveImage(userId, fakeFile({}));
            const r2 = await service.saveImage(userId, fakeFile({}));
            expect(r1.filename).toBe(r2.filename);
            expect(r1.hash).toBe(r2.hash);
        });

        it('isolates files by userId — different users get different paths', async () => {
            const otherUser = 'ffffffff-1111-2222-3333-444444444444';
            const a = await service.saveImage(userId, fakeFile({}));
            const b = await service.saveImage(otherUser, fakeFile({}));
            expect(a.url).toContain(userId);
            expect(b.url).toContain(otherUser);
            expect(a.url).not.toBe(b.url);
            // Verify on disk too — separate directories.
            await expect(fs.stat(join(root, userId, a.filename))).resolves.toBeDefined();
            await expect(fs.stat(join(root, otherUser, b.filename))).resolves.toBeDefined();
        });
    });

    describe('saveImage — rejection paths', () => {
        it('rejects empty buffer', async () => {
            await expect(
                service.saveImage(userId, fakeFile({ buffer: Buffer.alloc(0), size: 0 })),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects when declared MIME is not in the allow-list (no SVG, no octet-stream)', async () => {
            await expect(
                service.saveImage(
                    userId,
                    fakeFile({ buffer: TINY_PNG, mimetype: 'application/octet-stream' }),
                ),
            ).rejects.toThrow(/not in the allow-list/);
            await expect(
                service.saveImage(
                    userId,
                    fakeFile({
                        buffer: Buffer.from('<svg><script>alert(1)</script></svg>'),
                        mimetype: 'image/svg+xml',
                    }),
                ),
            ).rejects.toThrow(/not in the allow-list/);
        });

        it('rejects when declared MIME does not match the actual magic bytes (content-type lying)', async () => {
            // text body claiming to be image/png
            await expect(
                service.saveImage(
                    userId,
                    fakeFile({
                        buffer: Buffer.from('this is plain text masquerading as a png'),
                        mimetype: 'image/png',
                    }),
                ),
            ).rejects.toThrow(/does not match the file's magic bytes/);

            // .exe payload labeled image/png
            await expect(
                service.saveImage(
                    userId,
                    fakeFile({
                        buffer: Buffer.from('MZ\x90\x00executable-payload'),
                        mimetype: 'image/png',
                    }),
                ),
            ).rejects.toThrow(/does not match the file's magic bytes/);
        });

        it('rejects oversized files', async () => {
            process.env.UPLOADS_MAX_BYTES = '100';
            const localBackend = new LocalFsStoragePlugin();
            await localBackend.onLoad(stubContext('local-fs'));
            const s = new UploadsService(localBackend);
            const big = Buffer.concat([TINY_PNG, Buffer.alloc(200)]);
            await expect(
                s.saveImage(userId, {
                    buffer: big,
                    mimetype: 'image/png',
                    size: big.length,
                    originalname: 'big.png',
                }),
            ).rejects.toThrow(/byte cap/);
        });

        it('rejects invalid userId (path traversal in user segment)', async () => {
            await expect(service.saveImage('../../../etc', fakeFile({}))).rejects.toThrow(
                /Invalid user id/,
            );
            await expect(service.saveImage('user/../escape', fakeFile({}))).rejects.toThrow(
                /Invalid user id/,
            );
            await expect(service.saveImage('', fakeFile({}))).rejects.toThrow(/Invalid user id/);
        });

        it('never stores the client-supplied originalname on disk (path-traversal defense)', async () => {
            const r = await service.saveImage(
                userId,
                fakeFile({ originalname: '../../../etc/passwd' }),
            );
            // Filename is the sha256 hash + extension, NOT the originalname.
            expect(r.filename).not.toContain('..');
            expect(r.filename).not.toContain('passwd');
            expect(r.filename).toMatch(/^[a-f0-9]{64}\.png$/);
        });
    });

    describe('saveImage — workId threading (EW-644)', () => {
        // Capture the StoragePutInput the active backend receives so we
        // can assert the workId field is set / unset / validated. Uses
        // a tiny spy backend instead of LocalFs because we only care
        // about what got handed to putObject.
        const captured: Array<{ workId?: string }> = [];
        let spyBackend: {
            id: string;
            name: string;
            version: string;
            category: string;
            capabilities: readonly string[];
            providerName: string;
            putObject: (input: { workId?: string }) => Promise<{ key: string; url: string }>;
            getObject: () => Promise<{ buffer: Buffer; mimeType: string }>;
            deleteObject: () => Promise<void>;
            isAvailable: () => Promise<boolean>;
            onLoad: () => Promise<void>;
            onUnload?: () => Promise<void>;
            getManifest?: () => unknown;
        };
        let svc: UploadsService;

        beforeEach(() => {
            captured.length = 0;
            spyBackend = {
                id: 'spy',
                name: 'spy',
                version: '0.0.0',
                category: 'storage',
                capabilities: ['put-object', 'get-object'],
                providerName: 'spy',
                async putObject(input) {
                    captured.push({ workId: input.workId });
                    return { key: 'spy-key', url: '/api/uploads/x/y.png' };
                },
                async getObject() {
                    return { buffer: Buffer.from(''), mimeType: 'image/png' };
                },
                async deleteObject() {
                    /* noop */
                },
                async isAvailable() {
                    return true;
                },
                async onLoad() {
                    /* noop */
                },
            };
            svc = new UploadsService(spyBackend as never);
        });

        it('does not set workId on the backend by default', async () => {
            await svc.saveImage(userId, fakeFile({}));
            expect(captured).toHaveLength(1);
            expect(captured[0].workId).toBeUndefined();
        });

        it('threads a valid UUID workId through to the backend', async () => {
            const workId = '11111111-2222-3333-4444-555555555555';
            await svc.saveImage(userId, fakeFile({}), { workId });
            expect(captured[0].workId).toBe(workId);
        });

        it('propagates workId into the returned URL as a ?workId= query (EW-644 Codex P1 #3)', async () => {
            // Without this, github-storage `data-repo` keys (dr:<workId>:...)
            // can't be reconstructed on the serve route.
            const workId = '22222222-3333-4444-5555-666666666666';
            const out = await svc.saveImage(userId, fakeFile({}), { workId });
            expect(out.url).toMatch(/\?workId=22222222-3333-4444-5555-666666666666$/);
        });

        it('does not add a workId query string when no workId is provided', async () => {
            const out = await svc.saveImage(userId, fakeFile({}));
            expect(out.url).not.toContain('workId=');
        });

        it('rejects a malformed workId before reaching the backend', async () => {
            await expect(
                svc.saveImage(userId, fakeFile({}), { workId: 'not-a-uuid' }),
            ).rejects.toThrow(/Invalid workId/);
            expect(captured).toHaveLength(0);
        });
    });

    describe('readFile', () => {
        it('round-trips bytes for the owner', async () => {
            const r = await service.saveImage(userId, fakeFile({}));
            const { buffer, mimeType } = await service.readFile(userId, r.filename);
            expect(buffer.equals(TINY_PNG)).toBe(true);
            expect(mimeType).toBe('image/png');
        });

        it('returns 404 (NotFoundException) for a missing file', async () => {
            const fake = `${'a'.repeat(64)}.png`;
            await expect(service.readFile(userId, fake)).rejects.toThrow(NotFoundException);
        });

        it('refuses invalid filenames', async () => {
            await expect(service.readFile(userId, '../escape.png')).rejects.toThrow(
                /Invalid filename/,
            );
            await expect(service.readFile(userId, 'something.exe')).rejects.toThrow(
                /Invalid filename/,
            );
            await expect(service.readFile(userId, '/etc/passwd')).rejects.toThrow(
                /Invalid filename/,
            );
        });

        it('refuses invalid userIds', async () => {
            const fake = `${'a'.repeat(64)}.png`;
            await expect(service.readFile('../bad', fake)).rejects.toThrow(/Invalid user id/);
        });

        it("cannot read another user's file even with their userId — path enforcement", async () => {
            const otherUser = 'ffffffff-1111-2222-3333-444444444444';
            const r = await service.saveImage(otherUser, fakeFile({}));
            // The file exists on disk under otherUser. Reading via userId
            // (a different folder) must 404 — files are physically isolated.
            await expect(service.readFile(userId, r.filename)).rejects.toThrow(NotFoundException);
            // Sanity: it IS readable under the actual owner.
            const { buffer } = await service.readFile(otherUser, r.filename);
            expect(buffer.equals(TINY_PNG)).toBe(true);
        });

        // Codex P1 follow-up to PR #890: prove that readFile asks the active
        // backend to derive its own canonical key instead of hardcoding the
        // legacy `<ownerId>/<filename>` shape. Without deriveKey, S3-prefixed
        // backends would 404 every read for a file they successfully wrote.
        it('uses backend.deriveKey() when present, not the legacy <user>/<file> shape', async () => {
            const calls: { put: string[]; get: string[]; derive: Array<[string, string]> } = {
                put: [],
                get: [],
                derive: [],
            };
            const fakeBackend = {
                providerName: 'fake-prefixed',
                async putObject(input: { ownerId?: string; filename: string; buffer: Buffer }) {
                    // Mirrors the AWS S3 plugin: prefix every key with `uploads/`.
                    const key = `uploads/${input.ownerId}/${input.filename}`;
                    calls.put.push(key);
                    return { key, url: 's3://ignored-by-service' };
                },
                async getObject(key: string) {
                    calls.get.push(key);
                    // Only the prefixed shape exists on this backend.
                    if (!key.startsWith('uploads/')) {
                        throw new Error('not found');
                    }
                    return { buffer: TINY_PNG, mimeType: 'image/png' };
                },
                async deleteObject() {},
                async isAvailable() {
                    return true;
                },
                deriveKey(ownerId: string, filename: string) {
                    calls.derive.push([ownerId, filename]);
                    return `uploads/${ownerId}/${filename}`;
                },
            };
            const svc = new UploadsService(fakeBackend as never);
            const r = await svc.saveImage(userId, fakeFile({}));

            // Codex P1 #2: response URL is the API-routed path regardless of
            // what the backend's putObject returned. Private buckets and
            // owner-gated reads depend on this.
            expect(r.url).toBe(`/api/uploads/${userId}/${r.filename}`);
            expect(r.url).not.toContain('s3://');

            // Round-trip the read; without deriveKey() the service would
            // hand `<user>/<file>` to getObject and the backend would 404.
            const { buffer } = await svc.readFile(userId, r.filename);
            expect(buffer.equals(TINY_PNG)).toBe(true);
            expect(calls.derive).toEqual([[userId, r.filename]]);
            expect(calls.get).toEqual([`uploads/${userId}/${r.filename}`]);
        });

        // Codex P1 #1 fallback path: a backend without deriveKey (older
        // third-party plugins, ad-hoc test doubles) keeps working via the
        // legacy `<ownerId>/<filename>` shape. local-fs uses exactly that
        // key, so removing its deriveKey override should not change reads.
        it('falls back to <user>/<file> when backend does not implement deriveKey', async () => {
            const lastSeenKey: string[] = [];
            const backendNoDerive = {
                providerName: 'fake-bare',
                async putObject(input: { ownerId?: string; filename: string }) {
                    const key = `${input.ownerId}/${input.filename}`;
                    return { key, url: '/api/uploads/whatever' };
                },
                async getObject(key: string) {
                    lastSeenKey.push(key);
                    return { buffer: TINY_PNG, mimeType: 'image/png' };
                },
                async deleteObject() {},
                async isAvailable() {
                    return true;
                },
                // intentionally NO deriveKey
            };
            const svc = new UploadsService(backendNoDerive as never);
            const r = await svc.saveImage(userId, fakeFile({}));
            await svc.readFile(userId, r.filename);
            expect(lastSeenKey).toEqual([`${userId}/${r.filename}`]);
        });
    });
});
