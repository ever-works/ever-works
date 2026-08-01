// Mock the agent barrels this spec injects through. Importing
// `@ever-works/agent/services` for real pulls the whole services barrel,
// which reaches `@src/*` path aliases that do not resolve under the API
// jest config. The classes are only needed as DI tokens here.
jest.mock('@ever-works/agent/services', () => ({ KnowledgeBaseService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ SubAgentDelegationService: class {} }));
jest.mock('@ever-works/agent/facades', () => ({ AiFacadeService: class {} }));

import { Test, TestingModule } from '@nestjs/testing';
import { WorkflowNodeRunnerService } from './workflow-node.runner';
import { SubAgentDelegationService } from '@ever-works/agent/agents';
import { AiFacadeService } from '@ever-works/agent/facades';
import { KnowledgeBaseService } from '@ever-works/agent/services';

/**
 * The real workflow node runner.
 *
 * `WorkflowGraphExecutorService` owns edge semantics and delegates what a
 * node DOES to this seam — which nothing bound, so a graph could be
 * validated but never executed.
 *
 * The behaviours pinned here are the ones that decide whether a graph can
 * be trusted: that an unknown kind FAILS rather than quietly succeeding,
 * that a thrown node becomes a catchable failure instead of aborting the
 * graph, and that a delegation refusal surfaces its code so an
 * `on_failure` edge can route on it.
 */
