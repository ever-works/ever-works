import { TaskStatus } from '../../entities/task.entity';
import { TaskTransitionService } from '../../tasks-domain/task-transition.service';
import { TaskRunDenormService } from '../../tasks-domain/task-run-denorm.service';
import type { TaskRepository } from '../../database/repositories/task.repository';
import {
    APP_WORK_RUN_PARK_REASONS,
    APP_WORK_RUN_STOP_RAILS,
    classifyAppWorkRunStop,
} from '../app-work-run-holds';
import {
    APP_WORK_RUN_REFUSALS_SCAN,
    APP_WORK_RUN_REFUSALS_WINDOW_MARGIN_MS,
    AppWorkRunHoldsService,
} from '../app-work-run-holds.service';

/**
 * APW-08 T46 (Resolution R-17, FR-66, FR-67; ACC-08-31) — safety-rail holds on App Work runs.
 *
 * A stop or pause is a person's hold (`wait`): nothing moves. Any other refusal is `needs_input`:
 * the Task is BLOCKED with ONE `guardrail-refusal` escalation carrying the rail and the category
 * only. The record is the safety gate's own `rail_refusals` row (never the model's word), read when
 * the run ends through `TaskRunDenormService.recordTerminal` — the write the cloud worker (over its
 * RPC proxy) and the Fleet reconciler both make — so both paths are covered by that one hook.
 */
describe('APW-08 T46 — classifyAppWorkRunStop', () => {
    it.each(['ladder', 'taxonomy', 'rules', 'grants', 'caps'])(
        'a %s refusal is needs_input, carrying the rail and the category',
        (railId) => {
            expect(
                classifyAppWorkRunStop({
                    refusals: [{ railId, category: 'publish.external', verdict: 'refused' }],
                }),
            ).toEqual({ kind: 'needs_input', railId, category: 'publish.external' });
        },
    );

    it('a held verdict is needs_input too', () => {
        expect(
            classifyAppWorkRunStop({ refusals: [{ railId: 'ladder', verdict: 'held' }] }),
        ).toEqual({ kind: 'needs_input', railId: 'ladder', category: null });
    });

    it.each(APP_WORK_RUN_STOP_RAILS)('a %s stop is a wait — a person holds it', (railId) => {
        expect(classifyAppWorkRunStop({ refusals: [{ railId, verdict: 'refused' }] })).toEqual({
            kind: 'wait',
            cause: 'stop-rail',
            detail: railId,
        });
    });

    it.each(APP_WORK_RUN_PARK_REASONS)('a run parked %s is a wait', (queuedReason) => {
        expect(classifyAppWorkRunStop({ queuedReason })).toEqual({
            kind: 'wait',
            cause: 'parked',
            detail: queuedReason,
        });
    });

    it('a wait wins over a refusal in the same run; the FIRST refusal is the one asked about', () => {
        expect(
            classifyAppWorkRunStop({
                refusals: [
                    { railId: 'ladder', verdict: 'refused' },
                    { railId: 'platform-stop', verdict: 'refused' },
                ],
            }),
        ).toMatchObject({ kind: 'wait' });
        expect(
            classifyAppWorkRunStop({
                refusals: [
                    { railId: 'grants', category: 'messaging.send', verdict: 'refused' },
                    { railId: 'ladder', category: 'publish.external', verdict: 'held' },
                ],
            }),
        ).toEqual({ kind: 'needs_input', railId: 'grants', category: 'messaging.send' });
    });

    it('nothing held or refused (or an unknown verdict, or another park reason) is null', () => {
        expect(classifyAppWorkRunStop({})).toBeNull();
        expect(classifyAppWorkRunStop({ refusals: [] })).toBeNull();
        expect(
            classifyAppWorkRunStop({ refusals: [{ railId: 'ladder', verdict: 'allowed' }] }),
        ).toBeNull();
        expect(classifyAppWorkRunStop({ queuedReason: 'concurrency' })).toBeNull();
    });
});

