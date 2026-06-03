// AuthSessionGuard transitively imports `@ever-works/agent/database` which
// pulls a heavy runtime tree we don't need for a controller-shape test.
// Stub the import to a class with the same name.
jest.mock('@src/auth/guards/auth-session.guard', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
}));

// The controller value-imports `UserRepository` from `@ever-works/agent/database`,
// which transitively loads the full DB runtime tree (TypeORM config that reads
// `@src/config`, not mapped in this jest project). We only need the class as a
// constructor-injection token here, so stub the module to a same-named class.
jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
}));

import { NotFoundException } from '@nestjs/common';
import { PeopleController } from './people.controler';
import { CrmTenantService } from '../services/crm-tenant.service';
import type { ClientService } from '../services/client.service';
import type { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

const TENANT_A = 'tenant-a';
const PREFIX_A = `/tenants/${TENANT_A}`;

const authUser = (userId = 'user-1'): AuthenticatedUser =>
    ({ userId, email: 'u@x.test' }) as AuthenticatedUser;

describe('PeopleController', () => {
    let client: jest.Mocked<
        Pick<
            ClientService,
            'getContacts' | 'getContact' | 'createContact' | 'updateContact' | 'deleteContact'
        >
    >;
    let userRepo: { findById: jest.Mock };
    let crmTenant: CrmTenantService;
    let controller: PeopleController;

    beforeEach(() => {
        client = {
            getContacts: jest.fn(),
            getContact: jest.fn(),
            createContact: jest.fn(),
            updateContact: jest.fn(),
            deleteContact: jest.fn(),
        };
        crmTenant = new CrmTenantService();
        jest.spyOn((crmTenant as any).logger, 'debug').mockImplementation(() => undefined);
        jest.spyOn((crmTenant as any).logger, 'error').mockImplementation(() => undefined);
        userRepo = { findById: jest.fn().mockResolvedValue({ id: 'user-1', tenantId: TENANT_A }) };
        controller = new PeopleController(
            client as unknown as ClientService,
            crmTenant,
            userRepo as unknown as UserRepository,
        );
    });

    it('GET /people scopes the read to the caller’s tenant prefix', async () => {
        client.getContacts.mockResolvedValue([{ id: 'p-1', firstName: 'Ada' }]);
        await expect(controller.getContacts(authUser())).resolves.toEqual([
            { id: 'p-1', firstName: 'Ada' },
        ]);
        expect(client.getContacts).toHaveBeenCalledWith(PREFIX_A);
    });

    it('POST /people maps the body fields explicitly + forwards the prefix (no extra fields leak through)', async () => {
        const body = {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            phone: '+1-555',
            companyId: 'co-1',
            position: 'Engineer',
            avatarUrl: 'https://x/y.png',
            // extra field that should NOT be forwarded
            id: 'should-be-ignored',
            extraneous: true,
        } as any;

        client.createContact.mockResolvedValue({ id: 'p-1' });
        await controller.createContact(authUser(), body);

        expect(client.createContact).toHaveBeenCalledWith(
            {
                firstName: 'Ada',
                lastName: 'Lovelace',
                email: 'ada@example.com',
                phone: '+1-555',
                companyId: 'co-1',
                position: 'Engineer',
                avatarUrl: 'https://x/y.png',
            },
            PREFIX_A,
        );
    });

    it('POST /people forwards undefined fields as undefined (no defaulting)', async () => {
        client.createContact.mockResolvedValue({ id: 'p-1' });
        await controller.createContact(authUser(), {} as any);
        expect(client.createContact).toHaveBeenCalledWith(
            {
                firstName: undefined,
                lastName: undefined,
                email: undefined,
                phone: undefined,
                companyId: undefined,
                position: undefined,
                avatarUrl: undefined,
            },
            PREFIX_A,
        );
    });

    it('PATCH /people/:id verifies ownership then forwards id + body + prefix', async () => {
        const body = { firstName: 'Ada2' };
        client.getContact.mockResolvedValue({ id: 'p-1', firstName: 'Ada' });
        client.updateContact.mockResolvedValue({ id: 'p-1', ...body });
        await expect(controller.updateContact(authUser(), 'p-1', body)).resolves.toEqual({
            id: 'p-1',
            firstName: 'Ada2',
        });
        expect(client.getContact).toHaveBeenCalledWith('p-1', PREFIX_A);
        expect(client.updateContact).toHaveBeenCalledWith('p-1', body, PREFIX_A);
    });

    it('DELETE /people/:id verifies ownership then forwards id + prefix', async () => {
        client.getContact.mockResolvedValue({ id: 'p-1', firstName: 'Ada' });
        client.deleteContact.mockResolvedValue(undefined);
        await controller.deleteContact(authUser(), 'p-1');
        expect(client.getContact).toHaveBeenCalledWith('p-1', PREFIX_A);
        expect(client.deleteContact).toHaveBeenCalledWith('p-1', PREFIX_A);
    });

    describe('cross-tenant IDOR is blocked', () => {
        it('a caller with NO Tenant is refused (404) and never reaches the CRM', async () => {
            userRepo.findById.mockResolvedValue({ id: 'user-1', tenantId: null });
            await expect(controller.getContacts(authUser())).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(client.getContacts).not.toHaveBeenCalled();
        });

        it('PATCH of a record not in the caller’s tenant 404s and never mutates', async () => {
            client.getContact.mockRejectedValue(new NotFoundException('Contact p-9 not found'));
            await expect(
                controller.updateContact(authUser(), 'p-9', { firstName: 'pwned' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(client.updateContact).not.toHaveBeenCalled();
        });

        it('DELETE of a record not in the caller’s tenant 404s and never deletes', async () => {
            client.getContact.mockRejectedValue(new NotFoundException('Contact p-9 not found'));
            await expect(controller.deleteContact(authUser(), 'p-9')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(client.deleteContact).not.toHaveBeenCalled();
        });
    });

    it('propagates ClientService errors back to the caller', async () => {
        client.createContact.mockRejectedValue(new Error('upstream'));
        await expect(controller.createContact(authUser(), {} as any)).rejects.toThrow('upstream');
    });
});
