import { IntegrationLinksController } from '../links.controller';

/**
 * `PUT` / `DELETE /api/integrations/v1/links/:entityType/:entityId` (EW-P1-4):
 * the record must be visible in the pinned organization, the source is the
 * key's, and the installation comes from the body or `X-Sync-Origin`.
 */
describe('IntegrationLinksController writes', () => {
    const ORG = 'org-1';
    const TASK = '0b6f7c1e-7a43-4a4f-9a51-5b9d1d2c0a11';
    const user = {
        userId: 'owner-1',
        authMethod: 'integration',
        integration: {
            keyId: 'key-1',
            integrationKind: 'ever-gauzy',
            tenantId: 'tenant-1',
            allowedOrganizationIds: [ORG],
            scopes: ['links:write'],
        },
    } as never;
    const row = {
        organizationId: ORG,
        entityType: 'task',
        entityId: TASK,
        source: 'gauzy',
        installationKey: 'conn-1',
        externalId: 'g-1',
        externalUrl: null,
        createdAt: new Date('2026-10-16T09:00:00Z'),
        updatedAt: new Date('2026-10-16T09:00:00Z'),
    };

    const setup = () => {
        const links = {
            put: jest.fn().mockResolvedValue(row),
            remove: jest.fn().mockResolvedValue(1),
            list: jest.fn(),
        };
        const resources = { assertLinkTarget: jest.fn().mockResolvedValue(true) };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationLinksController(
            links as never,
            scope as never,
            resources as never,
        );
        return { controller, links, resources };
    };

    it('PUT checks the record, then sets the link for the X-Sync-Origin installation', async () => {
        const { controller, links, resources } = setup();
        const dto = await controller.put(user, 'task', TASK, { externalId: 'g-1' }, 'gauzy:conn-1');
        expect(resources.assertLinkTarget).toHaveBeenCalledWith('task', ORG, TASK, 'gauzy');
        expect(links.put).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                source: 'gauzy',
                installationId: 'conn-1',
                integrationKeyId: 'key-1',
            }),
            { entityType: 'task', entityId: TASK, externalId: 'g-1', externalUrl: null },
        );
        expect(dto).toMatchObject({ entityId: TASK, source: 'gauzy', externalId: 'g-1' });
    });

    it('PUT refuses an unknown entity type and one v1 does not serve yet', async () => {
        const { controller, links, resources } = setup();
        await expect(
            controller.put(user, 'invoice', TASK, { externalId: 'g-1' }, undefined),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        resources.assertLinkTarget.mockResolvedValueOnce(false);
        await expect(
            controller.put(user, 'mission', TASK, { externalId: 'g-1' }, undefined),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        expect(links.put).not.toHaveBeenCalled();
    });

    it("DELETE removes this source's link, for one installation when named", async () => {
        const { controller, links } = setup();
        await controller.remove(user, 'task', TASK);
        expect(links.remove).toHaveBeenLastCalledWith(
            { organizationId: ORG, source: 'gauzy' },
            'task',
            TASK,
        );
        await controller.remove(user, 'task', TASK, 'conn-1');
        expect(links.remove).toHaveBeenLastCalledWith(
            { organizationId: ORG, source: 'gauzy', installationId: 'conn-1' },
            'task',
            TASK,
        );
    });
});
