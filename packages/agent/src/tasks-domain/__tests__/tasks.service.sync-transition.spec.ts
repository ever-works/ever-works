import { ConflictException, NotFoundException } from '@nestjs/common';
import { TasksService } from '../tasks.service';
import { TaskStatus } from '../../entities/task.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

/**
 * EW-P1-6 — `TasksService.syncTransition`: ownership first (same 404 as every
 * Task read), then the gated walk, then ONE `task_transitioned` activity row
 * per hop so the history shows every status the Task passed through.
 */
describe('TasksService.syncTransition', () => {
    const task = { id: 't1', userId: 'u1', status: TaskStatus.BACKLOG, workId: null };

    function build(found: unknown = task) {
        const tasks = { findByIdAndUser: jest.fn().mockResolvedValue(found) };
        // Behaves like the real walk: reports each hop through `onHop` as it lands.
        const transitions = {
            transitionSync: jest.fn(
                async (
                    _task: unknown,
                    _to: TaskStatus,
                    _opts: unknown,
                    onHop?: (hop: { from: TaskStatus; to: TaskStatus }) => Promise<void>,
                ) => {
                    await onHop?.({ from: TaskStatus.BACKLOG, to: TaskStatus.TODO });
                    await onHop?.({ from: TaskStatus.TODO, to: TaskStatus.IN_PROGRESS });
                    return {
                        task: { ...task, status: TaskStatus.IN_PROGRESS },
                        from: TaskStatus.BACKLOG,
                        path: [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
                    };
                },
            ),
        };
        const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
        const service = new TasksService(
            tasks as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            transitions as never,
            activityLog as never,
        );
        return { service, tasks, transitions, activityLog };
    }

    it('walks through TaskTransitionService and logs one row per hop', async () => {
        const { service, transitions, activityLog } = build();
        const result = await service.syncTransition('u1', 't1', TaskStatus.IN_PROGRESS);

        expect(transitions.transitionSync).toHaveBeenCalledWith(
            task,
            TaskStatus.IN_PROGRESS,
            {},
            expect.any(Function),
        );
        expect(result.path).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS]);
        expect(
            activityLog.log.mock.calls.map((call) => [call[0].actionType, call[0].details]),
        ).toEqual([
            [
                ActivityActionType.TASK_TRANSITIONED,
                expect.objectContaining({ from: 'backlog', to: 'todo', mode: 'sync' }),
            ],
            [
                ActivityActionType.TASK_TRANSITIONED,
                expect.objectContaining({ from: 'todo', to: 'in_progress', mode: 'sync' }),
            ],
        ]);
    });

    it('keeps the history of the hops taken when the walk is refused mid-way', async () => {
        const { service, transitions, activityLog } = build();
        transitions.transitionSync.mockImplementationOnce(
            async (_task: unknown, _to: TaskStatus, _opts: unknown, onHop?: any) => {
                await onHop?.({ from: TaskStatus.BACKLOG, to: TaskStatus.TODO });
                throw new ConflictException('gate closed');
            },
        );
        await expect(
            service.syncTransition('u1', 't1', TaskStatus.IN_PROGRESS),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(activityLog.log).toHaveBeenCalledTimes(1);
        expect(activityLog.log.mock.calls[0][0].details).toMatchObject({
            from: 'backlog',
            to: 'todo',
            mode: 'sync',
        });
    });

    it('404s a Task the caller cannot see, before any walk', async () => {
        const { service, transitions } = build(null);
        await expect(service.syncTransition('u1', 't1', TaskStatus.DONE)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(transitions.transitionSync).not.toHaveBeenCalled();
    });
});
