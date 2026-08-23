// Short-circuit the transitive `@ever-works/agent/*` import chain so the
// test doesn't pull `@src/entities` (which only resolves inside apps/api)
// through `packages/agent/src/database/repositories/...`. Mirrors
// `agents.controller.runtime.spec.ts`.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AgentScope: { TENANT: 'tenant', MISSION: 'mission', IDEA: 'idea', WORK: 'work' },
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
    RunDispatchGateService: class {},
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
        AGENT_CREATED: 'agent_created',
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { AgentsController } from './agents.controller';

/**
 * Environments (Settings → Environments) — the `environmentId`
 * assignment must survive the controller's EXPLICIT body→input mapping.
 *
 * This is the "whitelist drops new columns" bug class: `CreateAgentDto` /
 * `UpdateAgentDto` gained `environmentId`, but the controller copies
 * named fields one by one, so a field that is not copied is silently
 * dropped — DTO validation passes, the API answers 200, and the
 * assignment never persists. These tests pin the two mappings.
 */
describe('AgentsController — Environment assignment mapping', () => {
    const auth = { userId: 'u1' } as any;
    const agentId = '00000000-0000-0000-0000-000000000001';
    const environmentId = '00000000-0000-0000-0000-0000000000e1';
    const activeScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    let service: any;
    let controller: AgentsController;

    beforeEach(() => {
        service = {
            create: jest.fn().mockResolvedValue({ id: agentId, environmentId }),
            update: jest.fn().mockResolvedValue({ id: agentId, environmentId }),
        };
        controller = new AgentsController(
            service,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            { log: jest.fn().mockResolvedValue(undefined) } as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { getScope: () => activeScope } as any,
        );
    });

    it('POST forwards environmentId to the service', async () => {
        await controller.create(auth, { scope: 'tenant', name: 'A', environmentId } as any);
        expect(service.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ environmentId }),
            activeScope,
        );
    });

    it('POST maps an omitted environmentId to null (platform default runtime)', async () => {
        await controller.create(auth, { scope: 'tenant', name: 'A' } as any);
        expect(service.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ environmentId: null }),
            activeScope,
        );
    });

    it('PATCH forwards environmentId so the assignment persists', async () => {
        await controller.update(auth, agentId, { environmentId } as any);
        expect(service.update).toHaveBeenCalledWith(
            'u1',
            agentId,
            expect.objectContaining({ environmentId }),
            activeScope,
        );
    });

    it('PATCH forwards an explicit null so the assignment can be cleared', async () => {
        await controller.update(auth, agentId, { environmentId: null } as any);
        expect(service.update).toHaveBeenCalledWith(
            'u1',
            agentId,
            expect.objectContaining({ environmentId: null }),
            activeScope,
        );
    });

    it('PATCH leaves environmentId undefined when the body omits it', async () => {
        await controller.update(auth, agentId, { name: 'renamed' } as any);
        const patch = service.update.mock.calls[0][2];
        expect(patch.environmentId).toBeUndefined();
    });
});
