import { IntegrationOrganizationsWriteController } from '../organizations-write.controller';

/**
 * `POST /api/integrations/v1/organizations` (EW-P2-6, `org:write`): the Organization
 * is created for the Tenant owner, pinned to the calling key, and an admin's key
 * makes its creator an admin of it — over doubles.
 */
describe('IntegrationOrganizationsWriteController', () => {
    const principal = (ownerUserId: string) => ({
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: ['org-a'],
        scopes: ['org:write'],
        ownerUserId,
        actAsUserId: null,
    });
    const user = (ownerUserId: string) =>
        ({
            userId: ownerUserId,
            authMethod: 'integration',
            integration: principal(ownerUserId),
        }) as never;
    const req = () => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/organizations',
        body: {},
        headers: { 'idempotency-key': 'idem-1' },
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = () => {
        const organizations = {
            createOrganization: jest.fn().mockResolvedValue({ id: 'org-new' }),
        };
        const keys = {
            addPin: jest.fn().mockResolvedValue(['org-a', 'org-new']),
            releasePin: jest.fn().mockResolvedValue(undefined),
        };
        const tenants = {
            findById: jest.fn().mockResolvedValue({ id: 'tenant-1', ownerUserId: 'owner-1' }),
        };
        const members = {
            findByOrgAndUser: jest.fn().mockResolvedValue(null),
            listAdministeredOrganizationIds: jest.fn().mockResolvedValue(['org-a']),
            create: jest.fn(async (row: Record<string, unknown>) => ({ ...row, id: 'm-1' })),
        };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({ ...(await work()), replayed: false }),
            ),
        };
        const resources = {
            organization: jest.fn().mockResolvedValue({ dto: { id: 'org-new' }, etag: '"1"' }),
        };
        const controller = new IntegrationOrganizationsWriteController(
            organizations as never,
            keys as never,
            tenants as never,
            members as never,
            idempotency as never,
            resources as never,
        );
        return { controller, organizations, keys, members };
    };

    it('creates the Organization for the Tenant owner and pins it to the key', async () => {
        const { controller, organizations, keys, members } = setup();
        const response = res();
        const body = await controller.create(
            user('owner-1'),
            { displayName: 'Acme EU', countryCode: 'de' },
            req(),
            response,
        );
        // The pin is reserved first, for the id the Organization is then created with.
        const reserved = keys.addPin.mock.calls[0][1] as string;
        expect(reserved).toMatch(/^[0-9a-f-]{36}$/);
        expect(organizations.createOrganization).toHaveBeenCalledWith(
            'owner-1',
            'Acme EU',
            undefined,
            { legalName: null, countryCode: 'DE', id: reserved },
        );
        expect(keys.addPin.mock.invocationCallOrder[0]).toBeLessThan(
            organizations.createOrganization.mock.invocationCallOrder[0],
        );
        expect(members.create).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toEqual({ id: 'org-new' });
    });

    it("an admin's key makes its creator an admin of the new Organization", async () => {
        const { controller, organizations, members } = setup();
        await controller.create(user('admin-1'), { displayName: 'Acme EU' }, req(), res());
        expect(organizations.createOrganization).toHaveBeenCalledWith(
            'owner-1',
            'Acme EU',
            undefined,
            expect.anything(),
        );
        expect(members.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-new',
                userId: 'admin-1',
                role: 'admin',
            }),
        );
    });

    it('writes nothing when the key has no pin left (400 before the create)', async () => {
        const { controller, organizations, keys, members } = setup();
        keys.addPin.mockRejectedValue(
            Object.assign(new Error('A key may be pinned to at most 50 organizations'), {
                status: 400,
            }),
        );
        await expect(
            controller.create(user('owner-1'), { displayName: 'Acme EU' }, req(), res()),
        ).rejects.toMatchObject({ status: 400 });
        expect(organizations.createOrganization).not.toHaveBeenCalled();
        expect(members.create).not.toHaveBeenCalled();
    });

    it('a failed create releases the reserved pin', async () => {
        const { controller, organizations, keys } = setup();
        organizations.createOrganization.mockRejectedValue(new Error('slug taken'));
        await expect(
            controller.create(user('owner-1'), { displayName: 'Acme EU' }, req(), res()),
        ).rejects.toThrow('slug taken');
        const reserved = keys.addPin.mock.calls[0][1] as string;
        expect(keys.releasePin).toHaveBeenCalledWith('key-1', reserved);
    });

    it("a demoted admin's key cannot create an Organization (and so regain the role)", async () => {
        const { controller, organizations, members } = setup();
        members.listAdministeredOrganizationIds.mockResolvedValue([]);
        await expect(
            controller.create(user('admin-1'), { displayName: 'Acme EU' }, req(), res()),
        ).rejects.toMatchObject({ status: 422 });
        expect(organizations.createOrganization).not.toHaveBeenCalled();
    });
});
