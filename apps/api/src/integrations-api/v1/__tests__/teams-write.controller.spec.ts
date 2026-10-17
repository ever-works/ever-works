import { VersionMismatchError } from '@ever-works/agent/integrations-api';
import { IntegrationTeamsWriteController } from '../teams-write.controller';

/**
 * Team writes of `/api/integrations/v1` (EW-P1-4): create with Idempotency-Key
 * and externalRef, If-Match on PATCH/DELETE, and the PUT sets as differences
 * through TeamsService / TeamResourcesService — over doubles.
 */
describe('IntegrationTeamsWriteController', () => {
    const ORG = 'org-1';
    const user = {
        userId: 'owner-1',
        authMethod: 'integration',
        integration: {
            keyId: 'key-1',
            integrationKind: 'ever-gauzy',
            tenantId: 'tenant-1',
            allowedOrganizationIds: [ORG],
            scopes: ['teams:write'],
            actAsUserId: null,
        },
    } as never;
    const req = () => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/teams',
        body: {},
        headers: { 'idempotency-key': 'idem-1' },
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = () => {
        const teams = {
            // As TeamsService.create: `withinCreate` runs in the create's transaction (T17a).
            create: jest.fn(
                async (
                    _userId: string,
                    _orgId: string,
                    _input: unknown,
                    options?: {
                        withinCreate?: (row: { id: string }, manager?: unknown) => Promise<void>;
                    },
                ) => {
                    const row = { id: 'team-1' };
                    if (options?.withinCreate) await options.withinCreate(row, 'tx-manager');
                    return row;
                },
            ),
            update: jest.fn().mockResolvedValue({}),
            remove: jest.fn().mockResolvedValue(undefined),
            addMember: jest.fn().mockResolvedValue({}),
            removeMember: jest.fn().mockResolvedValue(undefined),
        };
        const teamResources = { attach: jest.fn(), detach: jest.fn() };
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
        const resources = {
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: {
                    id,
                    version: 5,
                    members: [
                        { memberType: 'user', memberId: 'u-1', role: 'lead' },
                        { memberType: 'agent', memberId: 'ag-1', role: 'member' },
                    ],
                    resources: [
                        { resourceType: 'task', resourceId: 't-1' },
                        { resourceType: 'work', resourceId: 'w-1' },
                    ],
                },
                etag: '"5"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationTeamsWriteController(
            teams as never,
            teamResources as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
        );
        return { controller, teams, teamResources, links };
    };

    it('creates a team in the pinned organization and links its externalRef', async () => {
        const { controller, teams, links } = setup();
        const response = res();
        const body = await controller.create(
            user,
            {
                name: 'Platform',
                slug: 'platform',
                externalRef: { source: 'gauzy', externalId: 'gt-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(teams.create).toHaveBeenCalledWith(
            'owner-1',
            ORG,
            {
                name: 'Platform',
                slug: 'platform',
                description: null,
                parentTeamId: null,
                avatarIcon: null,
            },
            expect.objectContaining({ withinCreate: expect.any(Function) }),
        );
        // T17a — linked inside the create's transaction (its manager).
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG, installationId: 'conn-1' }),
            expect.objectContaining({ entityType: 'team', entityId: 'team-1', externalId: 'gt-1' }),
            'tx-manager',
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"5"');
        expect(body).toMatchObject({ id: 'team-1' });
    });

    it('answers 200 with the linked team for a known externalRef', async () => {
        const { controller, teams, links } = setup();
        links.findByExternal.mockResolvedValueOnce({ entityId: 'team-existing' });
        const response = res();
        const body = await controller.create(
            user,
            { name: 'Platform', externalRef: { source: 'gauzy', externalId: 'gt-1' } },
            undefined,
            req(),
            response,
        );
        expect(teams.create).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'team-existing' });
    });

    it('PATCH and DELETE honour If-Match; DELETE drops the team links', async () => {
        const { controller, teams, links } = setup();
        await expect(
            controller.update(user, 'team-1', { name: 'New' }, '"4"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        await controller.update(user, 'team-1', { name: 'New', avatarIcon: null }, '"5"', res());
        expect(teams.update).toHaveBeenCalledWith(ORG, 'team-1', { name: 'New', avatarIcon: null });
        await expect(controller.update(user, 'team-1', {}, undefined, res())).rejects.toMatchObject(
            {
                code: 'validation_failed',
            },
        );

        await controller.remove(user, 'team-1', undefined);
        expect(teams.remove).toHaveBeenCalledWith(ORG, 'team-1');
        expect(links.removeAllFor).toHaveBeenCalledWith(ORG, 'team', 'team-1');
    });

    it('PUT members applies the difference; a role change is a remove and an add', async () => {
        const { controller, teams } = setup();
        await controller.members(
            user,
            'team-1',
            {
                members: [
                    { memberType: 'user', memberId: 'u-1', role: 'member' },
                    { memberType: 'user', memberId: 'u-2', role: 'member' },
                ],
            },
            res(),
        );
        expect(teams.removeMember.mock.calls).toEqual([
            [ORG, 'team-1', 'user', 'u-1'],
            [ORG, 'team-1', 'agent', 'ag-1'],
        ]);
        expect(teams.addMember.mock.calls).toEqual([
            ['owner-1', ORG, 'team-1', { memberType: 'user', memberId: 'u-1', role: 'member' }],
            ['owner-1', ORG, 'team-1', { memberType: 'user', memberId: 'u-2', role: 'member' }],
        ]);
    });

    it('PUT resources applies the difference and refuses an unknown type', async () => {
        const { controller, teamResources } = setup();
        await controller.resourcesSet(
            user,
            'team-1',
            {
                resources: [
                    { resourceType: 'task', resourceId: 't-1' },
                    { resourceType: 'agent', resourceId: 'ag-9' },
                ],
            },
            res(),
        );
        expect(teamResources.detach).toHaveBeenCalledWith(ORG, 'team-1', 'work', 'w-1');
        // Review 2026-10-17 F4: attached as an integration (a private record answers 404).
        expect(teamResources.attach).toHaveBeenCalledWith(
            'owner-1',
            ORG,
            'team-1',
            { resourceType: 'agent', resourceId: 'ag-9' },
            { viewer: { kind: 'integration' } },
        );
        expect(teamResources.attach).toHaveBeenCalledTimes(1);
        await expect(
            controller.resourcesSet(
                user,
                'team-1',
                { resources: [{ resourceType: 'invoice', resourceId: 'x' }] },
                res(),
            ),
        ).rejects.toMatchObject({ code: 'validation_failed' });
    });
});
