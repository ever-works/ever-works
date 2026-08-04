import { DataSource } from 'typeorm';
import type { WorkflowGraph, WorkflowNode } from '@ever-works/contracts';
import { Workflow, WorkflowStatus } from '../../entities/workflow.entity';
import { WorkflowRun } from '../../entities/workflow-run.entity';
import { WorkflowRepository } from '../../database/repositories/workflow.repository';
import { WorkflowRunRepository } from '../../database/repositories/workflow-run.repository';
import { WorkflowGraphExecutorService } from '../../agents/workflow-graph-executor.service';
import type { WorkflowNodeRunner, WorkflowNodeRunResult } from '../../agents/workflow-graph.ports';
import { WorkflowRunExecutorService } from '../workflow-run-executor.service';

/**
 * The test that matters for the persisted-run slice.
 *
 * "A run row was created" passes even if nothing ever executes — which is
 * exactly the failure this whole PR exists to make impossible. So these
 * specs run a REAL `WorkflowGraphExecutorService` against a REAL
 * better-sqlite3 database and assert that the row's TERMINAL STATE
 * reflects what the node runner actually did:
 *
 *   - a runner that fails ⇒ the row lands `failed`, carrying the failure
 *     code and the node it stopped on;
 *   - a runner that succeeds ⇒ the row lands `completed`, carrying the
 *     visited node list in execution order.
 *
 * Only the node runner is a stub, because it is the seam whose behaviour
 * is being varied. Everything between it and the column — edge selection,
 * trace summarization, the CAS terminal write — is the real code.
 */
