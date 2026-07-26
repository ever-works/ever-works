import { BadRequestException, ConflictException } from '@nestjs/common';
import { TaskTransitionService } from '../task-transition.service';
import {
    TasksService,
    RUN_AGENT_AMBIGUOUS,
    RUN_AGENT_NOT_FOUND,
    RUN_ALREADY_IN_FLIGHT,
    RUN_BATCH_MAX_TASKS,
    RUN_NO_AGENT,
} from '../tasks.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * Board dispatch (kanban M3 / M4).
 *
 * Two things are pinned here:
 *   - `TaskTransitionService.dispatchAgentRun` is THE dispatch path
 *     (gate → queued row → denorm → enqueue → stamp), and the
 *     transition fan-out is just a loop over it;
 *   - `TasksService.runTask` resolves the agent the way the board's
 *     picker expects and refuses a duplicate in-flight run.
 */

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Ship the thing',
        description: null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        agentId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('TaskTransitionService.dispatchAgentRun — the one dispatch path', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let runs: any;
    let dispatcher: any;
    let runDenorm: any;
    let dispatchGate: any;

    beforeEach(() => {
        tasks = { casUpdateStatus: jest.fn().mockResolvedValue(true), findById: jest.fn() };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        runDenorm = {
            recordQueued: jest.fn().mockResolvedValue(undefined),
            recordTerminal: jest.fn().mockResolvedValue(undefined),
        };
        dispatchGate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
    });

    const makeSvc = () =>
        new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            assignees,
            runs,
            dispatcher,
            undefined,
            runDenorm,
            dispatchGate,
        );

    it('consults the dispatch gate, creates the queued run, mirrors it on the board and enqueues', async () => {
        const result = await makeSvc().dispatchAgentRun(makeTask({ workId: 'w1' }), 'agent-1');
        expect(dispatchGate.admit).toHaveBeenCalledWith({
            userId: 'u1',
            workId: 'w1',
            organizationId: null,
        });
        expect(runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'agent-1', taskId: 't1', workId: 'w1' }),
        );
        expect(runDenorm.recordQueued).toHaveBeenCalledWith('t1', 'r1');
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(runs.setTriggerRunId).toHaveBeenCalledWith('r1', 'trd-1');
        expect(result).toEqual({ runId: 'r1', dispatched: true, parked: false });
    });

    it('parks the run WITHOUT enqueuing when the concurrency gate refuses', async () => {
        dispatchGate.admit.mockResolvedValue({
            admitted: false,
            queuedReason: 'concurrency-limit',
        });
        const result = await makeSvc().dispatchAgentRun(makeTask({ workId: 'w1' }), 'agent-1');
        expect(runs.createQueued).toHaveBeenCalledWith(
            expect.objectContaining({ queuedReason: 'concurrency-limit' }),
        );
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
        expect(result).toEqual({
            runId: 'r1',
            dispatched: false,
            parked: true,
            queuedReason: 'concurrency-limit',
        });
    });

    it('marks the run dispatch-failed (and clears the board chip) when the enqueue throws', async () => {
        dispatcher.enqueue.mockRejectedValue(new Error('runtime unreachable'));
        const result = await makeSvc().dispatchAgentRun(makeTask(), 'agent-1');
        expect(runs.markDispatchFailed).toHaveBeenCalledWith(
            'r1',
            expect.stringContaining('dispatch-failed'),
        );
        expect(runDenorm.recordTerminal).toHaveBeenCalledWith('t1', 'r1', 'failed');
        expect(result.dispatched).toBe(false);
        expect(result.error).toContain('runtime unreachable');
    });

    it('reports no-dispatcher instead of throwing when no job runtime is wired', async () => {
        const svc = new TaskTransitionService(tasks, blocks, approvers, assignees, runs);
        await expect(svc.dispatchAgentRun(makeTask(), 'agent-1')).resolves.toEqual({
            runId: null,
            dispatched: false,
            parked: false,
            error: 'no-dispatcher',
        });
    });

    it('fails OPEN when the gate itself throws — a broken valve never stops work', async () => {
        dispatchGate.admit.mockRejectedValue(new Error('count query exploded'));
        const result = await makeSvc().dispatchAgentRun(makeTask({ workId: 'w1' }), 'agent-1');
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(result.dispatched).toBe(true);
    });

    it('still fans a status transition out over every Agent assignee (one call per pair)', async () => {
        const svc = makeSvc();
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValue({ ...task, status: TaskStatus.IN_PROGRESS });
        assignees.findAgentAssignees.mockResolvedValue([
            { assigneeId: 'agent-1' },
            { assigneeId: 'agent-2' },
        ]);
        await svc.transition(task, TaskStatus.IN_PROGRESS);
        await new Promise((r) => setImmediate(r));
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        expect(dispatcher.enqueue.mock.calls.map((c: any[]) => c[0].agentId)).toEqual([
            'agent-1',
            'agent-2',
        ]);
    });
});

