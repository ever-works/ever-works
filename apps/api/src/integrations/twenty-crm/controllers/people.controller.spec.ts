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

import {
    ArgumentMetadata,
    BadRequestException,
    NotFoundException,
    ParseUUIDPipe,
} from '@nestjs/common';
import { PeopleController } from './people.controler';
import { CrmTenantService } from '../services/crm-tenant.service';
import type { ClientService } from '../services/client.service';
import type { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

const TENANT_A = 'tenant-a';
// Controllers now pass the raw tenant id (which selects that tenant's own
// Twenty workspace credentials), not a `/tenants/{id}` path prefix.
const PREFIX_A = TENANT_A;

// Real UUIDs: the by-id handlers are now guarded by `ParseUUIDPipe`, so the
// route param must be a valid UUID for the happy path to reach the controller.
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_CONTACT_ID = '88888888-8888-4888-8888-888888888888';

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
        client.getContact.mockResolvedValue({ id: CONTACT_ID, firstName: 'Ada' });
        client.updateContact.mockResolvedValue({ id: CONTACT_ID, ...body });
        await expect(controller.updateContact(authUser(), CONTACT_ID, body)).resolves.toEqual({
            id: CONTACT_ID,
            firstName: 'Ada2',
        });
        expect(client.getContact).toHaveBeenCalledWith(CONTACT_ID, PREFIX_A);
        expect(client.updateContact).toHaveBeenCalledWith(CONTACT_ID, body, PREFIX_A);
    });

    it('DELETE /people/:id verifies ownership then forwards id + prefix', async () => {
        client.getContact.mockResolvedValue({ id: CONTACT_ID, firstName: 'Ada' });
        client.deleteContact.mockResolvedValue(undefined);
        await controller.deleteContact(authUser(), CONTACT_ID);
        expect(client.getContact).toHaveBeenCalledWith(CONTACT_ID, PREFIX_A);
        expect(client.deleteContact).toHaveBeenCalledWith(CONTACT_ID, PREFIX_A);
    });

    // Security (EW-717 #3): the by-id mutating handlers (`@Get/@Patch/@Delete(':id')`)
    // are decorated with `new ParseUUIDPipe()`, so a non-UUID `:id` is rejected at the
    // pipe layer (400) before any tenant resolution / CRM call. Pipes do not run on a
    // direct method call in a unit test, so we exercise the exact pipe wired onto the
    // route param here.
    describe('id route param is UUID-validated (ParseUUIDPipe)', () => {
        const pipe = new ParseUUIDPipe();
        const meta: ArgumentMetadata = { type: 'param', data: 'id' };

        it('rejects a malformed / injection-shaped id with a 400 BadRequestException', async () => {
            await expect(pipe.transform('p-1', meta)).rejects.toBeInstanceOf(BadRequestException);
            await expect(pipe.transform("p-1' OR '1'='1", meta)).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('passes a legitimate UUID through unchanged', async () => {
            await expect(pipe.transform(CONTACT_ID, meta)).resolves.toBe(CONTACT_ID);
        });
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
            client.getContact.mockRejectedValue(
                new NotFoundException(`Contact ${FOREIGN_CONTACT_ID} not found`),
            );
            await expect(
                controller.updateContact(authUser(), FOREIGN_CONTACT_ID, { firstName: 'pwned' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(client.updateContact).not.toHaveBeenCalled();
        });

        it('DELETE of a record not in the caller’s tenant 404s and never deletes', async () => {
            client.getContact.mockRejectedValue(
                new NotFoundException(`Contact ${FOREIGN_CONTACT_ID} not found`),
            );
            await expect(
                controller.deleteContact(authUser(), FOREIGN_CONTACT_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(client.deleteContact).not.toHaveBeenCalled();
        });
    });

    it('propagates ClientService errors back to the caller', async () => {
        client.createContact.mockRejectedValue(new Error('upstream'));
        await expect(controller.createContact(authUser(), {} as any)).rejects.toThrow('upstream');
    });
});
