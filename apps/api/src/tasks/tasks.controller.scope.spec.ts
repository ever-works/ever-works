jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: {},
    TaskPriority: {},
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { TasksController } from './tasks.controller';

describe('TasksController — board-run active scope', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const auth = { userId } as never;
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const agentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function build() {
        const service = {
            runTasksBatch: jest.fn().mockResolvedValue({ results: [] }),
            listRunCandidates: jest.fn().mockResolvedValue([]),
            runTask: jest.fn().mockResolvedValue({ taskId, agentId }),
        };
        const controller = new TasksController(
            service as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { getScope: () => everScope } as never,
        );
        return { controller, service };
    }

    it('threads the exact active tenant and Organization through run, batch, and candidates', async () => {
        const { controller, service } = build();

        await controller.run(auth, taskId, { agentId });
        await controller.runBatch(auth, { items: [{ taskId, agentId }] });
        await controller.runCandidates(auth, taskId);

        expect(service.runTask).toHaveBeenCalledWith(userId, taskId, { agentId }, everScope);
        expect(service.runTasksBatch).toHaveBeenCalledWith(
            userId,
            [{ taskId, agentId }],
            everScope,
        );
        expect(service.listRunCandidates).toHaveBeenCalledWith(userId, taskId, everScope);
    });
});
