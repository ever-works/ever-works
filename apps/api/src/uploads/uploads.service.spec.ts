import { BadRequestException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { UploadsService } from './uploads.service';

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
        service = new UploadsService();
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
            const s = new UploadsService();
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
    });
});
