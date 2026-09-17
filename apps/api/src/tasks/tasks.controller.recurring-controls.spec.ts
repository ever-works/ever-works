jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: { TODO: 'todo', IN_PROGRESS: 'in_progress' },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: (row: { tenantId?: string | null; organizationId?: string | null }) => ({
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
    }),
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { ConflictException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import {
    TaskChatService,
    TaskPrStatusService,
    TaskReviewRejectionService,
    TasksService,
    TaskWorkspaceService,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, PluginUsageRepository } from '@ever-works/agent/database';
import { DecisionConflictService } from '@ever-works/agent/services';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { AgentEscalationService } from '@ever-works/agent/agents';
import { ScopeContextService } from '../scope/scope-context.service';
import { TasksController } from './tasks.controller';

/**
 * `POST /api/tasks/:id/recurring/run-now` — fire a recurring template out of
 * band. The Task domain owns the behaviour (instance spawn, gated dispatch,
 * never moving the next fire); the controller must thread the ACTIVE tenant
 * and Organization, return the result, and surface refusals unchanged.
 */
describe('TasksController — recurring run-now', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const auth = { userId } as never;
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    async function build() {
        const service = {
            runRecurringNow: jest.fn().mockResolvedValue({
                templateId: taskId,
                instanceId: 'instance-1',
                instanceSlug: 'T-9',
                nextOccurrenceAt: new Date('2026-09-15T07:00:00.000Z'),
                runs: [{ agentId: 'agent-1', runId: 'run-1', dispatched: true, parked: false }],
            }),
        };
        const moduleRef = await Test.createTestingModule({
            controllers: [TasksController],
            providers: [
                { provide: TasksService, useValue: service },
                { provide: TaskChatService, useValue: {} },
                { provide: PluginUsageRepository, useValue: {} },
                { provide: AgentRepository, useValue: {} },
                { provide: TaskWorkspaceService, useValue: {} },
                { provide: DecisionConflictService, useValue: {} },
                { provide: TaskReviewRejectionService, useValue: {} },
                { provide: AgentEscalationService, useValue: {} },
                { provide: TaskPrStatusService, useValue: {} },
                { provide: ScopeContextService, useValue: { getScope: () => everScope } },
                { provide: ActivityLogService, useValue: {} },
            ],
        }).compile();
        return { controller: moduleRef.get(TasksController), service };
    }

    it('threads the active scope and returns the unchanged next fire', async () => {
        const { controller, service } = await build();
        const result = await controller.runRecurringNow(auth, taskId);
        expect(service.runRecurringNow).toHaveBeenCalledWith(userId, taskId, everScope);
        expect(result.nextOccurrenceAt).toEqual(new Date('2026-09-15T07:00:00.000Z'));
        expect(result.runs[0].runId).toBe('run-1');
    });

    it('surfaces 404 and each 409 refusal unchanged', async () => {
        const { controller, service } = await build();
        service.runRecurringNow.mockRejectedValueOnce(new NotFoundException());
        await expect(controller.runRecurringNow(auth, taskId)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        for (const code of [
            'SCHEDULE_ALREADY_RUNNING',
            'SCHEDULE_NO_AGENT',
            'SCHEDULE_OWNER_ARCHIVED',
        ]) {
            service.runRecurringNow.mockRejectedValueOnce(new ConflictException({ code }));
            const error = await controller.runRecurringNow(auth, taskId).catch((err) => err);
            expect(error.getResponse()).toMatchObject({ code });
        }
    });

    it('is a POST under :id/recurring, throttled at 10 per minute', () => {
        const handler = TasksController.prototype.runRecurringNow as unknown as object;
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/recurring/run-now');
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
        const keys = Reflect.getMetadataKeys(handler);
        const limitKey = keys.find(
            (key) => String(key).includes('LIMIT') && String(key).includes('long'),
        );
        expect(Reflect.getMetadata(limitKey, handler)).toBe(10);
    });
});
