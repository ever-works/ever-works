import { DataSource, In, type Repository } from 'typeorm';
import { AgentRun } from '../../entities/agent-run.entity';
import { Goal } from '../../entities/goal.entity';
import { GoalEvent } from '../../entities/goal-event.entity';
import { Task } from '../../entities/task.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import type { RunSteeringService } from '../../agents/run-steering.service';
import { GoalOrchestratorService } from '../goal-orchestrator.service';

/**
 * Goal iterations read their runs in two orders. A Task's latest run (the
 * Sessions tab) is its most recently CREATED run, the same run
 * `findLatestForTask` names. The active head (nudge, advance, cancel) is the
 * FIRST in-flight run oldest-started first, never-started runs last.
 *
 * On better-sqlite3 two things used to skew both reads: NULL `startedAt`
 * (every queued run) sorted FIRST in ascending order, and runs sharing a
 * whole-second `createdAt` came back in index order. Against a real
 * in-memory schema this pins both reads, breaking ties by insertion order.
 * One case drives the non-SQLite path with a stubbed repository returning
 * rows in Postgres's order, NULLs last.
 */
describe('GoalOrchestratorService — iteration run order (better-sqlite3 integration)', () => {
    let dataSource: DataSource;
    let goals: Repository<Goal>;
    let events: Repository<GoalEvent>;
    let tasks: Repository<Task>;
    let runs: Repository<AgentRun>;

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SAME_SECOND = new Date('2026-09-14T10:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        goals = dataSource.getRepository(Goal);
        events = dataSource.getRepository(GoalEvent);
        tasks = dataSource.getRepository(Task);
        runs = dataSource.getRepository(AgentRun);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        for (const repository of [runs, tasks, events, goals] as Repository<object>[]) {
            await repository.clear();
        }
    });

    async function seedGoalAndTask(): Promise<{ goal: Goal; task: Task }> {
        const goal = await goals.save(
            goals.create({
                userId: USER,
                title: 'Ship the login page',
                goalKind: 'delivery',
                window: 'total',
                iteration: 1,
            } as Partial<Goal>),
        );
        const task = await tasks.save(
            tasks.create({
                userId: USER,
                goalId: goal.id,
                agentId: AGENT,
                slug: 'T-1',
                title: 'Iteration 1',
                createdByType: 'user',
                createdById: USER,
            } as Partial<Task>),
        );
        return { goal, task };
    }

    function seedRun(taskId: string, overrides: Partial<AgentRun>): Promise<AgentRun> {
        return runs.save(
            runs.create({
                userId: USER,
                agentId: AGENT,
                taskId,
                triggerKind: 'task',
                status: 'completed',
                gateAttempts: 0,
                persistent: false,
                awaitingInput: false,
                interruptRequested: false,
                createdAt: SAME_SECOND,
                ...overrides,
            } as Partial<AgentRun>),
        );
    }

    it('listSessions reports the last-inserted queued run as the iteration latest', async () => {
        const { goal, task } = await seedGoalAndTask();
        await seedRun(task.id, {
            id: 'ffffffff-0000-4000-8000-000000000001',
            status: 'completed',
            startedAt: new Date('2026-09-14T09:00:00.000Z'),
            createdAt: new Date('2026-09-14T08:59:00.000Z'),
        });
        // Two queued runs in one second; the newer one has the SMALLER id.
        await seedRun(task.id, {
            id: 'eeeeeeee-0000-4000-8000-000000000002',
            status: 'queued',
            startedAt: null,
        });
        const newest = await seedRun(task.id, {
            id: '00000000-0000-4000-8000-000000000003',
            status: 'queued',
            startedAt: null,
        });

        const service = new GoalOrchestratorService(goals, events, tasks, runs);
        const sessions = await service.listSessions(USER, goal.id);

        expect(sessions).toHaveLength(1);
        expect(sessions[0].runId).toBe(newest.id);
        expect(sessions[0].runStatus).toBe('queued');
    });

    it('treats the running run as the active head, ahead of a queued one', async () => {
        const { goal, task } = await seedGoalAndTask();
        const running = await seedRun(task.id, {
            id: 'ffffffff-0000-4000-8000-000000000001',
            status: 'running',
            startedAt: new Date('2026-09-14T10:00:00.500Z'),
        });
        await seedRun(task.id, {
            id: '00000000-0000-4000-8000-000000000002',
            status: 'queued',
            startedAt: null,
        });
        const steer = jest.fn(async () => ({ dispatched: 'injected' as const }));
        const service = new GoalOrchestratorService(
            goals,
            events,
            tasks,
            runs,
            undefined,
            undefined,
            undefined,
            { steer } as unknown as RunSteeringService,
        );

        const result = await service.nudge(USER, goal.id, 'check the failing test first');

        expect(steer).toHaveBeenCalledWith(expect.objectContaining({ runId: running.id }));
        expect(result.runId).toBe(running.id);
    });

    it('keeps the running run as the active head when an older queued run was inserted first', async () => {
        const { goal, task } = await seedGoalAndTask();
        await seedRun(task.id, {
            id: '00000000-0000-4000-8000-000000000001',
            status: 'queued',
            startedAt: null,
        });
        const running = await seedRun(task.id, {
            id: 'ffffffff-0000-4000-8000-000000000002',
            status: 'running',
            startedAt: new Date('2026-09-14T10:00:00.500Z'),
        });
        const steer = jest.fn(async () => ({ dispatched: 'injected' as const }));
        const service = new GoalOrchestratorService(
            goals,
            events,
            tasks,
            runs,
            undefined,
            undefined,
            undefined,
            { steer } as unknown as RunSteeringService,
        );

        const result = await service.nudge(USER, goal.id, 'check the failing test first');

        expect(steer).toHaveBeenCalledWith(expect.objectContaining({ runId: running.id }));
        expect(result.runId).toBe(running.id);
    });

    it('listSessions does not let an older never-started cancelled run mask a newer started run', async () => {
        const { goal, task } = await seedGoalAndTask();
        await seedRun(task.id, {
            id: '00000000-0000-4000-8000-000000000001',
            status: 'cancelled',
            startedAt: null,
            createdAt: new Date('2026-09-14T10:00:00.000Z'),
        });
        const completed = await seedRun(task.id, {
            id: 'ffffffff-0000-4000-8000-000000000002',
            status: 'completed',
            startedAt: new Date('2026-09-14T10:05:00.000Z'),
            createdAt: new Date('2026-09-14T10:04:59.000Z'),
        });

        const service = new GoalOrchestratorService(goals, events, tasks, runs);
        const [session] = await service.listSessions(USER, goal.id);

        expect(session.runId).toBe(completed.id);
        expect(session.runStatus).toBe('completed');
    });

    it('listSessions picks the last-inserted run when a never-started failed run shares its second', async () => {
        const { goal, task } = await seedGoalAndTask();
        await seedRun(task.id, {
            id: 'ffffffff-0000-4000-8000-000000000001',
            status: 'failed',
            startedAt: null,
        });
        // Same createdAt, inserted later, SMALLER id, and it did start.
        const newest = await seedRun(task.id, {
            id: '00000000-0000-4000-8000-000000000002',
            status: 'completed',
            startedAt: new Date('2026-09-14T10:00:00.500Z'),
        });
        const stamps = await runs.find({ where: { taskId: task.id } });
        expect(new Set(stamps.map((run) => run.createdAt.getTime())).size).toBe(1);

        const service = new GoalOrchestratorService(goals, events, tasks, runs);
        const [session] = await service.listSessions(USER, goal.id);

        expect(session.runId).toBe(newest.id);
        expect(session.runStatus).toBe('completed');
    });

    it('on a non-SQLite driver keeps the original find and still picks the latest-created run', async () => {
        const { goal, task } = await seedGoalAndTask();
        const cancelled = {
            id: '00000000-0000-4000-8000-000000000001',
            taskId: task.id,
            agentId: AGENT,
            status: 'cancelled',
            startedAt: null,
            createdAt: new Date('2026-09-14T10:00:00.000Z'),
        } as AgentRun;
        const completed = {
            id: 'ffffffff-0000-4000-8000-000000000002',
            taskId: task.id,
            agentId: AGENT,
            status: 'completed',
            startedAt: new Date('2026-09-14T10:05:00.000Z'),
            createdAt: new Date('2026-09-14T10:04:59.000Z'),
        } as AgentRun;
        // Postgres order for `startedAt ASC`: NULLs last.
        const find = jest.fn(async () => [completed, cancelled]);
        const createQueryBuilder = jest.fn(() => {
            throw new Error('createQueryBuilder must not be used on this driver');
        });
        const postgresRuns = {
            find,
            createQueryBuilder,
            manager: { connection: { options: { type: 'postgres' } } },
        } as unknown as Repository<AgentRun>;

        const service = new GoalOrchestratorService(goals, events, tasks, postgresRuns);
        const [session] = await service.listSessions(USER, goal.id);

        expect(session.runId).toBe(completed.id);
        expect(session.runStatus).toBe('completed');
        expect(find).toHaveBeenCalledTimes(1);
        expect(find).toHaveBeenCalledWith({
            where: { taskId: In([task.id]) },
            order: { startedAt: 'ASC' },
        });
        expect(createQueryBuilder).not.toHaveBeenCalled();
    });
});
