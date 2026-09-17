import {
    BadRequestException,
    ConflictException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ScheduleControlService, parseScheduleId } from '../schedule-control.service';
import { buildScheduleControls } from '../schedule-controls';
import type { ScheduleView } from '../schedule-view.types';
import { ActivityActionType } from '../../entities/activity-log.types';

const CTX = { userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' };
const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };

function view(over: Partial<ScheduleView>): ScheduleView {
    const base: ScheduleView = {
        id: 'recurring_task:task-1',
        sourceType: 'recurring_task',
        ownerType: 'task',
        ownerId: 'task-1',
        ownerName: 'Morning inbox scan',
        ownerLink: '/tasks/task-1',
        cadenceRaw: '0 7 * * *',
        cadenceHuman: 'Every day at 07:00',
        nextRunAt: '2026-09-15T07:00:00.000Z',
        lastRunAt: null,
        lastRunStatus: null,
        status: 'active',
        enabled: true,
        pausedAt: null,
        health: { ok: true, reason: null, reasonKey: null, repair: 'none', checkedAt: null },
        ...over,
    };
    base.controls = buildScheduleControls(base);
    return base;
}

function build(rows: ScheduleView[]) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const schedules = {
        findOne: jest.fn(async (_scope: unknown, id: string) => byId.get(id) ?? null),
    };
    const tasks = {
        runRecurringNow: jest.fn().mockResolvedValue({
            templateId: 'task-1',
            instanceId: 'instance-1',
            instanceSlug: 'T-9',
            nextOccurrenceAt: new Date('2026-09-15T07:00:00.000Z'),
            runs: [{ agentId: 'agent-1', runId: 'run-1', dispatched: true, parked: false }],
        }),
        pauseRecurrence: jest.fn().mockResolvedValue({}),
        resumeRecurrence: jest.fn().mockResolvedValue({}),
    };
    const agents = {
        getOne: jest.fn().mockResolvedValue({}),
        pauseHeartbeat: jest.fn().mockResolvedValue({}),
        resumeHeartbeat: jest.fn().mockResolvedValue({}),
    };
    const dispatcher = {
        dispatchOne: jest.fn().mockResolvedValue({ outcome: 'dispatched', runId: 'run-hb' }),
    };
    const trigger = { enqueue: jest.fn() };
    const missions = {
        runNow: jest
            .fn()
            .mockResolvedValue({ status: 'spawned', missionId: 'mission-1', ideasCreated: 3 }),
        pause: jest.fn().mockResolvedValue({}),
        resume: jest.fn().mockResolvedValue({}),
    };
    const inboundTriggers = {
        pause: jest.fn().mockResolvedValue({}),
        resume: jest.fn().mockResolvedValue({}),
    };
    const activityLog = { log: jest.fn().mockResolvedValue({}) };
    const service = new ScheduleControlService(
        schedules as never,
        tasks as never,
        agents as never,
        dispatcher as never,
        trigger as never,
        missions as never,
        inboundTriggers as never,
        activityLog as never,
    );
    return {
        service,
        schedules,
        tasks,
        agents,
        dispatcher,
        trigger,
        missions,
        inboundTriggers,
        activityLog,
    };
}

describe('parseScheduleId', () => {
    it('splits a well-formed id and rejects anything else', () => {
        expect(parseScheduleId('mission_tick:abc')).toEqual({
            sourceType: 'mission_tick',
            ownerKey: 'abc',
        });
        expect(parseScheduleId('nope:abc')).toBeNull();
        expect(parseScheduleId('mission_tick')).toBeNull();
        expect(parseScheduleId('mission_tick:a:b')).toBeNull();
        expect(parseScheduleId('mission_tick:')).toBeNull();
    });
});

