import { PeopleController } from './people.controler';
import type { ClientService } from '../services/client.service';

describe('PeopleController', () => {
    let client: jest.Mocked<
        Pick<ClientService, 'getContacts' | 'createContact' | 'updateContact' | 'deleteContact'>
    >;
    let controller: PeopleController;

    beforeEach(() => {
        client = {
            getContacts: jest.fn(),
            createContact: jest.fn(),
            updateContact: jest.fn(),
            deleteContact: jest.fn(),
        };
        controller = new PeopleController(client as unknown as ClientService);
    });

    it('GET /people delegates to ClientService.getContacts', async () => {
        client.getContacts.mockResolvedValue([{ id: 'p-1', firstName: 'Ada' }]);
        await expect(controller.getContacts()).resolves.toEqual([{ id: 'p-1', firstName: 'Ada' }]);
        expect(client.getContacts).toHaveBeenCalledTimes(1);
    });

    it('POST /people maps the body fields explicitly into createContact (no extra fields leak through)', async () => {
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
        await controller.createContact(body);

        expect(client.createContact).toHaveBeenCalledWith({
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            phone: '+1-555',
            companyId: 'co-1',
            position: 'Engineer',
            avatarUrl: 'https://x/y.png',
        });
    });

    it('POST /people forwards undefined fields as undefined (no defaulting)', async () => {
        client.createContact.mockResolvedValue({ id: 'p-1' });
        await controller.createContact({} as any);
        expect(client.createContact).toHaveBeenCalledWith({
            firstName: undefined,
            lastName: undefined,
            email: undefined,
            phone: undefined,
            companyId: undefined,
            position: undefined,
            avatarUrl: undefined,
        });
    });

    it('PATCH /people/:id forwards id + body to updateContact', async () => {
        const body = { firstName: 'Ada2' };
        client.updateContact.mockResolvedValue({ id: 'p-1', ...body });
        await expect(controller.updateContact('p-1', body)).resolves.toEqual({
            id: 'p-1',
            firstName: 'Ada2',
        });
        expect(client.updateContact).toHaveBeenCalledWith('p-1', body);
    });

    it('DELETE /people/:id forwards id to deleteContact', async () => {
        client.deleteContact.mockResolvedValue(undefined);
        await controller.deleteContact('p-1');
        expect(client.deleteContact).toHaveBeenCalledWith('p-1');
    });

    it('propagates ClientService errors back to the caller', async () => {
        client.createContact.mockRejectedValue(new Error('upstream'));
        await expect(controller.createContact({} as any)).rejects.toThrow('upstream');
    });
});