describe('APW-08 T46 — AppWorkRunHoldsService (needs_input → BLOCKED + one escalation)', () => {
    const TASK = 't1';
    const RUN = 'r1';
    let task: Record<string, unknown>;
    let workKind: string;
    let refusalRows: Array<Record<string, unknown>>;
    let tasks: { findById: jest.Mock };
    let works: { findById: jest.Mock };
    let runs: { findById: jest.Mock };
    let refusals: { find: jest.Mock };
    let escalations: { record: jest.Mock };
    let transitions: { transition: jest.Mock };

    function build() {
        const moduleRef = {
            get: jest.fn((token: unknown) => {
                if (token === TaskTransitionService) return transitions;
                throw new Error('not in graph');
            }),
        };
        return new AppWorkRunHoldsService(
            tasks as never,
            works as never,
            moduleRef as never,
            runs as never,
            refusals as never,
            escalations as never,
        );
    }

    beforeEach(() => {
        task = {
            id: TASK,
            userId: 'user-1',
            workId: 'work-app',
            agentId: 'agent-1',
            status: TaskStatus.IN_PROGRESS,
            tenantId: null,
            organizationId: null,
        };
        workKind = 'app';
        refusalRows = [{ railId: 'ladder', category: 'publish.external', verdict: 'refused' }];
        tasks = { findById: jest.fn(async () => task) };
        works = {
            findById: jest.fn(async (id: string) => ({ id, kind: workKind, name: 'Bookings' })),
        };
        runs = {
            findById: jest.fn(async () => ({
                id: RUN,
                createdAt: new Date('2026-10-31T10:00:00Z'),
                // Re-stamped when the run was claimed again: never the window's start.
                startedAt: new Date('2026-10-31T10:30:00Z'),
            })),
        };
        // The stop-rail query (`railId: In(...)`) answers the stop rows; the plain one, all rows.
        refusals = {
            find: jest.fn(async (opts: { where: { railId?: unknown } }) =>
                opts.where.railId
                    ? refusalRows.filter((row) =>
                          APP_WORK_RUN_STOP_RAILS.includes(row.railId as string),
                      )
                    : refusalRows.slice(0, APP_WORK_RUN_REFUSALS_SCAN),
            ),
        };
        escalations = { record: jest.fn(async () => ({ id: 'esc-1' })) };
        transitions = { transition: jest.fn(async () => task) };
    });

    it('a ladder refusal blocks the Task and files ONE guardrail-refusal escalation — rail and category only (ACC-08-31)', async () => {
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });

        expect(transitions.transition).toHaveBeenCalledWith(task, TaskStatus.BLOCKED, {
            actorType: 'agent',
        });
        expect(escalations.record).toHaveBeenCalledTimes(1);
        const filed = escalations.record.mock.calls[0][0];
        expect(filed).toMatchObject({
            reasonCode: 'guardrail-refusal',
            taskId: TASK,
            workId: 'work-app',
            dedupKey: `app-guardrail-refusal:${RUN}`,
        });
        expect(filed.summary).toContain('ladder');
        expect(filed.summary).toContain('publish.external');
        // The run's own verdicts, in its own window, oldest first.
        expect(refusals.find).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: 'user-1', runId: RUN }),
                order: { createdAt: 'ASC' },
            }),
        );
    });

    it('a stop or pause (wait) moves nothing and files nothing — no gate attempt, no follow-up', async () => {
        refusalRows = [{ railId: 'platform-stop', category: null, verdict: 'refused' }];
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'failed' });
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('a run nothing refused, and any non-App Work, are left exactly as they were', async () => {
        refusalRows = [];
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        workKind = 'directory';
        refusalRows = [{ railId: 'ladder', verdict: 'refused' }];
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
        // A non-App Work is never asked for its verdicts (the App run: stop rails, then all).
        expect(refusals.find).toHaveBeenCalledTimes(2);
    });

    it('a Task already blocked is not moved, and the refusal is still escalated', async () => {
        task.status = TaskStatus.BLOCKED;
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).toHaveBeenCalledTimes(1);
    });

    // Review of #3050 — the escalation says "so the Task is blocked": never filed when it is not.
    it('a Task already finished (or moved back) is not moved, and nothing is escalated', async () => {
        for (const status of [TaskStatus.DONE, TaskStatus.CANCELLED, TaskStatus.TODO]) {
            task.status = status;
            await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        }
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('a lost compare-and-set: escalated only if the winner left the Task BLOCKED', async () => {
        transitions.transition.mockRejectedValue(new Error('cas lost'));
        tasks.findById
            .mockResolvedValueOnce(task) // the run's Task
            .mockResolvedValueOnce({ ...task, status: TaskStatus.IN_REVIEW }); // after the race
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        expect(escalations.record).not.toHaveBeenCalled();

        tasks.findById
            .mockResolvedValueOnce(task)
            .mockResolvedValueOnce({ ...task, status: TaskStatus.BLOCKED }); // e.g. gate-exhausted
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        expect(escalations.record).toHaveBeenCalledTimes(1);
    });

    it('no transition service bound: nothing is blocked, so nothing is escalated', async () => {
        transitions = undefined as never;
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('a stop rail past the first page of verdicts still makes the run a wait (review of #3050)', async () => {
        refusalRows = [
            ...Array.from({ length: APP_WORK_RUN_REFUSALS_SCAN }, () => ({
                railId: 'ladder',
                category: 'publish.external',
                verdict: 'refused',
            })),
            { railId: 'workspace-pause', category: null, verdict: 'refused' },
        ];
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'failed' });
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('the window opens a margin before the run ROW was created, not at a re-stamped start', async () => {
        await build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' });
        const where = refusals.find.mock.calls[0][0].where as { createdAt: { value: Date } };
        expect(where.createdAt.value.toISOString()).toBe(
            new Date(
                Date.parse('2026-10-31T10:00:00Z') - APP_WORK_RUN_REFUSALS_WINDOW_MARGIN_MS,
            ).toISOString(),
        );
    });

    it('never throws: an unreadable Task, a failing transition or escalation are logged, nothing escapes', async () => {
        tasks.findById.mockRejectedValueOnce(new Error('db down'));
        await expect(
            build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' }),
        ).resolves.toBeUndefined();
        transitions.transition.mockRejectedValueOnce(new Error('cas lost'));
        escalations.record.mockRejectedValueOnce(new Error('inbox down'));
        await expect(
            build().onRunTerminal({ taskId: TASK, runId: RUN, status: 'completed' }),
        ).resolves.toBeUndefined();
    });
});

describe('APW-08 T46 — end to end through TaskRunDenormService.recordTerminal (both run paths)', () => {
    it('the run that ends (cloud worker or Fleet reconciler — both write here) blocks its App Work Task', async () => {
        const row: Record<string, unknown> = {
            id: 't1',
            userId: 'user-1',
            workId: 'work-app',
            agentId: 'agent-1',
            status: TaskStatus.IN_PROGRESS,
            latestRunId: 'r1',
            latestRunStatus: 'running',
        };
        const taskRepo = {
            findById: jest.fn(async () => row),
            updateLatestRun: jest.fn(async () => true),
        };
        const transitions = {
            transition: jest.fn(async (task: Record<string, unknown>, status: TaskStatus) => {
                task.status = status;
                return task;
            }),
        };
        const escalations = { record: jest.fn(async () => ({ id: 'esc-1' })) };
        const holds = new AppWorkRunHoldsService(
            taskRepo as never,
            {
                findById: jest.fn(async () => ({ id: 'work-app', kind: 'app', name: 'Bookings' })),
            } as never,
            { get: jest.fn(() => transitions) } as never,
            { findById: jest.fn(async () => ({ id: 'r1', startedAt: new Date() })) } as never,
            {
                find: jest.fn(async () => [
                    { railId: 'ladder', category: 'publish.external', verdict: 'refused' },
                ]),
            } as never,
            escalations as never,
        );
        const onRunTerminal = jest.spyOn(holds, 'onRunTerminal');
        const denorm = new TaskRunDenormService(
            taskRepo as unknown as TaskRepository,
            undefined,
            undefined,
            holds,
        );

        await expect(denorm.recordTerminal('t1', 'r1', 'completed')).resolves.toBe(true);
        await onRunTerminal.mock.results[0].value;

        expect(onRunTerminal).toHaveBeenCalledWith({
            taskId: 't1',
            runId: 'r1',
            status: 'completed',
        });
        expect(row.status).toBe(TaskStatus.BLOCKED);
        expect(escalations.record).toHaveBeenCalledTimes(1);
    });

    it('a stale run that lost the pointer to a newer run does not touch the Task', async () => {
        const handler = { onRunTerminal: jest.fn(async () => undefined) };
        const denorm = new TaskRunDenormService(
            { updateLatestRun: jest.fn(async () => false) } as unknown as TaskRepository,
            undefined,
            undefined,
            handler,
        );
        await expect(denorm.recordTerminal('t1', 'r-old', 'completed')).resolves.toBe(false);
        expect(handler.onRunTerminal).not.toHaveBeenCalled();
    });

    it('without the handler the terminal write is exactly what it was', async () => {
        const repo = { updateLatestRun: jest.fn(async () => true) };
        await expect(
            new TaskRunDenormService(repo as unknown as TaskRepository).recordTerminal(
                't1',
                'r1',
                'failed',
            ),
        ).resolves.toBe(true);
        expect(repo.updateLatestRun).toHaveBeenCalledTimes(1);
    });
});