describe('TasksService.runTask — board dispatch', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let taskRepo: any;
    let assignees: any;
    let transitions: any;
    let agents: any;
    let agentRuns: any;

    const build = () =>
        new TasksService(
            taskRepo,
            assignees,
            {} as any, // reviewers
            {} as any, // approvers
            {} as any, // blocks
            {} as any, // relations
            {} as any, // counter
            transitions,
            undefined, // activityLog
            undefined, // attachments
            agents,
            undefined, // notifications
            undefined, // workUploads
            undefined, // works
            undefined, // missions
            undefined, // ideas
            undefined, // teams
            undefined, // goals
            agentRuns,
        );

    beforeEach(() => {
        taskRepo = { findByIdAndUser: jest.fn().mockResolvedValue(makeTask()) };
        assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
        transitions = {
            dispatchAgentRun: jest
                .fn()
                .mockResolvedValue({ runId: 'r1', dispatched: true, parked: false }),
        };
        agents = {
            findByIdAndUser: jest.fn(async (id: string) => ({ id, name: `Agent ${id}` })),
            findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
        };
        agentRuns = { findInFlightForTaskAgent: jest.fn().mockResolvedValue(null) };
    });

    it('dispatches through TaskTransitionService — never its own copy of the dispatch logic', async () => {
        const result = await build().runTask('u1', 't1', { agentId: 'agent-x' });
        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 't1' }),
            'agent-x',
            expect.objectContaining({ dedupKey: expect.stringContaining('t1:agent-x:manual:') }),
        );
        expect(result).toMatchObject({ taskId: 't1', agentId: 'agent-x', dispatched: true });
    });

    it('refuses with 409 RUN_ALREADY_IN_FLIGHT when that (task, agent) pair is already running', async () => {
        agentRuns.findInFlightForTaskAgent.mockResolvedValue({ id: 'run-live', status: 'running' });
        const error = await build()
            .runTask('u1', 't1', { agentId: 'agent-x' })
            .catch((e) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toMatchObject({
            code: RUN_ALREADY_IN_FLIGHT,
            runId: 'run-live',
        });
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('rejects an agentId the caller does not own, without leaking whether it exists', async () => {
        agents.findByIdAndUser.mockResolvedValue(null);
        const error = await build()
            .runTask('u1', 't1', { agentId: 'not-mine' })
            .catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse()).toMatchObject({ code: RUN_AGENT_NOT_FOUND });
    });

    it('falls back to the single Agent assignee when no agentId is given', async () => {
        assignees.findAgentAssignees.mockResolvedValue([{ assigneeId: 'agent-assigned' }]);
        const result = await build().runTask('u1', 't1');
        expect(result.agentId).toBe('agent-assigned');
    });

    it("falls back to the Work's default Agent when the Task itself has none", async () => {
        taskRepo.findByIdAndUser.mockResolvedValue(makeTask({ workId: 'w1' }));
        agents.findByUserIdScoped.mockResolvedValue({
            rows: [{ id: 'agent-work', name: 'Work agent' }],
            total: 1,
        });
        const result = await build().runTask('u1', 't1');
        expect(agents.findByUserIdScoped).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ workId: 'w1' }),
        );
        expect(result.agentId).toBe('agent-work');
    });

    it('answers RUN_AGENT_AMBIGUOUS with the candidate list when several Agents could run it', async () => {
        assignees.findAgentAssignees.mockResolvedValue([
            { assigneeId: 'agent-1' },
            { assigneeId: 'agent-2' },
        ]);
        const error = await build()
            .runTask('u1', 't1')
            .catch((e) => e);
        expect(error.getResponse()).toMatchObject({ code: RUN_AGENT_AMBIGUOUS });
        expect(error.getResponse().candidates).toHaveLength(2);
    });

    it('answers RUN_NO_AGENT with an empty candidate list when nothing can run it', async () => {
        const error = await build()
            .runTask('u1', 't1')
            .catch((e) => e);
        expect(error.getResponse()).toMatchObject({ code: RUN_NO_AGENT, candidates: [] });
    });

    it('reports a parked run as a success — the run exists, it is just waiting for capacity', async () => {
        transitions.dispatchAgentRun.mockResolvedValue({
            runId: 'r1',
            dispatched: false,
            parked: true,
            queuedReason: 'concurrency-limit',
        });
        const result = await build().runTask('u1', 't1', { agentId: 'agent-x' });
        expect(result).toMatchObject({ parked: true, queuedReason: 'concurrency-limit' });
    });
});