describe('ScheduleControlService', () => {
    it('a foreign or missing schedule is a 404, and a malformed id a 400 — before any write', async () => {
        const { service, tasks } = build([]);
        await expect(service.runNow(CTX, 'recurring_task:someone-else')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(service.pause(CTX, 'garbage')).rejects.toBeInstanceOf(BadRequestException);
        expect(tasks.pauseRecurrence).not.toHaveBeenCalled();
    });

    describe('run now', () => {
        it('recurring Task: delegates to the Task domain and echoes the unchanged next fire', async () => {
            const { service, tasks } = build([view({})]);
            const result = await service.runNow(CTX, 'recurring_task:task-1');
            expect(tasks.runRecurringNow).toHaveBeenCalledWith('user-1', 'task-1', SCOPE);
            expect(result).toEqual({
                kind: 'run',
                scheduleId: 'recurring_task:task-1',
                runIds: ['run-1'],
                parked: false,
                queuedReason: null,
                taskId: 'instance-1',
                nextRunAt: '2026-09-15T07:00:00.000Z',
            });
        });

        it('recurring Task: a deployment with no job runtime is a 503, never a silent success', async () => {
            const { service, tasks } = build([view({})]);
            tasks.runRecurringNow.mockResolvedValueOnce({
                templateId: 'task-1',
                instanceId: 'instance-1',
                instanceSlug: 'T-9',
                nextOccurrenceAt: null,
                runs: [
                    {
                        agentId: 'agent-1',
                        runId: null,
                        dispatched: false,
                        parked: false,
                        error: 'no-dispatcher',
                    },
                ],
            });
            await expect(service.runNow(CTX, 'recurring_task:task-1')).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });

        it('refuses with the code the row health already declared', async () => {
            const { service, tasks } = build([
                view({
                    health: {
                        ok: false,
                        reason: 'no-agent',
                        reasonKey: 'noAgent',
                        repair: 'choice',
                        checkedAt: null,
                    },
                }),
            ]);
            const error = await service.runNow(CTX, 'recurring_task:task-1').catch((err) => err);
            expect(error).toBeInstanceOf(ConflictException);
            expect(error.getResponse()).toMatchObject({
                code: 'SCHEDULE_NO_AGENT',
                reasonKey: 'noAgent',
            });
            expect(tasks.runRecurringNow).not.toHaveBeenCalled();
        });

        it('heartbeat: goes through the Agent run-now dispatcher with the configured trigger', async () => {
            const row = view({
                id: 'agent_heartbeat:agent-1',
                sourceType: 'agent_heartbeat',
                ownerId: 'agent-1',
            });
            const { service, agents, dispatcher, trigger, activityLog } = build([row]);
            const result = await service.runNow(CTX, row.id);
            expect(agents.getOne).toHaveBeenCalledWith('user-1', 'agent-1', SCOPE);
            expect(dispatcher.dispatchOne).toHaveBeenCalledWith(trigger, 'agent-1');
            expect(result).toMatchObject({
                kind: 'run',
                runIds: ['run-hb'],
                nextRunAt: row.nextRunAt,
            });
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.SCHEDULE_EXECUTED }),
            );
        });

        it('heartbeat: an in-flight claim is SCHEDULE_ALREADY_RUNNING', async () => {
            const row = view({
                id: 'agent_heartbeat:agent-1',
                sourceType: 'agent_heartbeat',
                ownerId: 'agent-1',
            });
            const { service, dispatcher } = build([row]);
            dispatcher.dispatchOne.mockResolvedValueOnce({
                outcome: 'skipped',
                reason: 'already-claimed',
            });
            const error = await service.runNow(CTX, row.id).catch((err) => err);
            expect(error.getResponse()).toMatchObject({ code: 'SCHEDULE_ALREADY_RUNNING' });
        });

        it('heartbeat: without a trigger binding the control answers 503', async () => {
            const row = view({
                id: 'agent_heartbeat:agent-1',
                sourceType: 'agent_heartbeat',
                ownerId: 'agent-1',
            });
            const { schedules, agents, dispatcher } = build([row]);
            const service = new ScheduleControlService(
                schedules as never,
                undefined,
                agents as never,
                dispatcher as never,
                undefined,
            );
            await expect(service.runNow(CTX, row.id)).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });

        it('Mission tick: raises Ideas and returns a Mission link with NO run id', async () => {
            const row = view({
                id: 'mission_tick:mission-1',
                sourceType: 'mission_tick',
                ownerType: 'mission',
                ownerId: 'mission-1',
                ownerLink: '/missions/mission-1',
            });
            const { service, missions } = build([row]);
            const result = await service.runNow(CTX, row.id);
            expect(missions.runNow).toHaveBeenCalledWith('user-1', 'mission-1', SCOPE);
            expect(result).toEqual({
                kind: 'mission-tick',
                scheduleId: row.id,
                missionId: 'mission-1',
                ownerLink: '/missions/mission-1',
                outcome: 'spawned',
                ideasCreated: 3,
                ideasQueued: null,
            });
            expect(result).not.toHaveProperty('runIds');
        });

        it('inbound Trigger and Work-owned rows refuse with their declared reason', async () => {
            const trigger = view({
                id: 'inbound_trigger:t-1',
                sourceType: 'inbound_trigger',
                ownerId: 't-1',
            });
            const work = view({ id: 'data_sync:w-1', sourceType: 'data_sync', ownerId: 'w-1' });
            const { service } = build([trigger, work]);
            const triggerError = await service.runNow(CTX, trigger.id).catch((err) => err);
            expect(triggerError.getResponse()).toMatchObject({
                code: 'SCHEDULE_CONTROL_UNAVAILABLE',
                reasonKey: 'eventDriven',
            });
            const workError = await service.pause(CTX, work.id).catch((err) => err);
            expect(workError.getResponse()).toMatchObject({ reasonKey: 'managedOnWork' });
        });
    });

    describe('pause and resume', () => {
        it('recurring Task: pause and resume delegate to the Task domain and log activity', async () => {
            const row = view({});
            const { service, tasks, schedules, activityLog } = build([row]);
            const paused = view({
                status: 'paused',
                pausedAt: '2026-09-14T10:00:00.000Z',
                enabled: false,
            });
            schedules.findOne.mockResolvedValueOnce(row).mockResolvedValueOnce(paused);

            const after = await service.pause(CTX, row.id);
            expect(tasks.pauseRecurrence).toHaveBeenCalledWith('user-1', 'task-1', SCOPE);
            expect(after.status).toBe('paused');
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.SCHEDULE_PAUSED,
                    details: expect.objectContaining({
                        scheduleId: row.id,
                        control: 'pause',
                        before: { status: 'active' },
                        after: { status: 'paused' },
                    }),
                }),
            );

            const pausedRow = view({ status: 'paused', pausedAt: '2026-09-14T10:00:00.000Z' });
            const second = build([pausedRow]);
            await second.service.resume(CTX, pausedRow.id);
            expect(second.tasks.resumeRecurrence).toHaveBeenCalledWith('user-1', 'task-1', SCOPE);
        });

        it('pausing an already-paused row and resuming an active row are no-ops', async () => {
            const pausedRow = view({ status: 'paused', pausedAt: '2026-09-14T10:00:00.000Z' });
            const activeRow = view({ id: 'recurring_task:task-2', ownerId: 'task-2' });
            const { service, tasks, activityLog } = build([pausedRow, activeRow]);
            await expect(service.pause(CTX, pausedRow.id)).resolves.toBe(pausedRow);
            await expect(service.resume(CTX, activeRow.id)).resolves.toBe(activeRow);
            expect(tasks.pauseRecurrence).not.toHaveBeenCalled();
            expect(tasks.resumeRecurrence).not.toHaveBeenCalled();
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('heartbeat pause goes to the Agent heartbeat pause, never the Agent pause', async () => {
            const row = view({
                id: 'agent_heartbeat:agent-1',
                sourceType: 'agent_heartbeat',
                ownerId: 'agent-1',
            });
            const { service, agents } = build([row]);
            await service.pause(CTX, row.id);
            expect(agents.pauseHeartbeat).toHaveBeenCalledWith('user-1', 'agent-1', SCOPE);
            expect(agents).not.toHaveProperty('pause');
        });

        it('Mission tick pause is refused until the whole-Mission pause is acknowledged', async () => {
            const row = view({
                id: 'mission_tick:mission-1',
                sourceType: 'mission_tick',
                ownerType: 'mission',
                ownerId: 'mission-1',
            });
            const { service, missions } = build([row]);
            const error = await service.pause(CTX, row.id).catch((err) => err);
            expect(error).toBeInstanceOf(ConflictException);
            expect(error.getResponse()).toMatchObject({ code: 'MISSION_PAUSE_NOT_ACKNOWLEDGED' });
            expect(missions.pause).not.toHaveBeenCalled();

            await service.pause(CTX, row.id, { acknowledgeMissionPause: true });
            expect(missions.pause).toHaveBeenCalledWith('user-1', 'mission-1', SCOPE);
        });

        it('inbound Trigger pause and resume use the trigger scope shape', async () => {
            const active = view({
                id: 'inbound_trigger:t-1',
                sourceType: 'inbound_trigger',
                ownerId: 'agent-7',
            });
            const paused = view({
                id: 'inbound_trigger:t-2',
                sourceType: 'inbound_trigger',
                ownerId: 't-2',
                status: 'paused',
            });
            const { service, inboundTriggers } = build([active, paused]);
            await service.pause(CTX, active.id);
            // The trigger id comes from the synthetic id, not from ownerId
            // (which is the target Agent when one is set).
            expect(inboundTriggers.pause).toHaveBeenCalledWith(
                { userId: 'user-1', organizationId: 'org-1' },
                't-1',
            );
            await service.resume(CTX, paused.id);
            expect(inboundTriggers.resume).toHaveBeenCalledWith(
                { userId: 'user-1', organizationId: 'org-1' },
                't-2',
            );
        });
    });
});
