jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IntegrationPrincipalGuard } from '../integration/integration-principal.guard';
import { ApiKeyService } from './api-key.service';
import { IntegrationKeyService } from './integration-key.service';

/**
 * EW-P2-6 — Organization admins and integration keys: who may create one, which
 * Organizations they may pin, which pins a key may use at request time, and the
 * `org:write` auto-pin — over doubles of the repositories.
 */
describe('integration keys and organization admins (EW-P2-6)', () => {
    const TENANT = 'tenant-1';
    const OWNER = 'owner-1';
    const ADMIN = 'admin-1';
    const MEMBER = 'member-1';
    const ORG_A = 'org-a';
    const ORG_B = 'org-b';

    const tenants = {
        findById: jest.fn(async (id: string) =>
            id === TENANT ? { id, ownerUserId: OWNER } : null,
        ),
    };
    const members = {
        listAdministeredOrganizationIds: jest.fn(async (userId: string) =>
            userId === ADMIN ? [ORG_A] : [],
        ),
    };

    describe('ApiKeyService.effectivePins', () => {
        const service = new ApiKeyService({} as never, tenants as never, members as never);

        it('a key whose creator administers none of its pins any more does not authenticate', async () => {
            const row = (userId: string) => ({
                id: 'k-1',
                kind: 'integration',
                userId,
                tenantId: TENANT,
                organizationIds: [ORG_A],
                expiresAt: null,
            });
            const keysOf = (userId: string) => ({
                findByHashedKey: jest.fn().mockResolvedValue(row(userId)),
                findByPreviousHashedKey: jest.fn().mockResolvedValue(null),
                updateLastUsed: jest.fn().mockResolvedValue(undefined),
            });
            const demoted = new ApiKeyService(
                keysOf(MEMBER) as never,
                tenants as never,
                members as never,
            );
            await expect(demoted.validateIntegrationKey('ew_int_secret')).resolves.toBeNull();
            const admin = new ApiKeyService(
                keysOf(ADMIN) as never,
                tenants as never,
                members as never,
            );
            await expect(admin.validateIntegrationKey('ew_int_secret')).resolves.toMatchObject({
                id: 'k-1',
                organizationIds: [ORG_A],
            });
        });

        it('keeps every pin of a key the Tenant owner created', async () => {
            await expect(
                service.effectivePins({
                    userId: OWNER,
                    tenantId: TENANT,
                    organizationIds: [ORG_A, ORG_B],
                }),
            ).resolves.toEqual([ORG_A, ORG_B]);
        });

        it("narrows an admin's key to what the admin still administers", async () => {
            await expect(
                service.effectivePins({
                    userId: ADMIN,
                    tenantId: TENANT,
                    organizationIds: [ORG_A, ORG_B],
                }),
            ).resolves.toEqual([ORG_A]);
            // Demoted: no pins left.
            await expect(
                service.effectivePins({
                    userId: MEMBER,
                    tenantId: TENANT,
                    organizationIds: [ORG_A],
                }),
            ).resolves.toEqual([]);
        });

        it('fails closed on a lookup error, and keeps the stored pins without the repositories', async () => {
            const broken = new ApiKeyService(
                {} as never,
                tenants as never,
                {
                    listAdministeredOrganizationIds: jest
                        .fn()
                        .mockRejectedValue(new Error('db down')),
                } as never,
            );
            await expect(
                broken.effectivePins({ userId: ADMIN, tenantId: TENANT, organizationIds: [ORG_A] }),
            ).resolves.toEqual([]);
            const legacy = new ApiKeyService({} as never);
            await expect(
                legacy.effectivePins({ userId: ADMIN, tenantId: TENANT, organizationIds: [ORG_A] }),
            ).resolves.toEqual([ORG_A]);
        });
    });

    describe('IntegrationKeyService', () => {
        const setup = () => {
            const apiKeys = {
                countActiveIntegrationKeysByTenant: jest.fn().mockResolvedValue(0),
                create: jest.fn(async (row: Record<string, unknown>) => ({
                    ...row,
                    id: 'key-1',
                    createdAt: new Date(),
                })),
                findIntegrationKeysByTenant: jest.fn().mockResolvedValue([
                    { id: 'k-owner', userId: OWNER, organizationIds: [ORG_A] },
                    { id: 'k-admin', userId: ADMIN, organizationIds: [ORG_A] },
                ]),
                findById: jest.fn(async (id: string) =>
                    id === 'key-1' ? { id, kind: 'integration', organizationIds: [ORG_A] } : null,
                ),
                updateOrganizationIds: jest.fn().mockResolvedValue(true),
                appendOrganizationId: jest.fn(async (id: string, org: string) =>
                    id !== 'key-1'
                        ? { status: 'missing', organizationIds: [] }
                        : org === ORG_A
                          ? { status: 'present', organizationIds: [ORG_A] }
                          : { status: 'added', organizationIds: [ORG_A, org] },
                ),
            };
            const organizations = {
                findByTenantId: jest.fn().mockResolvedValue([
                    { id: ORG_A, slug: 'a', displayName: 'A' },
                    { id: ORG_B, slug: 'b', displayName: 'B' },
                ]),
            };
            const users = {
                findById: jest.fn(async (id: string) => ({ id, tenantId: TENANT })),
            };
            const service = new IntegrationKeyService(
                apiKeys as never,
                tenants as never,
                organizations as never,
                users as never,
                undefined,
                undefined,
                members as never,
            );
            return { service, apiKeys };
        };
        const input = (organizationIds: string[]) =>
            ({
                name: 'Gauzy',
                integrationKind: 'ever-gauzy',
                scopes: ['tasks:read'],
                organizationIds,
            }) as never;

        it('an admin creates a key pinned to the Organizations they administer', async () => {
            const { service, apiKeys } = setup();
            await service.create(ADMIN, input([ORG_A]));
            expect(apiKeys.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: ADMIN,
                    tenantId: TENANT,
                    organizationIds: [ORG_A],
                }),
            );
        });

        it('an admin cannot pin an Organization they do not administer; a member cannot create', async () => {
            const { service } = setup();
            await expect(service.create(ADMIN, input([ORG_B]))).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.create(MEMBER, input([ORG_A]))).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('the owner lists every key of the Tenant; an admin lists their own', async () => {
            const { service } = setup();
            expect((await service.list(OWNER)).map((key) => key.id)).toEqual([
                'k-owner',
                'k-admin',
            ]);
            expect((await service.list(ADMIN)).map((key) => key.id)).toEqual(['k-admin']);
            expect(await service.list(MEMBER)).toEqual([]);
        });

        it('addPin refuses a full key before writing (400)', async () => {
            const { service, apiKeys } = setup();
            apiKeys.findById.mockResolvedValue({
                id: 'key-1',
                kind: 'integration',
                organizationIds: Array.from({ length: 50 }, (_, index) => `org-${index}`),
            } as never);
            await expect(service.addPin('key-1', ORG_B)).rejects.toThrow('at most 50');
            expect(apiKeys.appendOrganizationId).not.toHaveBeenCalled();
        });

        it('addPin appends a pin once and refuses a key that is not an integration key', async () => {
            const { service, apiKeys } = setup();
            await expect(service.addPin('key-1', ORG_B)).resolves.toEqual([ORG_A, ORG_B]);
            expect(apiKeys.appendOrganizationId).toHaveBeenCalledWith('key-1', ORG_B, 50);
            await expect(service.addPin('key-1', ORG_A)).resolves.toEqual([ORG_A]);
            await expect(service.addPin('nope', ORG_A)).rejects.toThrow('not found');
        });
    });

    describe('X-Act-As-User on an admin-created key', () => {
        const roster: Record<string, string> = {
            [ADMIN]: 'admin',
            'admin-2': 'admin',
            [MEMBER]: 'member',
        };
        const guard = new IntegrationPrincipalGuard(
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            tenants as never,
            {
                findByOrgAndUser: jest.fn(async (_org: string, userId: string) =>
                    roster[userId] ? { userId, role: roster[userId] } : null,
                ),
            } as never,
        );
        const mayActAs = (creator: string, target: string, org: string | null) =>
            (
                guard as unknown as {
                    mayActAs: (
                        principal: { tenantId: string; ownerUserId: string },
                        target: string,
                        org: string | null,
                    ) => Promise<boolean>;
                }
            ).mayActAs({ tenantId: TENANT, ownerUserId: creator }, target, org);

        it('acts only as itself or a plain member of the pinned organization, never as the owner or another admin', async () => {
            await expect(mayActAs(ADMIN, MEMBER, ORG_A)).resolves.toBe(true);
            await expect(mayActAs(ADMIN, ADMIN, ORG_A)).resolves.toBe(true);
            await expect(mayActAs(ADMIN, OWNER, ORG_A)).resolves.toBe(false);
            await expect(mayActAs(ADMIN, 'admin-2', ORG_A)).resolves.toBe(false);
            await expect(mayActAs(ADMIN, MEMBER, null)).resolves.toBe(false);
            // The Tenant owner's key keeps today's rule.
            await expect(mayActAs(OWNER, ADMIN, ORG_A)).resolves.toBe(true);
        });
    });
});
