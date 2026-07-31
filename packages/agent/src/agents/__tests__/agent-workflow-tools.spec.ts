import type { WorkflowGraph } from '@ever-works/contracts';
import type { WorkflowRunResult } from '../workflow-graph-executor.service';
import {
    admitModelAuthoredGraph,
    buildWorkflowTools,
    WORKFLOW_TOOL_MAX_DELEGATE_NODES,
    WORKFLOW_TOOL_MAX_NODES,
    WORKFLOW_TOOL_MAX_STEPS,
} from '../agent-workflow-tools';

/**
 * Judgment layer G5 — the workflow-graph chat tools.
 *
 * These tests exist because of what the tool reaches: the bound node
 * runner turns `agent.delegate` nodes into real child Tasks that spend
 * real budget, and it reads the ambient run context to decide what a node
 * may touch. The graph is authored by a MODEL, so the two properties that
 * must hold are:
 *
 *  1. cost is clamped before `execute()` is ever called, and
 *  2. authority comes from the Agent row, never from the payload.
 *
 * `validateWorkflowGraph` covers neither — it checks structure only.
 */

const node = (id: string, kind = 'noop') => ({ id, kind });

const graph = (over: Partial<WorkflowGraph> = {}): WorkflowGraph =>
    ({
        id: 'g-1',
        entryNodeId: 'a',
        nodes: [node('a')],
        edges: [],
        ...over,
    }) as WorkflowGraph;

describe('admitModelAuthoredGraph', () => {
    it('admits a well-formed graph', () => {
        const result = admitModelAuthoredGraph(graph());
        expect(result.ok).toBe(true);
    });

    it('refuses a non-object', () => {
        expect(admitModelAuthoredGraph('nope')).toMatchObject({ ok: false });
        expect(admitModelAuthoredGraph(null)).toMatchObject({ ok: false });
    });

    it('refuses a graph with no nodes', () => {
        expect(admitModelAuthoredGraph(graph({ nodes: [] }))).toMatchObject({ ok: false });
    });

    it('refuses an oversized graph', () => {
        const many = Array.from({ length: WORKFLOW_TOOL_MAX_NODES + 1 }, (_, i) => node(`n${i}`));
        const result = admitModelAuthoredGraph(graph({ entryNodeId: 'n0', nodes: many }));
        expect(result).toMatchObject({ ok: false });
        expect((result as { reason: string }).reason).toContain('nodes');
    });

    it('refuses an unsupported node kind rather than skipping the node', () => {
        // Silently skipping would let a graph report success for work it
        // never did — the exact silence this seam exists to avoid.
        const result = admitModelAuthoredGraph(
            graph({ nodes: [node('a'), node('b', 'shell.exec')], edges: [] }),
        );
        expect(result).toMatchObject({ ok: false });
        expect((result as { reason: string }).reason).toContain('shell.exec');
    });

    it('refuses more delegate nodes than the fan-out cap', () => {
        const nodes = [
            node('a'),
            ...Array.from({ length: WORKFLOW_TOOL_MAX_DELEGATE_NODES + 1 }, (_, i) =>
                node(`d${i}`, 'agent.delegate'),
            ),
        ];
        const result = admitModelAuthoredGraph(graph({ nodes }));
        expect(result).toMatchObject({ ok: false });
        expect((result as { reason: string }).reason).toContain('agent.delegate');
    });

    it('allows delegate nodes up to the cap', () => {
        const nodes = [
            node('a'),
            ...Array.from({ length: WORKFLOW_TOOL_MAX_DELEGATE_NODES }, (_, i) =>
                node(`d${i}`, 'agent.delegate'),
            ),
        ];
        expect(admitModelAuthoredGraph(graph({ nodes }))).toMatchObject({ ok: true });
    });

    it('REWRITES an over-large maxSteps instead of refusing it', () => {
        // A model has no way to guess this number, and a cycle is a
        // legitimate retry loop — failing the graph would be hostile.
        const result = admitModelAuthoredGraph(graph({ maxSteps: 10_000 }));
        expect(result).toMatchObject({ ok: true });
        expect((result as { graph: WorkflowGraph }).graph.maxSteps).toBe(WORKFLOW_TOOL_MAX_STEPS);
    });

    it('clamps a nonsense maxSteps up to at least 1', () => {
        const result = admitModelAuthoredGraph(graph({ maxSteps: -5 }));
        expect(result).toMatchObject({ ok: true });
        expect((result as { graph: WorkflowGraph }).graph.maxSteps).toBe(1);
    });

    it('propagates a structural failure from validateWorkflowGraph', () => {
        const result = admitModelAuthoredGraph(graph({ entryNodeId: 'missing' }));
        expect(result).toMatchObject({ ok: false });
        expect((result as { reason: string }).reason).toContain('invalid graph');
    });
});

