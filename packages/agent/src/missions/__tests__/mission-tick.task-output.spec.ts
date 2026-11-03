import type { Repository } from 'typeorm';
import { combineBothOutcomes, MissionTickService } from '../mission-tick.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

/**
 * APW-08 T35 (FR-51…FR-54; ACC-08-26) — the Mission tick's Task branch, through `runOnce`:
 * `ideas` untouched; `tasks` / `both`; the open-Tasks cap and the per-tick count; duplicate open
 * titles dropped; Backlog when the Mission requires approval, otherwise To do and started; at most
 * five Works; the once-per-day "nothing to file" notice.
 */

type Row = Record<string, unknown>;

const NOW_DAY_1 = new Date('2026-10-31T10:00:00.000Z');

function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
        if (expected && typeof expected === 'object' && '_type' in (expected as object)) {
            const op = expected as { _type: string; _value: unknown };
            if (op._type === 'not') {
                const inner = op._value as { _type: string; _value: unknown[] };
                return !inner._value.includes(row[key]);
            }
            if (op._type === 'in') return (op._value as unknown[]).includes(row[key]);
        }
        return row[key] === expected;
    });
}

function build(
    missionOver: Partial<Mission> = {},
    relations: Array<{
        workId: string;
        relation: string;
        workKind: string | null;
        workName?: string;
    }> = [{ workId: 'w-1', relation: 'improves', workKind: 'app', workName: 'Bookings' }],
) {
    const mission = {
        id: 'm1',
        userId: 'u1',
        title: 'Grow Bookings',
        description: 'Make Bookings the easiest way to book a class.',
        type: MissionType.ONE_SHOT,
        status: MissionStatus.ACTIVE,
        schedule: null,
        outputMode: 'tasks',
        taskOutput: null,
        guardrailsOverride: null,
        taskOutputNoticeAt: null,
        tenantId: null,
        organizationId: null,
        ...missionOver,
    } as unknown as Mission;
    // The Task-output lease (review of #3061): a compare-and-set on
    // `taskOutputLeaseUntil`, modelled on the one Mission row.
    const leaseWrites: Array<{ set: Row; params: Row }> = [];
    const createQueryBuilder = jest.fn(() => {
        const state: { set: Row; params: Row } = { set: {}, params: {} };
        const qb = {
            update: () => qb,
            set: (patch: Row) => {
                state.set = patch;
                return qb;
            },
            where: (_clause: string, params: Row = {}) => {
                Object.assign(state.params, params);
                return qb;
            },
            andWhere: (_clause: string, params: Row = {}) => {
                Object.assign(state.params, params);
                return qb;
            },
            execute: jest.fn(async () => {
                leaseWrites.push({ set: { ...state.set }, params: { ...state.params } });
                const held = (mission as unknown as Row).taskOutputLeaseUntil as Date | null;
                const next = state.set.taskOutputLeaseUntil as Date | null;
                if (next instanceof Date && 'held' in state.params) {
                    // A renewal: only the instant this tick last set.
                    if (!held || held.getTime() !== state.params.held) return { affected: 0 };
                    (mission as unknown as Row).taskOutputLeaseUntil = next;
                    return { affected: 1 };
                }
                if (next instanceof Date) {
                    const now = state.params.now as number;
                    if (held && held.getTime() >= now) return { affected: 0 };
                    (mission as unknown as Row).taskOutputLeaseUntil = next;
                    return { affected: 1 };
                }
                if (held && held.getTime() === state.params.held) {
                    (mission as unknown as Row).taskOutputLeaseUntil = null;
                    return { affected: 1 };
                }
                return { affected: 0 };
            }),
        };
        return qb;
    });
    const missionRepo = {
        findOne: jest.fn(async () => mission),
        update: jest.fn(async (_where: Row, patch: Row) => {
            Object.assign(mission, patch);
            return { affected: 1 };
        }),
        createQueryBuilder,
        manager: { connection: { driver: { escape: (name: string) => `"${name}"` } } },
    };
    const proposals = { generate: jest.fn(async () => ({ status: 'generated', proposals: [] })) };
    const proposalRepo = { countOutstandingByMission: jest.fn(async () => 0) };
    const activityLog = { log: jest.fn(async () => undefined) };
    const works = {
        findById: jest.fn(async (id: string) => ({
            id,
            name: `Work ${id}`,
            description: 'An app.',
        })),
    };
    const taskRows: Row[] = [];
    const taskRepo = {
        find: jest.fn(async () => {
            throw new Error('the tick must not read Task rows past the visibility predicate');
        }),
        count: jest.fn(
            async (opts: { where: Row }) =>
                taskRows.filter((row) => matches(row, opts.where)).length,
        ),
    };
    const planner = {
        plan: jest.fn(async (input: { count: number; work: { id: string } }) =>
            Array.from({ length: input.count }, (_, i) => ({
                title: `Improve ${input.work.id} step ${i + 1}`,
                description: 'Done when it ships.',
            })),
        ),
    };
    let created = 0;
    const tasksService = {
        create: jest.fn(async (_userId: string, input: Row) => {
            const task = { id: `t-${++created}`, ...input };
            taskRows.push({ ...task, status: input.status });
            return task;
        }),
        runTask: jest.fn(async () => ({ dispatched: true })),
        // The Tasks list's visibility predicate, modelled: the owner's own rows, and other
        // people's rows unless they are private.
        list: jest.fn(
            async (
                userId: string,
                filter: { workId?: string; status?: string[]; orderBy?: string; limit?: number },
            ) => {
                let rows = taskRows.filter(
                    (row) =>
                        row.workId === filter.workId &&
                        (!filter.status || filter.status.includes(row.status as string)) &&
                        ((row.userId ?? userId) === userId || row.visibility !== 'private'),
                );
                if (filter.orderBy === 'createdAt') rows = [...rows].reverse();
                return { rows: rows.slice(0, filter.limit ?? 50), total: rows.length };
            },
        ),
    };
    const moduleRef = { get: jest.fn(() => tasksService) };
    const sink = { track: jest.fn() };
    const missionWorks = { listForMissionWithWork: jest.fn(async () => relations) };
    // The Agents the Mission's owner can still use (review of #3061).
    const reachableAgents = new Set<string>(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    const agentRows = {
        findOne: jest.fn(async (opts: { where: { id: string } }) =>
            reachableAgents.has(opts.where.id) ? { id: opts.where.id } : null,
        ),
    };

    const service = new (MissionTickService as unknown as new (
        ...args: unknown[]
    ) => MissionTickService)(
        missionRepo as unknown as Repository<Mission>,
        proposals,
        proposalRepo,
        {}, // workAgent
        activityLog,
        undefined, // ideaBuildDispatcher
        works,
        undefined, // domainEvents
        planner,
        missionWorks,
        taskRepo,
        moduleRef,
        sink,
        agentRows,
    );
    return {
        service,
        mission,
        missionRepo,
        proposals,
        activityLog,
        planner,
        tasksService,
        taskRows,
        sink,
        missionWorks,
        taskRepo,
        leaseWrites,
        reachableAgents,
    };
}

const nothingToFile = (activityLog: { log: jest.Mock }) =>
    activityLog.log.mock.calls.filter(
        ([entry]) => (entry as Row).actionType === ActivityActionType.MISSION_NOTHING_TO_FILE,
    );

describe('MissionTickService — Task output (APW-08 T35)', () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW_DAY_1);
    });
    afterEach(() => jest.useRealTimers());

    it('an `ideas` Mission is untouched: the planner is never asked, no Task is filed', async () => {
        const t = build({ outputMode: 'ideas' } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).toHaveBeenCalledTimes(1);
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
        expect(result.tasksFiled).toBeUndefined();
    });

    it('a `tasks` Mission files on its App Work in To do, with the Mission, the Work and the label, and starts it', async () => {
        const t = build();
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).not.toHaveBeenCalled();
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        expect(t.tasksService.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                missionId: 'm1',
                workId: 'w-1',
                labels: ['mission-task'],
                status: 'todo',
            }),
            undefined,
            { ownershipStamp: { tenantId: null, organizationId: null } },
        );
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );
        expect(t.sink.track).toHaveBeenCalledWith(
            'u1',
            'mission.task_output.tick',
            expect.objectContaining({ missionId: 'm1', worksConsidered: 1, tasksFiled: 1 }),
        );
    });

    // Review of #3061 — the per-run cap is resolved by `dispatchAgentRun` from the Task's Mission
    // for EVERY run of it, so the tick passes none of its own (pinned in the transition spec).
    it('leaves the Mission’s per-run budget to the dispatch path (FR-53)', async () => {
        const t = build({ guardrailsOverride: { maxBudgetCentsPerRun: 1500 } } as Partial<Mission>);
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );
    });

    it('counts the Mission’s open Tasks on the Work in SQL, never by reading rows', async () => {
        const t = build();
        await t.service.runOnce('m1', 'u1');
        expect(t.taskRepo.count).toHaveBeenCalledWith({
            where: expect.objectContaining({ workId: 'w-1', missionId: 'm1' }),
        });
        expect(t.taskRepo.find).not.toHaveBeenCalled();
    });

    it('never puts a colleague’s private Task in the planner prompt (review of #3061)', async () => {
        const t = build({ taskOutput: { tasksPerTick: 2, openTasksCap: 10 } } as Partial<Mission>);
        t.taskRows.push(
            { id: 'mine', workId: 'w-1', userId: 'u1', status: 'todo', title: 'My own Task' },
            {
                id: 'secret',
                workId: 'w-1',
                userId: 'u2',
                visibility: 'private',
                status: 'todo',
                title: 'Colleague secret plan',
            },
            {
                id: 'shared',
                workId: 'w-1',
                userId: 'u3',
                visibility: 'organization',
                status: 'todo',
                title: 'Shared roadmap item',
            },
        );
        await t.service.runOnce('m1', 'u1');
        const titles = (
            t.planner.plan.mock.calls[0][0] as unknown as { recentTaskTitles: string[] }
        ).recentTaskTitles;
        expect(titles).toEqual(expect.arrayContaining(['My own Task', 'Shared roadmap item']));
        expect(titles).not.toContain('Colleague secret plan');
        for (const [userId, filter] of t.tasksService.list.mock.calls) {
            expect(userId).toBe('u1');
            expect(filter).toMatchObject({ workId: 'w-1', view: 'organization' });
        }
    });

    it('while App changes are paused (T49) it asks no planner and files nothing', async () => {
        const previous = process.env.EVER_WORKS_APP_CHANGES_ENABLED;
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        try {
            const t = build();
            const result = await t.service.runOnce('m1', 'u1');
            expect(result).toMatchObject({
                outcome: 'no-tasks',
                tasksFiled: 0,
                message: 'app-changes-paused',
            });
            expect(t.planner.plan).not.toHaveBeenCalled();
            expect(t.tasksService.create).not.toHaveBeenCalled();
            expect(nothingToFile(t.activityLog)).toHaveLength(0);
        } finally {
            if (previous === undefined) delete process.env.EVER_WORKS_APP_CHANGES_ENABLED;
            else process.env.EVER_WORKS_APP_CHANGES_ENABLED = previous;
        }
    });

    it('holds the Mission’s lease while it files and gives it back after', async () => {
        const t = build();
        await t.service.runOnce('m1', 'u1');
        // Claim, renew before the Work's planner call, renew before filing, release.
        expect(t.leaseWrites).toHaveLength(4);
        expect(t.leaseWrites[0].set.taskOutputLeaseUntil).toBeInstanceOf(Date);
        expect(t.leaseWrites[0].params).toHaveProperty('now');
        expect(t.leaseWrites[1].params).toHaveProperty('held');
        expect(t.leaseWrites[2].params).toHaveProperty('held');
        // A tick is not an edit: `updatedAt` keeps its value.
        for (const write of t.leaseWrites) expect(typeof write.set.updatedAt).toBe('function');
        expect(t.leaseWrites[3].set.taskOutputLeaseUntil).toBeNull();
        expect((t.mission as unknown as Row).taskOutputLeaseUntil).toBeNull();
    });

    it('a lease taken over while the planner ran files nothing (review of #3061)', async () => {
        const t = build({}, [
            { workId: 'w-1', relation: 'improves', workKind: 'app' },
            { workId: 'w-2', relation: 'improves', workKind: 'app' },
        ]);
        t.planner.plan.mockImplementationOnce(
            async (input: { count: number; work: { id: string } }) => {
                // The planner outlived the lease and another tick claimed it.
                (t.mission as unknown as Row).taskOutputLeaseUntil = new Date(Date.now() + 1);
                return [{ title: `Improve ${input.work.id}`, description: '' }];
            },
        );
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).not.toHaveBeenCalled();
        // The remaining Works wait for the next tick; no "nothing to file" notice either.
        expect(t.planner.plan).toHaveBeenCalledTimes(1);
        expect(result.message).toContain('lease-lost');
        expect(nothingToFile(t.activityLog)).toHaveLength(0);
    });

    it('a Work detached while the planner ran gets no Task (review of #3061)', async () => {
        const t = build();
        t.planner.plan.mockImplementationOnce(async () => {
            t.missionWorks.listForMissionWithWork.mockResolvedValue([]);
            return [{ title: 'Add a waitlist', description: '' }];
        });
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).not.toHaveBeenCalled();
    });

    it('an Agent the owner can no longer use falls back to the Work’s default (review of #3061)', async () => {
        const gone = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const t = build({
            taskOutput: { tasksPerTick: 1, openTasksCap: 3, agentId: gone },
        } as Partial<Mission>);
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).toHaveBeenCalledTimes(1);
        expect(t.tasksService.create.mock.calls[0][1]).not.toHaveProperty('agentId');
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );

        const kept = build({
            taskOutput: {
                tasksPerTick: 1,
                openTasksCap: 3,
                agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            },
        } as Partial<Mission>);
        await kept.service.runOnce('m1', 'u1');
        expect(kept.tasksService.create.mock.calls[0][1]).toMatchObject({
            agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        });
    });

    it('a failed notice write leaves the day unstamped, so the next tick records it (review of #3061)', async () => {
        const t = build({}, [{ workId: 'w-site', relation: 'improves', workKind: 'directory' }]);
        t.activityLog.log.mockRejectedValueOnce(new Error('db down'));
        await t.service.runOnce('m1', 'u1');
        expect(t.mission.taskOutputNoticeAt).toBeNull();
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(2);
        expect(t.mission.taskOutputNoticeAt).toEqual(NOW_DAY_1);
    });

    it('a tick that finds the lease held files nothing and asks no planner', async () => {
        const t = build();
        (t.mission as unknown as Row).taskOutputLeaseUntil = new Date(Date.now() + 60_000);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'no-tasks', message: 'task-output-busy' });
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
    });

    it('two overlapping ticks (Run now + the schedule) never both file up to the cap', async () => {
        const t = build({ taskOutput: { tasksPerTick: 3, openTasksCap: 3 } } as Partial<Mission>);
        const [first, second] = await Promise.all([
            t.service.runOnce('m1', 'u1'),
            t.service.runOnce('m1', 'u1'),
        ]);
        expect([first.tasksFiled, second.tasksFiled].sort()).toEqual([0, 3]);
        expect(t.tasksService.create).toHaveBeenCalledTimes(3);
        expect(t.planner.plan).toHaveBeenCalledTimes(1);
    });

    it('a lease that cannot be written files nothing (fail closed)', async () => {
        const t = build();
        t.missionRepo.createQueryBuilder.mockImplementation(() => {
            throw new Error('db down');
        });
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'no-tasks', message: 'task-output-busy' });
        expect(t.planner.plan).not.toHaveBeenCalled();
    });

    it('requires approval before creating: filed in Backlog, never started (ACC-08-26)', async () => {
        const t = build({
            guardrailsOverride: { requireApprovalBeforeCreate: true },
            taskOutput: { tasksPerTick: 3, openTasksCap: 10 },
        } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result.tasksFiled).toBe(3);
        for (const [, input] of t.tasksService.create.mock.calls) {
            expect((input as Row).status).toBe('backlog');
        }
        expect(t.tasksService.runTask).not.toHaveBeenCalled();
    });

    it('never past the open-Tasks cap: at the cap nothing is filed; below it only the headroom', async () => {
        const capped = build({
            taskOutput: { tasksPerTick: 3, openTasksCap: 2 },
        } as Partial<Mission>);
        capped.taskRows.push(
            { id: 'o1', workId: 'w-1', missionId: 'm1', status: 'todo', title: 'A' },
            { id: 'o2', workId: 'w-1', missionId: 'm1', status: 'in_review', title: 'B' },
            // Not the Mission's: does not count against its cap.
            { id: 'o3', workId: 'w-1', missionId: 'other', status: 'todo', title: 'C' },
        );
        expect((await capped.service.runOnce('m1', 'u1')).tasksFiled).toBe(0);
        expect(capped.planner.plan).not.toHaveBeenCalled();

        const headroom = build({
            taskOutput: { tasksPerTick: 3, openTasksCap: 3 },
        } as Partial<Mission>);
        headroom.taskRows.push(
            { id: 'o1', workId: 'w-1', missionId: 'm1', status: 'todo', title: 'A' },
            { id: 'o2', workId: 'w-1', missionId: 'm1', status: 'done', title: 'B' },
            { id: 'o3', workId: 'w-1', missionId: 'm1', status: 'blocked', title: 'C' },
        );
        expect((await headroom.service.runOnce('m1', 'u1')).tasksFiled).toBe(1);
        expect(headroom.planner.plan.mock.calls[0][0]).toMatchObject({ count: 1 });
    });

    it('drops a proposal whose normalised title equals an open Task’s title on that Work', async () => {
        const t = build({ taskOutput: { tasksPerTick: 2, openTasksCap: 10 } } as Partial<Mission>);
        t.taskRows.push({
            id: 'o1',
            workId: 'w-1',
            missionId: null,
            status: 'todo',
            title: 'Add  online CANCELLATION!',
        });
        t.planner.plan.mockResolvedValueOnce([
            { title: 'add online cancellation', description: '' },
            { title: 'Send reminder emails', description: '' },
        ]);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result.tasksFiled).toBe(1);
        expect(t.tasksService.create.mock.calls[0][1]).toMatchObject({
            title: 'Send reminder emails',
        });
        expect(t.sink.track.mock.calls[0][2]).toMatchObject({ skippedDuplicate: 1 });
    });

    it('files on at most five Works, only App Works attached as Improves or Operates', async () => {
        const relations = [
            ...Array.from({ length: 7 }, (_, i) => ({
                workId: `w-${i + 1}`,
                relation: i % 2 ? 'operates' : 'improves',
                workKind: 'app',
            })),
            { workId: 'w-site', relation: 'improves', workKind: 'directory' },
            { workId: 'w-mkt', relation: 'markets', workKind: 'app' },
        ];
        const t = build({}, relations);
        await t.service.runOnce('m1', 'u1');
        const planned = t.planner.plan.mock.calls.map(
            ([input]) => (input as { work: { id: string } }).work.id,
        );
        expect(planned).toEqual(['w-1', 'w-2', 'w-3', 'w-4', 'w-5']);
        expect(t.planner.plan.mock.calls[1][0]).toMatchObject({ relation: 'operates' });
    });

    it('one Work’s planner failure never stops the others or fails the Mission', async () => {
        const t = build({}, [
            { workId: 'w-1', relation: 'improves', workKind: 'app' },
            { workId: 'w-2', relation: 'improves', workKind: 'app' },
        ]);
        t.planner.plan.mockRejectedValueOnce(new Error('model down'));
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        expect(t.mission.status).toBe(MissionStatus.ACTIVE);
    });

    it('no App Work to file on: ONE notice per Mission per day, stamped on the Mission (FR-54, S27)', async () => {
        const t = build({}, [{ workId: 'w-site', relation: 'improves', workKind: 'directory' }]);
        expect(await t.service.runOnce('m1', 'u1')).toMatchObject({
            outcome: 'no-tasks',
            tasksFiled: 0,
        });
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(1);
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({
                reason: 'no-app-work',
                message: 'No attached App Work to file Tasks on.',
            }),
        });
        expect(t.mission.taskOutputNoticeAt).toEqual(NOW_DAY_1);

        jest.setSystemTime(new Date('2026-11-01T09:00:00.000Z'));
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(2);
        expect(
            t.sink.track.mock.calls.filter(
                ([, event]) => event === 'mission.task_output.nothing_to_file',
            ),
        ).toHaveLength(2);
    });

    it('a `both` Mission runs the Ideas branch, then files Tasks — and reports both halves', async () => {
        const t = build({ outputMode: 'both' } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).toHaveBeenCalledTimes(1);
        expect(result.tasksFiled).toBe(1);
        // Review of #3061 — "generated no Ideas" no longer hides the Tasks that were filed.
        expect(result.outcome).toBe('tasks-filed');
        expect(result.message).toMatch(/^ideas: .*; tasks: /);
    });

    it('combineBothOutcomes: Ideas spawned wins; Tasks filed beats an empty Ideas half; else the Ideas outcome', () => {
        expect(
            combineBothOutcomes(
                { outcome: 'spawned', ideasCreated: 2 },
                { outcome: 'tasks-filed', tasksFiled: 1 },
            ),
        ).toMatchObject({ outcome: 'spawned', ideasCreated: 2, tasksFiled: 1 });
        expect(
            combineBothOutcomes(
                { outcome: 'cap-hit', outstanding: 5, cap: 5 },
                { outcome: 'tasks-filed', tasksFiled: 2 },
            ),
        ).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 2, cap: 5 });
        expect(
            combineBothOutcomes(
                { outcome: 'no-ideas', message: 'none' },
                { outcome: 'no-tasks', tasksFiled: 0, message: 'works=1 filed=0' },
            ),
        ).toMatchObject({
            outcome: 'no-ideas',
            tasksFiled: 0,
            message: 'ideas: none; tasks: works=1 filed=0',
        });
    });
});
