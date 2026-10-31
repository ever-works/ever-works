import type { Repository } from 'typeorm';
import { MissionTickService } from '../mission-tick.service';
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
    const missionRepo = {
        findOne: jest.fn(async () => mission),
        update: jest.fn(async (_where: Row, patch: Row) => {
            Object.assign(mission, patch);
            return { affected: 1 };
        }),
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
        find: jest.fn(async (opts: { where: Row; take?: number; order?: Row }) => {
            let rows = taskRows.filter((row) => matches(row, opts.where));
            if (opts.order) rows = [...rows].reverse();
            return rows.slice(0, opts.take ?? rows.length);
        }),
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
    };
    const moduleRef = { get: jest.fn(() => tasksService) };
    const sink = { track: jest.fn() };
    const missionWorks = { listForMissionWithWork: jest.fn(async () => relations) };

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

    it('a `both` Mission runs the Ideas branch, then files Tasks', async () => {
        const t = build({ outputMode: 'both' } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).toHaveBeenCalledTimes(1);
        expect(result.tasksFiled).toBe(1);
    });
});
