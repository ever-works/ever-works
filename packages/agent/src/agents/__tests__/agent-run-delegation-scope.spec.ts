import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import type { AgentToolService, AgentToolDescriptor } from '../agent-tool.service';

/**
 * Judgment layer G9 — a delegated run is actually CONFINED to the scope
 * it was admitted under.
 *
 * `narrowSubAgentScope` has always produced a correct narrowed scope, and
 * `SubAgentDelegationRunnerService` then discarded everything but
 * `workId`. So the contract's headline property — "privilege can only
 * ever shrink going down the tree" — held at the admission boundary (an
 * over-broad REQUEST was refused) and nowhere else: a child that WAS
 * admitted resolved its tools from its own Agent row, and `childAgentId`
 * defaults to the parent, so by default the child ran as the parent with
 * every permission it holds.
 *
 * The assertion that matters is therefore not "the scope was narrowed"
 * (a unit test of `narrowSubAgentScope` already passes and proves
 * nothing about enforcement) but "the child was HANDED fewer tools".
 */

const descriptor = (name: string): AgentToolDescriptor => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {}, required: [] },
    invoke: async () => ({ ok: true }),
});

const ALL_TOOLS = [
    descriptor('getSkillBody'),
    descriptor('commitToRepo'),
    descriptor('openPullRequest'),
    descriptor('searchWeb'),
];

describe('AgentRunService — delegation scope confines a child run', () => {
    let runs: {
        findById: jest.Mock;
        markRunning: jest.Mock;
        markCompleted: jest.Mock;
    };
    let runLogs: { append: jest.Mock };
    let toolService: { resolveAllowedTools: jest.Mock; resolveGrantedTools?: jest.Mock };

    beforeEach(() => {
        runs = {
            findById: jest.fn().mockResolvedValue({ id: 'run-1', status: 'running' }),
            markRunning: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
        };
        runLogs = { append: jest.fn().mockResolvedValue(undefined) };
        toolService = { resolveAllowedTools: jest.fn().mockReturnValue([...ALL_TOOLS]) };
    });

    function makeSvc(): AgentRunService {
        return new AgentRunService(
            { findById: jest.fn() } as never,
            runs as never,
            runLogs as never,
            { findByAgentId: jest.fn().mockResolvedValue(null) } as never,
            new PromptAssemblerService(),
            undefined,
            undefined,
            undefined,
            undefined,
            toolService as unknown as AgentToolService,
        );
    }

    /**
     * `resolveToolsForRun` is private; the behaviour under test is its
     * output. The scope arrives as an ARGUMENT (off the run context),
     * deliberately not re-read from the database here — an ordinary run
     * must pay no extra query, and a cooperative-abort test pins that the
     * tool loop performs no DB work it did not already do.
     */
    const resolve = (svc: AgentRunService, scope: unknown = undefined) =>
        (
            svc as unknown as {
                resolveToolsForRun(
                    agent: unknown,
                    runId: string,
                    edits: Set<string>,
                    scope?: unknown,
                ): Promise<AgentToolDescriptor[]>;
            }
        ).resolveToolsForRun({ id: 'a1', userId: 'u1' }, 'run-1', new Set(), scope);

    it('HANDS a delegated child only the tools its scope allows', async () => {
        // The whole point. A delegation admitted with one tool must not
        // produce a run that can commit to a repo.
        const tools = await resolve(makeSvc(), { allowedTools: ['getSkillBody'] });

        expect(tools.map((t) => t.name)).toEqual(['getSkillBody']);
        expect(tools.map((t) => t.name)).not.toContain('commitToRepo');
    });

    it('leaves an ORDINARY run completely untouched', async () => {
        // The overwhelmingly common path: no delegation, no scope. This
        // must be byte-for-byte the pre-change behaviour.
        const tools = await resolve(makeSvc(), null);

        expect(tools.map((t) => t.name)).toEqual([
            'getSkillBody',
            'commitToRepo',
            'openPullRequest',
            'searchWeb',
        ]);
    });

    it('treats the wildcard as no restriction', async () => {
        const tools = await resolve(makeSvc(), { allowedTools: ['*'] });

        expect(tools).toHaveLength(ALL_TOOLS.length);
    });

    it('records WHY a tool vanished instead of dropping it silently', async () => {
        // A tool the model was told about that quietly disappears is the
        // single most confusing failure mode in a tool loop — the same
        // reasoning the tool-grant refusals are logged for.
        await resolve(makeSvc(), { allowedTools: ['getSkillBody'] });

        expect(runLogs.append).toHaveBeenCalledWith(
            expect.objectContaining({
                level: 'WARN',
                step: 'tools',
                metadata: expect.objectContaining({
                    withheld: ['commitToRepo', 'openPullRequest', 'searchWeb'],
                }),
            }),
        );
    });

    it('does not log when the scope withheld nothing', async () => {
        await resolve(makeSvc(), { allowedTools: ['*'] });

        expect(runLogs.append).not.toHaveBeenCalled();
    });

    it('reads NO database row to apply the scope', async () => {
        // The first cut of this looked the run up here, which added a
        // query to every ordinary run's hot path and broke a
        // cooperative-abort test asserting the tool loop touches no DB.
        // The scope rides the run context instead.
        await resolve(makeSvc(), { allowedTools: ['getSkillBody'] });

        expect(runs.findById).not.toHaveBeenCalled();
    });

    it('applies the scope on the GRANTED path too, not just the plain one', async () => {
        // Both paths funnel through `resolveToolsForRun`; a filter on only
        // one of them would be enforced or not depending on whether an
        // operator happened to bind the grant enforcer.
        toolService.resolveGrantedTools = jest
            .fn()
            .mockResolvedValue({ tools: [...ALL_TOOLS], refused: [] });
        const tools = await resolve(makeSvc(), { allowedTools: ['searchWeb'] });

        expect(tools.map((t) => t.name)).toEqual(['searchWeb']);
        expect(toolService.resolveGrantedTools).toHaveBeenCalled();
    });
});
