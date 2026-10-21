import { AgentScope } from '../entities/agent.entity';
import type { Agent } from '../entities/agent.entity';
import { buildAgentTaskTools } from './agent-task-tools';
import type { TasksService } from './tasks.service';
import type { TaskChatService } from './task-chat.service';

describe('buildAgentTaskTools createTask ownership', () => {
    it('stamps a Task from the persisted organization-scoped Agent', async () => {
        const tasksService = {
            create: jest.fn().mockResolvedValue({ id: 'task-1', slug: 'ship-fix' }),
        } as unknown as TasksService;
        const agent = {
            id: 'agent-1',
            userId: 'user-1',
            scope: AgentScope.WORK,
            workId: 'work-1',
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
            permissions: { canAssignTasks: true },
        } as Agent;
        const [createTask] = buildAgentTaskTools({
            agent,
            tasksService,
            chatService: {} as TaskChatService,
        });

        await createTask.invoke({ title: 'Ship fix' });

        expect(tasksService.create).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({
                title: 'Ship fix',
                workId: 'work-1',
                createdByType: 'agent',
                createdById: 'agent-1',
            }),
            {
                tenantId: '11111111-1111-4111-8111-111111111111',
                organizationId: '22222222-2222-4222-8222-222222222222',
            },
        );
    });
});

describe('buildAgentTaskTools transitionTask (prompt-injection hardening)', () => {
    const agent = {
        id: 'agent-1',
        userId: 'user-1',
        scope: AgentScope.WORK,
        workId: 'work-1',
        permissions: { canAssignTasks: true },
    } as Agent;

    it('offers no force parameter', () => {
        const tools = buildAgentTaskTools({
            agent,
            tasksService: {} as TasksService,
            chatService: {} as TaskChatService,
        });
        const transition = tools.find((tool) => tool.name === 'transitionTask')!;
        expect(Object.keys(transition.parameters.properties)).not.toContain('force');
    });

    it('never forwards a model-supplied force=true — the move runs every gate', async () => {
        const tasksService = {
            transition: jest.fn().mockResolvedValue({ id: 'task-1', status: 'done' }),
        } as unknown as TasksService;
        const tools = buildAgentTaskTools({
            agent,
            tasksService,
            chatService: {} as TaskChatService,
        });
        const transition = tools.find((tool) => tool.name === 'transitionTask')!;
        await transition.invoke({ taskId: 'task-1', to: 'done', force: true });
        expect(tasksService.transition).toHaveBeenCalledWith('user-1', 'task-1', 'done', {
            force: false,
            actorType: 'agent',
        });
    });
});
