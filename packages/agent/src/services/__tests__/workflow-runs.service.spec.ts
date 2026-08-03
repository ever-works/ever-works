import { DataSource } from 'typeorm';
import type { WorkflowGraph, WorkflowNode } from '@ever-works/contracts';
import { Workflow, WorkflowStatus } from '../../entities/workflow.entity';
import { WorkflowRun } from '../../entities/workflow-run.entity';
import { WorkflowRepository } from '../../database/repositories/workflow.repository';
import { WorkflowRunRepository } from '../../database/repositories/workflow-run.repository';
import type { WorkflowRunDispatcher } from '../../tasks/workflow-run-dispatcher';
import { WorkflowRunsService } from '../workflow-runs.service';

/**
 * The REQUEST side of running a workflow.
 *
 * The property these specs exist to protect is that `POST :id/run`
 * returns without waiting for the graph. A maximal graph walks for ~40
 * minutes, so an endpoint that awaited it could never answer — and the
 * regression would not be a crash, it would be a slow timeout under load
 * that nothing else catches.
 */
describe('WorkflowRunsService', () => {
    let dataSource: DataSource;
    let workflows: WorkflowRepository;
    let runs: WorkflowRunRepository;

    const graph: WorkflowGraph = {
        id: 'g-1',
        entryNodeId: 'a',
        nodes: [{ id: 'a', kind: 'noop' } as WorkflowNode],
        edges: [],
    } as WorkflowGraph;

    const seedWorkflow = (over: Parameters<WorkflowRepository['create']>[0] | object = {}) =>
        workflows.create({
            userId: 'user-1',
            name: 'Nightly digest',
            graph,
            status: WorkflowStatus.ACTIVE,
            ...over,
        } as Parameters<WorkflowRepository['create']>[0]);

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

    describe('start', () => {
        it('returns a QUEUED run — it does not walk the graph', async () => {
            const workflow = await seedWorkflow();
            const dispatcher: WorkflowRunDispatcher = {
                dispatchWorkflowRun: jest.fn().mockResolvedValue('run_abc'),
            };
            const service = new WorkflowRunsService(workflows, runs, dispatcher);

            const run = await service.start('user-1', workflow.id);

            // If anyone ever made this await the execution, the row would
            // already be `completed`/`failed` here. `queued` is the proof
            // that the request handed the work off and returned.
            expect(run.status).toBe('queued');
            expect(run.startedAt).toBeNull();
            expect(run.finishedAt).toBeNull();
            expect(run.stepCount).toBe(0);
            expect(run.trace).toBeNull();
        });

        it('hands the ids to the dispatcher and stamps the returned handle', async () => {
            const workflow = await seedWorkflow();
            const dispatch = jest.fn().mockResolvedValue('run_abc');
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: dispatch,
            });

            const run = await service.start('user-1', workflow.id);

            expect(dispatch).toHaveBeenCalledWith({
                workflowRunId: run.id,
                workflowId: workflow.id,
                userId: 'user-1',
            });
            expect(run.triggerRunId).toBe('run_abc');
        });

        it('bumps the workflow’s runCount and lastRunAt', async () => {
            // `WorkflowRepository.recordRun` shipped in PR #1986 with no
            // caller at all — this is the slice that makes it real.
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: jest.fn().mockResolvedValue('run_abc'),
            });

            await service.start('user-1', workflow.id);
            await service.start('user-1', workflow.id);

            const after = await workflows.findByIdAndUser(workflow.id, 'user-1');
            expect(after?.runCount).toBe(2);
            expect(after?.lastRunAt).toBeInstanceOf(Date);
        });

        it('records the run as FAILED when the job runtime is not configured', async () => {
            // A `queued` row nothing will ever pick up reads as "in
            // progress" forever. The row is the account of what happened,
            // so it says what happened.
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: jest.fn().mockResolvedValue(null),
            });

            const run = await service.start('user-1', workflow.id);

            expect(run.status).toBe('failed');
            // Records that dispatch was not accepted WITHOUT asserting why:
            // an unconfigured runtime and an auth failure both surface as
            // `null`, and the adapter is what logs the real cause.
            expect(run.errorMessage).toMatch(/did not accept the run/i);
        });

        it('records the run as FAILED when no dispatcher is bound at all', async () => {
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs);

            const run = await service.start('user-1', workflow.id);

            expect(run.status).toBe('failed');
            expect(run.errorMessage).toMatch(/no workflow run dispatcher/i);
        });

        it('does not 500 when the dispatcher throws — the row already exists', async () => {
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: jest.fn().mockRejectedValue(new Error('socket hang up')),
            });

            const run = await service.start('user-1', workflow.id);

            expect(run.status).toBe('failed');
            expect(run.errorMessage).toBe('socket hang up');
        });

        it('reports 404 — never 403 — for another user’s workflow', async () => {
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs);
            await expect(service.start('someone-else', workflow.id)).rejects.toMatchObject({
                status: 404,
            });
        });

        it('refuses to start an archived workflow', async () => {
            const workflow = await seedWorkflow({ status: WorkflowStatus.ARCHIVED });
            const service = new WorkflowRunsService(workflows, runs);
            await expect(service.start('user-1', workflow.id)).rejects.toMatchObject({
                status: 409,
            });
        });

        it('starts a DRAFT workflow — draft is unfinished, not unrunnable', async () => {
            const workflow = await seedWorkflow({ status: WorkflowStatus.DRAFT });
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: jest.fn().mockResolvedValue('run_abc'),
            });
            await expect(service.start('user-1', workflow.id)).resolves.toMatchObject({
                status: 'queued',
            });
        });
    });

    describe('reads', () => {
        it('lists a workflow’s runs newest first, without the heavy columns', async () => {
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: jest.fn().mockResolvedValue('run_abc'),
            });
            await service.start('user-1', workflow.id);
            await service.start('user-1', workflow.id);

            const page = await service.listForWorkflow('user-1', workflow.id);

            expect(page.total).toBe(2);
            expect(page.items).toHaveLength(2);
            // The projection is the point: `trace` and `output` are the two
            // columns that can be kilobytes each.
            expect(page.items[0]).not.toHaveProperty('trace');
            expect(page.items[0]).not.toHaveProperty('output');
            expect(page.items[0]).toHaveProperty('status');
        });

        it('reports 404 for a run list on another user’s workflow', async () => {
            // Not an empty page — that would read as "no runs yet".
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs);
            await expect(
                service.listForWorkflow('someone-else', workflow.id),
            ).rejects.toMatchObject({ status: 404 });
        });

        it('reports 404 for another user’s run id', async () => {
            const workflow = await seedWorkflow();
            const service = new WorkflowRunsService(workflows, runs, {
                dispatchWorkflowRun: jest.fn().mockResolvedValue('run_abc'),
            });
            const run = await service.start('user-1', workflow.id);

            await expect(service.getRun('someone-else', run.id)).rejects.toMatchObject({
                status: 404,
            });
            await expect(service.getRun('user-1', run.id)).resolves.toMatchObject({ id: run.id });
        });
    });
});