describe('TasksService.listRunCandidates', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const build = (taskRepo: any, assignees: any, agents: any) =>
        new TasksService(
            taskRepo,
            assignees,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            undefined,
            undefined,
            agents,
        );

    it('labels each candidate with WHY it is offered and dedupes across sources', async () => {
        const taskRepo = {
            findByIdAndUser: jest
                .fn()
                .mockResolvedValue(makeTask({ workId: 'w1', agentId: 'agent-1' })),
        };
        const assignees = {
            findAgentAssignees: jest.fn().mockResolvedValue([{ assigneeId: 'agent-1' }]),
        };
        const agents = {
            findByIdAndUser: jest.fn(async (id: string) => ({ id, name: `Agent ${id}` })),
            findByUserIdScoped: jest
                .fn()
                .mockResolvedValue({ rows: [{ id: 'agent-2', name: 'Work agent' }], total: 1 }),
        };
        const rows = await build(taskRepo, assignees, agents).listRunCandidates('u1', 't1');
        expect(rows).toEqual([
            expect.objectContaining({ id: 'agent-1', source: 'assignee' }),
            expect.objectContaining({ id: 'agent-2', source: 'work-default' }),
        ]);
    });

    it('drops an assignee row whose Agent no longer resolves for this owner', async () => {
        const taskRepo = { findByIdAndUser: jest.fn().mockResolvedValue(makeTask()) };
        const assignees = {
            findAgentAssignees: jest.fn().mockResolvedValue([{ assigneeId: 'ghost' }]),
        };
        const agents = {
            findByIdAndUser: jest.fn().mockResolvedValue(null),
            findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
        };
        await expect(
            build(taskRepo, assignees, agents).listRunCandidates('u1', 't1'),
        ).resolves.toEqual([]);
    });
});

describe('TasksService.runTasksBatch', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const build = () =>
        new TasksService(
            { findByIdAndUser: jest.fn().mockResolvedValue(makeTask()) } as any,
            { findAgentAssignees: jest.fn().mockResolvedValue([]) } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                dispatchAgentRun: jest
                    .fn()
                    .mockResolvedValue({ runId: 'r1', dispatched: true, parked: false }),
            } as any,
            undefined,
            undefined,
            {
                findByIdAndUser: jest.fn(async (id: string) => ({ id, name: id })),
                findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            } as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { findInFlightForTaskAgent: jest.fn().mockResolvedValue(null) } as any,
        );

    it('returns one result per item and never lets a failure abort the rest', async () => {
        const service = build();
        const { results } = await service.runTasksBatch('u1', [
            { taskId: 't1', agentId: 'agent-1' },
            { taskId: 't2' }, // no agent → per-item failure, not a thrown batch
            { taskId: 't3', agentId: 'agent-3' },
        ]);
        expect(results).toHaveLength(3);
        expect(results[0]).toMatchObject({ taskId: 't1', ok: true });
        expect(results[1]).toMatchObject({ taskId: 't2', ok: false });
        expect((results[1] as any).error.code).toBe(RUN_NO_AGENT);
        expect(results[2]).toMatchObject({ taskId: 't3', ok: true });
    });

    it('rejects an empty batch and one over the cap', async () => {
        const service = build();
        await expect(service.runTasksBatch('u1', [])).rejects.toBeInstanceOf(BadRequestException);
        const tooMany = Array.from({ length: RUN_BATCH_MAX_TASKS + 1 }, (_, i) => ({
            taskId: `t${i}`,
            agentId: 'a',
        }));
        await expect(service.runTasksBatch('u1', tooMany)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});