describe('WorkflowRunExecutorService', () => {
    let dataSource: DataSource;
    let workflows: WorkflowRepository;
    let runs: WorkflowRunRepository;

    /** Two sequential noop nodes, a → b. */
    const graph: WorkflowGraph = {
        id: 'g-1',
        entryNodeId: 'a',
        nodes: [
            { id: 'a', kind: 'noop' } as WorkflowNode,
            { id: 'b', kind: 'noop' } as WorkflowNode,
        ],
        edges: [{ id: 'e-ab', from: 'a', to: 'b', kind: 'sequential' }],
    } as WorkflowGraph;

    /** A node runner with the behaviour each test wants to observe. */
    const runnerOf = (impl: (node: WorkflowNode) => WorkflowNodeRunResult): WorkflowNodeRunner => ({
        run: async (node) => impl(node),
    });

    const buildExecutor = (runner: WorkflowNodeRunner) =>
        new WorkflowRunExecutorService(workflows, runs, new WorkflowGraphExecutorService(runner));

    const seed = async (over: Partial<Workflow> = {}) => {
        const workflow = await workflows.create({
            userId: 'user-1',
            name: 'Nightly digest',
            graph,
            status: WorkflowStatus.ACTIVE,
            ...over,
        });
        const run = await runs.createQueued({ workflowId: workflow.id, userId: 'user-1' });
        return { workflow, run };
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [Workflow, WorkflowRun],
            synchronize: true,
        });
        await dataSource.initialize();
        workflows = new WorkflowRepository(dataSource.getRepository(Workflow));
        runs = new WorkflowRunRepository(dataSource.getRepository(WorkflowRun));
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('lands `completed` with the visited node list when every node succeeds', async () => {
        const { run } = await seed();

        const status = await buildExecutor(
            runnerOf(() => ({ ok: true, output: { done: true } })),
        ).execute({ workflowRunId: run.id, userId: 'user-1' });

        expect(status).toBe('completed');

        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('completed');
        // The whole point: the row knows WHICH nodes ran, in order.
        expect(row?.trace?.visited).toEqual(['a', 'b']);
        expect(row?.stepCount).toBe(2);
        expect(row?.failureCode).toBeNull();
        expect(row?.trace?.nodes.every((node) => node.ok)).toBe(true);
        expect(row?.output).toEqual({ done: true });
    });

    it('lands `failed` with the failure code when the node runner fails', async () => {
        const { run } = await seed();

        const status = await buildExecutor(
            runnerOf(() => ({ ok: false, failureCode: 'kb-unavailable', error: 'KB not bound' })),
        ).execute({ workflowRunId: run.id, userId: 'user-1' });

        expect(status).toBe('failed');

        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('failed');
        // `node-failed` is the EXECUTOR's verdict (nothing caught the
        // failure); the runner's own `kb-unavailable` is preserved on the
        // node entry, so both halves of the story survive.
        expect(row?.failureCode).toBe('node-failed');
        expect(row?.failedNodeId).toBe('a');
        expect(row?.trace?.nodes[0]).toMatchObject({
            nodeId: 'a',
            ok: false,
            failureCode: 'kb-unavailable',
        });
        // It stopped at the failing node — `b` never ran.
        expect(row?.trace?.visited).toEqual(['a']);
        expect(row?.errorMessage).toContain('a');
    });

    it('records the SECOND node failing, so the status tracks the run and not the graph', async () => {
        // Guards against a terminal status derived from anything other
        // than the walk: same graph, same first node, different outcome.
        const { run } = await seed();

        await buildExecutor(
            runnerOf((node) =>
                node.id === 'b'
                    ? { ok: false, failureCode: 'ai-unavailable' }
                    : { ok: true, output: 1 },
            ),
        ).execute({ workflowRunId: run.id, userId: 'user-1' });

        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('failed');
        expect(row?.failedNodeId).toBe('b');
        expect(row?.trace?.visited).toEqual(['a', 'b']);
        expect(row?.stepCount).toBe(2);
    });

    it('stamps startedAt, finishedAt and a duration on the terminal row', async () => {
        const { run } = await seed();
        expect((await runs.findByIdAndUser(run.id, 'user-1'))?.startedAt).toBeNull();

        await buildExecutor(runnerOf(() => ({ ok: true }))).execute({
            workflowRunId: run.id,
            userId: 'user-1',
            triggerRunId: 'run_abc123',
        });

        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.startedAt).toBeInstanceOf(Date);
        expect(row?.finishedAt).toBeInstanceOf(Date);
        expect(row?.durationMs).toBeGreaterThanOrEqual(0);
        expect(row?.triggerRunId).toBe('run_abc123');
    });

    it('does not re-walk a run that is already terminal (Trigger.dev retry)', async () => {
        const { run } = await seed();
        const runner = jest.fn(async () => ({ ok: true }));

        await buildExecutor({ run: runner }).execute({
            workflowRunId: run.id,
            userId: 'user-1',
        });
        expect(runner).toHaveBeenCalledTimes(2);

        // Second delivery of the same payload. Re-walking would re-pay for
        // every ai.ask node and re-spawn every delegate node's child run.
        const status = await buildExecutor({ run: runner }).execute({
            workflowRunId: run.id,
            userId: 'user-1',
        });
        expect(status).toBe('completed');
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('records a run whose workflow was deleted mid-flight rather than throwing', async () => {
        const { workflow, run } = await seed();
        await workflows.remove(workflow.id, 'user-1');

        const status = await buildExecutor(runnerOf(() => ({ ok: true }))).execute({
            workflowRunId: run.id,
            userId: 'user-1',
        });

        expect(status).toBe('failed');
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.failureCode).toBe('workflow-deleted');
    });

    it('refuses to execute another user’s run', async () => {
        const { run } = await seed();
        await expect(
            buildExecutor(runnerOf(() => ({ ok: true }))).execute({
                workflowRunId: run.id,
                userId: 'someone-else',
            }),
        ).rejects.toThrow(/not found/i);
    });

    it('reports `no-node-runner` as a failed row when nothing can execute a node', async () => {
        // The executor calls this `blocked`; the row has no such status,
        // and the distinction survives in the failure code.
        const { run } = await seed();

        const status = await new WorkflowRunExecutorService(
            workflows,
            runs,
            new WorkflowGraphExecutorService(),
        ).execute({ workflowRunId: run.id, userId: 'user-1' });

        expect(status).toBe('failed');
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.failureCode).toBe('no-node-runner');
        expect(row?.trace?.visited).toEqual([]);
    });
});
