import {
    DuplicateExternalRefError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { IntegrationIdeasController } from '../ideas.controller';

/**
 * Ideas of `/api/integrations/v1` (EW-P2-1): creates always external + pending
 * through `createExternal`, externalRef de-duplication, If-Match, idempotent
 * dismiss / restore and the owner rule — over doubles of the domain services.
 */
describe('IntegrationIdeasController', () => {
    const ORG = 'org-1';
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['ideas:write'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const req = (key: string | undefined = 'idem-1', body: unknown = {}) => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/ideas',
        body,
        headers: key ? { 'idempotency-key': key } : {},
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = (status = 'pending') => {
        const ideas = {
            // As WorkProposalService.createExternal: `withinCreate` runs in the create's
            // transaction (T17a pattern), and its throw rolls the Idea back.
            createExternal: jest.fn(
                async (
                    _input: unknown,
                    options?: {
                        withinCreate?: (row: { id: string }, manager: unknown) => Promise<void>;
                    },
                ) => {
                    if (options?.withinCreate)
                        await options.withinCreate({ id: 'idea-1' }, 'tx-manager');
                    return { id: 'idea-1' };
                },
            ),
            updateContent: jest.fn().mockResolvedValue({}),
            dismiss: jest.fn().mockResolvedValue(true),
            restore: jest.fn().mockResolvedValue(true),
            delete: jest.fn().mockResolvedValue({ deleted: true }),
            getForUser: jest.fn(async (userId: string, id: string) =>
                userId === 'owner-1' ? { id, status } : null,
            ),
        };
        const visibility = {
            setTeams: jest.fn().mockResolvedValue({}),
            setVisibility: jest.fn().mockResolvedValue({}),
        };
        const links = {
            findByExternal: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
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
            list: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: { id, version: 3, status },
                etag: '"3"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationIdeasController(
            ideas as never,
            visibility as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
        );
        return { controller, ideas, visibility, links, idempotency, resources };
    };

    it('creates an Idea through createExternal, attributed to the key, linked to its externalRef', async () => {
        const { controller, ideas, links } = setup();
        const response = res();
        const body = await controller.create(
            user,
            {
                title: 'Customer portal',
                description: 'Invoices for customers.',
                teamIds: ['team-a'],
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(ideas.createExternal).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'owner-1',
                tenantId: 'tenant-1',
                organizationId: ORG,
                title: 'Customer portal',
                teamIds: ['team-a'],
                integrationKeyId: 'key-1',
                createdBy: { type: 'integration', id: 'key-1' },
            }),
            expect.objectContaining({ withinCreate: expect.any(Function) }),
        );
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                source: 'gauzy',
                installationId: 'conn-1',
            }),
            expect.objectContaining({ entityType: 'idea', entityId: 'idea-1', externalId: 'g-1' }),
            'tx-manager',
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"3"');
        expect(body).toMatchObject({ id: 'idea-1' });
    });

    it('answers 200 with the existing Idea for a repeated externalRef, creating nothing', async () => {
        const { controller, ideas, links } = setup();
        links.findByExternal.mockResolvedValue({ entityId: 'idea-0' });
        const response = res();
        const body = await controller.create(
            user,
            {
                title: 'Again',
                description: 'Same reference.',
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            },
            undefined,
            req(),
            response,
        );
        expect(ideas.createExternal).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'idea-0' });
    });

    it('rolls its create back (one transaction) and answers the winner when a concurrent create took the externalRef', async () => {
        const { controller, ideas, links } = setup();
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'idea-w' });
        links.create.mockRejectedValue(new DuplicateExternalRefError('external', 'idea-w', 'g-1'));
        const response = res();
        const body = await controller.create(
            user,
            {
                title: 'Race',
                description: 'Lost it.',
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            },
            undefined,
            req(),
            response,
        );
        // Nothing to undo: the link threw inside the create's transaction.
        expect(ideas.delete).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'idea-w' });
    });

    it('requires an Idempotency-Key, refuses private (422) and another source', async () => {
        const { controller } = setup();
        await expect(
            controller.create(
                user,
                { title: 't', description: 'd' },
                undefined,
                // '' (not `undefined`, which takes the default key): no header at all.
                req(''),
                res(),
            ),
        ).rejects.toBeInstanceOf(IntegrationHttpException);
        await expect(
            controller.create(
                user,
                { title: 't', description: 'd', visibility: 'private' },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
            controller.create(
                user,
                { title: 't', description: 'd', externalRef: { source: 'jira', externalId: 'x' } },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ status: 400 });
    });

    it('PATCH edits content, teams and visibility as the owner, under If-Match', async () => {
        const { controller, ideas, visibility } = setup();
        await controller.update(
            user,
            'idea-1',
            { title: 'Portal v2', teamIds: ['team-a'], visibility: 'organization' },
            '"3"',
            res(),
        );
        expect(ideas.updateContent).toHaveBeenCalledWith('owner-1', 'idea-1', {
            title: 'Portal v2',
            description: undefined,
        });
        expect(visibility.setTeams).toHaveBeenCalledWith('idea', 'idea-1', ['team-a'], 'owner-1');
        expect(visibility.setVisibility).toHaveBeenCalledWith('idea', 'idea-1', 'organization');
    });

    it('PATCH answers 412 on a stale If-Match, 400 on an empty body, 404 for an Idea someone else owns', async () => {
        const { controller, ideas } = setup();
        await expect(
            controller.update(user, 'idea-1', { title: 'x' }, '"2"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        await expect(controller.update(user, 'idea-1', {}, undefined, res())).rejects.toMatchObject(
            {
                status: 400,
            },
        );
        const other = { ...(user as object), userId: 'someone-else' } as never;
        await expect(
            controller.update(other, 'idea-1', { title: 'x' }, undefined, res()),
        ).rejects.toMatchObject({ status: 404 });
        expect(ideas.updateContent).not.toHaveBeenCalled();
    });

    it('dismiss moves a pending Idea; a repeat is a no-op 200; a building Idea answers 422', async () => {
        const pending = setup('pending');
        await pending.controller.dismiss(user, 'idea-1', res());
        expect(pending.ideas.dismiss).toHaveBeenCalledWith('owner-1', 'idea-1');

        const dismissed = setup('dismissed');
        await dismissed.controller.dismiss(user, 'idea-1', res());
        expect(dismissed.ideas.dismiss).not.toHaveBeenCalled();

        const building = setup('building');
        await expect(building.controller.dismiss(user, 'idea-1', res())).rejects.toMatchObject({
            status: 422,
        });
        expect(building.ideas.dismiss).not.toHaveBeenCalled();
    });

    it('restore moves a dismissed Idea back to pending; a pending one is a no-op; an accepted one is 422', async () => {
        const dismissed = setup('dismissed');
        await dismissed.controller.restore(user, 'idea-1', res());
        expect(dismissed.ideas.restore).toHaveBeenCalledWith('owner-1', 'idea-1');

        const pending = setup('pending');
        await pending.controller.restore(user, 'idea-1', res());
        expect(pending.ideas.restore).not.toHaveBeenCalled();

        const accepted = setup('accepted');
        await expect(accepted.controller.restore(user, 'idea-1', res())).rejects.toMatchObject({
            status: 422,
        });
    });

    it('lists the pinned organization Ideas through the shared reader', async () => {
        const { controller, resources } = setup();
        await controller.list(user, { limit: '50' });
        expect(resources.list).toHaveBeenCalledWith(
            'idea',
            ORG,
            expect.objectContaining({ limit: 50, cursor: null }),
            'gauzy',
        );
    });
});
