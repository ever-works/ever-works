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
import type { AgentToolService } from '../agent-tool.service';

/**
 * Skills feature — invocation slugs. A chat message starting with
 * `/<known-invocation-slug>` injects that skill's FULL body into the
 * turn, system-side (a forced getSkillBody). Contract under test:
 * chat-kind-only, word-boundary parse, unknown slug = plain text (no
 * error), cross-user isolation via the user-scoped lookup, the file
 * manifest riding along, and best-effort degradation on lookup failure.
 */
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
        modelId: 'gpt-4o-mini',
        maxSkillContextTokens: 4000,
        memoryRecallEnabled: true,
        status: AgentStatus.ACTIVE,
        permissions: null,
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
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

function aiResponse(over: Partial<AgentAiDispatchResult> = {}): AgentAiDispatchResult {
    return {
        text: 'Reply text',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        model: 'gpt-4o-mini',
        ...over,
    };
}

function makeInvokedSkill(over: any = {}) {
    return {
        id: 'sk-plan',
        userId: 'u1',
        slug: 'planning-guide',
        invocationSlug: 'plan',
        title: 'Planning Guide',
        version: '2.0.0',
        instructionsMd: '# Planning steps\nAlways write the plan first.',
        ...over,
    };
}

describe('AgentRunService — slash invocation (invocation slugs)', () => {
    let agents: any;
    let runs: any;
    let runLogs: any;
    let budgets: any;
    let skillBindings: any;
    let activity: any;
    let toolService: jest.Mocked<Pick<AgentToolService, 'resolveAllowedTools'>>;
    let ai: jest.Mocked<AgentAiDispatchFacade>;
    let skillRepo: any;
    let skillFiles: any;

    beforeEach(() => {
        agents = { findById: jest.fn().mockResolvedValue(makeAgent()) };
        runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            setMemorySessionId: jest.fn().mockResolvedValue(undefined),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        toolService = { resolveAllowedTools: jest.fn().mockReturnValue([]) };
        ai = { dispatch: jest.fn().mockResolvedValue(aiResponse()) };
        skillRepo = {
            findByUserAndInvocationSlug: jest.fn().mockResolvedValue(makeInvokedSkill()),
        };
        skillFiles = { findBySkillIds: jest.fn().mockResolvedValue([]) };
    });

    function makeSvc(): AgentRunService {
        return new AgentRunService(
            agents,
            runs,
            runLogs,
            budgets,
            new PromptAssemblerService(),
            skillBindings,
            activity,
            undefined, // chat-back poster
            undefined, // task finisher
            toolService as unknown as AgentToolService,
            ai,
            undefined, // agent memory
            undefined, // vision context
            undefined, // tool grants
            skillRepo,
            skillFiles,
        );
    }

    const chatContext = (immediateInput: string) => ({
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'chat' as const,
        taskId: 't1',
        immediateInput,
    });

    function invocationRows() {
        return runLogs.append.mock.calls
            .map(([row]: [any]) => row)
            .filter((row: any) => row.step === 'skill-invocation');
    }

    it('injects the invoked skill body into the system message for /slug chat messages', async () => {
        const result = await makeSvc().execute(chatContext('/plan ship the login fix'));

        expect(result.status).toBe('dispatched');
        expect(skillRepo.findByUserAndInvocationSlug).toHaveBeenCalledWith('u1', 'plan');
        const system = result.prompt?.systemMessage ?? '';
        expect(system).toContain('# INVOKED SKILL');
        expect(system).toContain('invocation="/plan"');
        expect(system).toContain('Always write the plan first.');
        // The user message keeps the ORIGINAL text, slash command included.
        expect(result.prompt?.userMessage).toContain('/plan ship the login fix');

        const rows = invocationRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].level).toBe('INFO');
        expect(rows[0].metadata).toEqual(
            expect.objectContaining({ skillSlug: 'planning-guide', invocationSlug: 'plan' }),
        );
    });

    it('attaches the invoked skill\'s file manifest when it carries files', async () => {
        skillFiles.findBySkillIds.mockResolvedValue([
            { skillId: 'sk-plan', filename: 'template.md', kind: 'reference', sizeBytes: 512 },
        ]);
        const result = await makeSvc().execute(chatContext('/plan go'));
        expect(result.prompt?.systemMessage).toContain('files: template.md (reference, 512 B)');
        expect(skillFiles.findBySkillIds).toHaveBeenCalledWith(['sk-plan'], 'u1');
    });

    it('treats an unknown /slug as plain text — no injection, no error', async () => {
        skillRepo.findByUserAndInvocationSlug.mockResolvedValue(null);
        const result = await makeSvc().execute(chatContext('/ghost do something'));

        expect(result.status).toBe('dispatched');
        expect(result.prompt?.systemMessage).not.toContain('# INVOKED SKILL');
        expect(invocationRows()).toHaveLength(0);
    });

    it('requires the slash at the very start with a word boundary', async () => {
        await makeSvc().execute(chatContext('see /plan for details'));
        expect(skillRepo.findByUserAndInvocationSlug).not.toHaveBeenCalled();
    });

    it('does NOT fire for task-kind runs (task bodies are not chat messages)', async () => {
        const svc = makeSvc();
        await svc.execute({ ...chatContext('/plan run it'), kind: 'task' as any });
        expect(skillRepo.findByUserAndInvocationSlug).not.toHaveBeenCalled();
    });

    it('degrades to plain text when the lookup throws (best-effort)', async () => {
        skillRepo.findByUserAndInvocationSlug.mockRejectedValue(new Error('db down'));
        const result = await makeSvc().execute(chatContext('/plan go'));
        expect(result.status).toBe('dispatched');
        expect(result.prompt?.systemMessage).not.toContain('# INVOKED SKILL');
    });
});
