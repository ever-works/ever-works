import {
    BadRequestException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { RecordVisibilityController } from './record-visibility.controller';

/**
 * `/api/record-visibility` (EW-P1-3, spec §5 + §7): readers may GET, only the owner may
 * PUT, an integration principal may not choose `private`, and a record the caller may
 * not read is a 404.
 */
describe('RecordVisibilityController', () => {
    const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
    const owner = { userId: 'owner-1' } as never;
    const reader = { userId: 'reader-1' } as never;
    const integration = { userId: 'owner-1', authMethod: 'integration' } as never;
    const row = { id: 'task-1', userId: 'owner-1', ...scope };
    const state = { visibility: 'team', visibilityExplicit: false, teamIds: ['team-1'] };

    function build(opts: { row?: object | null; readable?: boolean } = {}) {
        const repository = {
            findOne: jest.fn().mockResolvedValue(opts.row === undefined ? row : opts.row),
        };
        const policy = {
            repositoryFor: jest.fn().mockReturnValue(repository),
            findVisibleNotOwned: jest.fn().mockResolvedValue(opts.readable ? row : null),
        };
        const visibility = {
            getState: jest.fn().mockResolvedValue(state),
            organizationTeamsOf: jest
                .fn()
                .mockResolvedValue([{ id: 'team-1', name: 'Core', slug: 'core' }]),
            setVisibility: jest.fn().mockResolvedValue({ ...state, visibilityExplicit: true }),
            setTeams: jest.fn().mockResolvedValue(state),
        };
        const scopeContext = { getScope: jest.fn().mockReturnValue(scope) };
        const controller = new RecordVisibilityController(
            policy as never,
            visibility as never,
            scopeContext as never,
        );
        return { controller, policy, visibility };
    }

    it('the owner reads the state with canEdit', async () => {
        const { controller } = build();
        await expect(controller.get(owner, 'task', 'task-1')).resolves.toEqual({
            ...state,
            canEdit: true,
            organizationTeams: [{ id: 'team-1', name: 'Core', slug: 'core' }],
        });
    });

    it('a reader who does not own the record reads it without canEdit', async () => {
        const { controller, policy } = build({ readable: true });
        await expect(controller.get(reader, 'task', 'task-1')).resolves.toEqual({
            ...state,
            canEdit: false,
        });
        expect(policy.findVisibleNotOwned).toHaveBeenCalledWith({
            aggregate: 'task',
            userId: 'reader-1',
            id: 'task-1',
            scope,
        });
    });

    it('a non-reader gets 404', async () => {
        const { controller } = build({ readable: false });
        await expect(controller.get(reader, 'task', 'task-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('only the owner may set visibility or Teams (a reader gets 404)', async () => {
        const { controller, visibility } = build({ readable: true });
        await expect(
            controller.set(reader, 'task', 'task-1', { visibility: 'private' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            controller.setTeams(reader, 'task', 'task-1', { teamIds: [] }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(visibility.setVisibility).not.toHaveBeenCalled();
        expect(visibility.setTeams).not.toHaveBeenCalled();
    });

    it('the owner sets visibility and Teams', async () => {
        const { controller, visibility } = build();
        await controller.set(owner, 'goal', 'task-1', { visibility: 'organization' });
        expect(visibility.setVisibility).toHaveBeenCalledWith('goal', 'task-1', 'organization');
        await controller.setTeams(owner, 'goal', 'task-1', { teamIds: ['team-1'] });
        expect(visibility.setTeams).toHaveBeenCalledWith('goal', 'task-1', ['team-1'], 'owner-1');
    });

    it('a row in another scope is not owned (404)', async () => {
        const { controller } = build({ row: { ...row, organizationId: 'org-2' } });
        await expect(
            controller.set(owner, 'task', 'task-1', { visibility: 'team' }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an integration principal may not choose private (422 domain_rule)', async () => {
        const { controller, visibility } = build();
        await expect(
            controller.set(integration, 'task', 'task-1', { visibility: 'private' }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(visibility.setVisibility).not.toHaveBeenCalled();
        await controller.set(integration, 'task', 'task-1', { visibility: 'team' });
        expect(visibility.setVisibility).toHaveBeenCalledWith('task', 'task-1', 'team');
    });

    it('rejects an unknown aggregate', async () => {
        const { controller } = build();
        await expect(controller.get(owner, 'work', 'task-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});
