import { DataSource } from 'typeorm';
import type { WorkflowGraph, WorkflowNode } from '@ever-works/contracts';
import { Workflow, WorkflowStatus } from '../../entities/workflow.entity';
import { WorkflowRun } from '../../entities/workflow-run.entity';
import { WorkflowRepository } from '../../database/repositories/workflow.repository';
import {
    WORKFLOW_RUN_SWEPT_FAILURE_CODE,
    WorkflowRunRepository,
} from '../../database/repositories/workflow-run.repository';
import { WorkflowRunSweeperService } from '../workflow-run-sweeper.service';

/**
 * The backstop for `workflow_runs` rows abandoned by a dead worker.
 *
 * `workflow-run.task.ts` runs `maxAttempts: 1`, so nothing re-enters the task
 * to finish a row whose machine was OOM-killed, evicted, or rolled by a
 * deploy. Before this sweep such a row read `queued`/`running` forever, with
 * `finishedAt` and `durationMs` NULL, and there is still no cancel route to
 * clear it by hand.
 *
 * Runs against a real in-memory DataSource rather than a mocked repository:
 * the whole mechanism is a `COALESCE(startedAt, createdAt) < cutoff` predicate
 * plus a status-guarded bulk CAS, and a mock would only assert the SQL I wrote
 * rather than the rows it actually selects.
 */
describe('WorkflowRunSweeperService', () => {
    const ORIGINAL_ENV = { ...process.env };

    let dataSource: DataSource;
    let workflows: WorkflowRepository;
    let runs: WorkflowRunRepository;
    let sweeper: WorkflowRunSweeperService;

    const graph: WorkflowGraph = {
        id: 'g-1',
        entryNodeId: 'a',
        nodes: [{ id: 'a', kind: 'noop' } as WorkflowNode],
        edges: [],
    } as WorkflowGraph;

    /** Backdate a row's clock columns so the cutoff predicate can see it. */
    const backdate = async (
        runId: string,
        minutesAgo: number,
        column: 'startedAt' | 'createdAt',
    ) => {
        const when = new Date(Date.now() - minutesAgo * 60 * 1000);
        await dataSource
            .getRepository(WorkflowRun)
            .createQueryBuilder()
            .update(WorkflowRun)
            .set({ [column]: when })
            .where('id = :runId', { runId })
            .execute();
    };

    beforeEach(async () => {
        process.env = { ...ORIGINAL_ENV };
        delete process.env.WORKFLOW_RUN_SWEEPER_ENABLED;
        delete process.env.WORKFLOW_RUN_STUCK_TIMEOUT_MINUTES;
        delete process.env.WORKFLOW_RUN_SWEEPER_MAX_BATCH;

        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [Workflow, WorkflowRun],
            synchronize: true,
        });
        await dataSource.initialize();
        workflows = new WorkflowRepository(dataSource.getRepository(Workflow));
        runs = new WorkflowRunRepository(dataSource.getRepository(WorkflowRun));
        sweeper = new WorkflowRunSweeperService(runs);
    });

    afterEach(async () => {
        process.env = { ...ORIGINAL_ENV };
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const seedRun = async () => {
        const workflow = await workflows.create({
            userId: 'user-1',
            name: 'Nightly digest',
            graph,
            status: WorkflowStatus.ACTIVE,
        } as Parameters<WorkflowRepository['create']>[0]);
        return runs.createQueued({ workflowId: workflow.id, userId: 'user-1' });
    };

    it('reaps a running row whose startedAt is past the cutoff', async () => {
        const run = await seedRun();
        await runs.markStarted(run.id, 'run_abc');
        await backdate(run.id, 200, 'startedAt');

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.swept).toEqual([run.id]);
        expect(summary.scanned).toBe(1);

        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('failed');
        expect(row?.failureCode).toBe(WORKFLOW_RUN_SWEPT_FAILURE_CODE);
        expect(row?.finishedAt).not.toBeNull();
        expect(row?.errorMessage).toContain('abandoned');
    });

    it('reaps a queued row too — an enqueue can park across a deploy skew and never run', async () => {
        const run = await seedRun();
        // Never started, so `startedAt` is NULL and only the COALESCE onto
        // `createdAt` can see this row. A predicate written against
        // `startedAt` alone would leave it stranded forever.
        await backdate(run.id, 200, 'createdAt');

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.swept).toEqual([run.id]);
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('failed');
    });

    it('does NOT touch a long-running walk inside its own time budget', async () => {
        const run = await seedRun();
        await runs.markStarted(run.id);
        // 45 minutes in. The task pins `maxDuration: 60 * 60`, so this is a
        // healthy walk. Reaping it would be the unrecoverable error: the row
        // reads `failed`, the worker's own `markCompleted` then no-ops against
        // the terminal CAS, and the real result is gone.
        await backdate(run.id, 45, 'startedAt');

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.swept).toEqual([]);
        expect(summary.scanned).toBe(0);
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('running');
    });

    it('clamps a misconfigured cutoff up above the task maxDuration', async () => {
        // An operator setting 5 minutes would otherwise reap every healthy
        // walk. The floor is 61 minutes.
        process.env.WORKFLOW_RUN_STUCK_TIMEOUT_MINUTES = '5';
        const run = await seedRun();
        await runs.markStarted(run.id);
        await backdate(run.id, 30, 'startedAt');

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.cutoffMinutes).toBeGreaterThan(60);
        expect(summary.swept).toEqual([]);
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('running');
    });

    it('leaves a row that reached its own terminal status alone', async () => {
        const run = await seedRun();
        await runs.markStarted(run.id);
        await runs.markCompleted(run.id, { stepCount: 3 });
        await backdate(run.id, 500, 'startedAt');

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.swept).toEqual([]);
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('completed');
        expect(row?.failureCode ?? null).toBeNull();
    });

    it('honours the kill switch without scanning', async () => {
        process.env.WORKFLOW_RUN_SWEEPER_ENABLED = 'false';
        const run = await seedRun();
        await runs.markStarted(run.id);
        await backdate(run.id, 500, 'startedAt');

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.enabled).toBe(false);
        expect(summary.swept).toEqual([]);
        const row = await runs.findByIdAndUser(run.id, 'user-1');
        expect(row?.status).toBe('running');
    });

    it('bounds one tick by the max batch', async () => {
        process.env.WORKFLOW_RUN_SWEEPER_MAX_BATCH = '2';
        for (let i = 0; i < 3; i++) {
            const run = await seedRun();
            await runs.markStarted(run.id);
            await backdate(run.id, 300 + i, 'startedAt');
        }

        const summary = await sweeper.sweepStuckRuns();

        expect(summary.scanned).toBe(2);
    });

    it('markStuckFailed no-ops on an empty batch rather than emitting invalid SQL', async () => {
        // TypeORM renders `IN (:...ids)` as invalid SQL for an empty array.
        await expect(runs.markStuckFailed([], 'nothing')).resolves.toBe(0);
    });
});
