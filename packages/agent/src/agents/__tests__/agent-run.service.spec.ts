import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

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
        soulMd: '# Who I am\nThe boss.',
        agentsMd: null,
        heartbeatMd: '# Each tick\nLook at recent activity.',
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentRunService', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let activity: any;
    let assembler: PromptAssemblerService;
    let svc: AgentRunService;

    let skillBindings: any;
    beforeEach(() => {
        agents = { findById: jest.fn() };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            markFailed: jest.fn().mockResolvedValue(undefined),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        assembler = new PromptAssemblerService();
        svc = new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            skillBindings,
            activity,
        );
    });

    it('returns agent-not-found when the Agent is missing', async () => {
        agents.findById.mockResolvedValueOnce(null);
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'missing',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(result.status).toBe('agent-not-found');
        expect(runs.markFailed).not.toHaveBeenCalled();
    });

    it('happy heartbeat path — assembles a prompt and writes an INFO log row', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(result.status).toBe('assembled');
        expect(result.prompt?.systemMessage).toContain('Who I am');
        expect(result.prompt?.userMessage).toMatch(/What's the next action/);
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({ level: 'INFO', step: 'prompt-assembly' }),
        );
    });

    it('no-budget case returns allowed: true with reason="no-budget"', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(result.budgetCheck?.allowed).toBe(true);
        expect(result.budgetCheck?.reason).toBe('no-budget');
    });

    it('unlimited budget returns allowed: true with reason="unlimited"', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        budgets.findByAgentId.mockResolvedValueOnce({
            intervalUnit: 'unlimited',
            intervalCount: 1,
            capCents: null,
        });
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(result.budgetCheck?.allowed).toBe(true);
        expect(result.budgetCheck?.reason).toBe('unlimited');
    });

    it('budget blocked path — marks run failed, emits ERROR log + AGENT_BUDGET_EXCEEDED activity', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        // v1 currentSpendCents synthesizes to 0; force the cap-based
        // failure by overriding the checkBudget result directly.
        (svc as any).checkBudget = jest.fn().mockResolvedValueOnce({
            allowed: false,
            reason: 'over-cap',
            currentSpendCents: 5_000,
            capCents: 1_000,
            periodStart: new Date(),
            periodEnd: new Date(),
        });
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(result.status).toBe('budget-blocked');
        expect(runs.markFailed).toHaveBeenCalledWith('r1', 'Budget exceeded');
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({ level: 'ERROR', step: 'budget' }),
        );
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: ActivityActionType.AGENT_BUDGET_EXCEEDED }),
        );
    });

    it('records WARN run-log rows when PromptAssembler truncates a segment', async () => {
        const longTools = 'tool '.repeat(5_000);
        agents.findById.mockResolvedValueOnce(makeAgent({ toolsMd: longTools }));
        await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'heartbeat',
        });
        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({ level: 'WARN', step: 'prompt-assembly' }),
        );
    });

    it('task kind forks the user message to use immediateInput', async () => {
        agents.findById.mockResolvedValueOnce(makeAgent());
        const result = await svc.execute({
            runId: 'r1',
            agentId: 'a1',
            userId: 'u1',
            kind: 'task',
            immediateInput: 'Write the migration.',
        });
        expect(result.prompt?.userMessage).toContain('Write the migration.');
        expect(result.prompt?.systemMessage).toContain('You are working on a specific Task');
    });

    describe('Phase 10 — skill injection', () => {
        it('resolves bound skills via SkillBindingRepository and includes them in the prompt', async () => {
            agents.findById.mockResolvedValueOnce(makeAgent());
            skillBindings.resolveActive.mockResolvedValueOnce([
                {
                    binding: { priority: 50 },
                    skill: { id: 's1', slug: 'cron-defaults', instructionsMd: '# UTC always' },
                },
            ]);
            const result = await svc.execute({
                runId: 'r1',
                agentId: 'a1',
                userId: 'u1',
                kind: 'heartbeat',
            });
            expect(result.prompt?.systemMessage).toContain('cron-defaults');
            expect(result.prompt?.systemMessage).toContain('UTC always');
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'skill_invoked' }),
            );
        });

        it('drops lowest-priority skills when bundle exceeds maxSkillContextTokens + emits WARN log', async () => {
            agents.findById.mockResolvedValueOnce(makeAgent({ maxSkillContextTokens: 100 }));
            const longBody = 'word '.repeat(1_000); // ~1250 tokens
            skillBindings.resolveActive.mockResolvedValueOnce([
                {
                    binding: { priority: 50 },
                    skill: { id: 'a', slug: 'high-pri', instructionsMd: '# short' },
                },
                {
                    binding: { priority: 200 },
                    skill: { id: 'b', slug: 'low-pri', instructionsMd: longBody },
                },
            ]);
            const result = await svc.execute({
                runId: 'r1',
                agentId: 'a1',
                userId: 'u1',
                kind: 'heartbeat',
            });
            expect(result.prompt?.systemMessage).toContain('high-pri');
            expect(result.prompt?.systemMessage).not.toContain('low-pri');
            expect(runLogs.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    level: 'WARN',
                    step: 'skill-injection',
                    message: expect.stringMatching(/low-pri/),
                }),
            );
        });
    });
});
