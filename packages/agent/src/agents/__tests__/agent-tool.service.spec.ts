import { AgentToolService } from '../agent-tool.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentToolService.resolveAllowedTools', () => {
    let agents: any;
    let skills: any;
    let bindings: any;
    let files: any;
    let svc: AgentToolService;

    beforeEach(() => {
        agents = { create: jest.fn() };
        skills = { findByIdAndUser: jest.fn() };
        bindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        files = { write: jest.fn() };
        svc = new AgentToolService(agents, skills, bindings, files);
    });

    it('always exposes the placeholder tools (getActivity + getKbDocument)', () => {
        const tools = svc.resolveAllowedTools(makeAgent());
        const names = tools.map((t) => t.name);
        expect(names).toContain('getActivity');
        expect(names).toContain('getKbDocument');
    });

    it('exposes getSkillBody when SkillRepository + SkillBindingRepository are wired', () => {
        const tools = svc.resolveAllowedTools(makeAgent());
        expect(tools.map((t) => t.name)).toContain('getSkillBody');
    });

    it('gates editAgentFile behind permissions.canEditAgentFiles', () => {
        const noPerm = svc.resolveAllowedTools(makeAgent());
        expect(noPerm.map((t) => t.name)).not.toContain('editAgentFile');

        const withPerm = svc.resolveAllowedTools(
            makeAgent({
                permissions: { ...makeAgent().permissions, canEditAgentFiles: true },
            }),
        );
        expect(withPerm.map((t) => t.name)).toContain('editAgentFile');
    });

    it('gates createSubAgent behind permissions.canCreateAgents', () => {
        const noPerm = svc.resolveAllowedTools(makeAgent());
        expect(noPerm.map((t) => t.name)).not.toContain('createSubAgent');

        const withPerm = svc.resolveAllowedTools(
            makeAgent({
                permissions: { ...makeAgent().permissions, canCreateAgents: true },
            }),
        );
        expect(withPerm.map((t) => t.name)).toContain('createSubAgent');
    });

    describe('editAgentFile tool — once-per-file-per-run cap', () => {
        it('rejects a second edit of the same file in the same run', async () => {
            files.write.mockResolvedValue({ newHash: 'h' });
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canEditAgentFiles: true },
                }),
                { runId: 'r1', editsThisRunByFile: new Set() },
            );
            const tool = tools.find((t) => t.name === 'editAgentFile')!;
            const first = (await tool.invoke({ name: 'SOUL.md', body: '# v1' })) as Record<
                string,
                unknown
            >;
            expect('newHash' in first && first.newHash).toBe('h');
            const second = (await tool.invoke({ name: 'SOUL.md', body: '# v2' })) as Record<
                string,
                unknown
            >;
            expect('error' in second).toBe(true);
            expect((second as any).error).toMatch(/already edited once in this run/);
        });

        it('allows edits to DIFFERENT files in the same run', async () => {
            files.write.mockResolvedValue({ newHash: 'h' });
            const ctx = { runId: 'r1', editsThisRunByFile: new Set<string>() };
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canEditAgentFiles: true },
                }),
                ctx,
            );
            const tool = tools.find((t) => t.name === 'editAgentFile')!;
            const first = (await tool.invoke({ name: 'SOUL.md', body: '# soul' })) as Record<
                string,
                unknown
            >;
            const second = (await tool.invoke({ name: 'TOOLS.md', body: '# tools' })) as Record<
                string,
                unknown
            >;
            expect('newHash' in first).toBe(true);
            expect('newHash' in second).toBe(true);
        });
    });

    describe('createSubAgent tool', () => {
        it('always creates the sub-Agent in DRAFT with all permissions FALSE', async () => {
            agents.create.mockResolvedValueOnce({ id: 'sub-1', slug: 'helper' });
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCreateAgents: true },
                }),
            );
            const tool = tools.find((t) => t.name === 'createSubAgent')!;
            await tool.invoke({ name: 'Helper' });
            const arg = agents.create.mock.calls[0][0];
            expect(arg.status).toBe('draft');
            expect(arg.permissions).toEqual({
                canCreateAgents: false,
                canAssignTasks: false,
                canEditSkills: false,
                canEditAgentFiles: false,
                canSpend: false,
                canCommitToRepo: false,
                canOpenPullRequests: false,
                canCallExternalTools: false,
            });
        });

        it('inherits the actor scope into the sub-Agent', async () => {
            agents.create.mockResolvedValueOnce({ id: 'sub-1', slug: 'helper' });
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    scope: AgentScope.MISSION,
                    missionId: 'm1',
                    permissions: { ...makeAgent().permissions, canCreateAgents: true },
                }),
            );
            const tool = tools.find((t) => t.name === 'createSubAgent')!;
            await tool.invoke({ name: 'Helper' });
            const arg = agents.create.mock.calls[0][0];
            expect(arg.scope).toBe(AgentScope.MISSION);
            expect(arg.missionId).toBe('m1');
        });

        it('requires a name', async () => {
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCreateAgents: true },
                }),
            );
            const tool = tools.find((t) => t.name === 'createSubAgent')!;
            const out = (await tool.invoke({} as any)) as Record<string, unknown>;
            expect('error' in out).toBe(true);
        });
    });

    describe('sendEmail tool (EW-670 / T23)', () => {
        const makeEmailFacade = () => ({ sendEmail: jest.fn() });

        it('is NOT exposed when emailFacade token is unbound', () => {
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            expect(tools.map((t) => t.name)).not.toContain('sendEmail');
        });

        it('is NOT exposed without canCallExternalTools even when facade is wired', () => {
            const facade = makeEmailFacade();
            const withFacade = new AgentToolService(
                agents,
                skills,
                bindings,
                files,
                undefined,
                undefined,
                facade as any,
            );
            const tools = withFacade.resolveAllowedTools(makeAgent());
            expect(tools.map((t) => t.name)).not.toContain('sendEmail');
        });

        it('is exposed when canCallExternalTools + facade are both present', () => {
            const facade = makeEmailFacade();
            const withFacade = new AgentToolService(
                agents,
                skills,
                bindings,
                files,
                undefined,
                undefined,
                facade as any,
            );
            const tools = withFacade.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            expect(tools.map((t) => t.name)).toContain('sendEmail');
        });

        it('invoke rejects empty recipient list + forwards valid sends to the facade', async () => {
            const facade = makeEmailFacade();
            facade.sendEmail.mockResolvedValue({
                providerMessageId: 'pm-1',
                accepted: ['b@x.com'],
                rejected: [],
            });
            const withFacade = new AgentToolService(
                agents,
                skills,
                bindings,
                files,
                undefined,
                undefined,
                facade as any,
            );
            const tools = withFacade.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            const tool = tools.find((t) => t.name === 'sendEmail')!;

            const bad = (await tool.invoke({
                to: [],
                subject: 's',
                bodyText: 'b',
            } as any)) as Record<string, unknown>;
            expect('error' in bad).toBe(true);
            expect(facade.sendEmail).not.toHaveBeenCalled();

            const ok = await tool.invoke({
                to: ['b@x.com'],
                subject: 'hello',
                bodyText: 'world',
            } as any);
            expect(facade.sendEmail).toHaveBeenCalledTimes(1);
            expect((ok as { providerMessageId: string }).providerMessageId).toBe('pm-1');
        });
    });

    describe('messageAgent tool (EW-670 / T24)', () => {
        const makeFullFacade = () => ({ sendEmail: jest.fn(), messageAgent: jest.fn() });
        const wire = (facade: unknown) =>
            new AgentToolService(
                agents,
                skills,
                bindings,
                files,
                undefined,
                undefined,
                facade as any,
            );

        it('is NOT exposed when the facade only implements sendEmail', () => {
            const svcSendOnly = wire({ sendEmail: jest.fn() });
            const tools = svcSendOnly.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            expect(tools.map((t) => t.name)).toContain('sendEmail');
            expect(tools.map((t) => t.name)).not.toContain('messageAgent');
        });

        it('is exposed when the facade implements messageAgent + permission present', () => {
            const tools = wire(makeFullFacade()).resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            expect(tools.map((t) => t.name)).toContain('messageAgent');
        });

        it('invoke rejects self-message + forwards a valid peer message', async () => {
            const facade = makeFullFacade();
            facade.messageAgent.mockResolvedValue({
                providerMessageId: 'pm-9',
                targetAddress: 'peer@inbound.acme.com',
            });
            const tools = wire(facade).resolveAllowedTools(
                makeAgent({
                    id: 'agent-self',
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            const tool = tools.find((t) => t.name === 'messageAgent')!;

            const selfMsg = (await tool.invoke({
                targetAgentId: 'agent-self',
                subject: 's',
                body: 'b',
            } as any)) as Record<string, unknown>;
            expect('error' in selfMsg).toBe(true);
            expect(facade.messageAgent).not.toHaveBeenCalled();

            const ok = await tool.invoke({
                targetAgentId: 'agent-peer',
                subject: 'sync up',
                body: 'please review',
            } as any);
            expect(facade.messageAgent).toHaveBeenCalledTimes(1);
            expect((ok as { providerMessageId: string }).providerMessageId).toBe('pm-9');
        });
    });

    describe('notifyChannel tool (EW-673 / T26)', () => {
        const wire = (facade: unknown) =>
            new AgentToolService(
                agents,
                skills,
                bindings,
                files,
                undefined,
                undefined,
                undefined,
                facade as any,
            );

        it('is NOT exposed without the facade token', () => {
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            expect(tools.map((t) => t.name)).not.toContain('notifyChannel');
        });

        it('is NOT exposed without canCallExternalTools', () => {
            const tools = wire({ notifyChannel: jest.fn() }).resolveAllowedTools(makeAgent());
            expect(tools.map((t) => t.name)).not.toContain('notifyChannel');
        });

        it('is exposed when permission + facade are present', () => {
            const tools = wire({ notifyChannel: jest.fn() }).resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            expect(tools.map((t) => t.name)).toContain('notifyChannel');
        });

        it('invoke validates input + forwards a valid call', async () => {
            const facade = { notifyChannel: jest.fn().mockResolvedValue({ status: 'delivered', providerMessageId: 'm-1' }) };
            const tools = wire(facade).resolveAllowedTools(
                makeAgent({
                    permissions: { ...makeAgent().permissions, canCallExternalTools: true },
                }),
            );
            const tool = tools.find((t) => t.name === 'notifyChannel')!;

            const bad = (await tool.invoke({ channelId: '', text: 'x' } as any)) as Record<string, unknown>;
            expect('error' in bad).toBe(true);
            expect(facade.notifyChannel).not.toHaveBeenCalled();

            const ok = await tool.invoke({ channelId: 'ch-1', text: 'deploy finished' } as any);
            expect(facade.notifyChannel).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: 'ch-1', text: 'deploy finished' }),
            );
            expect((ok as { status: string }).status).toBe('delivered');
        });
    });
});
