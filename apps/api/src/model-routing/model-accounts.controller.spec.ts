// Stub the agent subpath + auth barrel so the transitive database config
// (api-only `@src/config`) is never pulled into this controller test.
jest.mock('@ever-works/agent/model-routing', () => ({
    ModelAccountService: class ModelAccountService {},
}));
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));
jest.mock('../scope/scope-context.service', () => ({
    ScopeContextService: class ScopeContextService {},
}));

import 'reflect-metadata';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { ModelAccountsController } from './model-accounts.controller';
import {
    CreateModelAccountDto,
    ReorderModelAccountsDto,
    UpdateModelAccountDto,
} from './dto/model-accounts.dto';
import { ModelWorkspaceAccessService } from './model-workspace-access.service';

/**
 * Model accounts (AW-16) — the account routes. The account rules are tested
 * where they live (`ModelAccountService`, packages/agent); this suite pins
 * the workspace authorization split (members read, admins change), that the
 * organization comes from the session and never the request, that no route
 * echoes a credential back, and the DTO rules.
 */
describe('ModelAccountsController', () => {
    const auth = { userId: 'user-1' } as never;
    const SECRET = 'sk-controller-secret-1234';
    const view = {
        id: '11111111-1111-4111-8111-111111111111',
        providerPluginId: 'provider-a',
        providerName: 'Provider A',
        label: 'Company key',
        position: 1,
        health: 'working',
        enabled: true,
    };
    let service: Record<string, jest.Mock>;
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };
    let scope: { getOrganizationId: jest.Mock; getTenantId: jest.Mock };
    let controller: ModelAccountsController;

    beforeEach(() => {
        service = {
            list: jest.fn().mockResolvedValue([view]),
            listProviders: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue(view),
            update: jest.fn().mockResolvedValue(view),
            replaceCredentials: jest.fn().mockResolvedValue(view),
            reorder: jest.fn().mockResolvedValue([view]),
            check: jest.fn().mockResolvedValue(view),
            remove: jest.fn().mockResolvedValue({ removed: view, renumbered: [] }),
        };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({ id: 'org-1' }),
            ensureAdmin: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        scope = {
            getOrganizationId: jest.fn().mockReturnValue('org-1'),
            getTenantId: jest.fn().mockReturnValue('tenant-1'),
        };
        const access = new ModelWorkspaceAccessService(scope as never, membership as never);
        controller = new ModelAccountsController(service as never, access);
    });

    const orgScope = { userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' };

    it('lets a member read accounts and providers in the active organization', async () => {
        await expect(controller.list(auth)).resolves.toEqual({ accounts: [view] });
        await expect(controller.providers(auth)).resolves.toEqual({ providers: [] });
        expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'user-1');
        expect(membership.ensureAdmin).not.toHaveBeenCalled();
        expect(service.list).toHaveBeenCalledWith(orgScope, undefined);
    });

    it('requires an organization admin for every change, and refuses before touching anything', async () => {
        membership.ensureAdmin.mockRejectedValue(new ForbiddenException());
        const id = view.id;
        const attempts = [
            () =>
                controller.create(
                    auth,
                    Object.assign(new CreateModelAccountDto(), {
                        providerPluginId: 'provider-a',
                        label: 'x',
                        credentials: { apiKey: SECRET },
                    }),
                ),
            () =>
                controller.reorder(
                    auth,
                    Object.assign(new ReorderModelAccountsDto(), {
                        providerPluginId: 'provider-a',
                        orderedIds: [id],
                    }),
                ),
            () =>
                controller.update(
                    auth,
                    id,
                    Object.assign(new UpdateModelAccountDto(), { enabled: false }),
                ),
            () => controller.replaceCredentials(auth, id, { credentials: { apiKey: SECRET } }),
            () => controller.check(auth, id),
            () => controller.remove(auth, id),
        ];
        for (const attempt of attempts) {
            await expect(attempt()).rejects.toBeInstanceOf(ForbiddenException);
        }
        for (const method of [
            'create',
            'reorder',
            'update',
            'replaceCredentials',
            'check',
            'remove',
        ]) {
            expect(service[method]).not.toHaveBeenCalled();
        }
    });

    it('acts on the personal workspace for an unprefixed request, with no membership check', async () => {
        scope.getOrganizationId.mockReturnValue(null);
        await controller.create(
            auth,
            Object.assign(new CreateModelAccountDto(), {
                providerPluginId: 'provider-a',
                label: 'Personal key',
                credentials: { apiKey: SECRET },
            }),
        );
        expect(membership.ensureAdmin).not.toHaveBeenCalled();
        expect(service.create).toHaveBeenCalledWith(
            { userId: 'user-1', tenantId: 'tenant-1', organizationId: null },
            {
                providerPluginId: 'provider-a',
                label: 'Personal key',
                credentials: { apiKey: SECRET },
                position: undefined,
            },
        );
    });

    it('never echoes a credential from the request in any response', async () => {
        const responses = [
            await controller.create(
                auth,
                Object.assign(new CreateModelAccountDto(), {
                    providerPluginId: 'provider-a',
                    label: 'Company key',
                    credentials: { apiKey: SECRET },
                }),
            ),
            await controller.replaceCredentials(auth, view.id, { credentials: { apiKey: SECRET } }),
            await controller.list(auth),
            await controller.remove(auth, view.id),
        ];
        for (const body of responses) {
            expect(JSON.stringify(body)).not.toContain(SECRET);
        }
    });

    it('passes the order and the order the editor loaded straight to the service', async () => {
        const body = Object.assign(new ReorderModelAccountsDto(), {
            providerPluginId: 'provider-a',
            orderedIds: ['b', 'a'],
            expectedOrder: ['a', 'b'],
        });
        await expect(controller.reorder(auth, body)).resolves.toEqual({ accounts: [view] });
        expect(service.reorder).toHaveBeenCalledWith(orgScope, {
            providerPluginId: 'provider-a',
            orderedIds: ['b', 'a'],
            expectedOrder: ['a', 'b'],
        });
    });

    describe('DTO validation', () => {
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        });
        const validate = (metatype: unknown, value: unknown) =>
            pipe.transform(value, { type: 'body', metatype: metatype as never });

        it('accepts an account with the provider’s own credential field names', async () => {
            await expect(
                validate(CreateModelAccountDto, {
                    providerPluginId: 'provider-a',
                    label: 'Company key',
                    credentials: { apiKey: SECRET, organizationId: 'org' },
                    position: 'first',
                }),
            ).resolves.toMatchObject({ credentials: { apiKey: SECRET, organizationId: 'org' } });
        });

        it.each([
            [{ providerPluginId: 'provider-a', label: '', credentials: { apiKey: 'k' } }],
            [
                {
                    providerPluginId: 'provider-a',
                    label: 'x'.repeat(61),
                    credentials: { apiKey: 'k' },
                },
            ],
            [{ providerPluginId: 'provider-a', label: 'x' }],
            [{ providerPluginId: 'provider-a', label: 'x', credentials: 'sk-plain' }],
            [{ providerPluginId: 'provider-a', label: 'x', credentials: {}, position: 'middle' }],
            [{ label: 'x', credentials: {} }],
            [{ providerPluginId: 'provider-a', label: 'x', credentials: {}, health: 'working' }],
        ])('rejects create %j', async (body) => {
            await expect(validate(CreateModelAccountDto, body)).rejects.toBeDefined();
        });

        it('rejects a reorder longer than the per-provider limit or empty', async () => {
            await expect(
                validate(ReorderModelAccountsDto, {
                    providerPluginId: 'provider-a',
                    orderedIds: Array.from({ length: 9 }, (_, index) => `id-${index}`),
                }),
            ).rejects.toBeDefined();
            await expect(
                validate(ReorderModelAccountsDto, {
                    providerPluginId: 'provider-a',
                    orderedIds: [],
                }),
            ).rejects.toBeDefined();
        });

        it('rejects an update that tries to set anything but the name or paused state', async () => {
            await expect(validate(UpdateModelAccountDto, { position: 3 })).rejects.toBeDefined();
            await expect(validate(UpdateModelAccountDto, { enabled: 'no' })).rejects.toBeDefined();
            await expect(validate(UpdateModelAccountDto, { enabled: false })).resolves.toEqual({
                enabled: false,
            });
        });
    });
});