describe('WorkflowNodeRunnerService', () => {
    let runner: WorkflowNodeRunnerService;
    let delegation: { delegate: jest.Mock };
    let ai: { createChatCompletion: jest.Mock };
    let kb: { listDocuments: jest.Mock };

    const ctx = (over: Record<string, unknown> = {}) => ({
        graphId: 'g1',
        runId: 'run-1',
        viaEdgeId: null,
        stepIndex: 0,
        context: { userId: 'user-1', workId: 'work-1', agentId: 'agent-1', ...over },
    });

    beforeEach(async () => {
        delegation = {
            delegate: jest
                .fn()
                .mockResolvedValue({ status: 'completed', output: 'child output', summary: 'ok' }),
        };
        ai = {
            createChatCompletion: jest
                .fn()
                .mockResolvedValue({ choices: [{ message: { content: 'an answer' } }] }),
        };
        kb = { listDocuments: jest.fn().mockResolvedValue({ items: [], total: 0 }) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WorkflowNodeRunnerService,
                { provide: SubAgentDelegationService, useValue: delegation },
                { provide: AiFacadeService, useValue: ai },
                { provide: KnowledgeBaseService, useValue: kb },
            ],
        }).compile();

        runner = module.get(WorkflowNodeRunnerService);
    });

    it('passes inputs through a noop node', async () => {
        const result = await runner.run({ id: 'n1', kind: 'noop' }, { a: 1 }, ctx() as never);

        expect(result.ok).toBe(true);
        expect(result.output).toEqual({ a: 1 });
    });

    it('FAILS an unknown node kind instead of silently succeeding', async () => {
        // A successful no-op would let a graph appear to complete while
        // doing nothing — the exact silence this seam exists to avoid.
        const result = await runner.run({ id: 'n1', kind: 'wat' }, {}, ctx() as never);

        expect(result.ok).toBe(false);
        expect(result.failureCode).toBe('unknown-node-kind');
    });

    it('runs an agent.delegate node through the delegation service', async () => {
        const result = await runner.run(
            { id: 'n1', kind: 'agent.delegate', config: { objective: 'do the thing' } },
            {},
            ctx() as never,
        );

        expect(result.ok).toBe(true);
        expect(result.output).toBe('child output');
        expect(delegation.delegate).toHaveBeenCalledWith(
            expect.objectContaining({
                objective: 'do the thing',
                parentAgentId: 'agent-1',
                parentRunId: 'run-1',
                // Deterministic per (run, node) so a retried step reuses
                // the dedup key rather than spawning a second child.
                delegationId: 'run-1:n1',
            }),
            // The limits argument — see the `delegation limits` block.
            expect.any(Object),
        );
    });

    /**
     * The delegation contract's caps are all evaluated against a `limits`
     * argument the CALLER supplies. This runner is the only production
     * caller, and it used to pass none — so `narrowSubAgentScope` never
     * ran ("privilege only shrinks" was unenforced) and the fan-out check
     * compared `0 >= maxSiblings`, which is never true.
     */
    describe('delegation limits', () => {
        const PARENT_SCOPE = {
            allowedTools: ['read_file', 'write_file'],
            workId: 'work-1',
            organizationId: 'org-1',
            networkAccess: false,
        };

        const delegateNode = (config: Record<string, unknown> = {}) => ({
            id: 'n1',
            kind: 'agent.delegate',
            config: { objective: 'do the thing', ...config },
        });

        it('passes the parent scope so narrowing actually runs', async () => {
            await runner.run(delegateNode(), {}, ctx({ parentScope: PARENT_SCOPE }) as never);

            expect(delegation.delegate).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ parentScope: PARENT_SCOPE }),
            );
        });

        it('passes a sibling count that RISES, so the fan-out cap can fire', async () => {
            // The cap compares `siblingCount >= maxSiblings`. A constant 0
            // can never trip it however many delegations a run issues.
            await runner.run(delegateNode(), {}, ctx({ parentScope: PARENT_SCOPE }) as never);
            await runner.run(
                { ...delegateNode(), id: 'n2' },
                {},
                ctx({ parentScope: PARENT_SCOPE }) as never,
            );
            await runner.run(
                { ...delegateNode(), id: 'n3' },
                {},
                ctx({ parentScope: PARENT_SCOPE }) as never,
            );

            const counts = delegation.delegate.mock.calls.map((call) => call[1].siblingCount);
            expect(counts).toEqual([0, 1, 2]);
        });

        it('counts siblings PER RUN, not globally', async () => {
            await runner.run(delegateNode(), {}, ctx({ parentScope: PARENT_SCOPE }) as never);

            const other = {
                graphId: 'g1',
                runId: 'run-2',
                viaEdgeId: null,
                stepIndex: 0,
                context: { userId: 'user-1', agentId: 'agent-1', parentScope: PARENT_SCOPE },
            };
            await runner.run(delegateNode(), {}, other as never);

            // A second graph run starts its own budget — otherwise one busy
            // run would refuse delegations for an unrelated one.
            expect(delegation.delegate.mock.calls[1][1].siblingCount).toBe(0);
        });

        it("defaults a node's tools to the inherit-parent wildcard when a parent scope bounds it", async () => {
            await runner.run(delegateNode(), {}, ctx({ parentScope: PARENT_SCOPE }) as never);

            // `['*']` intersects to exactly the parent's tools. Without a
            // parent scope this would be an unbounded ask.
            expect(delegation.delegate.mock.calls[0][0].scope.allowedTools).toEqual(['*']);
        });

        it('keeps the empty tool list when NO parent scope bounds it', async () => {
            await runner.run(delegateNode(), {}, ctx() as never);

            // Unchanged from before this feature: the contract refuses an
            // empty scope as `scope-empty` rather than letting an unbounded
            // request through.
            expect(delegation.delegate.mock.calls[0][0].scope.allowedTools).toEqual([]);
            expect(delegation.delegate.mock.calls[0][1].parentScope).toBeUndefined();
        });

        it('still honours an explicit allowedTools list from the node', async () => {
            await runner.run(
                delegateNode({ allowedTools: ['read_file'] }),
                {},
                ctx({ parentScope: PARENT_SCOPE }) as never,
            );

            expect(delegation.delegate.mock.calls[0][0].scope.allowedTools).toEqual(['read_file']);
        });

        it('drops a malformed parent scope rather than half-applying it', async () => {
            await runner.run(
                delegateNode(),
                {},
                ctx({ parentScope: { allowedTools: 'not-an-array' } }) as never,
            );

            expect(delegation.delegate.mock.calls[0][1].parentScope).toBeUndefined();
        });

        it('drops a parent scope that grants no tools', async () => {
            // An empty parent intersects to nothing and would refuse every
            // delegation — a broken feature, not a safe default.
            await runner.run(
                delegateNode(),
                {},
                ctx({ parentScope: { allowedTools: [] } }) as never,
            );

            expect(delegation.delegate.mock.calls[0][1].parentScope).toBeUndefined();
        });
    });

    it('prefers the REAL agent run id as parentRunId when the host supplies one', async () => {
        // This is what anchors delegation depth. The resolver walks
        // `agent_run -> task -> delegationDepth` from `parentRunId`, and
        // the graph's own `runId` is minted by the executor — it is not an
        // `agent_runs` row, so resolving from it finds nothing and the
        // recursion cap silently never fires.
        await runner.run(
            { id: 'n1', kind: 'agent.delegate', config: { objective: 'do the thing' } },
            {},
            ctx({ agentRunId: 'agent-run-real' }) as never,
        );

        expect(delegation.delegate).toHaveBeenCalledWith(
            expect.objectContaining({ parentRunId: 'agent-run-real' }),
            expect.any(Object),
        );
    });

    it('falls back to the graph run id when no agent run is threaded', async () => {
        // A host that supplies neither keeps working exactly as before.
        await runner.run(
            { id: 'n1', kind: 'agent.delegate', config: { objective: 'do the thing' } },
            {},
            ctx() as never,
        );

        expect(delegation.delegate).toHaveBeenCalledWith(
            expect.objectContaining({ parentRunId: 'run-1' }),
            expect.any(Object),
        );
    });

    it('surfaces a delegation refusal code so an on_failure edge can route on it', async () => {
        delegation.delegate.mockResolvedValue({
            status: 'refused',
            refusalCode: 'depth-exceeded',
            summary: 'too deep',
            output: null,
        });

        const result = await runner.run(
            { id: 'n1', kind: 'agent.delegate', config: { objective: 'x' } },
            {},
            ctx() as never,
        );

        expect(result.ok).toBe(false);
        expect(result.failureCode).toBe('depth-exceeded');
    });

    it('turns a thrown node into a catchable failure rather than aborting the graph', async () => {
        ai.createChatCompletion.mockRejectedValue(new Error('provider down'));

        const result = await runner.run(
            { id: 'n1', kind: 'ai.ask', config: { prompt: 'hello' } },
            {},
            ctx() as never,
        );

        expect(result.ok).toBe(false);
        expect(result.failureCode).toBe('node-threw');
        expect(result.error).toMatch(/provider down/);
    });

    it('runs ai.ask through the facade and reads the provider choice shape', async () => {
        const result = await runner.run(
            { id: 'n1', kind: 'ai.ask', config: { prompt: 'hello' } },
            {},
            ctx() as never,
        );

        expect(result.ok).toBe(true);
        expect(result.output).toBe('an answer');
    });

    it('refuses kb.search without the scope it needs, rather than reading the wrong Work', async () => {
        const result = await runner.run(
            { id: 'n1', kind: 'kb.search', config: { query: 'x' } },
            {},
            ctx({ workId: undefined }) as never,
        );

        expect(result.ok).toBe(false);
        expect(result.failureCode).toBe('bad-node-config');
        expect(kb.listDocuments).not.toHaveBeenCalled();
    });
});
