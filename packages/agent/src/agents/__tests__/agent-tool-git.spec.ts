import { AgentToolService } from '../agent-tool.service';
import {
    AgentScope,
    AgentStatus,
    AgentAvatarMode,
    AgentIdleBehavior,
} from '../../entities/agent.entity';
import type { Agent, AgentPermissions } from '../../entities/agent.entity';
import type { AgentGitFacade } from '../agent-git-facade';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 16.6 + 16.7.
 *
 * Unit tests for the new `commitToRepo` + `openPullRequest` Agent
 * tools. Coverage:
 *   - descriptor inclusion gated by permission AND token presence
 *   - Work-scope check (non-Work scopes refuse with actionable error)
 *   - happy invoke path forwards to the AgentGitFacade
 *   - required-field validation
 *   - adapter exceptions are caught and returned as `{ error }`
 */

function makePerms(over: Partial<AgentPermissions> = {}): AgentPermissions {
    return {
        canCreateAgents: false,
        canAssignTasks: false,
        canEditSkills: false,
        canEditAgentFiles: false,
        canSpend: false,
        canCommitToRepo: false,
        canOpenPullRequests: false,
        canCallExternalTools: false,
        ...over,
    };
}

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.WORK,
        missionId: null,
        ideaId: null,
        workId: 'w1',
        name: 'Coder',
        slug: 'coder',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: makePerms(),
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
        soulMd: '# Soul',
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentToolService git tools (Phase 16.6 + 16.7)', () => {
    let agentsRepo: any;
    let git: jest.Mocked<AgentGitFacade>;
    let svc: AgentToolService;

    beforeEach(() => {
        agentsRepo = { create: jest.fn() };
        git = {
            commitToRepo: jest
                .fn()
                .mockResolvedValue({ sha: 'abc123', branch: 'main', filesChanged: 2 }),
            openPullRequest: jest.fn().mockResolvedValue({
                number: 42,
                url: 'https://github.com/x/y/pull/42',
                state: 'open',
            }),
        };
        svc = new AgentToolService(agentsRepo, undefined, undefined, undefined, git);
    });

    it('does NOT register commitToRepo when canCommitToRepo is false', () => {
        const tools = svc.resolveAllowedTools(makeAgent());
        expect(tools.find((t) => t.name === 'commitToRepo')).toBeUndefined();
    });

    it('does NOT register commitToRepo when git facade is unbound (even with permission)', () => {
        const bareSvc = new AgentToolService(agentsRepo);
        const tools = bareSvc.resolveAllowedTools(
            makeAgent({ permissions: makePerms({ canCommitToRepo: true }) }),
        );
        expect(tools.find((t) => t.name === 'commitToRepo')).toBeUndefined();
    });

    it('registers commitToRepo when permission + facade are both present', () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({ permissions: makePerms({ canCommitToRepo: true }) }),
        );
        const tool = tools.find((t) => t.name === 'commitToRepo');
        expect(tool).toBeDefined();
        expect(tool?.parameters.required).toEqual(['message']);
    });

    it('commitToRepo invoke forwards to the facade with semantic args', async () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({ permissions: makePerms({ canCommitToRepo: true }) }),
        );
        const tool = tools.find((t) => t.name === 'commitToRepo')!;
        const result = await tool.invoke({
            message: 'feat: add fizz',
            files: [{ path: 'src/fizz.ts', body: 'export const fizz = 1;\n' }],
            branch: 'feat/fizz',
        } as any);
        expect(git.commitToRepo).toHaveBeenCalledWith({
            userId: 'u1',
            agentId: 'a1',
            workId: 'w1',
            message: 'feat: add fizz',
            files: [{ path: 'src/fizz.ts', body: 'export const fizz = 1;\n' }],
            branch: 'feat/fizz',
        });
        expect(result).toEqual({ sha: 'abc123', branch: 'main', filesChanged: 2 });
    });

    it('commitToRepo refuses when Agent is not Work-scoped', async () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({
                scope: AgentScope.MISSION,
                missionId: 'm1',
                workId: null,
                permissions: makePerms({ canCommitToRepo: true }),
            }),
        );
        const tool = tools.find((t) => t.name === 'commitToRepo')!;
        const result = await tool.invoke({ message: 'try' } as any);
        expect(result).toEqual({ error: expect.stringContaining('not Work-scoped') });
        expect(git.commitToRepo).not.toHaveBeenCalled();
    });

    it('commitToRepo refuses on empty message', async () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({ permissions: makePerms({ canCommitToRepo: true }) }),
        );
        const tool = tools.find((t) => t.name === 'commitToRepo')!;
        const result = await tool.invoke({ message: '   ' } as any);
        expect(result).toEqual({ error: 'message is required.' });
        expect(git.commitToRepo).not.toHaveBeenCalled();
    });

    it('commitToRepo catches adapter exceptions and returns them as error', async () => {
        git.commitToRepo.mockRejectedValueOnce(new Error('repo locked'));
        const tools = svc.resolveAllowedTools(
            makeAgent({ permissions: makePerms({ canCommitToRepo: true }) }),
        );
        const tool = tools.find((t) => t.name === 'commitToRepo')!;
        const result = await tool.invoke({ message: 'feat: x' } as any);
        expect(result).toEqual({ error: 'repo locked' });
    });

    it('does NOT register openPullRequest when canOpenPullRequests is false', () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({ permissions: makePerms({ canCommitToRepo: true }) }),
        );
        expect(tools.find((t) => t.name === 'openPullRequest')).toBeUndefined();
    });

    it('registers openPullRequest when permission + facade are both present', () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({
                permissions: makePerms({ canCommitToRepo: true, canOpenPullRequests: true }),
            }),
        );
        const tool = tools.find((t) => t.name === 'openPullRequest');
        expect(tool).toBeDefined();
        expect(tool?.parameters.required).toEqual(['title', 'body', 'head']);
    });

    it('openPullRequest invoke forwards to the facade with semantic args', async () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({
                permissions: makePerms({ canCommitToRepo: true, canOpenPullRequests: true }),
            }),
        );
        const tool = tools.find((t) => t.name === 'openPullRequest')!;
        const result = await tool.invoke({
            title: 'feat: fizz',
            body: 'adds fizz module',
            head: 'feat/fizz',
            base: 'develop',
            draft: true,
        } as any);
        expect(git.openPullRequest).toHaveBeenCalledWith({
            userId: 'u1',
            agentId: 'a1',
            workId: 'w1',
            title: 'feat: fizz',
            body: 'adds fizz module',
            head: 'feat/fizz',
            base: 'develop',
            draft: true,
        });
        expect(result).toEqual({
            number: 42,
            url: 'https://github.com/x/y/pull/42',
            state: 'open',
        });
    });

    it('openPullRequest refuses on missing required fields', async () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({
                permissions: makePerms({ canCommitToRepo: true, canOpenPullRequests: true }),
            }),
        );
        const tool = tools.find((t) => t.name === 'openPullRequest')!;
        const result = await tool.invoke({ title: '', body: '', head: '' } as any);
        expect(result).toEqual({ error: expect.stringContaining('required') });
        expect(git.openPullRequest).not.toHaveBeenCalled();
    });

    it('openPullRequest refuses when Agent is not Work-scoped', async () => {
        const tools = svc.resolveAllowedTools(
            makeAgent({
                scope: AgentScope.TENANT,
                workId: null,
                permissions: makePerms({ canCommitToRepo: true, canOpenPullRequests: true }),
            }),
        );
        const tool = tools.find((t) => t.name === 'openPullRequest')!;
        const result = await tool.invoke({
            title: 't',
            body: 'b',
            head: 'h',
        } as any);
        expect(result).toEqual({ error: expect.stringContaining('not Work-scoped') });
    });
});
