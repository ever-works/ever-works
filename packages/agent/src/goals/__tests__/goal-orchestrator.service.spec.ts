import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Goal } from '../../entities/goal.entity';
import type { GoalEvent } from '../../entities/goal-event.entity';
import type { AgentRun } from '../../entities/agent-run.entity';
import { Task } from '../../entities/task.entity';
import { GoalOrchestratorService } from '../goal-orchestrator.service';

/**
 * Autonomy layer — orchestrator service (the I/O half).
 *
 * The DECISIONS are unit-tested in `goal-orchestrator-rules.spec.ts`;
 * what this suite proves is the wiring around them: an iteration really
 * becomes a Task handed to `dispatchAgentRun`, spend really comes from
 * the linked runs' `costCents`, a nudge really reaches `RunSteeringService`,
 * and every one of those writes an orchestrator-log row.
 *
 * Hand-rolled in-memory repository mocks, mirroring the
 * `goals.service.spec.ts` idiom, extended to understand TypeORM's `In()`
 * operator (the run lookup needs it).
 */

interface AnyRow {
    id: string;
    [key: string]: unknown;
}

function matchesValue(actual: unknown, expected: unknown): boolean {
    // Minimal FindOperator support: `In([...])` and `IsNull()` are the
    // only ones these paths use.
    if (expected && typeof expected === 'object' && '_type' in (expected as object)) {
        const op = expected as { _type: string; _value: unknown };
        if (op._type === 'in') return (op._value as unknown[]).includes(actual);
        if (op._type === 'isNull') return actual === null || actual === undefined;
    }
    return actual === expected;
}

function makeRepo(prefix: string) {
    const rows: AnyRow[] = [];
    let counter = 0;
    const matches = (row: AnyRow, where: Record<string, unknown> = {}) =>
        Object.entries(where).every(([k, v]) => matchesValue(row[k], v));
    return {
        find: jest.fn(async (opts: any = {}) => {
            let result = rows.filter((r) => matches(r, opts.where));
            if (opts.order) {
                const [key, dir] = Object.entries(opts.order)[0] as [string, string];
                result = [...result].sort((a, b) => {
                    const av = a[key] as never;
                    const bv = b[key] as never;
                    const cmp = av > bv ? 1 : av < bv ? -1 : 0;
                    return dir === 'DESC' ? -cmp : cmp;
                });
            }
            if (opts.take !== undefined) result = result.slice(0, opts.take);
            return result;
        }),
        findOne: jest.fn(async (opts: any) => rows.find((r) => matches(r, opts.where)) ?? null),
        save: jest.fn(async (entity: any) => {
            const idx = rows.findIndex((r) => r.id === entity.id);
            if (idx >= 0) {
                rows[idx] = { ...rows[idx], ...entity };
                return rows[idx];
            }
            const row = { ...entity };
            if (!row.id) row.id = `${prefix}${++counter}`;
            rows.push(row);
            return row;
        }),
        insert: jest.fn(async (partial: any) => {
            rows.push({ id: `${prefix}${++counter}`, createdAt: new Date(), ...partial });
            return { identifiers: [] };
        }),
        _rows: rows,
    };
}

