// The `@ever-works/agent/services` barrel pulls in the whole agent graph (work module ->
// subscriptions -> api notifications/auth -> ESM-only better-auth, website-generator
// config), which this jest environment cannot load. The controller only needs these
// classes as DI tokens and the spec hands it fakes: stub the barrel, as the other api
// specs do.
jest.mock('@ever-works/agent/services', () => ({
    WorkLifecycleService: class WorkLifecycleService {},
    WorkQueryService: class WorkQueryService {},
}));

jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { projectWorks: { enabled: jest.fn(() => true) } } },
}));

import { config } from '@ever-works/agent/config';
import { DuplicateExternalRefError } from '@ever-works/agent/integrations-api';
import { IntegrationWorksWriteController } from '../works-write.controller';

/**
 * `POST /api/integrations/v1/works` (Gauzy CR-6): a Project Work through the app's
 * own `createProjectWork`, owned by the caller, its Teams attached, the flag answered
 * as `422 domain_rule` — over doubles.
 */
describe('IntegrationWorksWriteController', () => {
    const ORG = 'org-1';
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['works:write'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const req = () => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/works',
        body: {},
        headers: { 'idempotency-key': 'idem-1' },
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = () => {
        const lifecycle = {
            // As WorkLifecycleService.createProjectWork: `withinCreate` runs in the create's
            // transaction (T17a pattern), and its throw rolls the Work back.
            createProjectWork: jest.fn(
                async (
                    _owner: unknown,
                    _params: unknown,
                    options?: {
                        withinCreate?: (row: { id: string }, manager: unknown) => Promise<void>;
                    },
                ) => {
                    if (options?.withinCreate) {
                        await options.withinCreate({ id: 'work-1' }, 'tx-manager');
                    }
                    return { id: 'work-1' };
                },
            ),
        };
        const workQuery = {
            checkSlugAvailability: jest
                .fn()
                .mockResolvedValue({ available: false, slug: 'site', suggestion: 'site-2' }),
        };
        const users = { findById: jest.fn().mockResolvedValue({ id: 'owner-1' }) };
        const teamResources = { attach: jest.fn().mockResolvedValue({}) };
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
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: { id, version: 1 },
                etag: '"1"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationWorksWriteController(
            lifecycle as never,
            workQuery as never,
            users as never,
            teamResources as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
        );
        return { controller, lifecycle, teamResources, links, resources };
    };

    it('creates a Project Work with a derived free slug, its Teams and its link', async () => {
        const { controller, lifecycle, teamResources, links } = setup();
        const response = res();
        await controller.create(
            user,
            {
                kind: 'project',
                name: 'Site',
                website: 'https://acme.test',
                teamIds: ['team-a'],
                externalRef: { source: 'gauzy', externalId: 'p-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(lifecycle.createProjectWork).toHaveBeenCalledWith(
            { id: 'owner-1' },
            expect.objectContaining({ name: 'Site', slug: 'site-2', website: 'https://acme.test' }),
            expect.objectContaining({ withinCreate: expect.any(Function) }),
        );
        // The link is written in the create's transaction (T17a pattern).
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({ installationId: 'conn-1' }),
            expect.objectContaining({ entityType: 'work', entityId: 'work-1', externalId: 'p-1' }),
            'tx-manager',
        );
        expect(teamResources.attach).toHaveBeenCalledWith('owner-1', ORG, 'team-a', {
            resourceType: 'work',
            resourceId: 'work-1',
        });
        expect(response.status).toHaveBeenCalledWith(201);
    });

    it('a lost externalRef race rolls the Project Work back and answers the winner (200)', async () => {
        const { controller, links, teamResources } = setup();
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'work-w' });
        links.create.mockRejectedValue(new DuplicateExternalRefError('external', 'work-w', 'p-1'));
        const response = res();
        const body = await controller.create(
            user,
            { kind: 'project', name: 'Site', externalRef: { source: 'gauzy', externalId: 'p-1' } },
            undefined,
            req(),
            response,
        );
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'work-w' });
        // Nothing of ours is left to attach: the Work rolled back with its link.
        expect(teamResources.attach).not.toHaveBeenCalled();
    });

    it('answers 422 project_works_disabled while the flag is off, and 422 for private', async () => {
        const { controller, lifecycle } = setup();
        (config.everWorks.projectWorks.enabled as jest.Mock).mockReturnValueOnce(false);
        await expect(
            controller.create(user, { kind: 'project', name: 'Site' }, undefined, req(), res()),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
            controller.create(
                user,
                { kind: 'project', name: 'Site', visibility: 'private' },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ status: 422 });
        expect(lifecycle.createProjectWork).not.toHaveBeenCalled();
    });

    it('checks every Team before it creates the Work (no orphan on a foreign Team)', async () => {
        const { controller, lifecycle, resources } = setup();
        resources.get.mockImplementation(async (kind: string, _org: string, id: string) => {
            if (kind === 'team') throw Object.assign(new Error('Not found'), { status: 404 });
            return { dto: { id, version: 1 }, etag: '"1"' };
        });
        await expect(
            controller.create(
                user,
                { kind: 'project', name: 'Site', teamIds: ['foreign-team'] },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ status: 404 });
        expect(lifecycle.createProjectWork).not.toHaveBeenCalled();
    });
});
