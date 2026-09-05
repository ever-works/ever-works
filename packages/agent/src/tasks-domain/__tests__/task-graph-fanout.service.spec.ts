import { BadRequestException, ConflictException } from '@nestjs/common';
import { TaskGraphFanoutService } from '../task-graph-fanout.service';
import { TaskStatus, type Task } from '../../entities/task.entity';
import {
    QUEUED_REASON_CONCURRENCY,
    QUEUED_REASON_KILL_SWITCH,
} from '../../agents/run-admission-chain';

/**
 * Task-graph fan-out (self-build slice AH) — the bounded driver.
 *
 * The whole point of this suite is that the driver can never become a way
 * PAST a limit: every start goes through `transition(→ in_progress)` (and
 * therefore through the one dispatch path with its admission chain), the
 * global stop flag stops the tick outright, an owner's ceiling stops that
 * owner, and any refusal leaves the Task in `todo` so the next tick can
 * try again.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 't-1',
        slug: 'T-1',
        userId: 'u1',
        title: 'Implement',
        status: TaskStatus.TODO,
        workId: 'w1',
        organizationId: null,
        agentId: 'a1',
        ...overrides,
    } as Task;
}

describe('TaskGraphFanoutService', () => {
    const originalEnv = process.env;

    let tasks: { findFanoutCandidates: jest.Mock };
    let transitions: {
        listOpenBlockerIds: jest.Mock;
        resolveDispatchAgentIds: jest.Mock;
        transition: jest.Mock;
    };
    let dispatchGate: { admit: jest.Mock };
    let runs: { findInFlightForTaskAgent: jest.Mock; findLatestForTask?: jest.Mock };
    let killSwitch: { shouldHaltDispatch: jest.Mock };

    function build(): TaskGraphFanoutService {
        return new TaskGraphFanoutService(
            tasks as never,
            transitions as never,
            dispatchGate as never,
            runs as never,
            killSwitch as never,
        );
    }

    beforeEach(() => {
        process.env = { ...originalEnv, TASK_FANOUT_MAX_STARTS_PER_OWNER: '2' };
        tasks = { findFanoutCandidates: jest.fn().mockResolvedValue([]) };
        transitions = {
            listOpenBlockerIds: jest.fn().mockResolvedValue([]),
            resolveDispatchAgentIds: jest.fn().mockResolvedValue(['a1']),
            transition: jest.fn().mockResolvedValue(undefined),
        };
        dispatchGate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
        runs = { findInFlightForTaskAgent: jest.fn().mockResolvedValue(null) };
        killSwitch = { shouldHaltDispatch: jest.fn().mockResolvedValue(false) };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('the unblocked set', () => {
        it('starts exactly the Tasks with zero open blockers, through transition()', async () => {
            const free = makeTask({ id: 't-free', slug: 'T-1' });
            const blocked = makeTask({ id: 't-blocked', slug: 'T-2' });
            tasks.findFanoutCandidates.mockResolvedValue([free, blocked]);
            transitions.listOpenBlockerIds.mockImplementation(async (taskId: string) =>
                taskId === 't-blocked' ? ['blocker-1'] : [],
            );

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(1);
            expect(transitions.transition).toHaveBeenCalledTimes(1);
            expect(transitions.transition).toHaveBeenCalledWith(free, TaskStatus.IN_PROGRESS);
            expect(summary.entries).toEqual([
                { taskId: 't-free', taskSlug: 'T-1', outcome: 'started' },
                {
                    taskId: 't-blocked',
                    taskSlug: 'T-2',
                    outcome: 'skipped',
                    reason: 'blocked',
                    message: '1 open blocker(s)',
                },
            ]);
        });

        it('leaves a Task blocked by TWO blockers alone until both clear', async () => {
            const task = makeTask({ id: 't-2', slug: 'T-2' });
            tasks.findFanoutCandidates.mockResolvedValue([task]);
            // Both open, then one open, then none — three consecutive ticks.
            transitions.listOpenBlockerIds
                .mockResolvedValueOnce(['b1', 'b2'])
                .mockResolvedValueOnce(['b2'])
                .mockResolvedValueOnce([]);
            const svc = build();

            expect((await svc.dispatchUnblocked()).started).toBe(0);
            expect((await svc.dispatchUnblocked()).started).toBe(0);
            expect(transitions.transition).not.toHaveBeenCalled();

            expect((await svc.dispatchUnblocked()).started).toBe(1);
            expect(transitions.transition).toHaveBeenCalledTimes(1);
        });

        it('never auto-starts a Task with no resolvable agent', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask({ agentId: null })]);
            transitions.resolveDispatchAgentIds.mockResolvedValue([]);

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(0);
            expect(summary.entries[0]).toMatchObject({ outcome: 'skipped', reason: 'no-agent' });
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('skips a Task whose every agent already has a run in flight', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            runs.findInFlightForTaskAgent.mockResolvedValue({ id: 'run-1' });

            const summary = await build().dispatchUnblocked();

            expect(summary.entries[0]).toMatchObject({ outcome: 'skipped', reason: 'in-flight' });
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('starts when at least ONE of several agents is free', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            transitions.resolveDispatchAgentIds.mockResolvedValue(['busy', 'free']);
            runs.findInFlightForTaskAgent.mockImplementation(async (_t: string, agentId: string) =>
                agentId === 'busy' ? { id: 'run-1' } : null,
            );

            expect((await build().dispatchUnblocked()).started).toBe(1);
        });

        it('scans in the repository order and does not reshuffle between ticks', async () => {
            const order = [
                makeTask({ id: 'a', slug: 'T-1' }),
                makeTask({ id: 'b', slug: 'T-2' }),
                makeTask({ id: 'c', slug: 'T-3' }),
            ];
            tasks.findFanoutCandidates.mockResolvedValue(order);
            process.env.TASK_FANOUT_MAX_STARTS_PER_OWNER = '1';
            const svc = build();

            const first = await svc.dispatchUnblocked();
            const second = await svc.dispatchUnblocked();

            // Deterministic: the same bound spends itself on the same Task
            // both times, and the same two are reported over budget.
            expect(first.entries.map((entry) => [entry.taskSlug, entry.outcome])).toEqual([
                ['T-1', 'started'],
                ['T-2', 'skipped'],
                ['T-3', 'skipped'],
            ]);
            expect(second.entries).toEqual(first.entries);
        });
    });

    describe('work another driver already dispatched', () => {
        // Three shipped paths dispatch a run and LEAVE the Task in `todo`:
        // board Run (`TasksService.runTask`), the recurrence scan, and the
        // Goal loop. "Still todo" therefore does not mean "never started",
        // and their dedup keys differ from the generation key this driver's
        // dispatch would use — so a fan-out that re-started them would
        // silently run the same work twice and drive a serial Goal past its
        // own `maxConcurrentIterations` ceiling.
        it('never starts a Task that already has a run, even a finished one', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            runs.findLatestForTask = jest
                .fn()
                .mockResolvedValue({ id: 'run-done', status: 'completed' });

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(0);
            expect(summary.entries[0]).toMatchObject({
                outcome: 'skipped',
                reason: 'already-run',
            });
            expect(transitions.transition).not.toHaveBeenCalled();
            // Authoritative check, before the admission probe is spent.
            expect(dispatchGate.admit).not.toHaveBeenCalled();
        });

        it('starts a Task that has never been run', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            runs.findLatestForTask = jest.fn().mockResolvedValue(null);

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(1);
            expect(runs.findLatestForTask).toHaveBeenCalledWith('t-1');
        });

        it('falls back to the per-agent in-flight check when the run-history query is absent', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            runs.findInFlightForTaskAgent.mockResolvedValue({ id: 'run-1' });

            const summary = await build().dispatchUnblocked();

            expect(summary.entries[0]).toMatchObject({ outcome: 'skipped', reason: 'in-flight' });
        });
    });

    describe('bounds', () => {
        it('never exceeds the per-owner bound in one tick', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([
                makeTask({ id: 'a', slug: 'T-1' }),
                makeTask({ id: 'b', slug: 'T-2' }),
                makeTask({ id: 'c', slug: 'T-3' }),
                makeTask({ id: 'd', slug: 'T-4' }),
            ]);

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(2);
            expect(summary.maxStartsPerOwner).toBe(2);
            expect(summary.entries.filter((e) => e.reason === 'owner-bound')).toHaveLength(2);
        });

        it('bounds each owner separately', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([
                makeTask({ id: 'a', slug: 'T-1', userId: 'u1' }),
                makeTask({ id: 'b', slug: 'T-2', userId: 'u1' }),
                makeTask({ id: 'c', slug: 'T-3', userId: 'u1' }),
                makeTask({ id: 'd', slug: 'T-4', userId: 'u2' }),
            ]);

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(3);
            expect(summary.entries.map((entry) => entry.outcome)).toEqual([
                'started',
                'started',
                'skipped',
                'started',
            ]);
        });

        it('is OFF by default — no scan, no gate probe, no Task touched', async () => {
            delete process.env.TASK_FANOUT_MAX_STARTS_PER_OWNER;

            const summary = await build().dispatchUnblocked();

            expect(summary).toMatchObject({ disabled: true, started: 0, candidateCount: 0 });
            expect(tasks.findFanoutCandidates).not.toHaveBeenCalled();
            expect(dispatchGate.admit).not.toHaveBeenCalled();
            expect(killSwitch.shouldHaltDispatch).not.toHaveBeenCalled();
        });

        it('honours an explicit scan limit and the configured default', async () => {
            process.env.TASK_FANOUT_SCAN_LIMIT = '7';
            await build().dispatchUnblocked();
            expect(tasks.findFanoutCandidates).toHaveBeenCalledWith(7);

            await build().dispatchUnblocked(3);
            expect(tasks.findFanoutCandidates).toHaveBeenLastCalledWith(3);
        });
    });

    describe('the gates it must not walk past', () => {
        it('starts NOTHING while the global stop flag is set', async () => {
            killSwitch.shouldHaltDispatch.mockResolvedValue(true);
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);

            const summary = await build().dispatchUnblocked();

            expect(summary).toMatchObject({ halted: true, started: 0 });
            // Not even the scan runs: a stopped platform spends no query.
            expect(tasks.findFanoutCandidates).not.toHaveBeenCalled();
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('fails CLOSED when the stop flag cannot be read', async () => {
            killSwitch.shouldHaltDispatch.mockRejectedValue(new Error('redis down'));
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);

            const summary = await build().dispatchUnblocked();

            expect(summary).toMatchObject({ halted: true, started: 0 });
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('aborts the WHOLE tick when the stop flag comes on mid-tick', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([
                makeTask({ id: 'a', slug: 'T-1' }),
                makeTask({ id: 'b', slug: 'T-2', userId: 'u2' }),
                makeTask({ id: 'c', slug: 'T-3', userId: 'u3' }),
            ]);
            dispatchGate.admit
                .mockResolvedValueOnce({ admitted: true })
                .mockResolvedValue({ admitted: false, queuedReason: QUEUED_REASON_KILL_SWITCH });

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(1);
            expect(summary.halted).toBe(true);
            // The third candidate is never even considered.
            expect(summary.entries).toHaveLength(1);
            expect(transitions.transition).toHaveBeenCalledTimes(1);
        });

        it("stops an owner's fan-out when their ceiling is reached, and leaves the Tasks startable", async () => {
            const first = makeTask({ id: 'a', slug: 'T-1' });
            const second = makeTask({ id: 'b', slug: 'T-2' });
            tasks.findFanoutCandidates.mockResolvedValue([first, second]);
            dispatchGate.admit.mockResolvedValue({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });

            const refused = await build().dispatchUnblocked();

            expect(refused.started).toBe(0);
            expect(transitions.transition).not.toHaveBeenCalled();
            expect(refused.entries).toEqual([
                {
                    taskId: 'a',
                    taskSlug: 'T-1',
                    outcome: 'skipped',
                    reason: 'owner-refused',
                    message: QUEUED_REASON_CONCURRENCY,
                },
                { taskId: 'b', taskSlug: 'T-2', outcome: 'skipped', reason: 'owner-refused' },
            ]);
            // One probe for the owner, then the rest of their Tasks are
            // skipped without re-asking a valve that just said no.
            expect(dispatchGate.admit).toHaveBeenCalledTimes(1);

            // Nothing was consumed: the very next tick starts them.
            dispatchGate.admit.mockResolvedValue({ admitted: true });
            const retried = await build().dispatchUnblocked();
            expect(retried.started).toBe(2);
        });

        it('probes the gate WITHOUT reserving, before claiming the Task', async () => {
            const task = makeTask({ workId: 'w9', organizationId: 'org-1' });
            tasks.findFanoutCandidates.mockResolvedValue([task]);

            await build().dispatchUnblocked();

            expect(dispatchGate.admit).toHaveBeenCalledTimes(1);
            // Verdict-only: a second `reserve` argument would create a run
            // row this driver never dispatches.
            expect(dispatchGate.admit.mock.calls[0]).toHaveLength(1);
            expect(dispatchGate.admit).toHaveBeenCalledWith({
                userId: 'u1',
                workId: 'w9',
                organizationId: 'org-1',
            });
            // ...and the probe happens before the claim.
            expect(dispatchGate.admit.mock.invocationCallOrder[0]).toBeLessThan(
                transitions.transition.mock.invocationCallOrder[0],
            );
        });

        it('fails CLOSED when the admission probe itself throws', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            dispatchGate.admit.mockRejectedValue(new Error('count query exploded'));

            const summary = await build().dispatchUnblocked();

            expect(summary.started).toBe(0);
            expect(summary.entries[0]).toMatchObject({
                outcome: 'skipped',
                reason: 'owner-refused',
                message: 'admission-probe-failed',
            });
            expect(transitions.transition).not.toHaveBeenCalled();
        });
    });

    describe('overlapping ticks', () => {
        it('counts a lost CAS as skipped, never failed, and dispatches once', async () => {
            const task = makeTask();
            tasks.findFanoutCandidates.mockResolvedValue([task]);
            const svc = build();
            // The atomic claim lives in transition(); the loser of two
            // overlapping ticks gets its 400 back.
            transitions.transition
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(
                    new BadRequestException(
                        'Cannot transition Task from in_progress to in_progress.',
                    ),
                );

            const [first, second] = await Promise.all([
                svc.dispatchUnblocked(),
                svc.dispatchUnblocked(),
            ]);

            expect(first.started + second.started).toBe(1);
            expect(first.failed + second.failed).toBe(0);
            expect(first.skipped + second.skipped).toBe(1);
            const loser = [...first.entries, ...second.entries].find(
                (entry) => entry.outcome === 'skipped',
            );
            expect(loser).toMatchObject({ reason: 'claim-lost' });
        });

        it('counts a blocker that appeared inside the claim as skipped', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            transitions.transition.mockRejectedValue(
                new ConflictException(
                    'Task cannot transition to in_progress — has 1 open blocker(s).',
                ),
            );

            const summary = await build().dispatchUnblocked();

            expect(summary).toMatchObject({ started: 0, skipped: 1, failed: 0 });
            expect(summary.entries[0]).toMatchObject({ reason: 'claim-lost' });
        });

        it('records an unexpected error as failed and keeps going', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([
                makeTask({ id: 'a', slug: 'T-1' }),
                makeTask({ id: 'b', slug: 'T-2' }),
            ]);
            transitions.transition
                .mockRejectedValueOnce(new Error('database on fire'))
                .mockResolvedValueOnce(undefined);

            const summary = await build().dispatchUnblocked();

            expect(summary).toMatchObject({ failed: 1, started: 1 });
            expect(summary.entries[0]).toMatchObject({
                outcome: 'failed',
                message: 'database on fire',
            });
        });
    });

    describe('degradation', () => {
        it('refuses rather than inventing a dispatch path when transitions are unbound', async () => {
            const svc = new TaskGraphFanoutService(tasks as never);

            const summary = await svc.dispatchUnblocked();

            expect(summary.started).toBe(0);
            expect(tasks.findFanoutCandidates).not.toHaveBeenCalled();
        });

        it('runs ungated when neither the gate nor the stop flag is bound', async () => {
            tasks.findFanoutCandidates.mockResolvedValue([makeTask()]);
            const svc = new TaskGraphFanoutService(tasks as never, transitions as never);

            const summary = await svc.dispatchUnblocked();

            // No fleet stack and no gate is an install without those valves,
            // not a refusal — exactly what dispatchAgentRun does.
            expect(summary).toMatchObject({ started: 1, halted: false });
        });
    });
});
