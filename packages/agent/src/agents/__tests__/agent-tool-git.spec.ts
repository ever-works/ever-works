import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 *   - the tool CONTRACT wording (APW-08 P0 T5): the protected-branch
 *     refusal and the Work's Task base branch, on the tool descriptors
 *     and on the facade's own documented inputs
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
    let agentsService: any;
    let git: jest.Mocked<AgentGitFacade>;
    let svc: AgentToolService;

    beforeEach(() => {
        agentsRepo = { create: jest.fn() };
        // EW-721 #10: AgentsService became a required ctor dep (the
        // optional raw-repo fallback for createSubAgent was removed).
        agentsService = { create: jest.fn() };
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
        svc = new AgentToolService(agentsRepo, agentsService, undefined, undefined, undefined, git);
    });

    it('does NOT register commitToRepo when canCommitToRepo is false', () => {
        const tools = svc.resolveAllowedTools(makeAgent());
        expect(tools.find((t) => t.name === 'commitToRepo')).toBeUndefined();
    });

    it('does NOT register commitToRepo when git facade is unbound (even with permission)', () => {
        const bareSvc = new AgentToolService(agentsRepo, agentsService);
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

    /**
     * APW-08 P0 (T5) — the tool CONTRACT is what the model reads before it calls
     * anything: the protected-branch refusal and the Work's Task base branch have
     * to be in the descriptors, or the model learns both rules by failing. The
     * descriptions are asserted, not the implementation — the implementation is
     * pinned by `agents.module.spec.ts` on the api side.
     */
    describe('the contract wording (APW-08 P0 T5)', () => {
        const toolNamed = (name: string) => {
            const tools = svc.resolveAllowedTools(
                makeAgent({
                    permissions: makePerms({ canCommitToRepo: true, canOpenPullRequests: true }),
                }),
            );
            return tools.find((t) => t.name === name)!;
        };

        it('commitToRepo names the protected-branch refusal', () => {
            const tool = toolNamed('commitToRepo');

            expect(tool).toBeDefined();
            expect(tool.description).toMatch(/protected branch/i);
            expect(tool.description).toMatch(/feature branch/i);
            // …and it names the branch the commit is based on, which is the
            // Work's Task base branch — not "the repository default".
            expect(tool.description).toMatch(/base branch/i);
        });

        it("commitToRepo's `branch` parameter carries the same rule as the facade doc", () => {
            const branch = toolNamed('commitToRepo').parameters.properties.branch.description;

            expect(branch).toMatch(/Task base branch/);
            expect(branch).toMatch(/taskIsolationBaseBranch/);
            expect(branch).toMatch(/refus/i);
            expect(branch).toMatch(/protected/);
            expect(branch).toMatch(/merge policy/);
            // The stale claim — that the tool resolves "the Work's own default
            // branch" — is gone, because the target is the Task base branch.
            expect(branch).not.toMatch(/resolves the Work's own default branch/);
        });

        it('openPullRequest names the missing-head refusal (FR-5)', () => {
            const tool = toolNamed('openPullRequest');

            expect(tool).toBeDefined();
            expect(tool.description).toMatch(/must already exist/i);
            expect(tool.parameters.properties.head.description).toMatch(/does not exist/i);
            expect(tool.parameters.properties.head.description).toMatch(/must already exist/i);
        });

        it("openPullRequest's `base` parameter names the Work's Task base branch", () => {
            const base = toolNamed('openPullRequest').parameters.properties.base.description;

            expect(base).toMatch(/Task base branch/);
            expect(base).toMatch(/taskIsolationBaseBranch/);
            expect(base).not.toMatch(/Defaults to the Work's default branch/);
        });

        it('forwards every argument to the facade unchanged — the wording adds no behaviour', async () => {
            const tool = toolNamed('commitToRepo');
            // The `branch` parameter is still optional and still forwarded
            // verbatim: the wording describes the adapter's rule, it does not
            // move it into the tool.
            await tool.invoke({ message: 'feat: fizz', branch: 'feat/fizz' } as any);

            expect(git.commitToRepo).toHaveBeenCalledWith({
                userId: 'u1',
                agentId: 'a1',
                workId: 'w1',
                message: 'feat: fizz',
                files: undefined,
                branch: 'feat/fizz',
            });
        });
    });
});

/**
 * The facade's INPUT DOCS are part of the same contract, and TypeScript erases
 * them — no runtime assertion can see a doc comment. So the source is read, the
 * same way `agents.module.spec.ts` reads its own adapter and
 * `agent-plugins.module.spec.ts` reads its module.
 */
describe('AgentGitFacade input docs (APW-08 P0 T5)', () => {
    const FACADE_PATH = join(__dirname, '..', 'agent-git-facade.ts');
    const source = (): string => readFileSync(FACADE_PATH, 'utf8');

    /** The doc block immediately preceding `needle`, flattened to one line. */
    const docBefore = (needle: string): string => {
        const text = source();
        const end = text.lastIndexOf('*/', text.indexOf(needle));
        const start = text.lastIndexOf('/**', end);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        // The doc is WRAPPED in the source, so the block is unwrapped before it
        // is matched: asserting on the raw line breaks would test the column
        // width rather than the contract. Only the line-leading `*` markers are
        // stripped, so a deliberate `**bold**` sentence survives intact.
        return text
            .slice(start, end + 2)
            .split('\n')
            .map((line) => line.replace(/^\s*\*\s?/, ''))
            .join(' ')
            .replace(/\s+/g, ' ');
    };

    it("documents `branch` as defaulting to the Work's Task base branch, refused when protected", () => {
        const doc = docBefore('branch?: string;');

        expect(doc).toMatch(/Task base branch/);
        expect(doc).toMatch(/taskIsolationBaseBranch/);
        expect(doc).toMatch(/protected/);
        expect(doc).toMatch(/merge policy/);
        // The stale claim: the default target used to be described as "the
        // Work's own default branch".
        expect(doc).not.toMatch(/resolves the Work's own default branch/);
    });

    it("documents `base` as the Work's Task base branch — never 'the Work's default branch'", () => {
        const doc = docBefore('base?: string;');

        expect(doc).toMatch(/Task base branch/);
        expect(doc).toMatch(/taskIsolationBaseBranch/);
        expect(doc).not.toMatch(/Defaults to the Work's default branch/);
    });
});
