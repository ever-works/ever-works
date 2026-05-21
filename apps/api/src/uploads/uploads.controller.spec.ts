// EW-637 — UploadsController transitively imports AnonymousAuthService,
// which pulls in @ever-works/agent/database (TypeORM repositories). The
// database module's @src/config alias is resolvable in the API runtime
// but not in this isolated jest context, so we mock the agent surface
// the same way auth.controller.spec.ts does.
jest.mock('@ever-works/agent/database', () => ({}));

import { BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { LocalFsStoragePlugin } from '@ever-works/local-fs-plugin';
import type { PluginContext } from '@ever-works/plugin';
import type { AnonymousAuthService } from '../auth/services/anonymous-auth.service';
import type { AuthProvider } from '../auth/providers/auth-provider.abstract';
import type { AuthenticatedUser } from '../auth/types/auth.types';

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

const mkAuth = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
    ({
        userId: overrides.userId ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        email: 'u@example.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    }) as AuthenticatedUser;

const mkFile = (
    overrides: Partial<{
        buffer: Buffer;
        mimetype: string;
        size: number;
        originalname: string;
    }> = {},
): Express.Multer.File =>
    ({
        buffer: overrides.buffer ?? TINY_PNG,
        mimetype: overrides.mimetype ?? 'image/png',
        size: overrides.size ?? (overrides.buffer ?? TINY_PNG).length,
        originalname: overrides.originalname ?? 'probe.png',
        fieldname: 'file',
        encoding: '7bit',
        destination: '',
        filename: '',
        path: '',
        stream: undefined as any,
    }) as Express.Multer.File;

const mkRes = () => {
    const calls: {
        statusCode?: number;
        body?: unknown;
        headers: Record<string, string | number>;
        sent?: Buffer | string;
    } = { headers: {} };
    const res = {
        status(code: number) {
            calls.statusCode = code;
            return res;
        },
        setHeader(name: string, value: string | number) {
            calls.headers[name] = value;
        },
        json(body: unknown) {
            calls.body = body;
        },
        send(body: string | Buffer) {
            calls.sent = body;
        },
    };
    return { res, calls };
};

describe('UploadsController', () => {
    let root: string;
    let controller: UploadsController;
    let service: UploadsService;

    beforeEach(async () => {
        root = resolve(
            tmpdir(),
            `ever-works-uploads-ctl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        process.env.UPLOADS_DIR = root;
        delete process.env.UPLOADS_MAX_BYTES;
        const backend = new LocalFsStoragePlugin();
        await backend.onLoad(stubContext('local-fs'));
        service = new UploadsService(backend);
        // The anonymous-auth service is only invoked by /anonymous and
        // /presign endpoints — pass a stub that throws if these tests
        // ever exercise it accidentally.
        const anonStub = {
            createAnonymousUser: () => {
                throw new Error('AnonymousAuthService stub: not expected in these tests');
            },
        } as unknown as AnonymousAuthService;
        // AuthProvider is consumed by `tryAuthenticate` on the @Public()
        // upload routes (Codex P2 follow-up). These auth-required tests
        // never hit that path, so we hand it a stub that returns null
        // (treated as "no session present" by the controller).
        const authProviderStub = {
            authenticate: async () => null,
        } as unknown as AuthProvider;
        controller = new UploadsController(service, anonStub, authProviderStub);
    });

    afterEach(async () => {
        try {
            await fs.rm(root, { recursive: true, force: true });
        } catch {
            // tolerate
        }
        delete process.env.UPLOADS_DIR;
    });

    describe('POST /api/uploads', () => {
        it('rejects when no file is attached (400)', async () => {
            await expect(controller.upload(mkAuth(), undefined)).rejects.toThrow(
                BadRequestException,
            );
        });

        it('accepts a valid PNG and returns canonical reference shape', async () => {
            const r = await controller.upload(mkAuth(), mkFile({}));
            expect(r.url).toContain('/api/uploads/');
            expect(r.mimeType).toBe('image/png');
            expect(r.id).toMatch(/^[a-f0-9]{64}$/);
        });

        it('forwards a Content-Type lie up as a 400 from the service', async () => {
            await expect(
                controller.upload(
                    mkAuth(),
                    mkFile({ buffer: Buffer.from('plain text'), mimetype: 'image/png' }),
                ),
            ).rejects.toThrow(BadRequestException);
        });

        it('delegate alias /api/uploads/image returns identical shape', async () => {
            const r = await controller.uploadImage(mkAuth(), mkFile({}));
            expect(r.mimeType).toBe('image/png');
            expect(r.url).toContain('/api/uploads/');
        });
    });

    describe('GET /api/uploads/:userId/:filename', () => {
        it("refuses to serve another user's file (returns 404 — never 200 / never leaks)", async () => {
            const owner = mkAuth({ userId: 'ffffffff-1111-2222-3333-444444444444' });
            const stored = await controller.upload(owner, mkFile({}));
            const stranger = mkAuth({ userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
            const { res, calls } = mkRes();
            await controller.serve(stranger, owner.userId, stored.filename, res);
            expect(calls.statusCode).toBe(HttpStatus.NOT_FOUND);
            // Body must NOT contain the file bytes.
            expect(calls.sent).toBeUndefined();
            expect(typeof calls.body).toBe('object');
        });

        it("serves the owner's own file with the sniffed Content-Type and inline disposition", async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const { res, calls } = mkRes();
            await controller.serve(owner, owner.userId, stored.filename, res);
            expect(calls.headers['Content-Type']).toBe('image/png');
            expect(calls.headers['Content-Length']).toBe(TINY_PNG.length);
            expect(calls.headers['Content-Disposition']).toBe(
                `inline; filename="${stored.filename}"`,
            );
            expect(Buffer.isBuffer(calls.sent)).toBe(true);
            expect((calls.sent as Buffer).equals(TINY_PNG)).toBe(true);
        });
    });
});
