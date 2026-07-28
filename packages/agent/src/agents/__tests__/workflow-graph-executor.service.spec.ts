import type { WorkflowGraph, WorkflowNode } from '@ever-works/contracts';
import { WorkflowGraphExecutorService } from '../workflow-graph-executor.service';
import type {
    WorkflowDecisionPort,
    WorkflowNodeRunResult,
    WorkflowNodeRunner,
} from '../workflow-graph.ports';

/**
 * Judgment layer G5 — the four edge kinds + input_mapping.
 *
 * One test per edge kind proves the traversal RULE, not just that the
 * executor walks: on_failure only fires on a failure it catches,
 * conditional picks by predicate in declaration order, llm_decide asks
 * once and honours the returned token (and degrades to the declared
 * fallback arm when the decider is unavailable), and input_mapping
 * actually shapes the next node's inputs.
 */
describe('WorkflowGraphExecutorService', () => {
    /** Runner whose per-node behaviour is scripted by id. */
    const scriptedRunner = (
        script: Record<string, WorkflowNodeRunResult>,
    ): WorkflowNodeRunner & {
        calls: Array<{ nodeId: string; inputs: Record<string, unknown> }>;
    } => {
        const calls: Array<{ nodeId: string; inputs: Record<string, unknown> }> = [];
        return {
            calls,
            run: jest.fn(async (node: WorkflowNode, inputs: Record<string, unknown>) => {
                calls.push({ nodeId: node.id, inputs });
                return script[node.id] ?? { ok: true, output: { from: node.id } };
            }),
        };
    };

    const node = (id: string) => ({ id, kind: 'noop' });

    describe('sequential edges', () => {
        it('walks the happy path and completes with the last output', async () => {
            const graph: WorkflowGraph = {
                id: 'g',
                entryNodeId: 'a',
                nodes: [node('a'), node('b')],
                edges: [{ id: 'e1', kind: 'sequential', from: 'a', to: 'b' }],
            };
            const runner = scriptedRunner({
                a: { ok: true, output: { value: 1 } },
                b: { ok: true, output: { value: 2 } },
            });
            const result = await new WorkflowGraphExecutorService(runner).execute(graph);
            expect(result.status).toBe('completed');
            expect(result.visited).toEqual(['a', 'b']);
            expect(result.traversedEdges).toEqual(['e1']);
            expect(result.output).toEqual({ value: 2 });
        });

        it('passes the source output straight through when the edge has no mapping', async () => {
            const graph: WorkflowGraph = {
                id: 'g',
                entryNodeId: 'a',
                nodes: [node('a'), node('b')],
                edges: [{ id: 'e1', kind: 'sequential', from: 'a', to: 'b' }],
            };
            const runner = scriptedRunner({ a: { ok: true, output: { value: 7 } } });
            await new WorkflowGraphExecutorService(runner).execute(graph);
            expect(runner.calls[1]).toEqual({ nodeId: 'b', inputs: { input: { value: 7 } } });
        });

        it('refuses an invalid graph before running anything', async () => {
            const graph: WorkflowGraph = {
                id: 'g',
                entryNodeId: 'ghost',
                nodes: [node('a')],
                edges: [],
            };
            const runner = scriptedRunner({});
            const result = await new WorkflowGraphExecutorService(runner).execute(graph);
            expect(result.status).toBe('failed');
            expect(result.failureCode).toBe('graph-invalid');
            expect(runner.run).not.toHaveBeenCalled();
        });

        it('stops with max-steps-exceeded instead of looping forever', async () => {
            const graph: WorkflowGraph = {
                id: 'g',
                entryNodeId: 'a',
                nodes: [node('a')],
                edges: [{ id: 'loop', kind: 'sequential', from: 'a', to: 'a' }],
                maxSteps: 4,
            };
            const result = await new WorkflowGraphExecutorService(scriptedRunner({})).execute(
                graph,
            );
            expect(result.status).toBe('failed');
            expect(result.failureCode).toBe('max-steps-exceeded');
            expect(result.visited).toHaveLength(4);
        });

        it('blocks (not fails) when no node runner is bound', async () => {
            const graph: WorkflowGraph = {
                id: 'g',
                entryNodeId: 'a',
                nodes: [node('a')],
                edges: [],
            };
            const result = await new WorkflowGraphExecutorService().execute(graph);
            expect(result).toMatchObject({ status: 'blocked', failureCode: 'no-node-runner' });
        });
    });

    describe('on_failure edges', () => {
        const graph = (over: Partial<WorkflowGraph> = {}): WorkflowGraph => ({
            id: 'g',
            entryNodeId: 'a',
            nodes: [node('a'), node('recover'), node('next')],
            edges: [
                { id: 'e-ok', kind: 'sequential', from: 'a', to: 'next' },
                { id: 'e-fail', kind: 'on_failure', from: 'a', to: 'recover' },
            ],
            ...over,
        });

        it('is NOT taken when the node succeeds', async () => {
            const result = await new WorkflowGraphExecutorService(scriptedRunner({})).execute(
                graph(),
            );
            expect(result.visited).toEqual(['a', 'next']);
            expect(result.traversedEdges).toEqual(['e-ok']);
        });

        it('is taken when the node fails, and the run then completes normally', async () => {
            const runner = scriptedRunner({ a: { ok: false, failureCode: 'lint-red' } });
            const result = await new WorkflowGraphExecutorService(runner).execute(graph());
            expect(result.status).toBe('completed');
            expect(result.visited).toEqual(['a', 'recover']);
            expect(result.traversedEdges).toEqual(['e-fail']);
        });

        it('only catches the failure codes it declares', async () => {
            const narrowed = graph({
                edges: [
                    {
                        id: 'e-fail',
                        kind: 'on_failure',
                        from: 'a',
                        to: 'recover',
                        catch: ['lint-red'],
                    },
                ],
            });
            const runner = scriptedRunner({ a: { ok: false, failureCode: 'build-red' } });
            const result = await new WorkflowGraphExecutorService(runner).execute(narrowed);
            expect(result.status).toBe('failed');
            expect(result.failureCode).toBe('node-failed');
            expect(result.failedNodeId).toBe('a');
            expect(result.visited).toEqual(['a']);
        });

        it('turns a THROWN node into a catchable failure rather than losing the trace', async () => {
            // Only `a` throws. A runner that threw for every node would make
            // the recovery node throw too, which tests nothing about the
            // on_failure edge — the point here is that a THROW is caught and
            // routed exactly like a returned failure.
            const runner: WorkflowNodeRunner = {
                run: jest.fn(async (node: WorkflowNode) => {
                    if (node.id === 'a') throw new Error('runner exploded');
                    return { ok: true, output: { from: node.id } };
                }),
            };
            const result = await new WorkflowGraphExecutorService(runner).execute(graph());
            expect(result.status).toBe('completed');
            expect(result.visited).toEqual(['a', 'recover']);
            expect(result.nodes[0]).toMatchObject({ ok: false, failureCode: 'node-threw' });
        });
    });

    describe('conditional edges', () => {
        const graph: WorkflowGraph = {
            id: 'g',
            entryNodeId: 'a',
            nodes: [node('a'), node('big'), node('small'), node('fallback')],
            edges: [
                {
                    id: 'e-big',
                    kind: 'conditional',
                    from: 'a',
                    to: 'big',
                    when: { path: 'nodes.a.output.count', operator: 'gte', value: 10 },
                },
                {
                    id: 'e-small',
                    kind: 'conditional',
                    from: 'a',
                    to: 'small',
                    when: { path: 'nodes.a.output.count', operator: 'gt', value: 0 },
                },
                { id: 'e-seq', kind: 'sequential', from: 'a', to: 'fallback' },
            ],
        };

        it('takes the first predicate that holds, in declaration order', async () => {
            const big = await new WorkflowGraphExecutorService(
                scriptedRunner({ a: { ok: true, output: { count: 42 } } }),
            ).execute(graph);
            expect(big.visited).toEqual(['a', 'big']);

            const small = await new WorkflowGraphExecutorService(
                scriptedRunner({ a: { ok: true, output: { count: 3 } } }),
            ).execute(graph);
            expect(small.visited).toEqual(['a', 'small']);
        });

        it('falls through to the sequential edge when no predicate holds', async () => {
            const result = await new WorkflowGraphExecutorService(
                scriptedRunner({ a: { ok: true, output: { count: 0 } } }),
            ).execute(graph);
            expect(result.visited).toEqual(['a', 'fallback']);
            expect(result.traversedEdges).toEqual(['e-seq']);
        });
    });

    describe('llm_decide edges', () => {
        const graph = (over: Partial<WorkflowGraph> = {}): WorkflowGraph => ({
            id: 'g',
            entryNodeId: 'a',
            nodes: [node('a'), node('ship'), node('revise')],
            edges: [
                {
                    id: 'e-ship',
                    kind: 'llm_decide',
                    from: 'a',
                    to: 'ship',
                    choice: 'ship',
                    choiceDescription: 'The draft is good enough',
                },
                {
                    id: 'e-revise',
                    kind: 'llm_decide',
                    from: 'a',
                    to: 'revise',
                    choice: 'revise',
                    fallback: true,
                },
            ],
            ...over,
        });

        const decider = (choice: string): WorkflowDecisionPort => ({
            decide: jest.fn(async () => ({ choice, rationale: 'because' })),
        });

        it('asks the decider ONCE with every arm and takes the chosen one', async () => {
            const port = decider('ship');
            const result = await new WorkflowGraphExecutorService(scriptedRunner({}), port).execute(
                graph(),
            );
            expect(port.decide).toHaveBeenCalledTimes(1);
            expect(port.decide).toHaveBeenCalledWith(
                expect.objectContaining({
                    nodeId: 'a',
                    choices: [
                        {
                            choice: 'ship',
                            targetNodeId: 'ship',
                            description: 'The draft is good enough',
                        },
                        { choice: 'revise', targetNodeId: 'revise' },
                    ],
                }),
            );
            expect(result.visited).toEqual(['a', 'ship']);
            expect(result.decisions).toEqual([
                { nodeId: 'a', choice: 'ship', rationale: 'because' },
            ]);
        });

        it('takes the declared fallback arm — marked degraded — when no decider is bound', async () => {
            const result = await new WorkflowGraphExecutorService(scriptedRunner({})).execute(
                graph(),
            );
            expect(result.visited).toEqual(['a', 'revise']);
            expect(result.decisions).toEqual([{ nodeId: 'a', choice: 'revise', degraded: true }]);
        });

        it('degrades the same way when the decider throws', async () => {
            const port: WorkflowDecisionPort = {
                decide: jest.fn(async () => {
                    throw new Error('provider down');
                }),
            };
            const result = await new WorkflowGraphExecutorService(scriptedRunner({}), port).execute(
                graph(),
            );
            expect(result.visited).toEqual(['a', 'revise']);
            expect(result.decisions[0]).toMatchObject({ degraded: true });
        });

        it('BLOCKS loudly when the decider is unavailable and no fallback arm is declared', async () => {
            const noFallback = graph({
                edges: [
                    { id: 'e-ship', kind: 'llm_decide', from: 'a', to: 'ship', choice: 'ship' },
                    {
                        id: 'e-revise',
                        kind: 'llm_decide',
                        from: 'a',
                        to: 'revise',
                        choice: 'revise',
                    },
                ],
            });
            const result = await new WorkflowGraphExecutorService(scriptedRunner({})).execute(
                noFallback,
            );
            expect(result).toMatchObject({
                status: 'blocked',
                failureCode: 'llm-decide-unavailable',
            });
            expect(result.visited).toEqual(['a']);
        });

        it('fails on an unknown choice when there is no fallback to fall back to', async () => {
            const noFallback = graph({
                edges: [
                    { id: 'e-ship', kind: 'llm_decide', from: 'a', to: 'ship', choice: 'ship' },
                    {
                        id: 'e-revise',
                        kind: 'llm_decide',
                        from: 'a',
                        to: 'revise',
                        choice: 'revise',
                    },
                ],
            });
            const result = await new WorkflowGraphExecutorService(
                scriptedRunner({}),
                decider('teleport'),
            ).execute(noFallback);
            expect(result).toMatchObject({
                status: 'failed',
                failureCode: 'llm-decide-unknown-choice',
            });
        });

        it('is only consulted after conditional edges have had their chance', async () => {
            const withConditional = graph({
                edges: [
                    {
                        id: 'e-cond',
                        kind: 'conditional',
                        from: 'a',
                        to: 'ship',
                        when: { path: 'nodes.a.ok', operator: 'truthy' },
                    },
                    {
                        id: 'e-revise',
                        kind: 'llm_decide',
                        from: 'a',
                        to: 'revise',
                        choice: 'revise',
                    },
                ],
            });
            const port = decider('revise');
            const result = await new WorkflowGraphExecutorService(scriptedRunner({}), port).execute(
                withConditional,
            );
            expect(result.visited).toEqual(['a', 'ship']);
            expect(port.decide).not.toHaveBeenCalled();
        });
    });

    describe('input_mapping', () => {
        const graph = (mapping: WorkflowGraph['edges'][number]['inputMapping']): WorkflowGraph => ({
            id: 'g',
            entryNodeId: 'a',
            nodes: [node('a'), node('b')],
            edges: [{ id: 'e1', kind: 'sequential', from: 'a', to: 'b', inputMapping: mapping }],
        });

        it('builds the destination inputs from scope paths and literals', async () => {
            const runner = scriptedRunner({ a: { ok: true, output: { items: [1, 2, 3] } } });
            await new WorkflowGraphExecutorService(runner).execute(
                graph([
                    { to: 'items', from: 'nodes.a.output.items' },
                    { to: 'seed', from: 'input.seed' },
                    { to: 'mode', fallback: 'strict' },
                ]),
                { input: { seed: 9 } },
            );
            expect(runner.calls[1].inputs).toEqual({ items: [1, 2, 3], seed: 9, mode: 'strict' });
        });

        it('reads ambient run context too', async () => {
            const runner = scriptedRunner({});
            await new WorkflowGraphExecutorService(runner).execute(
                graph([{ to: 'work', from: 'context.workId' }]),
                { context: { workId: 'work-1' } },
            );
            expect(runner.calls[1].inputs).toEqual({ work: 'work-1' });
        });

        it('fails the run when a REQUIRED binding cannot be resolved', async () => {
            const runner = scriptedRunner({});
            const result = await new WorkflowGraphExecutorService(runner).execute(
                graph([{ to: 'must', from: 'nodes.a.output.missing', required: true }]),
            );
            expect(result).toMatchObject({
                status: 'failed',
                failureCode: 'input-mapping-unresolved',
                failedNodeId: 'a',
            });
            // The destination node never ran with a silently missing input.
            expect(runner.calls.map((call) => call.nodeId)).toEqual(['a']);
        });

        it('omits an OPTIONAL binding that cannot be resolved', async () => {
            const runner = scriptedRunner({});
            const result = await new WorkflowGraphExecutorService(runner).execute(
                graph([{ to: 'maybe', from: 'nodes.a.output.missing' }]),
            );
            expect(result.status).toBe('completed');
            expect(runner.calls[1].inputs).toEqual({});
        });

        it('applies on an on_failure edge as well, so a recovery node gets the failure code', async () => {
            const runner = scriptedRunner({ a: { ok: false, failureCode: 'lint-red' } });
            const recoveryGraph: WorkflowGraph = {
                id: 'g',
                entryNodeId: 'a',
                nodes: [node('a'), node('b')],
                edges: [
                    {
                        id: 'e1',
                        kind: 'on_failure',
                        from: 'a',
                        to: 'b',
                        inputMapping: [
                            { to: 'reason', from: 'nodes.a.failureCode', required: true },
                        ],
                    },
                ],
            };
            const result = await new WorkflowGraphExecutorService(runner).execute(recoveryGraph);
            expect(result.status).toBe('completed');
            expect(runner.calls[1].inputs).toEqual({ reason: 'lint-red' });
        });
    });
});
