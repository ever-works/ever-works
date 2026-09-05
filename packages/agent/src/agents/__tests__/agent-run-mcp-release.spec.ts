import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import type { AgentAiDispatchFacade, AgentAiDispatchResult } from '../agent-ai-dispatch-facade';
import type { AgentRunChatBackPoster, AgentRunTaskFinisher } from '../agent-run-post-processor';

/**
 * AP-14 prerequisite — the MCP tool source is released on EVERY exit path
 * of the tool loop.
 *
 * `buildTools` may acquire per-run resources (the stdio slice launches a
 * subprocess per run). Nothing in the run path used to hand the run back,
 * so a launched server would have outlived its run for the lifetime of the
 * pod. These pin the three exits that matter: a completed loop, a loop the
 * model broke, and — the one the inner `finally` cannot see — tool
 * resolution throwing before the loop even starts.
 *
 * Same harness as the session-detail capture spec: real service over
 * mocked repositories, driven through `execute()`.
 */
function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'Builder',
        slug: 'builder',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: 'gpt-4o-mini',
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
            canCallExternalTools: true,
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
        soulMd: '# Who I am\nA builder.',
        agentsMd: null,
        heartbeatMd: '# Each tick\nBuild.',
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentRunService — MCP run resources are released on every exit path', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let skillBindings: any;
    let activity: any;
    let assembler: PromptAssemblerService;
    let chatBackPoster: jest.Mocked<AgentRunChatBackPoster>;
    let taskFinisher: jest.Mocked<AgentRunTaskFinisher>;
    let ai: jest.Mocked<AgentAiDispatchFacade>;
    let toolService: { resolveGrantedTools: jest.Mock; releaseMcpRun: jest.Mock };

    function aiResponse(over: Partial<AgentAiDispatchResult> = {}): AgentAiDispatchResult {
        return {
            text: 'Working on it.',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            model: 'gpt-4o-mini',
            ...over,
        };
    }

    beforeEach(() => {
        agents = { findById: jest.fn().mockResolvedValue(makeAgent()) };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue({ status: 'running' }),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            addTokens: jest.fn().mockResolvedValue(undefined),
            mergeFilesTouched: jest.fn().mockResolvedValue(undefined),
            takeSteeringSignals: jest
                .fn()
                .mockResolvedValue({ pendingInput: [], interruptRequested: false }),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        assembler = new PromptAssemblerService();
        chatBackPoster = { postReply: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
        taskFinisher = { finishTask: jest.fn().mockResolvedValue({ status: 'done' }) };
        ai = { dispatch: jest.fn().mockResolvedValue(aiResponse()) };
        toolService = {
            resolveGrantedTools: jest.fn().mockResolvedValue({ tools: [], refused: [] }),
            releaseMcpRun: jest.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => jest.restoreAllMocks());

    function makeSvc(): AgentRunService {
        return new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            skillBindings,
            activity,
            chatBackPoster,
            taskFinisher,
            toolService as any,
            ai,
        );
    }

    const ctx = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'task' as const,
        taskId: 't1',
        immediateInput: 'Ship it.',
    };

    it('releases the run after a completed loop, exactly once, with the run id', async () => {
        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(toolService.releaseMcpRun).toHaveBeenCalledTimes(1);
        expect(toolService.releaseMcpRun).toHaveBeenCalledWith('r1');
    });

    it('releases the run when the model dispatch throws mid-loop', async () => {
        ai.dispatch.mockRejectedValue(new Error('provider exploded'));

        await makeSvc().execute(ctx);

        expect(toolService.releaseMcpRun).toHaveBeenCalledWith('r1');
    });

    it('releases the run when tool resolution itself throws — before the loop has a try to fail in', async () => {
        toolService.resolveGrantedTools.mockRejectedValue(new Error('grant matrix down'));

        // `execute()` has no try around the loop: a run that cannot get its
        // tools propagates to the worker. The release must have happened
        // anyway — that is the whole point of the outer wrapper.
        await expect(makeSvc().execute(ctx)).rejects.toThrow('grant matrix down');

        expect(toolService.releaseMcpRun).toHaveBeenCalledWith('r1');
    });

    it('a release that fails never rewrites the run outcome', async () => {
        toolService.releaseMcpRun.mockRejectedValue(new Error('process already gone'));

        const result = await makeSvc().execute(ctx);

        expect(result.status).toBe('dispatched');
        expect(runs.markCompleted).toHaveBeenCalled();
        expect(runs.markFailed).not.toHaveBeenCalled();
    });

    it('a runtime whose tool service predates the release hook still runs', async () => {
        const legacy = { resolveGrantedTools: toolService.resolveGrantedTools };
        const svc = new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            assembler,
            skillBindings,
            activity,
            chatBackPoster,
            taskFinisher,
            legacy as any,
            ai,
        );

        await expect(svc.execute(ctx)).resolves.toMatchObject({ status: 'dispatched' });
    });
});
