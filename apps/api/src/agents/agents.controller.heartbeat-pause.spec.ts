// Short-circuit the transitive `@ever-works/agent/*` import chain so
// the test doesn't pull `@src/entities` (which only resolves inside
// apps/api) through `packages/agent/src/database/repositories/...`.
// Mirrors the pattern used by `account/account.controller.spec.ts`.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AgentScope: {
        TENANT: 'tenant',
        MISSION: 'mission',
        IDEA: 'idea',
        WORK: 'work',
    },
    AgentStatus: {
        DRAFT: 'draft',
        ACTIVE: 'active',
        PAUSED: 'paused',
        ERROR: 'error',
        ARCHIVED: 'archived',
    },
    AgentIdleBehavior: { PROPOSE: 'propose', SLEEP: 'sleep', SELF_IMPROVE: 'self-improve' },
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AGENT_PERMISSIONS_DEFAULT: {},
    AgentsService: class {},
    AgentFileService: class {},
    AgentExportService: class {},
    AgentScheduleDispatcherService: class {},
    AgentRunRepository: class {},
    AgentRunLogRepository: class {},
    // Wave 4 M2/M3 — dispatch gate injected for cancel-path draining.
    RunDispatchGateService: class {},
    // Wave 4 M5 — steer / interrupt / resume run controls.
    RunSteeringService: class {},
    SkillBindingRepository: class {},
    PluginUsageRepository: class {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    __esModule: true,
    AGENT_TASK_EXECUTE_DISPATCHER: 'AGENT_TASK_EXECUTE_DISPATCHER',
    TasksService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    __esModule: true,
    ActivityActionType: {
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
        AGENT_RUN_CANCELLED: 'agent_run_cancelled',
        AGENT_TASK_ASSIGNED: 'agent_task_assigned',
        AGENT_CREATED: 'agent_created',
        AGENT_PAUSED: 'agent_paused',
        AGENT_RESUMED: 'agent_resumed',
        AGENT_ARCHIVED: 'agent_archived',
        AGENT_UNARCHIVED: 'agent_unarchived',
        AGENT_EXPORTED: 'agent_exported',
        AGENT_IMPORTED: 'agent_imported',
        AGENT_BUDGET_EXCEEDED: 'agent_budget_exceeded',
        SCHEDULE_PAUSED: 'schedule_paused',
        SCHEDULE_RESUMED: 'schedule_resumed',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { BadRequestException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AgentsController } from './agents.controller';

/**
 * Schedules — pause / resume an Agent's heartbeat without pausing the Agent.
 *
 * The service owns the write (only `heartbeatPausedAt`); the controller must
 * thread the active scope, call the HEARTBEAT pause — never the Agent pause —
 * record one schedule activity row, and leave no trail when the service
 * refuses.
 */
describe('AgentsController — heartbeat pause / resume', () => {
    const auth = { userId: 'u1' } as never;
    const agentId = '00000000-0000-0000-0000-000000000001';
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function build() {
        const service = {
            pause: jest.fn(),
            resume: jest.fn(),
            pauseHeartbeat: jest.fn().mockResolvedValue({
                id: agentId,
                status: 'active',
                heartbeatCadence: '*/15 * * * *',
                heartbeatPausedAt: new Date('2026-09-14T10:00:00.000Z'),
            }),
            resumeHeartbeat: jest.fn().mockResolvedValue({
                id: agentId,
                status: 'active',
                heartbeatPausedAt: null,
                nextHeartbeatAt: new Date('2026-09-14T10:15:00.000Z'),
            }),
        };
        const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
        const controller = new AgentsController(
            service as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            activityLog as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { getScope: () => everScope } as never,
        );
        return { controller, service, activityLog };
    }

    it('pause calls the heartbeat pause under the active scope and leaves the Agent active', async () => {
        const { controller, service, activityLog } = build();
        const dto = await controller.pauseHeartbeat(auth, agentId);
        expect(service.pauseHeartbeat).toHaveBeenCalledWith('u1', agentId, everScope);
        expect(service.pause).not.toHaveBeenCalled();
        expect(dto).toMatchObject({ status: 'active', heartbeatCadence: '*/15 * * * *' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: 'schedule_paused',
                userId: 'u1',
                details: expect.objectContaining({
                    scheduleId: `agent_heartbeat:${agentId}`,
                    control: 'pause',
                    resourceId: agentId,
                }),
            }),
        );
    });

    it('resume calls the heartbeat resume and logs schedule_resumed', async () => {
        const { controller, service, activityLog } = build();
        await controller.resumeHeartbeat(auth, agentId);
        expect(service.resumeHeartbeat).toHaveBeenCalledWith('u1', agentId, everScope);
        expect(service.resume).not.toHaveBeenCalled();
        await new Promise((resolve) => setImmediate(resolve));
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: 'schedule_resumed' }),
        );
    });

    it('a foreign Agent 404s and an Agent without a heartbeat 400s, with no activity row', async () => {
        const { controller, service, activityLog } = build();
        service.pauseHeartbeat.mockRejectedValueOnce(new NotFoundException());
        await expect(controller.pauseHeartbeat(auth, agentId)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        service.pauseHeartbeat.mockRejectedValueOnce(new BadRequestException());
        await expect(controller.pauseHeartbeat(auth, agentId)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('declares both routes as POSTs under :id/heartbeat', () => {
        const proto = AgentsController.prototype as unknown as Record<string, object>;
        expect(Reflect.getMetadata(PATH_METADATA, proto.pauseHeartbeat)).toBe(
            ':id/heartbeat/pause',
        );
        expect(Reflect.getMetadata(PATH_METADATA, proto.resumeHeartbeat)).toBe(
            ':id/heartbeat/resume',
        );
        expect(Reflect.getMetadata(METHOD_METADATA, proto.pauseHeartbeat)).toBe(RequestMethod.POST);
    });
});
