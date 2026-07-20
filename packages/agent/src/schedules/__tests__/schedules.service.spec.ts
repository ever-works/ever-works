import { SchedulesService } from '../schedules.service';
import { AgentStatus } from '../../entities/agent.entity';
import { MissionType, MissionStatus } from '../../entities/mission.entity';
import { WorkScheduleStatus, WorkScheduleCadence } from '../../entities/types';

function makeRepo(rows: unknown[]) {
    return {
        find: jest.fn().mockResolvedValue(rows),
    };
}

function makeWorkScheduleRepo(rows: unknown[]) {
    const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
    };
    return { createQueryBuilder: jest.fn().mockReturnValue(qb), _qb: qb };
}

const SCOPE = { userId: 'user-1', organizationId: null };

describe('SchedulesService', () => {
    it('aggregates all six sources into a unified sorted read-model', async () => {
        const now = new Date('2026-07-18T08:00:00.000Z');
        jest.useFakeTimers().setSystemTime(now);

        const taskRepo = makeRepo([
            {
                id: 'task-1',
                title: 'Weekly report',
                recurrenceRule: 'FREQ=WEEKLY',
                nextOccurrenceAt: new Date('2026-07-20T09:00:00.000Z'),
                recurrenceEndsAt: null,
                recurrenceMaxOccurrences: null,
                recurrenceOccurredCount: 2,
            },
        ]);
        // 'manual' heartbeats are excluded at the DB layer now (WHERE
        // heartbeatCadence IS NOT NULL AND != 'manual'), so the mocked repo
        // returns only the scheduled agent — mirroring the real query result.
        const agentRepo = makeRepo([
            {
                id: 'agent-1',
                name: 'Nightly agent',
                heartbeatCadence: '0 9 * * *',
                nextHeartbeatAt: new Date('2026-07-18T09:00:00.000Z'),
                lastRunAt: new Date('2026-07-17T09:00:00.000Z'),
                lastRunStatus: 'completed',
                status: AgentStatus.ACTIVE,
            },
        ]);
        const workScheduleRepo = makeWorkScheduleRepo([
            {
                workId: 'work-1',
                work: { id: 'work-1', name: 'Directory A' },
                cadence: WorkScheduleCadence.DAILY,
                nextRunAt: new Date('2026-07-18T12:00:00.000Z'),
                lastRunAt: null,
                lastRunStatus: null,
                status: WorkScheduleStatus.ACTIVE,
            },
        ]);
        const missionRepo = makeRepo([
            {
                id: 'mission-1',
                title: 'Growth mission',
                schedule: '0 10 * * *',
                type: MissionType.SCHEDULED,
                status: MissionStatus.ACTIVE,
            },
        ]);
        const workRepo = {
            find: jest
                .fn()
                // source_validation query
                .mockResolvedValueOnce([
                    {
                        id: 'work-2',
                        name: 'Directory B',
                        sourceValidationEnabled: true,
                        sourceValidationCadence: WorkScheduleCadence.WEEKLY,
                        sourceValidationNextRunAt: new Date('2026-07-25T00:00:00.000Z'),
                        sourceValidationLastRunAt: null,
                    },
                ])
                // data_sync query
                .mockResolvedValueOnce([
                    {
                        id: 'work-3',
                        name: 'Directory C',
                        syncIntervalMinutes: 5,
                        lastPolledAt: new Date('2026-07-18T07:58:00.000Z'),
                    },
                ]),
        };

        const service = new SchedulesService(
            taskRepo as never,
            agentRepo as never,
            workScheduleRepo as never,
            missionRepo as never,
            workRepo as never,
        );

        const views = await service.getSchedules(SCOPE);

        // One row per source → 6 rows.
        expect(views).toHaveLength(6);
        const bySource = Object.fromEntries(views.map((v) => [v.sourceType, v]));

        // The 'manual' exclusion is pushed into the heartbeat query so the
        // MAX_PER_SOURCE limit counts only real scheduled heartbeats.
        expect(agentRepo.find.mock.calls[0][0].where.heartbeatCadence).toBeDefined();

        expect(bySource.recurring_task.ownerLink).toBe('/tasks/task-1');
        expect(bySource.recurring_task.cadenceHuman.toLowerCase()).toContain('week');
        expect(bySource.agent_heartbeat.ownerId).toBe('agent-1');
        expect(bySource.agent_heartbeat.enabled).toBe(true);
        expect(bySource.work_schedule.ownerLink).toBe('/works/work-1/generator/schedule');
        // Mission has no persisted next-run — it is computed from the cron.
        expect(bySource.mission_tick.nextRunAt).toBe('2026-07-18T10:00:00.000Z');
        expect(bySource.mission_tick.lastRunAt).toBeNull();
        expect(bySource.source_validation.ownerLink).toBe('/works/work-2');
        expect(bySource.data_sync.cadenceHuman).toBe('Every 5 minutes');

        // Sorted ascending by nextRunAt with nulls last.
        const order = views.map((v) => v.nextRunAt);
        const nonNull = order.filter((v): v is string => v !== null);
        const sorted = [...nonNull].sort((a, b) => a.localeCompare(b));
        expect(nonNull).toEqual(sorted);

        jest.useRealTimers();
    });

    it('applies the scope predicate (org IS NULL for personal scope)', async () => {
        const taskRepo = makeRepo([]);
        const agentRepo = makeRepo([]);
        const missionRepo = makeRepo([]);
        const workRepo = { find: jest.fn().mockResolvedValue([]) };
        const workScheduleRepo = makeWorkScheduleRepo([]);

        const service = new SchedulesService(
            taskRepo as never,
            agentRepo as never,
            workScheduleRepo as never,
            missionRepo as never,
            workRepo as never,
        );

        await service.getSchedules({ userId: 'user-9', organizationId: null });

        const taskWhere = taskRepo.find.mock.calls[0][0].where;
        expect(taskWhere.userId).toBe('user-9');
        // IsNull() is an object with a `@instanceof` marker — assert it is not a bare value.
        expect(taskWhere.organizationId).toBeDefined();
        expect(workScheduleRepo._qb.andWhere).toHaveBeenCalledWith('ws.organizationId IS NULL');
    });

    it('filters by sourceType and enabledOnly', async () => {
        const taskRepo = makeRepo([
            {
                id: 'task-ended',
                title: 'Done task',
                recurrenceRule: 'FREQ=DAILY',
                nextOccurrenceAt: null,
                recurrenceEndsAt: null,
                recurrenceMaxOccurrences: 3,
                recurrenceOccurredCount: 3,
            },
        ]);
        const service = new SchedulesService(
            taskRepo as never,
            makeRepo([]) as never,
            makeWorkScheduleRepo([]) as never,
            makeRepo([]) as never,
            { find: jest.fn().mockResolvedValue([]) } as never,
        );

        const all = await service.getSchedules(SCOPE, { sourceType: 'recurring_task' });
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('ended');
        expect(all[0].enabled).toBe(false);

        const enabledOnly = await service.getSchedules(SCOPE, {
            sourceType: 'recurring_task',
            enabledOnly: true,
        });
        expect(enabledOnly).toHaveLength(0);
    });
});
