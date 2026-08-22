import 'reflect-metadata';

jest.mock('@ever-works/agent/missions', () => ({
    MissionCloneService: class {},
    MissionsService: class {},
    MissionStatus: { ACTIVE: 'active', PAUSED: 'paused', COMPLETED: 'completed' },
}));
jest.mock('@ever-works/agent/budgets', () => ({ BudgetService: class {} }));
jest.mock('@ever-works/agent/goals', () => ({
    GoalOrchestratorService: class {},
    GoalsService: class {},
    GoalStatus: { DRAFT: 'draft', ACTIVE: 'active', PAUSED: 'paused', COMPLETED: 'completed' },
    GOAL_CONSTRAINT_CATEGORIES: ['budget', 'security'],
    MAX_GOAL_CONSTRAINTS: 20,
    MAX_GOAL_CRITERIA: 20,
    GOAL_DOD_SOURCES: ['user', 'planner'],
    GOAL_DOD_STATUSES: ['open', 'done', 'waived', 'proposed'],
    GOAL_EXECUTION_TARGETS: ['local', 'remote'],
    MAX_DOD_EVIDENCE_CHARS: 2000,
    MAX_DOD_ID_CHARS: 100,
    MAX_DOD_NOTE_CHARS: 2000,
    MAX_DOD_TEXT_CHARS: 2000,
    MAX_GOAL_DOD_CRITERIA: 50,
    MAX_GRACE_PERIOD_MINUTES: 10080,
    MAX_MODEL_HINT_CHARS: 200,
    MAX_NUDGE_CHARS: 4000,
    MAX_SESSION_BUDGET_MINUTES: 10080,
    MAX_SPEND_CAP_CENTS: 100000000,
    MAX_STUCK_THRESHOLD_ITERATIONS: 1000,
    MAX_WALL_CLOCK_LIMIT_HOURS: 8760,
}));
jest.mock('@ever-works/agent/entities', () => ({
    BudgetOwnerType: { MISSION: 'mission' },
    MISSION_WORK_RELATIONS: ['creates', 'improves', 'operates', 'markets', 'researches', 'retires'],
    MissionOutcome: {},
}));
jest.mock('@ever-works/agent/agents', () => ({
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AGENT_GUARDRAIL_MODES: ['strict', 'guided', 'permissive'],
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
    AgentsService: class {},
    AgentFileService: class {},
    AgentExportService: class {},
    AgentScheduleDispatcherService: class {},
    AgentRunRepository: class {},
    AgentRunLogRepository: class {},
    RunDispatchGateService: class {},
    RunSteeringService: class {},
    AgentTemplatesService: class {},
    SkillBindingRepository: class {},
    PluginUsageRepository: class {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    AGENT_TASK_EXECUTE_DISPATCHER: 'AGENT_TASK_EXECUTE_DISPATCHER',
    TasksService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class {},
    ActivityActionType: {
        AGENT_CREATED: 'agent_created',
        AGENT_PAUSED: 'agent_paused',
        AGENT_RESUMED: 'agent_resumed',
        AGENT_ARCHIVED: 'agent_archived',
        AGENT_UNARCHIVED: 'agent_unarchived',
        AGENT_EXPORTED: 'agent_exported',
        AGENT_IMPORTED: 'agent_imported',
        AGENT_BUDGET_EXCEEDED: 'agent_budget_exceeded',
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
        AGENT_RUN_CANCELLED: 'agent_run_cancelled',
        AGENT_TASK_ASSIGNED: 'agent_task_assigned',
        AGENT_COLLABORATOR_ENABLED: 'agent_collaborator_enabled',
        AGENT_COLLABORATOR_DISABLED: 'agent_collaborator_disabled',
        AGENT_COLLABORATOR_REMOVED: 'agent_collaborator_removed',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));
jest.mock('./missions/dto/mission.dto', () => ({
    AddMissionAttachmentDto: class {},
    AttachMissionWorkDto: class {},
    CloneMissionDto: class {},
    CompleteMissionDto: class {},
    CreateMissionDto: class {},
    UpdateMissionDto: class {},
}));
jest.mock('./goals/dto/goal.dto', () => ({
    CreateGoalDto: class {},
    LinkMissionGoalDto: class {},
    UpdateGoalDto: class {},
}));
jest.mock('./goals/dto/goal-orchestration.dto', () => ({
    ApproveGoalDodDto: class {},
    NudgeGoalDto: class {},
    PatchGoalDodCriterionDto: class {},
    ProposeGoalDodDto: class {},
    SetGoalDodDto: class {},
    UpdateGoalLimitsDto: class {},
}));
jest.mock('./agents/dto/agent.dto', () => ({
    AddAgentAttachmentDto: class {},
    AgentTargetBodyDto: class {},
    AssignTaskToAgentDto: class {},
    CreateAgentDto: class {},
    CreateAgentFromTemplateDto: class {},
    ListAgentRunsQueryDto: class {},
    ListAgentsQueryDto: class {},
    ListRunSessionsQueryDto: class {},
    ResumeRunDto: class {},
    SessionDetailQueryDto: class {},
    SteerRunDto: class {},
    UpdateAgentDto: class {},
    UpdateAgentGuardrailsDto: class {},
}));

import { AgentsController } from './agents/agents.controller';
import { GoalsController } from './goals/goals.controller';
import { MissionsController } from './missions/missions.controller';

const scope = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const auth = { userId: 'user-1' } as never;
const scopeContext = { getScope: () => scope };

describe('Organization ownership controller wiring', () => {
    it('passes the active request scope to Mission list and get', async () => {
        const service = {
            listForUser: jest.fn(
                async (_userId: string, _filter: unknown, activeScope?: unknown) =>
                    activeScope ? [{ id: 'mission-ever', ...scope }] : [],
            ),
            getForUser: jest.fn(async (_userId: string, id: string, activeScope?: unknown) =>
                activeScope ? { id, ...scope } : null,
            ),
        };
        const controller = new (MissionsController as any)(service, {}, {}, {}, scopeContext);

        await expect(controller.list(auth)).resolves.toEqual([{ id: 'mission-ever', ...scope }]);
        await expect(controller.getOne(auth, 'mission-ever')).resolves.toEqual({
            id: 'mission-ever',
            ...scope,
        });
    });

    it('passes the active request scope to Goal list and get', async () => {
        const service = {
            listForUser: jest.fn(
                async (_userId: string, _filter: unknown, activeScope?: unknown) =>
                    activeScope ? [{ id: 'goal-ever', ...scope }] : [],
            ),
            getForUser: jest.fn(async (_userId: string, id: string, activeScope?: unknown) =>
                activeScope ? { id, ...scope } : null,
            ),
        };
        const controller = new (GoalsController as any)(service, {}, scopeContext);

        await expect(controller.list(auth)).resolves.toEqual([{ id: 'goal-ever', ...scope }]);
        await expect(controller.getOne(auth, 'goal-ever')).resolves.toEqual({
            id: 'goal-ever',
            ...scope,
        });
    });

    it('passes the active request scope to Agent list and get', async () => {
        const service = {
            list: jest.fn(async (_userId: string, _filter: unknown, activeScope?: unknown) => ({
                rows: activeScope ? [{ id: 'agent-ever', ...scope }] : [],
                total: activeScope ? 1 : 0,
            })),
            getOne: jest.fn(async (_userId: string, id: string, activeScope?: unknown) =>
                activeScope ? { id, ...scope } : null,
            ),
        };
        const controller = new (AgentsController as any)(
            service,
            ...Array.from({ length: 15 }, () => ({})),
            scopeContext,
        );

        await expect(controller.list(auth, {})).resolves.toMatchObject({
            data: [{ id: 'agent-ever', ...scope }],
            meta: { total: 1 },
        });
        await expect(controller.getOne(auth, 'agent-ever')).resolves.toEqual({
            id: 'agent-ever',
            ...scope,
        });
    });
});
