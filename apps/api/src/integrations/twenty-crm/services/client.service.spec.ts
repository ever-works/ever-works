import { ClientService } from './client.service';
import type { TwentyCrmService } from './twenty-crm.service';

describe('ClientService', () => {
    let twenty: { makeRequest: jest.Mock };
    let service: ClientService;

    beforeEach(() => {
        twenty = { makeRequest: jest.fn() };
        service = new ClientService(twenty as unknown as TwentyCrmService);
    });

    const expectCall = (
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        endpoint: string,
        body?: unknown,
    ) => {
        const callArgs = twenty.makeRequest.mock.calls[0];
        if (body === undefined) {
            // The current implementation passes only (method, endpoint) for
            // bodyless calls — assert exact arity.
            expect(callArgs).toEqual([method, endpoint]);
        } else {
            expect(callArgs).toEqual([method, endpoint, body]);
        }
    };

    describe('create*', () => {
        it('createCompany POSTs to /companies and returns the response', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'co-1', name: 'Acme' });
            const out = await service.createCompany({ name: 'Acme' });
            expect(out).toEqual({ id: 'co-1', name: 'Acme' });
            expectCall('POST', '/companies', { name: 'Acme' });
        });

        it('createContact POSTs to /contacts', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'p-1' });
            await service.createContact({ firstName: 'A', email: 'a@b.test' });
            expectCall('POST', '/contacts', { firstName: 'A', email: 'a@b.test' });
        });

        it('createDeal POSTs to /deals', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'd-1' });
            await service.createDeal({ title: 'Big Deal' });
            expectCall('POST', '/deals', { title: 'Big Deal' });
        });

        it('createProduct POSTs to /products', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'pr-1' });
            await service.createProduct({ name: 'Widget' });
            expectCall('POST', '/products', { name: 'Widget' });
        });
    });

    describe('get* by id', () => {
        it.each([
            ['getCompany', 'co-1', '/companies/co-1'],
            ['getContact', 'p-1', '/contacts/p-1'],
            ['getDeal', 'd-1', '/deals/d-1'],
            ['getProduct', 'pr-1', '/products/pr-1'],
        ] as const)('%s GETs %s -> %s', async (method, id, endpoint) => {
            twenty.makeRequest.mockResolvedValue({ id });
            await (service as any)[method](id);
            expectCall('GET', endpoint);
        });
    });

    describe('update*', () => {
        it('updateCompany PUTs to /companies/:id with body', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'co-1' });
            await service.updateCompany('co-1', { name: 'Acme2' });
            expectCall('PUT', '/companies/co-1', { name: 'Acme2' });
        });

        it('updateContact PUTs to /contacts/:id', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'p-1' });
            await service.updateContact('p-1', { email: 'a@b.test' });
            expectCall('PUT', '/contacts/p-1', { email: 'a@b.test' });
        });

        it('updateDeal PUTs to /deals/:id', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'd-1' });
            await service.updateDeal('d-1', { title: 'Bigger Deal' });
            expectCall('PUT', '/deals/d-1', { title: 'Bigger Deal' });
        });

        it('updateProduct PUTs to /products/:id', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'pr-1' });
            await service.updateProduct('pr-1', { name: 'Widget v2' });
            expectCall('PUT', '/products/pr-1', { name: 'Widget v2' });
        });
    });

    describe('delete*', () => {
        it.each([
            ['deleteCompany', 'co-1', '/companies/co-1'],
            ['deleteContact', 'p-1', '/contacts/p-1'],
            ['deleteDeal', 'd-1', '/deals/d-1'],
            ['deleteProduct', 'pr-1', '/products/pr-1'],
        ] as const)('%s DELETEs %s', async (method, id, endpoint) => {
            twenty.makeRequest.mockResolvedValue(undefined);
            await (service as any)[method](id);
            expectCall('DELETE', endpoint);
        });
    });

    describe('list endpoints', () => {
        it.each([
            ['getCompanies', '/companies'],
            ['getContacts', '/contacts'],
            ['getDeals', '/deals'],
            ['getProducts', '/products'],
        ] as const)('%s GETs %s and returns the array', async (method, endpoint) => {
            twenty.makeRequest.mockResolvedValue([{ id: '1' }, { id: '2' }]);
            const out = await (service as any)[method]();
            expect(out).toEqual([{ id: '1' }, { id: '2' }]);
            expectCall('GET', endpoint);
        });
    });

    it('propagates errors thrown by the underlying TwentyCrmService', async () => {
        twenty.makeRequest.mockRejectedValue(new Error('boom'));
        await expect(service.createCompany({ name: 'X' })).rejects.toThrow('boom');
    });
});
