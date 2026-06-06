import { BadRequestException } from '@nestjs/common';
import { ClientService } from './client.service';
import type { TwentyCrmService } from './twenty-crm.service';

// Security (cross-tenant IDOR fix): every ClientService method now REQUIRES a
// per-caller tenant id and forwards it to `TwentyCrmService.makeRequest` as the
// 6th positional arg, which selects that tenant's own Twenty workspace
// credentials. These tests assert the tenant id is always threaded through so a
// caller can only ever address rows in their own workspace.
const PREFIX = 'tenant-1';

describe('ClientService', () => {
    let twenty: { makeRequest: jest.Mock };
    let service: ClientService;

    beforeEach(() => {
        twenty = { makeRequest: jest.fn() };
        service = new ClientService(twenty as unknown as TwentyCrmService);
    });

    // makeRequest signature: (method, endpoint, data, params, schema, tenantId)
    const expectCall = (
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        endpoint: string,
        body?: unknown,
    ) => {
        const callArgs = twenty.makeRequest.mock.calls[0];
        expect(callArgs[0]).toBe(method);
        expect(callArgs[1]).toBe(endpoint);
        expect(callArgs[2]).toEqual(body);
        // schema flag must be false for data-plane calls, and the tenant id
        // must always be forwarded as the final arg.
        expect(callArgs[4]).toBe(false);
        expect(callArgs[5]).toBe(PREFIX);
    };

    describe('create*', () => {
        it('createCompany POSTs to /companies and returns the response', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'co-1', name: 'Acme' });
            const out = await service.createCompany({ name: 'Acme' }, PREFIX);
            expect(out).toEqual({ id: 'co-1', name: 'Acme' });
            expectCall('POST', '/companies', { name: 'Acme' });
        });

        it('createContact POSTs to /contacts', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'p-1' });
            await service.createContact({ firstName: 'A', email: 'a@b.test' }, PREFIX);
            expectCall('POST', '/contacts', { firstName: 'A', email: 'a@b.test' });
        });

        it('createDeal POSTs to /deals', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'd-1' });
            await service.createDeal({ title: 'Big Deal' }, PREFIX);
            expectCall('POST', '/deals', { title: 'Big Deal' });
        });

        it('createProduct POSTs to /products', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'pr-1' });
            await service.createProduct({ name: 'Widget' }, PREFIX);
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
            await (service as any)[method](id, PREFIX);
            expectCall('GET', endpoint);
        });
    });

    describe('update*', () => {
        it('updateCompany PUTs to /companies/:id with body', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'co-1' });
            await service.updateCompany('co-1', { name: 'Acme2' }, PREFIX);
            expectCall('PUT', '/companies/co-1', { name: 'Acme2' });
        });

        it('updateContact PUTs to /contacts/:id', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'p-1' });
            await service.updateContact('p-1', { email: 'a@b.test' }, PREFIX);
            expectCall('PUT', '/contacts/p-1', { email: 'a@b.test' });
        });

        it('updateDeal PUTs to /deals/:id', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'd-1' });
            await service.updateDeal('d-1', { title: 'Bigger Deal' }, PREFIX);
            expectCall('PUT', '/deals/d-1', { title: 'Bigger Deal' });
        });

        it('updateProduct PUTs to /products/:id', async () => {
            twenty.makeRequest.mockResolvedValue({ id: 'pr-1' });
            await service.updateProduct('pr-1', { name: 'Widget v2' }, PREFIX);
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
            await (service as any)[method](id, PREFIX);
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
            const out = await (service as any)[method](PREFIX);
            expect(out).toEqual([{ id: '1' }, { id: '2' }]);
            expectCall('GET', endpoint);
        });
    });

    describe('tenant-prefix enforcement (cross-tenant IDOR guard)', () => {
        it('rejects an empty/whitespace tenant prefix on a list call without hitting the CRM', async () => {
            await expect(service.getCompanies('')).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.getCompanies('   ')).rejects.toBeInstanceOf(BadRequestException);
            expect(twenty.makeRequest).not.toHaveBeenCalled();
        });

        it('rejects an empty tenant prefix on every mutation without hitting the CRM', async () => {
            await expect(service.createCompany({ name: 'X' }, '')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.updateCompany('co-1', { name: 'X' }, '')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.deleteCompany('co-1', '')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.createContact({ firstName: 'X' }, '')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.deleteContact('p-1', '')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(twenty.makeRequest).not.toHaveBeenCalled();
        });

        it('still rejects path-traversal in the record id even with a valid prefix', async () => {
            await expect(service.getCompany('../metadata/objects', PREFIX)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(twenty.makeRequest).not.toHaveBeenCalled();
        });
    });

    it('propagates errors thrown by the underlying TwentyCrmService', async () => {
        twenty.makeRequest.mockRejectedValue(new Error('boom'));
        await expect(service.createCompany({ name: 'X' }, PREFIX)).rejects.toThrow('boom');
    });
});
