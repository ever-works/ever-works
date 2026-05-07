// AuthSessionGuard transitively imports `@ever-works/agent/database`
// which pulls a heavy runtime tree we don't need for a controller-shape
// test. Stub the import to a class with the same name.
jest.mock('@src/auth/guards/auth-session.guard', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
}));

import { CompaniesController } from './companies.service';
import type { ClientService } from '../services/client.service';

describe('CompaniesController', () => {
    let client: jest.Mocked<
        Pick<
            ClientService,
            | 'getCompanies'
            | 'createCompany'
            | 'updateCompany'
            | 'deleteCompany'
        >
    >;
    let controller: CompaniesController;

    beforeEach(() => {
        client = {
            getCompanies: jest.fn(),
            createCompany: jest.fn(),
            updateCompany: jest.fn(),
            deleteCompany: jest.fn(),
        };
        controller = new CompaniesController(client as unknown as ClientService);
    });

    it('GET /companies delegates to ClientService.getCompanies', async () => {
        client.getCompanies.mockResolvedValue([{ id: 'co-1', name: 'Acme' }]);
        await expect(controller.getCompanies()).resolves.toEqual([
            { id: 'co-1', name: 'Acme' },
        ]);
        expect(client.getCompanies).toHaveBeenCalledTimes(1);
    });

    it('POST /companies forwards the body to ClientService.createCompany', async () => {
        const body = { name: 'Acme' };
        client.createCompany.mockResolvedValue({ id: 'co-1', ...body });
        await expect(controller.createCompany(body)).resolves.toEqual({
            id: 'co-1',
            name: 'Acme',
        });
        expect(client.createCompany).toHaveBeenCalledWith(body);
    });

    it('PATCH /companies/:id forwards id + body to updateCompany', async () => {
        const body = { name: 'Acme v2' };
        client.updateCompany.mockResolvedValue({ id: 'co-1', ...body });
        await expect(controller.updateCompany('co-1', body)).resolves.toEqual({
            id: 'co-1',
            name: 'Acme v2',
        });
        expect(client.updateCompany).toHaveBeenCalledWith('co-1', body);
    });

    it('DELETE /companies/:id forwards id to deleteCompany', async () => {
        client.deleteCompany.mockResolvedValue(undefined);
        await controller.deleteCompany('co-1');
        expect(client.deleteCompany).toHaveBeenCalledWith('co-1');
    });

    it('propagates ClientService errors back to the caller', async () => {
        client.getCompanies.mockRejectedValue(new Error('upstream failure'));
        await expect(controller.getCompanies()).rejects.toThrow('upstream failure');
    });
});
