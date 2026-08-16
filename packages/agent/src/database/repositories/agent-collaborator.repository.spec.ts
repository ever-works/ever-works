import { AgentCollaboratorRepository } from './agent-collaborator.repository';

const PARENT = 'agent-parent';
const CHILD = 'agent-child';

/**
 * Agent Collaborators — persistence of the sub-agent delegation
 * allow-list.
 *
 * The three behaviours that are not free from TypeORM and that the
 * runner's security decision depends on:
 *
 *  - `upsert` is idempotent against UNIQUE(agentId, collaboratorAgentId):
 *    a second call must UPDATE the existing row's `enabled` flag, never
 *    insert a second rule (two rows for one pair would make "is this
 *    collaborator enabled?" order-dependent);
 *  - a SELF edge is refused here, because a row saying "this agent may
 *    spawn itself" is redundant (self-delegation is always allowed) and
 *    would suggest the toggle controls it;
 *  - the list helpers must not silently widen: `listEnabledForAgent`
 *    filters on `enabled: true` — an unfiltered read would make a
 *    DISABLED rule behave exactly like an enabled one at the choke
 *    point that consumes it.
 */
describe('AgentCollaboratorRepository', () => {
    let repository: {
        find: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        delete: jest.Mock;
    };
    let collaborators: AgentCollaboratorRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((row: unknown) => row),
            save: jest.fn(async (row: unknown) => row),
            delete: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        collaborators = new AgentCollaboratorRepository(repository as never);
    });

    describe('listing', () => {
        it('listForAgent reads every rule of the parent, enabled or not', async () => {
            await collaborators.listForAgent(PARENT);

            expect(repository.find).toHaveBeenCalledWith({
                where: { agentId: PARENT },
                order: { createdAt: 'ASC' },
            });
        });

        it('listEnabledForAgent filters on enabled — a disabled rule must not leak through', async () => {
            await collaborators.listEnabledForAgent(PARENT);

            expect(repository.find).toHaveBeenCalledWith(
                expect.objectContaining({ where: { agentId: PARENT, enabled: true } }),
            );
        });

        it('listAgentsAllowing is the reverse lookup, keyed on the collaborator end', async () => {
            await collaborators.listAgentsAllowing(CHILD);

            expect(repository.find).toHaveBeenCalledWith(
                expect.objectContaining({ where: { collaboratorAgentId: CHILD } }),
            );
        });
    });

    describe('upsert', () => {
        it('inserts a new rule with the owner + scope columns', async () => {
            const row = await collaborators.upsert({
                userId: 'u1',
                agentId: PARENT,
                collaboratorAgentId: CHILD,
                enabled: true,
            });

            expect(repository.create).toHaveBeenCalledWith({
                userId: 'u1',
                agentId: PARENT,
                collaboratorAgentId: CHILD,
                enabled: true,
                tenantId: null,
                organizationId: null,
            });
            expect(row).toMatchObject({ agentId: PARENT, collaboratorAgentId: CHILD });
        });

        it('UPDATES the existing rule instead of inserting a duplicate', async () => {
            const existing = {
                id: 'row-1',
                agentId: PARENT,
                collaboratorAgentId: CHILD,
                enabled: true,
            };
            repository.findOne.mockResolvedValue(existing);

            const row = await collaborators.upsert({
                userId: 'u1',
                agentId: PARENT,
                collaboratorAgentId: CHILD,
                enabled: false,
            });

            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).toHaveBeenCalledWith(existing);
            expect(row).toMatchObject({ id: 'row-1', enabled: false });
        });

        it('refuses a SELF edge — self-delegation is implicit, never a row', async () => {
            await expect(
                collaborators.upsert({
                    userId: 'u1',
                    agentId: PARENT,
                    collaboratorAgentId: PARENT,
                    enabled: true,
                }),
            ).rejects.toThrow(/own collaborator/i);

            expect(repository.save).not.toHaveBeenCalled();
        });
    });

    describe('remove', () => {
        it('reports true when a rule was deleted', async () => {
            await expect(collaborators.remove(PARENT, CHILD)).resolves.toBe(true);
            expect(repository.delete).toHaveBeenCalledWith({
                agentId: PARENT,
                collaboratorAgentId: CHILD,
            });
        });

        it('is idempotent — a delete that matched nothing reports false', async () => {
            repository.delete.mockResolvedValue({ affected: 0 });
            await expect(collaborators.remove(PARENT, CHILD)).resolves.toBe(false);
        });

        it('treats an undefined affected count as "nothing removed" rather than crashing', async () => {
            repository.delete.mockResolvedValue({});
            await expect(collaborators.remove(PARENT, CHILD)).resolves.toBe(false);
        });

        it('deleteAllForAgent clears BOTH ends of the edge', async () => {
            await collaborators.deleteAllForAgent(PARENT);

            expect(repository.delete).toHaveBeenCalledWith({ agentId: PARENT });
            expect(repository.delete).toHaveBeenCalledWith({ collaboratorAgentId: PARENT });
        });
    });
});
