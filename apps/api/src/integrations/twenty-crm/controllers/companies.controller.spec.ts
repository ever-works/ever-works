// AuthSessionGuard transitively imports `@ever-works/agent/database`
// which pulls a heavy runtime tree we don't need for a controller-shape
// test. Stub the import to a class with the same name.
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
import { CompaniesController } from './companies.service';
import { AuthSessionGuard } from '@src/auth/guards/auth-session.guard';
import { CrmSyncGuard } from '../guards/crm-sync.guard';
import { CrmTenantService } from '../services/crm-tenant.service';
import type { ClientService } from '../services/client.service';
import type { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
// Controllers now pass the raw tenant id (which selects that tenant's own
// Twenty workspace credentials), not a `/tenants/{id}` path prefix.
const PREFIX_A = TENANT_A;

// Real UUIDs: the by-id handlers are now guarded by `ParseUUIDPipe`, so the
// route param must be a valid UUID for the happy path to reach the controller.
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_COMPANY_ID = '99999999-9999-4999-8999-999999999999';

const authUser = (userId = 'user-1'): AuthenticatedUser =>
    ({ userId, email: 'u@x.test' }) as AuthenticatedUser;

describe('CompaniesController', () => {
    let client: jest.Mocked<
        Pick<
            ClientService,
            'getCompanies' | 'getCompany' | 'createCompany' | 'updateCompany' | 'deleteCompany'
        >
    >;
    let userRepo: { findById: jest.Mock };
    let crmTenant: CrmTenantService;
    let controller: CompaniesController;

    beforeEach(() => {
        client = {
            getCompanies: jest.fn(),
            getCompany: jest.fn(),
            createCompany: jest.fn(),
            updateCompany: jest.fn(),
            deleteCompany: jest.fn(),
        };
        // Real CrmTenantService — pure logic, lets us assert the actual prefix.
        crmTenant = new CrmTenantService();
        jest.spyOn((crmTenant as any).logger, 'debug').mockImplementation(() => undefined);
        jest.spyOn((crmTenant as any).logger, 'error').mockImplementation(() => undefined);
        // Default: caller belongs to TENANT_A.
        userRepo = { findById: jest.fn().mockResolvedValue({ id: 'user-1', tenantId: TENANT_A }) };
        controller = new CompaniesController(
            client as unknown as ClientService,
            crmTenant,
            userRepo as unknown as UserRepository,
        );
    });

    it('GET /companies scopes the read to the caller’s tenant prefix', async () => {
        client.getCompanies.mockResolvedValue([{ id: 'co-1', name: 'Acme' }]);
        await expect(controller.getCompanies(authUser())).resolves.toEqual([
            { id: 'co-1', name: 'Acme' },
        ]);
        expect(client.getCompanies).toHaveBeenCalledWith(PREFIX_A);
    });

    it('POST /companies forwards the body AND the caller’s tenant prefix', async () => {
        const body = { name: 'Acme' };
        client.createCompany.mockResolvedValue({ id: 'co-1', ...body });
        await expect(controller.createCompany(authUser(), body)).resolves.toEqual({
            id: 'co-1',
            name: 'Acme',
        });
        expect(client.createCompany).toHaveBeenCalledWith(body, PREFIX_A);
    });

    it('PATCH /companies/:id verifies ownership then forwards id + body + prefix', async () => {
        const body = { name: 'Acme v2' };
        client.getCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Acme' });
        client.updateCompany.mockResolvedValue({ id: COMPANY_ID, ...body });
        await expect(controller.updateCompany(authUser(), COMPANY_ID, body)).resolves.toEqual({
            id: COMPANY_ID,
            name: 'Acme v2',
        });
        // Ownership read is scoped to the caller's tenant before the mutation.
        expect(client.getCompany).toHaveBeenCalledWith(COMPANY_ID, PREFIX_A);
        expect(client.updateCompany).toHaveBeenCalledWith(COMPANY_ID, body, PREFIX_A);
    });

    it('DELETE /companies/:id verifies ownership then forwards id + prefix', async () => {
        client.getCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Acme' });
        client.deleteCompany.mockResolvedValue(undefined);
        await controller.deleteCompany(authUser(), COMPANY_ID);
        expect(client.getCompany).toHaveBeenCalledWith(COMPANY_ID, PREFIX_A);
        expect(client.deleteCompany).toHaveBeenCalledWith(COMPANY_ID, PREFIX_A);
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
            await expect(pipe.transform('co-1', meta)).rejects.toBeInstanceOf(BadRequestException);
            await expect(pipe.transform("co-1' OR '1'='1", meta)).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('passes a legitimate UUID through unchanged', async () => {
            await expect(pipe.transform(COMPANY_ID, meta)).resolves.toBe(COMPANY_ID);
        });
    });

    describe('cross-tenant IDOR is blocked', () => {
        it('a caller with NO Tenant is refused (404) and never reaches the CRM', async () => {
            userRepo.findById.mockResolvedValue({ id: 'user-1', tenantId: null });
            await expect(controller.getCompanies(authUser())).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(client.getCompanies).not.toHaveBeenCalled();
        });

        it('PATCH of a record not in the caller’s tenant 404s and never mutates', async () => {
            // Upstream returns 404 (record not under the caller's tenant prefix)
            // when the ownership read runs.
            client.getCompany.mockRejectedValue(
                new NotFoundException(`Company ${FOREIGN_COMPANY_ID} not found`),
            );
            await expect(
                controller.updateCompany(authUser(), FOREIGN_COMPANY_ID, { name: 'pwned' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(client.updateCompany).not.toHaveBeenCalled();
        });

        it('DELETE of a record not in the caller’s tenant 404s and never deletes', async () => {
            client.getCompany.mockRejectedValue(
                new NotFoundException(`Company ${FOREIGN_COMPANY_ID} not found`),
            );
            await expect(
                controller.deleteCompany(authUser(), FOREIGN_COMPANY_ID),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(client.deleteCompany).not.toHaveBeenCalled();
        });

        it('two different callers are scoped to two different, non-overlapping tenant ids', async () => {
            client.getCompanies.mockResolvedValue([]);

            await controller.getCompanies(authUser('user-a'));
            userRepo.findById.mockResolvedValue({ id: 'user-b', tenantId: TENANT_B });
            await controller.getCompanies(authUser('user-b'));

            expect(client.getCompanies).toHaveBeenNthCalledWith(1, PREFIX_A);
            expect(client.getCompanies).toHaveBeenNthCalledWith(2, TENANT_B);
        });
    });

    it('propagates ClientService errors back to the caller', async () => {
        client.getCompanies.mockRejectedValue(new Error('upstream failure'));
        await expect(controller.getCompanies(authUser())).rejects.toThrow('upstream failure');
    });

    // Security (audit #61): CrmSyncGuard existed but was never applied, leaving
    // every /api/twenty-crm/companies route reachable even with the CRM
    // integration disabled or misconfigured. Guards do not run on direct method
    // calls in a unit test, so assert the class-level `@UseGuards` wiring via
    // Nest's `__guards__` metadata: auth first, then the fail-closed CRM gate.
    it('class-level guards are AuthSessionGuard then CrmSyncGuard (fail-closed when CRM sync is off)', () => {
        const guards = Reflect.getMetadata('__guards__', CompaniesController) as unknown[];
        expect(guards).toEqual([AuthSessionGuard, CrmSyncGuard]);
    });
});