describe('buildWorkflowTools', () => {
    const OWNER = 'user-1';
    const AGENT = 'agent-1';

    const runResult = (over: Partial<WorkflowRunResult> = {}): WorkflowRunResult =>
        ({
            status: 'completed',
            runId: 'wfr-1',
            visited: ['a'],
            traversedEdges: [],
            nodes: [],
            decisions: [],
            output: { answer: 42 },
            nodeOutputs: { a: { answer: 42 } },
            ...over,
        }) as WorkflowRunResult;

    const tools = (execute: jest.Mock) =>
        buildWorkflowTools({
            userId: OWNER,
            agentId: AGENT,
            workId: 'work-1',
            organizationId: 'org-1',
            executor: { execute },
        });

    const runTool = (execute: jest.Mock) =>
        tools(execute).find((t) => t.name === 'run_workflow_graph')!;

    it('exposes both tools under snake_case names', () => {
        expect(tools(jest.fn()).map((t) => t.name)).toEqual([
            'run_workflow_graph',
            'validate_workflow_graph',
        ]);
    });

    it('never exposes an identity parameter the model could set', () => {
        // The node runner reads userId/workId/organizationId/agentId out of
        // the context to decide what a node may touch. A parameter for any
        // of them would be letting the model pick its own authorization.
        for (const tool of tools(jest.fn())) {
            const keys = Object.keys(tool.parameters.properties);
            expect(keys).not.toContain('context');
            expect(keys).not.toContain('userId');
            expect(keys).not.toContain('workId');
            expect(keys).not.toContain('organizationId');
            expect(keys).not.toContain('agentId');
            expect(keys).not.toContain('runId');
        }
    });

    it('builds the run context from the Agent row', async () => {
        const execute = jest.fn().mockResolvedValue(runResult());

        await runTool(execute).invoke({ graph: graph() });

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'g-1' }),
            expect.objectContaining({
                context: {
                    userId: OWNER,
                    agentId: AGENT,
                    workId: 'work-1',
                    organizationId: 'org-1',
                    delegationDepth: 0,
                },
            }),
        );
    });

    it('DISCARDS a model-supplied context rather than merging it', async () => {
        // Merging would let an unknown key win. This is the single most
        // important assertion in the file.
        const execute = jest.fn().mockResolvedValue(runResult());

        await runTool(execute).invoke({
            graph: graph(),
            context: { userId: 'someone-else', workId: 'other-work' },
            userId: 'someone-else',
        } as never);

        const passedContext = execute.mock.calls[0][1].context;
        expect(passedContext.userId).toBe(OWNER);
        expect(passedContext.workId).toBe('work-1');
    });

    it('passes model-supplied input through — it is data, not authority', async () => {
        const execute = jest.fn().mockResolvedValue(runResult());

        await runTool(execute).invoke({ graph: graph(), input: { topic: 'billing' } });

        expect(execute.mock.calls[0][1].input).toEqual({ topic: 'billing' });
    });

    it('refuses a bad graph WITHOUT calling the executor', async () => {
        const execute = jest.fn();

        const result = await runTool(execute).invoke({
            graph: graph({ nodes: [node('a'), node('b', 'shell.exec')] }),
        });

        expect(result).toMatchObject({ error: expect.stringContaining('shell.exec') });
        expect(execute).not.toHaveBeenCalled();
    });

    it('returns a projection, not the raw result', async () => {
        // `nodeOutputs` holds every node's full output — for a kb.search
        // node that is entire documents, which would blow the context
        // window on one tool call.
        const execute = jest.fn().mockResolvedValue(runResult());

        const result = (await runTool(execute).invoke({ graph: graph() })) as Record<
            string,
            unknown
        >;

        expect(result).toMatchObject({ status: 'completed', runId: 'wfr-1', visited: ['a'] });
        expect(result).not.toHaveProperty('nodeOutputs');
        expect(result).not.toHaveProperty('traversedEdges');
    });

    it('truncates a huge output instead of returning it whole', async () => {
        const execute = jest
            .fn()
            .mockResolvedValue(runResult({ output: { blob: 'x'.repeat(50_000) } }));

        const result = (await runTool(execute).invoke({ graph: graph() })) as {
            output: string;
        };

        expect(typeof result.output).toBe('string');
        expect(result.output).toContain('truncated');
        expect(result.output.length).toBeLessThan(20_000);
    });

    it('surfaces a failed run with its failure code', async () => {
        const execute = jest.fn().mockResolvedValue(
            runResult({
                status: 'failed',
                failureCode: 'no-node-runner',
                errors: ['nothing can execute a node'],
                output: undefined,
            }),
        );

        const result = await runTool(execute).invoke({ graph: graph() });

        expect(result).toMatchObject({
            status: 'failed',
            failureCode: 'no-node-runner',
            errors: ['nothing can execute a node'],
        });
    });

    it('turns a thrown executor into the tool-error shape', async () => {
        const execute = jest.fn().mockRejectedValue(new Error('infra down'));

        await expect(runTool(execute).invoke({ graph: graph() })).resolves.toMatchObject({
            error: 'infra down',
        });
    });

    it('validate_workflow_graph reports the rewritten step budget without running', async () => {
        const execute = jest.fn();
        const validate = tools(execute).find((t) => t.name === 'validate_workflow_graph')!;

        const result = await validate.invoke({ graph: graph({ maxSteps: 9_999 }) });

        expect(result).toMatchObject({ valid: true, maxSteps: WORKFLOW_TOOL_MAX_STEPS, nodes: 1 });
        expect(execute).not.toHaveBeenCalled();
    });

    it('validate_workflow_graph explains a refusal', async () => {
        const validate = tools(jest.fn()).find((t) => t.name === 'validate_workflow_graph')!;

        const result = await validate.invoke({ graph: graph({ entryNodeId: 'nope' }) });

        expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('invalid') });
    });
});
