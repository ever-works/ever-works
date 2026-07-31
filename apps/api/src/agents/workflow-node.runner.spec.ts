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
