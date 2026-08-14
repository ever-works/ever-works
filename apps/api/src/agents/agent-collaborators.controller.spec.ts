import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { AgentCollaboratorsController } from './agent-collaborators.controller';
import { UpdateAgentCollaboratorDto } from './dto/agent.dto';

const OWNER = 'user-1';
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const auth = { userId: OWNER } as never;

/**
 * Agent Collaborators controller — candidates listing + rule upsert.
 *
 * Pinned:
 *  - GET returns every OTHER agent of the owner (the parent never lists
 *    itself) with `configured`/`enabled` state merged from the rules;
 *  - PUT refuses a self edge with 400 and 404s a foreign agent on
 *    EITHER end via the service ownership gate (no existence leak);
 *  - the DTO whitelist rejects extra fields (global forbidNonWhitelisted).
 */
describe('AgentCollaboratorsController', () => {
    let service: { getOne: jest.Mock; list: jest.Mock };
    let repo: { listForAgent: jest.Mock; upsert: jest.Mock; remove: jest.Mock };
    let activityLog: { log: jest.Mock };
    let controller: AgentCollaboratorsController;

    beforeEach(() => {
        service = {
            getOne: jest.fn(async (userId: string, id: string) => {
                if (userId !== OWNER) throw new NotFoundException();
                return { id, name: 'CEO', slug: 'ceo' };
            }),
            list: jest.fn(async () => ({
                rows: [
                    {
                        id: AGENT,
                        name: 'CEO',
                        slug: 'ceo',
                        title: null,
                        status: 'active',
                        avatarMode: 'initials',
                        avatarIcon: null,
                    },
                    {
                        id: OTHER,
                        name: 'Researcher',
                        slug: 'researcher',
                        title: 'Research analyst',
                        status: 'active',
                        avatarMode: 'initials',
                        avatarIcon: null,
                    },
                ],
                total: 2,
            })),
        };
        repo = {
            listForAgent: jest.fn().mockResolvedValue([]),
            upsert: jest.fn(async (input) => ({ ...input, id: 'row-1' })),
            remove: jest.fn().mockResolvedValue(true),
        };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };
        controller = new AgentCollaboratorsController(
            service as never,
            repo as never,
            activityLog as never,
        );
    });

    describe('GET list', () => {
        it('lists every OTHER agent as a candidate, excluding the parent itself', async () => {
            const result = await controller.list(auth, AGENT);

            expect(result.data.map((row) => row.agentId)).toEqual([OTHER]);
            expect(result.data[0]).toMatchObject({
                name: 'Researcher',
                slug: 'researcher',
                title: 'Research analyst',
                configured: false,
                enabled: false,
            });
        });

        it('merges the configured rule state onto its candidate row', async () => {
            repo.listForAgent.mockResolvedValue([{ collaboratorAgentId: OTHER, enabled: true }]);

            const result = await controller.list(auth, AGENT);

            expect(result.data[0]).toMatchObject({ configured: true, enabled: true });
        });

        it('surfaces a DISABLED rule as configured-but-off', async () => {
            repo.listForAgent.mockResolvedValue([{ collaboratorAgentId: OTHER, enabled: false }]);

            const result = await controller.list(auth, AGENT);

            expect(result.data[0]).toMatchObject({ configured: true, enabled: false });
        });

        it('404s a cross-user agent before listing anything', async () => {
            service.getOne.mockRejectedValue(new NotFoundException());

            await expect(controller.list(auth, AGENT)).rejects.toThrow(NotFoundException);
            expect(repo.listForAgent).not.toHaveBeenCalled();
        });
    });

    describe('PUT upsert', () => {
        it('upserts the rule after verifying BOTH agents belong to the caller', async () => {
            const result = await controller.upsert(auth, AGENT, OTHER, { enabled: true });

            expect(service.getOne).toHaveBeenCalledWith(OWNER, AGENT);
            expect(service.getOne).toHaveBeenCalledWith(OWNER, OTHER);
            expect(repo.upsert).toHaveBeenCalledWith({
                userId: OWNER,
                agentId: AGENT,
                collaboratorAgentId: OTHER,
                enabled: true,
            });
            expect(result).toEqual({
                agentId: AGENT,
                collaboratorAgentId: OTHER,
                enabled: true,
            });
        });

        it('refuses a self edge with 400 — self-delegation needs no rule', async () => {
            await expect(controller.upsert(auth, AGENT, AGENT, { enabled: true })).rejects.toThrow(
                BadRequestException,
            );
            expect(repo.upsert).not.toHaveBeenCalled();
        });

        it("404s when the COLLABORATOR end is not the caller's agent", async () => {
            service.getOne.mockImplementation(async (_userId: string, id: string) => {
                if (id === OTHER) throw new NotFoundException();
                return { id };
            });

            await expect(controller.upsert(auth, AGENT, OTHER, { enabled: true })).rejects.toThrow(
                NotFoundException,
            );
            expect(repo.upsert).not.toHaveBeenCalled();
        });
    });

    describe('DELETE', () => {
        it('removes the rule and reports whether one existed', async () => {
            await expect(controller.remove(auth, AGENT, OTHER)).resolves.toEqual({
                removed: true,
            });
            expect(repo.remove).toHaveBeenCalledWith(AGENT, OTHER);
        });

        it('is idempotent — a second delete answers removed:false', async () => {
            repo.remove.mockResolvedValue(false);
            await expect(controller.remove(auth, AGENT, OTHER)).resolves.toEqual({
                removed: false,
            });
        });
    });

    describe('activity trail', () => {
        it('records an ENABLED row carrying both ends of the edge', async () => {
            await controller.upsert(auth, AGENT, OTHER, { enabled: true });

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: OWNER,
                    actionType: 'agent_collaborator_enabled',
                    details: expect.objectContaining({
                        // The feed matches on the PARENT agent; the
                        // collaborator rides along so the pair is recoverable.
                        resourceType: 'agent',
                        resourceId: AGENT,
                        collaboratorAgentId: OTHER,
                    }),
                }),
            );
        });

        it('records a DISABLED row when the toggle goes off', async () => {
            await controller.upsert(auth, AGENT, OTHER, { enabled: false });

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_collaborator_disabled' }),
            );
        });

        it('records a REMOVED row only when a rule actually existed', async () => {
            await controller.remove(auth, AGENT, OTHER);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_collaborator_removed' }),
            );

            activityLog.log.mockClear();
            repo.remove.mockResolvedValue(false);
            await controller.remove(auth, AGENT, OTHER);
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('a trail write that throws never fails the edit', async () => {
            activityLog.log.mockRejectedValue(new Error('activity db down'));

            await expect(controller.upsert(auth, AGENT, OTHER, { enabled: true })).resolves.toEqual(
                { agentId: AGENT, collaboratorAgentId: OTHER, enabled: true },
            );
        });

        it('works with the activity service unbound (optional injection)', async () => {
            const bare = new AgentCollaboratorsController(service as never, repo as never);

            await expect(bare.upsert(auth, AGENT, OTHER, { enabled: true })).resolves.toMatchObject(
                {
                    enabled: true,
                },
            );
        });
    });

    describe('UpdateAgentCollaboratorDto validation', () => {
        const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
        const meta = { type: 'body' as const, metatype: UpdateAgentCollaboratorDto };

        it('accepts { enabled: boolean }', async () => {
            await expect(pipe.transform({ enabled: false }, meta)).resolves.toMatchObject({
                enabled: false,
            });
        });

        it('rejects a non-boolean enabled', async () => {
            await expect(pipe.transform({ enabled: 'yes' }, meta)).rejects.toThrow();
        });

        it('rejects extra fields (forbidNonWhitelisted pins the wire shape)', async () => {
            await expect(
                pipe.transform({ enabled: true, agentId: 'sneaky' }, meta),
            ).rejects.toThrow();
        });
    });
});
