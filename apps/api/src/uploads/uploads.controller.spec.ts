// EW-637 — UploadsController transitively imports AnonymousAuthService,
// which pulls in @ever-works/agent/database (TypeORM repositories). The
// database module's @src/config alias is resolvable in the API runtime
// but not in this isolated jest context, so we mock the agent surface
// the same way auth.controller.spec.ts does.
jest.mock('@ever-works/agent/database', () => ({
    UserUploadRepository: class {},
    WorkRepository: class {},
    UserRepository: class {},
    OrganizationRepository: class {},
    OrganizationMemberRepository: class {},
    TenantRepository: class {},
    ownershipScopeMatches: (
        row: { tenantId?: string | null; organizationId?: string | null },
        scope?: { tenantId: string | null; organizationId: string | null },
    ) => {
        if (!scope) return true;
        const tenantId = row.tenantId ?? null;
        const organizationId = row.organizationId ?? null;
        if (scope.organizationId) {
            return tenantId === scope.tenantId && organizationId === scope.organizationId;
        }
        return (
            organizationId === null &&
            (tenantId === scope.tenantId || (scope.tenantId !== null && tenantId === null))
        );
    },
}));

import {
    BadRequestException,
    HttpStatus,
    Logger,
    NotFoundException,
    NotImplementedException,
} from '@nestjs/common';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
    UserUploadRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { LocalFsStoragePlugin } from '@ever-works/local-fs-plugin';