function goalRow(overrides: Partial<Goal> = {}): AnyRow {
    return {
        id: 'g1',
        userId: 'u1',
        title: 'Reach 1k signups',
        description: null,
        metricSource: { pluginId: 'stripe', metricId: 'signups' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'signups',
        window: 'total',
        status: 'active',
        outcome: null,
        dodCriteria: null,
        spendCapCents: null,
        spentCents: 0,
        wallClockLimitHours: null,
        stuckThresholdIterations: null,
        sessionBudgetMinutes: null,
        gracePeriodMinutes: null,
        executionTarget: null,
        plannerModelHint: null,
        workerModelHint: null,
        iteration: 0,
        lastProgressIteration: 0,
        activeAgentId: null,
        assignedAgentId: null,
        loopStatus: null,
        loopStartedAt: null,
        archivedAt: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        ...overrides,
    } as AnyRow;
}

function build(overrides: { goal?: Partial<Goal> } = {}) {
    const goals = makeRepo('g');
    const events = makeRepo('e');
    const tasks = makeRepo('t');
    const runs = makeRepo('r');

    goals._rows.push(goalRow(overrides.goal));

    const agents = {
        findByIdAndUser: jest.fn(async (id: string) => ({ id, name: `Agent ${id}`, slug: id })),
    };
    const tasksService = {
        create: jest.fn(async (userId: string, input: any) => {
            const task = {
                id: `task-${tasks._rows.length + 1}`,
                slug: `T-${tasks._rows.length + 1}`,
                userId,
                createdAt: new Date(Date.now() + tasks._rows.length),
                ...input,
            };
            tasks._rows.push(task);
            return task;
        }),
    };
    const transitions = {
        dispatchAgentRun: jest.fn(async () => ({
            runId: 'run-1',
            dispatched: true,
            parked: false,
        })),
    };
    const steering = {
        steer: jest.fn(async () => ({ dispatched: 'injected', runId: 'run-live', queuedCount: 1 })),
    };
    // The real `AgentRunRepository.cancel` flips the row to `cancelled` in
    // the database, and `restartSession` relies on the very next read
    // seeing that. A mock that only recorded the call would make the
    // restart path look broken (or, worse, hide a real regression), so it
    // mutates the store the way the repository does.
    const agentRuns = {
        cancel: jest.fn(async (runId: string) => {
            const row = runs._rows.find((r) => r.id === runId);
            if (!row) return { found: false };
            row.status = 'cancelled';
            return { found: true, previousStatus: 'running' };
        }),
    };
    const activityLog = { log: jest.fn(async () => undefined) };
    const notifications = { create: jest.fn(async () => undefined) };

    const service = new GoalOrchestratorService(
        goals as unknown as Repository<Goal>,
        events as unknown as Repository<GoalEvent>,
        tasks as unknown as Repository<Task>,
        runs as unknown as Repository<AgentRun>,
        agents as never,
        tasksService as never,
        transitions as never,
        steering as never,
        agentRuns as never,
        activityLog as never,
        notifications as never,
    );

    return {
        service,
        goals,
        events,
        tasks,
        runs,
        agents,
        tasksService,
        transitions,
        steering,
        agentRuns,
        activityLog,
        notifications,
    };
}

const eventKinds = (events: ReturnType<typeof makeRepo>) => events._rows.map((r) => r.kind);
const eventMessages = (events: ReturnType<typeof makeRepo>) =>
    events._rows.map((r) => String(r.message));

describe('GoalOrchestratorService — ownership', () => {
    it('404s a Goal owned by someone else, with no existence leak', async () => {
        const { service } = build();
        await expect(service.advance('someone-else', 'g1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});

describe('GoalOrchestratorService — limits', () => {
    it('persists every limit field and logs the change', async () => {
        const { service, goals, events } = build();
        const dto = await service.updateLimits('u1', 'g1', {
            spendCapCents: 5000,
            wallClockLimitHours: 12,
            stuckThresholdIterations: 3,
            sessionBudgetMinutes: 45,
            gracePeriodMinutes: 10,
            executionTarget: 'local-runner',
            plannerModelHint: '  big-planner  ',
            workerModelHint: 'small-worker',
            assignedAgentId: 'agent-9',
        });

        expect(dto).toMatchObject({
            spendCapCents: 5000,
            wallClockLimitHours: 12,
            stuckThresholdIterations: 3,
            sessionBudgetMinutes: 45,
            gracePeriodMinutes: 10,
            executionTarget: 'local-runner',
            plannerModelHint: 'big-planner',
            workerModelHint: 'small-worker',
            assignedAgentId: 'agent-9',
        });
        expect(goals._rows[0].spendCapCents).toBe(5000);
        expect(eventKinds(events)).toEqual(['control']);
        expect(eventMessages(events)[0]).toContain('spendCapCents');
    });

    it('clears a ceiling with null and leaves omitted fields alone', async () => {
        const { service } = build({ goal: { spendCapCents: 5000, wallClockLimitHours: 12 } });
        const dto = await service.updateLimits('u1', 'g1', { spendCapCents: null });
        expect(dto.spendCapCents).toBeNull();
        expect(dto.wallClockLimitHours).toBe(12);
    });

    it('rejects a non-integer or out-of-range ceiling', async () => {
        const { service } = build();
        await expect(
            service.updateLimits('u1', 'g1', { spendCapCents: 1.5 }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.updateLimits('u1', 'g1', { wallClockLimitHours: 0 }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown execution target', async () => {
        const { service } = build();
        await expect(
            service.updateLimits('u1', 'g1', {
                executionTarget: 'mainframe' as never,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to pin an agent the user does not own', async () => {
        const { service, agents } = build();
        agents.findByIdAndUser.mockResolvedValueOnce(null as never);
        await expect(
            service.updateLimits('u1', 'g1', { assignedAgentId: 'foreign' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('GoalOrchestratorService — Definition of Done', () => {
    it('sets the checklist and records the rollup', async () => {
        const { service, events } = build();
        const dto = await service.setDodCriteria('u1', 'g1', [
            { id: 'a', text: 'Ship pricing', status: 'open' },
            { id: 'b', text: 'Write docs', status: 'done' },
        ]);
        expect(dto.dodSummary).toMatchObject({ total: 2, done: 1, open: 1, complete: false });
        expect(eventKinds(events)).toEqual(['dod']);
        expect(eventMessages(events)[0]).toContain('1 done');
    });

    it('rejects a malformed checklist', async () => {
        const { service } = build();
        await expect(
            service.setDodCriteria('u1', 'g1', [{ id: 'a', text: '', status: 'open' }] as never),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('waives a criterion with a note and carries the note into the log', async () => {
        const { service, events } = build({
            goal: { dodCriteria: [{ id: 'a', text: 'Ship pricing', status: 'open' }] },
        });
        const dto = await service.patchDodCriterion('u1', 'g1', 'a', {
            status: 'waived',
            note: 'superseded by the new plan',
        });
        expect(dto.dodSummary).toMatchObject({ waived: 1, open: 0, complete: true });
        expect(eventMessages(events).at(-1)).toContain('superseded by the new plan');
    });

    it('404s an unknown criterion id', async () => {
        const { service } = build({
            goal: { dodCriteria: [{ id: 'a', text: 'x', status: 'open' }] },
        });
        await expect(
            service.patchDodCriterion('u1', 'g1', 'nope', { status: 'done' }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stamps lastProgressIteration only when the rollup actually moves', async () => {
        const { service, goals } = build({
            goal: {
                iteration: 5,
                lastProgressIteration: 2,
                dodCriteria: [{ id: 'a', text: 'x', status: 'open' }],
            },
        });

        // Editing evidence is not progress.
        await service.patchDodCriterion('u1', 'g1', 'a', { evidence: 'https://example.test' });
        expect(goals._rows[0].lastProgressIteration).toBe(2);

        // Closing the criterion is.
        await service.patchDodCriterion('u1', 'g1', 'a', { status: 'done' });
        expect(goals._rows[0].lastProgressIteration).toBe(5);
    });

    it('keeps planner proposals out of the rollup until approved', async () => {
        const { service, notifications, goals } = build({
            goal: { dodCriteria: [{ id: 'a', text: 'Ship pricing', status: 'done' }] },
        });

        const proposed = await service.proposeDodCriteria('u1', 'g1', [
            { id: 'p1', text: 'Also add a FAQ', status: 'open' },
        ]);
        // The Goal was complete before the proposal and must STAY complete:
        // a planning run cannot move its own finish line.
        expect(proposed.dodSummary).toMatchObject({ total: 1, proposed: 1, complete: true });
        expect(notifications.create).toHaveBeenCalledTimes(1);

        const approved = await service.approveDodCriteria('u1', 'g1');
        expect(approved.dodSummary).toMatchObject({ total: 2, proposed: 0, complete: false });
        expect(
            (goals._rows[0].dodCriteria as Array<{ proposed?: boolean }>).every(
                (c) => c.proposed !== true,
            ),
        ).toBe(true);
    });

    it('refuses to approve when nothing is proposed', async () => {
        const { service } = build({
            goal: { dodCriteria: [{ id: 'a', text: 'x', status: 'open' }] },
        });
        await expect(service.approveDodCriteria('u1', 'g1')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});

describe('GoalOrchestratorService — spend rollup', () => {
    it('sums costCents across every run linked to the Goal', async () => {
        const { service, tasks, runs } = build();
        tasks._rows.push(
            {
                id: 'task-1',
                goalId: 'g1',
                slug: 'T-1',
                title: 'a',
                status: 'todo',
                createdAt: new Date(1),
            },
            {
                id: 'task-2',
                goalId: 'g1',
                slug: 'T-2',
                title: 'b',
                status: 'done',
                createdAt: new Date(2),
            },
            {
                id: 'task-3',
                goalId: 'other',
                slug: 'T-3',
                title: 'c',
                status: 'done',
                createdAt: new Date(3),
            },
        );
        runs._rows.push(
            {
                id: 'r1',
                taskId: 'task-1',
                status: 'completed',
                costCents: 250,
                startedAt: new Date(1),
            },
            {
                id: 'r2',
                taskId: 'task-2',
                status: 'completed',
                costCents: 175,
                startedAt: new Date(2),
            },
            // Another Goal's run must not be counted.
            {
                id: 'r3',
                taskId: 'task-3',
                status: 'completed',
                costCents: 9999,
                startedAt: new Date(3),
            },
        );

        const dto = await service.rollupSpend('u1', 'g1');
        expect(dto.spentCents).toBe(425);
    });

    it('treats a null cost as zero rather than NaN', async () => {
        const { service, tasks, runs } = build();
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'todo',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'r1',
            taskId: 'task-1',
            status: 'running',
            costCents: null,
            startedAt: new Date(1),
        });
        const dto = await service.rollupSpend('u1', 'g1');
        expect(dto.spentCents).toBe(0);
    });
});

describe('GoalOrchestratorService — advance', () => {
    it('creates an iteration Task, dispatches it, and logs route + dispatch', async () => {
        const { service, tasksService, transitions, events, goals } = build({
            goal: {
                loopStatus: 'running',
                assignedAgentId: 'agent-7',
                dodCriteria: [{ id: 'a', text: 'Ship pricing', status: 'open' }],
                sessionBudgetMinutes: 30,
            },
        });

        const result = await service.advance('u1', 'g1');

        expect(result.action).toBe('dispatch');
        expect(result.agentId).toBe('agent-7');
        expect(result.iteration).toBe(1);

        expect(tasksService.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                title: '[Goal] Reach 1k signups — iteration 1',
                goalId: 'g1',
                agentId: 'agent-7',
                labels: ['goal-iteration'],
            }),
        );
        // The brief handed to the agent is built from persisted state, so
        // the open criterion and the session budget must both be in it.
        const brief = String(tasksService.create.mock.calls[0][1].description);
        expect(brief).toContain('Ship pricing');
        expect(brief).toContain('30 minutes');

        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-1' }),
            'agent-7',
            { dedupKey: 'goal:g1:1' },
        );

        expect(eventKinds(events)).toEqual(['route', 'dispatch']);
        expect(eventMessages(events)[0]).toContain('pins this agent');
        expect(eventMessages(events)[1]).toContain('Dispatched iteration 1');

        expect(goals._rows[0].iteration).toBe(1);
        expect(goals._rows[0].activeAgentId).toBe('agent-7');
    });

    it('round-robins over the agents that have already worked the Goal', async () => {
        const { service, tasks, transitions } = build({
            goal: { loopStatus: 'running', iteration: 1 },
        });
        tasks._rows.push(
            {
                id: 'task-1',
                goalId: 'g1',
                agentId: 'agent-a',
                slug: 'T-1',
                title: '[Goal] x — iteration 1',
                status: 'done',
                createdAt: new Date(1),
            },
            {
                id: 'task-2',
                goalId: 'g1',
                agentId: 'agent-b',
                slug: 'T-2',
                title: '[Goal] x — iteration 2',
                status: 'done',
                createdAt: new Date(2),
            },
        );

        const result = await service.advance('u1', 'g1');
        // nextIteration = 2, candidates = [a, b] → 2 % 2 = 0 → agent-a.
        expect(result.agentId).toBe('agent-a');
        expect(transitions.dispatchAgentRun).toHaveBeenCalled();
    });

    it('pauses the loop and logs a limit when the spend cap is reached', async () => {
        const { service, tasks, runs, events, goals, notifications } = build({
            goal: { loopStatus: 'running', spendCapCents: 300, assignedAgentId: 'agent-7' },
        });
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'done',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'r1',
            taskId: 'task-1',
            status: 'completed',
            costCents: 400,
            startedAt: new Date(1),
        });

        const result = await service.advance('u1', 'g1');

        expect(result.action).toBe('pause');
        expect(result.reasonCode).toBe('spend-cap-exceeded');
        expect(goals._rows[0].loopStatus).toBe('paused');
        expect(goals._rows[0].spentCents).toBe(400);
        expect(eventKinds(events)).toEqual(['limit']);
        expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('marks the loop done when every criterion is closed', async () => {
        const { service, events, goals, transitions } = build({
            goal: {
                loopStatus: 'running',
                assignedAgentId: 'agent-7',
                dodCriteria: [{ id: 'a', text: 'Ship pricing', status: 'done' }],
            },
        });

        const result = await service.advance('u1', 'g1');
        expect(result.action).toBe('complete');
        expect(goals._rows[0].loopStatus).toBe('done');
        expect(goals._rows[0].activeAgentId).toBeNull();
        expect(eventKinds(events)).toEqual(['complete']);
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });

    it('marks the loop stuck after the configured iterations without progress', async () => {
        const { service, goals, events } = build({
            goal: {
                loopStatus: 'running',
                assignedAgentId: 'agent-7',
                iteration: 5,
                lastProgressIteration: 2,
                stuckThresholdIterations: 3,
                dodCriteria: [{ id: 'a', text: 'Ship pricing', status: 'open' }],
            },
        });

        const result = await service.advance('u1', 'g1');
        expect(result.action).toBe('stuck');
        expect(goals._rows[0].loopStatus).toBe('stuck');
        expect(eventKinds(events)).toEqual(['limit']);
    });

    it('waits — and writes NO log line — while an iteration is in flight', async () => {
        const { service, tasks, runs, events, transitions } = build({
            goal: { loopStatus: 'running', assignedAgentId: 'agent-7', iteration: 1 },
        });
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'in_progress',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'r1',
            taskId: 'task-1',
            status: 'running',
            costCents: null,
            startedAt: new Date(1),
        });

        const result = await service.advance('u1', 'g1');
        expect(result.action).toBe('wait');
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
        // A per-5-minute cron that logged "still running" every tick would
        // bury the decisions that matter.
        expect(events._rows).toHaveLength(0);
    });

    it('does nothing for a paused loop', async () => {
        const { service, transitions } = build({ goal: { loopStatus: 'paused' } });
        const result = await service.advance('u1', 'g1');
        expect(result.action).toBe('noop');
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });
});

describe('GoalOrchestratorService — advanceDue', () => {
    it('summarizes a tick and keeps going when one Goal throws', async () => {
        const { service, goals, tasksService } = build({
            goal: { loopStatus: 'running', assignedAgentId: 'agent-7' },
        });
        goals._rows.push(
            goalRow({
                id: 'g2',
                title: 'Second',
                loopStatus: 'running',
                assignedAgentId: 'agent-8',
            }),
        );
        tasksService.create.mockRejectedValueOnce(new Error('tasks exploded'));

        const summary = await service.advanceDue();
        expect(summary.dueCount).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.dispatched).toBe(1);
        expect(summary.results).toHaveLength(2);
    });

    it('never picks up an archived Goal', async () => {
        const { service, goals } = build({
            goal: { loopStatus: 'running', archivedAt: new Date('2026-08-10T00:00:00.000Z') },
        });
        expect(goals._rows[0].archivedAt).toBeTruthy();
        const summary = await service.advanceDue();
        expect(summary.dueCount).toBe(0);
    });
});

describe('GoalOrchestratorService — loop control', () => {
    it('starts the loop, anchoring the wall clock once', async () => {
        const { service, goals, events } = build();
        await service.startLoop('u1', 'g1');
        const anchor = goals._rows[0].loopStartedAt;
        expect(goals._rows[0].loopStatus).toBe('running');
        expect(anchor).toBeInstanceOf(Date);

        await service.pauseLoop('u1', 'g1');
        await service.startLoop('u1', 'g1');
        // Re-anchoring on resume would let an operator reset a wall-clock
        // limit by pausing for a second.
        expect(goals._rows[0].loopStartedAt).toBe(anchor);
        expect(eventKinds(events)).toEqual(['control', 'control', 'control']);
    });

    it('refuses to pause a loop that is not running', async () => {
        const { service } = build();
        await expect(service.pauseLoop('u1', 'g1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to start the loop on an archived Goal', async () => {
        const { service } = build({ goal: { archivedAt: new Date() } });
        await expect(service.startLoop('u1', 'g1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancels the in-flight run when the loop is cancelled', async () => {
        const { service, tasks, runs, agentRuns, goals } = build({
            goal: { loopStatus: 'running' },
        });
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'in_progress',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'r1',
            taskId: 'task-1',
            status: 'running',
            costCents: 10,
            startedAt: new Date(1),
        });

        await service.cancelLoop('u1', 'g1');
        expect(agentRuns.cancel).toHaveBeenCalledWith('r1', 'u1');
        expect(goals._rows[0].loopStatus).toBe('cancelled');
        expect(goals._rows[0].activeAgentId).toBeNull();
    });

    it('restart cancels the live run and dispatches a fresh iteration', async () => {
        const { service, tasks, runs, agentRuns, transitions } = build({
            goal: { loopStatus: 'paused', assignedAgentId: 'agent-7', iteration: 2 },
        });
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'in_progress',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'r1',
            taskId: 'task-1',
            status: 'running',
            costCents: 10,
            startedAt: new Date(1),
        });

        const result = await service.restartSession('u1', 'g1');
        expect(agentRuns.cancel).toHaveBeenCalledWith('r1', 'u1');
        expect(result.action).toBe('dispatch');
        expect(result.iteration).toBe(3);
        expect(transitions.dispatchAgentRun).toHaveBeenCalled();
    });
});

describe('GoalOrchestratorService — nudge', () => {
    it('steers the live run and logs the nudge', async () => {
        const { service, tasks, runs, steering, events } = build({
            goal: { loopStatus: 'running', iteration: 3 },
        });
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'in_progress',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'run-live',
            taskId: 'task-1',
            agentId: 'agent-7',
            status: 'running',
            costCents: null,
            startedAt: new Date(1),
        });

        const result = await service.nudge('u1', 'g1', '  focus on the pricing page  ');
        expect(steering.steer).toHaveBeenCalledWith({
            runId: 'run-live',
            userId: 'u1',
            message: 'focus on the pricing page',
        });
        expect(result.runId).toBe('run-live');
        expect(eventKinds(events)).toEqual(['nudge']);
        expect(eventMessages(events)[0]).toContain('focus on the pricing page');
    });

    it('refuses an empty or over-long nudge', async () => {
        const { service } = build({ goal: { loopStatus: 'running' } });
        await expect(service.nudge('u1', 'g1', '   ')).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.nudge('u1', 'g1', 'x'.repeat(2001))).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('refuses when nothing is in flight rather than starting a run', async () => {
        const { service, steering } = build({ goal: { loopStatus: 'running' } });
        await expect(service.nudge('u1', 'g1', 'hello')).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(steering.steer).not.toHaveBeenCalled();
    });

    it('refuses when the run went terminal mid-nudge', async () => {
        const { service, tasks, runs, steering } = build({ goal: { loopStatus: 'running' } });
        tasks._rows.push({
            id: 'task-1',
            goalId: 'g1',
            slug: 'T-1',
            title: 'a',
            status: 'in_progress',
            createdAt: new Date(1),
        });
        runs._rows.push({
            id: 'run-live',
            taskId: 'task-1',
            agentId: 'a',
            status: 'running',
            costCents: null,
            startedAt: new Date(1),
        });
        steering.steer.mockResolvedValueOnce({ dispatched: 'new-run', runId: 'run-live' } as never);

        await expect(service.nudge('u1', 'g1', 'hello')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});

describe('GoalOrchestratorService — archive + sessions', () => {
    it('archives, pauses a running loop, and unarchives', async () => {
        const { service, goals } = build({ goal: { loopStatus: 'running' } });
        await service.archive('u1', 'g1');
        expect(goals._rows[0].archivedAt).toBeInstanceOf(Date);
        // Advancing a Goal the operator has retired would be a surprise
        // charge; archiving therefore stops the loop too.
        expect(goals._rows[0].loopStatus).toBe('paused');

        await service.unarchive('u1', 'g1');
        expect(goals._rows[0].archivedAt).toBeNull();
    });

    it('lists iteration Tasks even when they have no run yet', async () => {
        const { service, tasks, runs } = build();
        tasks._rows.push(
            {
                id: 'task-1',
                goalId: 'g1',
                agentId: 'agent-a',
                slug: 'T-1',
                title: '[Goal] x — iteration 1',
                status: 'done',
                createdAt: new Date(1),
            },
            {
                id: 'task-2',
                goalId: 'g1',
                agentId: 'agent-b',
                slug: 'T-2',
                title: '[Goal] x — iteration 2',
                status: 'todo',
                createdAt: new Date(2),
            },
        );
        runs._rows.push({
            id: 'r1',
            taskId: 'task-1',
            agentId: 'agent-a',
            status: 'completed',
            costCents: 120,
            durationMs: 4000,
            summary: 'Shipped the pricing page.',
            startedAt: new Date(1),
            finishedAt: new Date(5),
        });

        const sessions = await service.listSessions('u1', 'g1');
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toMatchObject({
            taskId: 'task-1',
            iteration: 1,
            runId: 'r1',
            costCents: 120,
            summary: 'Shipped the pricing page.',
        });
        // A dispatched-but-not-yet-run Task must still be visible, or a
        // stalled loop looks idle rather than broken.
        expect(sessions[1]).toMatchObject({ taskId: 'task-2', runId: null, iteration: 2 });
    });

    it('serves the orchestrator log newest first', async () => {
        const { service, events } = build();
        events._rows.push(
            {
                id: 'e1',
                goalId: 'g1',
                userId: 'u1',
                kind: 'route',
                message: 'first',
                iteration: 1,
                createdAt: new Date(1),
            },
            {
                id: 'e2',
                goalId: 'g1',
                userId: 'u1',
                kind: 'dispatch',
                message: 'second',
                iteration: 1,
                createdAt: new Date(2),
            },
        );
        const log = await service.listEvents('u1', 'g1');
        expect(log.map((e) => e.message)).toEqual(['second', 'first']);
    });
});
