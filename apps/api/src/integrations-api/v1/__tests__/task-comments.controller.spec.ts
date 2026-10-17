import { ForbiddenException } from '@nestjs/common';
import { DuplicateExternalRefError } from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { IntegrationTaskCommentsController } from '../task-comments.controller';

/**
 * Task comments of `/api/integrations/v1` (EW-P1-4): Idempotency-Key,
 * externalRef de-duplication, integration authorship (no edit window, its own
 * comments only) and the act-as user path — over doubles of the services.
 */
describe('IntegrationTaskCommentsController', () => {
    const ORG = 'org-1';
    const principal = (actAsUserId: string | null = null) => ({
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['tasks:write'],
        ownerUserId: 'owner-1',
        actAsUserId,
    });
    const integration = {
        userId: 'owner-1',
        authMethod: 'integration',
        integration: principal(),
    } as never;
    const actingAs = {
        userId: 'user-7',
        authMethod: 'integration',
        integration: principal('user-7'),
    } as never;
    const req = (key = 'idem-1') => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/tasks/task-1/comments',
        body: {},
        headers: key ? { 'idempotency-key': key } : {},
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = () => {
        const chat = {
            post: jest.fn().mockResolvedValue({ id: 'c-1' }),
            edit: jest.fn().mockResolvedValue({}),
            remove: jest.fn().mockResolvedValue(undefined),
        };
        const resources = {
            get: jest.fn().mockResolvedValue({ dto: { id: 'task-1' }, etag: '"3"' }),
            comment: jest.fn(async (_org: string, _task: string, id: string) => ({ id })),
            comments: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
        };
        const links = {
            findByExternal: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            removeAllFor: jest.fn().mockResolvedValue(1),
        };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({
                    ...(await work()),
                    replayed: false,
                }),
            ),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationTaskCommentsController(
            chat as never,
            resources as never,
            links as never,
            idempotency as never,
            scope as never,
        );
        return { controller, chat, resources, links };
    };

    it('posts as the integration with its externalAuthor, links the externalRef, never resolves @agents', async () => {
        const { controller, chat, links } = setup();
        const response = res();
        const body = await controller.create(
            integration,
            'task-1',
            {
                body: 'Hi @builder',
                externalAuthor: { name: 'Ada' },
                externalRef: { source: 'gauzy', externalId: 'gc-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(chat.post).toHaveBeenCalledWith(
            'owner-1',
            {
                taskId: 'task-1',
                authorType: 'integration',
                authorId: 'key-1',
                body: 'Hi @builder',
                externalAuthor: { name: 'Ada', avatarUrl: null, source: 'gauzy' },
            },
            {},
            expect.anything(),
        );
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                source: 'gauzy',
                installationId: 'conn-1',
            }),
            expect.objectContaining({
                entityType: 'task_comment',
                entityId: 'c-1',
                externalId: 'gc-1',
            }),
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toEqual({ id: 'c-1' });
    });

    it('an act-as user is the author, and externalAuthor is ignored', async () => {
        const { controller, chat } = setup();
        await controller.create(
            actingAs,
            'task-1',
            { body: 'Mine', externalAuthor: { name: 'Ada' } },
            undefined,
            req(),
            res(),
        );
        expect(chat.post).toHaveBeenCalledWith(
            'user-7',
            expect.objectContaining({
                authorType: 'user',
                authorId: 'user-7',
                externalAuthor: null,
            }),
            {},
            expect.anything(),
        );
    });

    it('answers 200 with the existing comment for a linked externalRef, and undoes a lost race', async () => {
        const { controller, chat, links } = setup();
        links.findByExternal.mockResolvedValueOnce({ entityId: 'c-existing' });
        const response = res();
        expect(
            await controller.create(
                integration,
                'task-1',
                { body: 'x', externalRef: { source: 'gauzy', externalId: 'gc-1' } },
                undefined,
                req(),
                response,
            ),
        ).toEqual({ id: 'c-existing' });
        expect(chat.post).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);

        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'c-winner' });
        links.create.mockRejectedValueOnce(
            new DuplicateExternalRefError('external', 'c-winner', 'gc-1'),
        );
        expect(
            await controller.create(
                integration,
                'task-1',
                { body: 'x', externalRef: { source: 'gauzy', externalId: 'gc-1' } },
                undefined,
                req(),
                res(),
            ),
        ).toEqual({ id: 'c-winner' });
        expect(chat.remove).toHaveBeenCalledWith('owner-1', 'c-1', expect.anything(), 'key-1');
    });

    it('requires an Idempotency-Key on create', async () => {
        const { controller } = setup();
        await expect(
            controller.create(integration, 'task-1', { body: 'x' }, undefined, req(''), res()),
        ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('PATCH and DELETE pass the integration as the author; a refusal is 422 domain_rule', async () => {
        const { controller, chat, links } = setup();
        expect(await controller.update(integration, 'task-1', 'c-1', { body: 'New' })).toEqual({
            id: 'c-1',
        });
        expect(chat.edit).toHaveBeenCalledWith(
            'owner-1',
            'c-1',
            'New',
            {},
            expect.anything(),
            'key-1',
        );

        await controller.update(actingAs, 'task-1', 'c-1', { body: 'Mine' });
        expect(chat.edit).toHaveBeenLastCalledWith(
            'user-7',
            'c-1',
            'Mine',
            {},
            expect.anything(),
            undefined,
        );

        chat.edit.mockRejectedValueOnce(
            new ForbiddenException('Edit window has expired (5 minutes).'),
        );
        const refused = controller.update(actingAs, 'task-1', 'c-1', { body: 'Late' });
        await expect(refused).rejects.toBeInstanceOf(IntegrationHttpException);
        await expect(refused).rejects.toMatchObject({ code: 'domain_rule' });

        await controller.remove(integration, 'task-1', 'c-1');
        expect(chat.remove).toHaveBeenCalledWith('owner-1', 'c-1', expect.anything(), 'key-1');
        expect(links.removeAllFor).toHaveBeenCalledWith(ORG, 'task_comment', 'c-1');

        chat.remove.mockRejectedValueOnce(
            new ForbiddenException('Only the original author can delete this message.'),
        );
        await expect(controller.remove(integration, 'task-1', 'c-2')).rejects.toMatchObject({
            code: 'domain_rule',
        });
    });

    it('lists through the resources service with keyset paging', async () => {
        const { controller, resources } = setup();
        await controller.list(integration, 'task-1', { limit: '10', cursor: 'abc' });
        expect(resources.comments).toHaveBeenCalledWith(
            ORG,
            'task-1',
            { updatedSince: null, cursor: 'abc', limit: 10 },
            'gauzy',
        );
    });
});