import type { PluginContext } from '@ever-works/plugin';
import type { AnonymousAuthService } from '../auth/services/anonymous-auth.service';
import type { AuthProvider } from '../auth/providers/auth-provider.abstract';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';

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
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const yoScope = {
        tenantId: everScope.tenantId,
        organizationId: '33333333-3333-4333-8333-333333333333',
    };
    const workId = '44444444-4444-4444-8444-444444444444';

    it('declares concrete Nest injection tokens for optional ownership repositories', () => {
        const tokens = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, UploadsController) ?? [];

        expect(tokens).toEqual(
            expect.arrayContaining([
                { index: 3, param: WorkRepository },
                { index: 4, param: UserUploadRepository },
                { index: 6, param: UserRepository },
                { index: 7, param: OrganizationRepository },
                { index: 8, param: OrganizationMemberRepository },
                { index: 9, param: TenantRepository },
            ]),
        );
        expect(Reflect.getMetadata('design:paramtypes', UploadsController)[5]).toBe(
            ScopeContextService,
        );
    });

    describe('public upload routes — bearer-aware scope hydration', () => {
        const bearerUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const yoMemberId = bearerUserId;
        const fileResult = {
            id: 'a'.repeat(64),
            url: `/api/uploads/${bearerUserId}/${'a'.repeat(64)}.png`,
            filename: `${'a'.repeat(64)}.png`,
            size: TINY_PNG.length,
            mimeType: 'image/png',
            hash: 'a'.repeat(64),
            key: `${bearerUserId}/${'a'.repeat(64)}.png`,
        };

        function publicController(options: {
            activeScope: { tenantId: string | null; organizationId: string | null };
            bearer?: boolean;
            authRejects?: boolean;
            user?: object | null;
            organization?: object | null;
            member?: object | null;
            tenant?: object | null;
            apiKey?: boolean;
        }) {
            const uploads = {
                saveImage: jest.fn().mockResolvedValue(fileResult),
                saveFile: jest.fn().mockResolvedValue(fileResult),
                getBackend: jest.fn().mockResolvedValue({
                    presignPut: jest.fn().mockResolvedValue({
                        url: 'https://storage.test/put',
                        key: `${bearerUserId}/direct.png`,
                        expiresAt: '2099-01-01T00:00:00.000Z',
                    }),
                }),
            };
            const anonymousAuth = {
                createAnonymousUser: jest.fn().mockResolvedValue({
                    user: {
                        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                        anonymousExpiresAt: '2099-01-01T00:00:00.000Z',
                    },
                    access_token: 'anon-token',
                }),
            };
            const authProvider = {
                authenticate: options.authRejects
                    ? jest.fn().mockRejectedValue(new Error('invalid bearer'))
                    : jest
                          .fn()
                          .mockResolvedValue(
                              options.bearer ? mkAuth({ userId: bearerUserId }) : null,
                          ),
            };
            const scopeContext = {
                getScope: jest.fn().mockReturnValue(options.activeScope),
                setScope: jest.fn(),
            };
            const users = {
                findById: jest
                    .fn()
                    .mockResolvedValue(
                        options.user === undefined
                            ? { id: bearerUserId, tenantId: everScope.tenantId, isActive: true }
                            : options.user,
                    ),
            };
            const organizations = {
                findById: jest
                    .fn()
                    .mockResolvedValue(
                        options.organization === undefined
                            ? { id: everScope.organizationId, tenantId: everScope.tenantId }
                            : options.organization,
                    ),
            };
            const members = {
                findByOrgAndUser: jest.fn().mockResolvedValue(
                    options.member === undefined
                        ? {
                              userId: bearerUserId,
                              tenantId: everScope.tenantId,
                              organizationId: everScope.organizationId,
                          }
                        : options.member,
                ),
            };
            const tenants = {
                findById: jest
                    .fn()
                    .mockResolvedValue(
                        options.tenant === undefined
                            ? { id: everScope.tenantId, ownerUserId: 'owner-other' }
                            : options.tenant,
                    ),
            };
            const apiKeys = {
                validateKey: jest
                    .fn()
                    .mockResolvedValue(
                        options.apiKey ? { id: 'key-1', userId: bearerUserId } : null,
                    ),
            };
            const scopedController = new (UploadsController as any)(
                uploads,
                anonymousAuth,
                authProvider,
                undefined,
                undefined,
                scopeContext,
                users,
                organizations,
                members,
                tenants,
                apiKeys,
            ) as UploadsController;
            const req = {
                headers: options.apiKey
                    ? { 'x-api-key': 'ew_live_test-key' }
                    : options.bearer || options.authRejects
                      ? { authorization: 'Bearer token' }
                      : {},
            } as never;
            return {
                controller: scopedController,
                uploads,
                anonymousAuth,
                authProvider,
                scopeContext,
                users,
                organizations,
                members,
                tenants,
                apiKeys,
                req,
            };
        }

        it.each([
            [
                'image',
                (ctx: ReturnType<typeof publicController>) =>
                    ctx.controller.uploadAnonymous(mkFile({}), ctx.req, undefined),
            ],
            [
                'file',
                (ctx: ReturnType<typeof publicController>) =>
                    ctx.controller.uploadAnonymousFile(mkFile({}), ctx.req),
            ],
        ] as const)(
            'forces a truly anonymous spoofed-scope %s upload to explicit null/null',
            async (_label, invoke) => {
                const ctx = publicController({ activeScope: everScope });

                await invoke(ctx);

                expect(ctx.scopeContext.setScope).toHaveBeenCalledWith({
                    tenantId: null,
                    organizationId: null,
                });
                const save = _label === 'image' ? ctx.uploads.saveImage : ctx.uploads.saveFile;
                expect(save).toHaveBeenCalledWith(
                    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                    expect.anything(),
                    { ownershipScope: { tenantId: null, organizationId: null } },
                );
            },
        );

        it.each([
            [
                'image',
                (ctx: ReturnType<typeof publicController>) =>
                    ctx.controller.uploadAnonymous(mkFile({}), ctx.req, undefined),
            ],
            [
                'file',
                (ctx: ReturnType<typeof publicController>) =>
                    ctx.controller.uploadAnonymousFile(mkFile({}), ctx.req),
            ],
        ] as const)(
            'hydrates and explicitly stamps a valid Ever bearer %s upload',
            async (_label, invoke) => {
                const ctx = publicController({ activeScope: everScope, bearer: true });

                await invoke(ctx);

                expect(ctx.anonymousAuth.createAnonymousUser).not.toHaveBeenCalled();
                const save = _label === 'image' ? ctx.uploads.saveImage : ctx.uploads.saveFile;
                expect(save).toHaveBeenCalledWith(bearerUserId, expect.anything(), {
                    ownershipScope: everScope,
                });
                expect(ctx.scopeContext.setScope).toHaveBeenCalledWith(everScope);
            },
        );

        it('authorizes a valid Ever bearer before presigning', async () => {
            const ctx = publicController({ activeScope: everScope, bearer: true });

            await ctx.controller.presign(
                { filename: 'direct.png', mimeType: 'image/png', size: 100 },
                ctx.req,
            );

            expect(ctx.users.findById).toHaveBeenCalledWith(bearerUserId);
            expect(ctx.members.findByOrgAndUser).toHaveBeenCalledWith(
                everScope.organizationId,
                bearerUserId,
            );
            expect(ctx.uploads.getBackend).toHaveBeenCalledTimes(1);
        });

        it('honors an x-api-key caller instead of minting an anonymous upload owner', async () => {
            const ctx = publicController({ activeScope: everScope, apiKey: true });

            await ctx.controller.uploadAnonymous(mkFile({}), ctx.req, undefined);

            expect(ctx.apiKeys.validateKey).toHaveBeenCalledWith('ew_live_test-key');
            expect(ctx.anonymousAuth.createAnonymousUser).not.toHaveBeenCalled();
            expect(ctx.uploads.saveImage).toHaveBeenCalledWith(bearerUserId, expect.anything(), {
                ownershipScope: everScope,
            });
        });

        it('resolves a headerless bearer to bare personal scope and never reads the persisted Organization pointer', async () => {
            const ctx = publicController({
                activeScope: { tenantId: null, organizationId: null },
                bearer: true,
                user: {
                    id: bearerUserId,
                    tenantId: everScope.tenantId,
                    // Another tab may have persisted Ever as the login default;
                    // that preference is never request authority.
                    lastScopeOrganizationId: everScope.organizationId,
                    isActive: true,
                },
            });
            const personalScope = { tenantId: everScope.tenantId, organizationId: null };

            await ctx.controller.uploadAnonymous(mkFile({}), ctx.req, undefined);

            expect(ctx.organizations.findById).not.toHaveBeenCalled();
            expect(ctx.members.findByOrgAndUser).not.toHaveBeenCalled();
            expect(ctx.uploads.saveImage).toHaveBeenCalledWith(bearerUserId, expect.anything(), {
                ownershipScope: personalScope,
            });
            expect(ctx.scopeContext.setScope).toHaveBeenCalledWith(personalScope);
        });

        it.each([
            [
                'file',
                (ctx: ReturnType<typeof publicController>) =>
                    ctx.controller.uploadAnonymousFile(mkFile({}), ctx.req),
            ],
            [
                'presign',
                (ctx: ReturnType<typeof publicController>) =>
                    ctx.controller.presign(
                        { filename: 'direct.png', mimeType: 'image/png', size: 100 },
                        ctx.req,
                    ),
            ],
        ] as const)(
            'keeps a headerless %s in bare personal scope even when the persisted default is revoked or unknown',
            async (label, invoke) => {
                const ctx = publicController({
                    activeScope: { tenantId: null, organizationId: null },
                    bearer: true,
                    user: {
                        id: bearerUserId,
                        tenantId: everScope.tenantId,
                        lastScopeOrganizationId: everScope.organizationId,
                        isActive: true,
                    },
                    // A revoked roster row / missing Organization must be
                    // irrelevant: the pointer is not consulted at all.
                    member: null,
                    organization: null,
                    tenant: { id: everScope.tenantId, ownerUserId: 'other' },
                });
                const personalScope = { tenantId: everScope.tenantId, organizationId: null };

                await invoke(ctx);

                expect(ctx.organizations.findById).not.toHaveBeenCalled();
                expect(ctx.members.findByOrgAndUser).not.toHaveBeenCalled();
                if (label === 'file') {
                    expect(ctx.uploads.saveFile).toHaveBeenCalledWith(
                        bearerUserId,
                        expect.anything(),
                        { ownershipScope: personalScope },
                    );
                } else {
                    expect(ctx.uploads.getBackend).toHaveBeenCalledTimes(1);
                }
                expect(ctx.scopeContext.setScope).toHaveBeenCalledWith(personalScope);
            },
        );

        /**
         * RE-POINTED (guard-roster-asymmetry, PR #2213 punch list).
         *
         * These cases previously asserted ROSTER-STRICT authorization. That was
         * introduced here on 2026-08-23 by `d220ee00f` / `dc0639e33` to mirror
         * `SessionScopeGuard`, which was briefly roster-strict at the time.
         * `b7550481a` (PR #2218) reverted the guard to TENANT-WIDE the next
         * morning and this controller was never reconciled — so these tests were
         * pinning a one-day-old regression, and with `organization_members`
         * empty in production they described a total lockout for the first
         * invited member.
         *
         * Tenant-wide is the ratified model, stated on the roster entity itself:
         * "because access is tenant-wide, a member of one Organization can see
         *  every Organization in that Tenant. The owner accepted this explicitly
         *  for v1." (packages/agent/src/entities/organization-member.entity.ts)
         *
         * The cases are kept and re-pointed rather than deleted, so the
         * behaviour change is explicit in the diff.
         */
        it.each([
            [
                'no roster row at all (the normal case — nothing writes one today)',
                { member: null, tenant: { id: everScope.tenantId, ownerUserId: 'other' } },
            ],
            [
                'a roster row for a DIFFERENT Organization in the same Tenant',
                {
                    member: {
                        userId: bearerUserId,
                        tenantId: yoScope.tenantId,
                        organizationId: yoScope.organizationId,
                    },
                    tenant: { id: everScope.tenantId, ownerUserId: 'other' },
                },
            ],
        ] as const)(
            'admits a Tenant member with %s (tenant-wide access, matching SessionScopeGuard)',
            async (_label, overrides) => {
                const ctx = publicController({
                    activeScope: everScope,
                    bearer: true,
                    ...overrides,
                });

                await expect(
                    ctx.controller.uploadAnonymous(mkFile({}), ctx.req, undefined),
                ).resolves.toBeDefined();
                expect(ctx.uploads.saveImage).toHaveBeenCalled();
            },
        );

        it.each([
            ['unknown Organization', { organization: null }],
            [
                // The boundary that must NOT move: tenant-wide widens access
                // WITHIN a Tenant, never across one.
                'an Organization belonging to another Tenant',
                {
                    organization: {
                        id: everScope.organizationId,
                        tenantId: '99999999-9999-4999-8999-999999999999',
                    },
                },
            ],
        ] as const)(
            'opaquely rejects a bearer with %s before upload or presign',
            async (_label, overrides) => {
                const uploadCtx = publicController({
                    activeScope: everScope,
                    bearer: true,
                    ...overrides,
                });
                const presignCtx = publicController({
                    activeScope: everScope,
                    bearer: true,
                    ...overrides,
                });

                await expect(
                    uploadCtx.controller.uploadAnonymous(mkFile({}), uploadCtx.req, undefined),
                ).rejects.toBeInstanceOf(NotFoundException);
                await expect(
                    presignCtx.controller.presign(
                        { filename: 'direct.png', mimeType: 'image/png', size: 100 },
                        presignCtx.req,
                    ),
                ).rejects.toBeInstanceOf(NotFoundException);
                expect(uploadCtx.uploads.saveImage).not.toHaveBeenCalled();
                expect(presignCtx.uploads.getBackend).not.toHaveBeenCalled();
            },
        );

        it('rejects an invalid bearer instead of silently minting an anonymous owner', async () => {
            const ctx = publicController({ activeScope: everScope, authRejects: true });

            await expect(
                ctx.controller.uploadAnonymous(mkFile({}), ctx.req, undefined),
            ).rejects.toBeDefined();
            expect(ctx.anonymousAuth.createAnonymousUser).not.toHaveBeenCalled();
            expect(ctx.uploads.saveImage).not.toHaveBeenCalled();
        });

        it('forces anonymous presign to null/null before reading the backend', async () => {
            const ctx = publicController({ activeScope: everScope });

            await ctx.controller.presign(
                { filename: 'direct.png', mimeType: 'image/png', size: 100 },
                ctx.req,
            );

            expect(ctx.scopeContext.setScope).toHaveBeenCalledWith({
                tenantId: null,
                organizationId: null,
            });
            expect(ctx.anonymousAuth.createAnonymousUser).toHaveBeenCalledTimes(1);
            expect(ctx.uploads.getBackend).toHaveBeenCalledTimes(1);
        });

        it('returns 501 for an unsupported backend without minting an anonymous user', async () => {
            const ctx = publicController({ activeScope: everScope });
            ctx.uploads.getBackend.mockResolvedValue({});

            await expect(
                ctx.controller.presign(
                    { filename: 'direct.png', mimeType: 'image/png', size: 100 },
                    ctx.req,
                ),
            ).rejects.toBeInstanceOf(NotImplementedException);

            expect(ctx.anonymousAuth.createAnonymousUser).not.toHaveBeenCalled();
        });

        it('derives an explicit personal scope for a valid bearer', async () => {
            const personalScope = { tenantId: everScope.tenantId, organizationId: null };
            const ctx = publicController({ activeScope: personalScope, bearer: true });

            await ctx.controller.uploadAnonymousFile(mkFile({}), ctx.req);

            expect(ctx.uploads.saveFile).toHaveBeenCalledWith(bearerUserId, expect.anything(), {
                ownershipScope: personalScope,
            });
            expect(ctx.organizations.findById).not.toHaveBeenCalled();
            expect(ctx.members.findByOrgAndUser).not.toHaveBeenCalled();
        });
    });

    beforeEach(async () => {
        root = resolve(
            tmpdir(),
            `ever-works-uploads-ctl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        process.env.UPLOADS_DIR = root;
        delete process.env.UPLOADS_MAX_BYTES;
        const backend = new LocalFsStoragePlugin();
        await backend.onLoad(stubContext('local-fs'));
        service = new UploadsService(
            backend,
            undefined,
            { record: jest.fn().mockResolvedValue({ id: 'upload-row' }) } as never,
            { getScope: () => ({ tenantId: null, organizationId: null }) } as never,
        );
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
        controller = new UploadsController(
            service,
            anonStub,
            authProviderStub,
            undefined,
            undefined,
            { getScope: () => ({ tenantId: null, organizationId: null }) } as never,
        );
    });

    function workScopedController(
        scope: object,
        work: object | null,
        userUploads?: { findOwnedByUser: jest.Mock },
    ) {
        return new UploadsController(
            service,
            {} as never,
            { authenticate: jest.fn().mockResolvedValue(null) } as never,
            { findById: jest.fn().mockResolvedValue(work) } as never,
            userUploads as never,
            { getScope: () => scope } as never,
        );
    }

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

        it('opaque-404s a same-user known Yo Work before associating an image in Ever', async () => {
            const saveImage = jest.spyOn(service, 'saveImage');
            const scoped = workScopedController(everScope, {
                id: workId,
                userId: mkAuth().userId,
                ...yoScope,
            });

            await expect(scoped.upload(mkAuth(), mkFile({}), workId)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(saveImage).not.toHaveBeenCalled();
        });

        it('opaque-404s a same-user known Yo Work before associating a general file in Ever', async () => {
            const saveFile = jest.spyOn(service, 'saveFile');
            const scoped = workScopedController(everScope, {
                id: workId,
                userId: mkAuth().userId,
                ...yoScope,
            });

            await expect(scoped.uploadFile(mkAuth(), mkFile({}), workId)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(saveFile).not.toHaveBeenCalled();
        });

        it('allows a legacy personal Work from explicit personal scope', async () => {
            const personalScope = { tenantId: everScope.tenantId, organizationId: null };
            const result = await workScopedController(personalScope, {
                id: workId,
                userId: mkAuth().userId,
                tenantId: null,
                organizationId: null,
            }).upload(mkAuth(), mkFile({}), workId);

            expect(result.id).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('GET /api/uploads/:userId/:filename', () => {
        function guardedController(userUploads: { findOwnedByUser: jest.Mock }, scope: object) {
            return new UploadsController(
                service,
                {} as never,
                { authenticate: jest.fn().mockResolvedValue(null) } as never,
                undefined,
                userUploads as never,
                { getScope: () => scope } as never,
            );
        }

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

        it('serves an Ever upload only after resolving the exact active scope', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const userUploads = {
                findOwnedByUser: jest.fn().mockResolvedValue({
                    sha256: stored.id,
                    userId: owner.userId,
                    workId: null,
                    ...everScope,
                }),
            };
            const { res, calls } = mkRes();

            await guardedController(userUploads, everScope).serve(
                owner,
                owner.userId,
                stored.filename,
                res,
            );

            expect(userUploads.findOwnedByUser).toHaveBeenCalledWith(
                stored.id,
                owner.userId,
                everScope,
                null,
            );
            expect(calls.statusCode).toBeUndefined();
            expect((calls.sent as Buffer).equals(TINY_PNG)).toBe(true);
        });

        it('serves a pre-index legacy upload only when no metadata row exists in any scope', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const userUploads = {
                findOwnedByUser: jest.fn().mockResolvedValue(null),
            };
            const { res, calls } = mkRes();

            await guardedController(userUploads, everScope).serve(
                owner,
                owner.userId,
                stored.filename,
                res,
            );

            expect(userUploads.findOwnedByUser).toHaveBeenNthCalledWith(
                1,
                stored.id,
                owner.userId,
                everScope,
                null,
            );
            expect(userUploads.findOwnedByUser).toHaveBeenNthCalledWith(2, stored.id, owner.userId);
            expect((calls.sent as Buffer).equals(TINY_PNG)).toBe(true);
        });

        it('does not treat a differently scoped metadata row as a legacy upload', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const userUploads = {
                findOwnedByUser: jest
                    .fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce({
                        sha256: stored.id,
                        userId: owner.userId,
                        workId: null,
                        ...yoScope,
                    }),
            };
            const readFile = jest.spyOn(service, 'readFile');
            const { res, calls } = mkRes();

            await guardedController(userUploads, everScope).serve(
                owner,
                owner.userId,
                stored.filename,
                res,
            );

            expect(calls.statusCode).toBe(HttpStatus.NOT_FOUND);
            expect(readFile).not.toHaveBeenCalled();
        });

        it('opaque-404s the same-user known hash in Yo before reading bytes from Ever', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const yoUpload = {
                sha256: stored.id,
                userId: owner.userId,
                workId: null,
                ...yoScope,
            };
            const userUploads = {
                findOwnedByUser: jest.fn(
                    async (_sha: string, _userId: string, scope?: typeof everScope) =>
                        !scope || scope.organizationId === yoUpload.organizationId
                            ? yoUpload
                            : null,
                ),
            };
            const readFile = jest.spyOn(service, 'readFile');
            const { res, calls } = mkRes();

            await guardedController(userUploads, everScope).serve(
                owner,
                owner.userId,
                stored.filename,
                res,
            );

            expect(calls.statusCode).toBe(HttpStatus.NOT_FOUND);
            expect(calls.body).toEqual({ status: 'error', message: 'Not found' });
            expect(calls.sent).toBeUndefined();
            expect(readFile).not.toHaveBeenCalled();
        });

        it('keeps a legacy personal upload readable from explicit personal scope', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const personalScope = { tenantId: everScope.tenantId, organizationId: null };
            const userUploads = {
                findOwnedByUser: jest.fn().mockResolvedValue({
                    sha256: stored.id,
                    userId: owner.userId,
                    workId: null,
                    tenantId: null,
                    organizationId: null,
                }),
            };
            const { res, calls } = mkRes();

            await guardedController(userUploads, personalScope).serve(
                owner,
                owner.userId,
                stored.filename,
                res,
            );

            expect(userUploads.findOwnedByUser).toHaveBeenCalledWith(
                stored.id,
                owner.userId,
                personalScope,
                null,
            );
            expect((calls.sent as Buffer).equals(TINY_PNG)).toBe(true);
        });

        it('opaque-404s an Ever upload whose same-user Work exists only in Yo before reading bytes', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const userUploads = {
                findOwnedByUser: jest.fn().mockResolvedValue({
                    sha256: stored.id,
                    userId: owner.userId,
                    workId,
                    ...everScope,
                }),
            };
            const scoped = workScopedController(
                everScope,
                { id: workId, userId: owner.userId, ...yoScope },
                userUploads,
            );
            const readFile = jest.spyOn(service, 'readFile');
            const { res } = mkRes();

            await expect(
                scoped.serve(owner, owner.userId, stored.filename, res, workId),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(readFile).not.toHaveBeenCalled();
        });

        it('serves a legacy personal upload associated with a legacy personal Work', async () => {
            const owner = mkAuth();
            const stored = await controller.upload(owner, mkFile({}));
            const personalScope = { tenantId: everScope.tenantId, organizationId: null };
            const userUploads = {
                findOwnedByUser: jest.fn().mockResolvedValue({
                    sha256: stored.id,
                    userId: owner.userId,
                    workId,
                    tenantId: null,
                    organizationId: null,
                }),
            };
            const scoped = workScopedController(
                personalScope,
                {
                    id: workId,
                    userId: owner.userId,
                    tenantId: null,
                    organizationId: null,
                },
                userUploads,
            );
            const { res, calls } = mkRes();

            await scoped.serve(owner, owner.userId, stored.filename, res, workId);

            expect((calls.sent as Buffer).equals(TINY_PNG)).toBe(true);
        });
    });
});

// ============================================================================
// NestJS DI smoke test — guard against the EW-637 regression where
// `UploadsService(backend?: IStoragePlugin)` lacked `@Optional()`. At
// runtime `IStoragePlugin` is an erased TS interface, so Nest has no
// token to resolve and the API boot dies with `UnknownDependenciesException`.
// The agent unit tests above don't catch this — they `new UploadsService(...)`
// and bypass DI entirely. Bootstrapping a TestingModule with the real
// providers list is what would have flagged it pre-merge.
// ============================================================================

describe('UploadsService — Nest DI', () => {
    it('resolves with neither storage nor metadata provider for legacy/minimal graphs', async () => {
        // Both optional providers are absent. Storage resolves lazily through
        // the factory; metadata stays on the legacy storage-only path.
        const moduleRef = await Test.createTestingModule({
            providers: [
                UploadsService,
                {
                    provide: ScopeContextService,
                    useValue: { getScope: () => ({ tenantId: null, organizationId: null }) },
                },
            ],
        }).compile();
        const svc = moduleRef.get(UploadsService);
        expect(svc).toBeInstanceOf(UploadsService);
        await moduleRef.close();
    });
});
