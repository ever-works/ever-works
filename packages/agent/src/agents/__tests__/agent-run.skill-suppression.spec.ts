import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import { resolveToolGrantChain } from '../../policy/tool-grant';
import { AgentIdleBehavior, AgentScope, AgentStatus } from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import type { AgentAiDispatchFacade } from '../agent-ai-dispatch-facade';
import type { AgentToolService } from '../agent-tool.service';

/**
 * Skills shelf (FR-32 / FR-62) — when a run drops a Skill because every tool
 * it declares is refused, the drop is (a) still logged against the run, now
 * with the Skill's id, and (b) reflected onto the Skill's cached readiness so
 * the shelf badges it. A readiness write that fails must never fail the run.
 */
function makeAgent(): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'Ops',
        slug: 'ops',
        modelId: 'gpt-4o-mini',
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        errorCount: 0,
        pauseAfterFailures: 3,
        soulMd: '# Ops',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
    } as Agent;
}

function resolvedRow(skillId: string, slug: string, allowedTools: string[]) {
    return {
        binding: { id: `b-${skillId}`, skillId, priority: 100, injectIntoAgent: true },
        skill: {
            id: skillId,
            userId: 'u1',
            slug,
            title: slug,
            frontmatter: { name: slug, description: 'd', allowedTools },
            instructionsMd: `# ${slug}`,
        },
    };
}

async function flush() {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentRunService — skill suppression reaches the shelf', () => {
    let runLogs: { append: jest.Mock };
    let skillRepo: {
        findByIdAndUser: jest.Mock;
        recordReadiness: jest.Mock;
        findByUserAndInvocationSlug: jest.Mock;
    };

    function makeSvc() {
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        const ai = {
            dispatch: jest.fn().mockResolvedValue({
                text: 'ok',
                toolCalls: [],
                finishReason: 'stop',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: 'gpt-4o-mini',
            }),
        } as unknown as AgentAiDispatchFacade;
        const toolGrants = {
            resolve: jest
                .fn()
                .mockResolvedValue(
                    resolveToolGrantChain([
                        { scope: 'tenant', id: 't1', grant: { allow: ['git_*'] } },
                    ]),
                ),
            decide: jest.fn(),
        };
        return new AgentRunService(
            { findById: jest.fn().mockResolvedValue(makeAgent()) } as never,
            {
                findByAgent: jest.fn().mockResolvedValue([]),
                markFailed: jest.fn().mockResolvedValue(undefined),
                markCompleted: jest.fn().mockResolvedValue(undefined),
                setMemorySessionId: jest.fn().mockResolvedValue(undefined),
            } as never,
            runLogs as never,
            { findByAgentId: jest.fn().mockResolvedValue(null) } as never,
            new PromptAssemblerService(),
            {
                resolveActive: jest
                    .fn()
                    .mockResolvedValue([
                        resolvedRow('sk-deploy', 'deployer', ['deploy_work']),
                        resolvedRow('sk-git', 'committer', ['git_commit']),
                    ]),
            } as never,
            { log: jest.fn().mockResolvedValue(undefined) } as never,
            undefined,
            undefined,
            { resolveAllowedTools: jest.fn().mockReturnValue([]) } as unknown as AgentToolService,
            ai,
            undefined,
            undefined,
            toolGrants as never,
            skillRepo as never,
            { findBySkillIds: jest.fn().mockResolvedValue([]) } as never,
        );
    }

    const context = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'task' as const,
        taskId: 't1',
    };

    beforeEach(() => {
        skillRepo = {
            findByIdAndUser: jest
                .fn()
                .mockResolvedValue({ id: 'sk-deploy', readiness: 'ready', readinessDetail: null }),
            recordReadiness: jest.fn().mockResolvedValue(true),
            findByUserAndInvocationSlug: jest.fn().mockResolvedValue(null),
        };
    });

    it('writes blocked_by_access onto the suppressed Skill only, and still logs the WARN with its id', async () => {
        const result = await makeSvc().execute(context as never);
        await flush();

        expect(result.status).toBe('dispatched');
        const warn = runLogs.append.mock.calls
            .map(([row]) => row)
            .find((row) => row.step === 'skills');
        expect(warn).toMatchObject({
            level: 'WARN',
            metadata: { slug: 'deployer', refusedTools: ['deploy_work'], skillId: 'sk-deploy' },
        });

        expect(skillRepo.recordReadiness).toHaveBeenCalledTimes(1);
        const [skillId, userId, verdict] = skillRepo.recordReadiness.mock.calls[0];
        expect(skillId).toBe('sk-deploy');
        expect(userId).toBe('u1');
        expect(verdict.readiness).toBe('blocked_by_access');
        expect(verdict.readinessDetail.requirements[0]).toMatchObject({
            kind: 'tool',
            id: 'deploy_work',
            status: 'refused',
            fixTarget: { surface: 'access', ref: 'a1' },
        });
        expect(result.prompt?.systemMessage).not.toContain('# deployer');
    });

    it('a rejecting readiness writer does not fail the run, and the WARN is still appended', async () => {
        skillRepo.recordReadiness.mockRejectedValue(new Error('db down'));
        const result = await makeSvc().execute(context as never);
        await flush();
        expect(result.status).toBe('dispatched');
        expect(
            runLogs.append.mock.calls.some(
                ([row]) => row.step === 'skills' && row.level === 'WARN',
            ),
        ).toBe(true);
    });

    it('a Skill lookup that throws does not fail the run either', async () => {
        skillRepo.findByIdAndUser.mockRejectedValue(new Error('db down'));
        const result = await makeSvc().execute(context as never);
        await flush();
        expect(result.status).toBe('dispatched');
        expect(skillRepo.recordReadiness).not.toHaveBeenCalled();
    });
});
