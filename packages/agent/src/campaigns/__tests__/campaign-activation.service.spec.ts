// `github-slugger` is ESM-only and reaches this spec transitively through
// `WorkLifecycleService -> MarkdownGeneratorService -> readme-builder`
// (a TYPE-only import here, but ts-jest still loads the module graph).
// Same stub the other work-lifecycle specs use.
jest.mock('github-slugger', () => ({
    __esModule: true,
    default: class {
        slug(s: string) {
            return s;
        }
    },
}));

import { BadRequestException } from '@nestjs/common';
import { AgentScope } from '../../entities/agent.entity';
import { TaskStatus } from '../../entities/task.entity';
import type { User } from '../../entities/user.entity';
import { CampaignActivationService } from '../campaign-activation.service';
import {
    CAMPAIGN_GOAL_DEFAULTS,
    CAMPAIGN_PIPELINE_ID,
    CAMPAIGN_SEED_STAGES,
    listCampaignAgentTemplateSlugs,
} from '../campaign-template';

/**
 * Campaign activation is pure orchestration over five owning services, so
 * the spec drives it with hand-rolled doubles and asserts on the calls:
 * what gets provisioned, that everything is owner-scoped, and that a
 * failure at any step leaves nothing behind.
 */

const USER = { id: 'user-1', username: 'founder' } as unknown as User;
const WORK_ID = 'work-1';

type Doubles = ReturnType<typeof buildDoubles>;

function buildDoubles() {
    let taskCounter = 0;
    let agentCounter = 0;

    const workLifecycle = {
        createCampaignWork: jest
            .fn()
            .mockImplementation(async (_user: User, params: Record<string, string>) => ({
                id: WORK_ID,
                slug: params.slug,
                name: params.name,
                kind: 'campaign',
                description: params.description,
            })),
    };
    const workQuery = {
        checkSlugAvailability: jest
            .fn()
            .mockImplementation(async (raw: string) => ({ available: true, slug: raw })),
    };
    const workRepository = { delete: jest.fn().mockResolvedValue(true) };
    const goals = {
        create: jest
            .fn()
            .mockImplementation(async (_userId: string, input: Record<string, unknown>) => ({
                id: 'goal-1',
                title: input.title,
                targetValue: input.targetValue,
                metricSource: input.metricSource,
                description: input.description,
                unit: input.unit,
                window: input.window,
            })),
        delete: jest.fn().mockResolvedValue({ deleted: true }),
    };
    const agentTemplates = {
        createFromTemplate: jest.fn().mockImplementation(async (_userId: string, slug: string) => ({
            id: `agent-${++agentCounter}`,
            name: slug,
        })),
    };
    const agents = { deleteHard: jest.fn().mockResolvedValue({ deleted: true }) };
    const tasks = {
        create: jest
            .fn()
            .mockImplementation(async (_userId: string, input: Record<string, unknown>) => ({
                id: `task-${++taskCounter}`,
                slug: `T-${taskCounter}`,
                title: input.title,
            })),
        remove: jest.fn().mockResolvedValue({ deleted: true }),
    };
    const pluginOperations = { enablePluginForWork: jest.fn().mockResolvedValue({}) };

    return {
        workLifecycle,
        workQuery,
        workRepository,
        goals,
        agentTemplates,
        agents,
        tasks,
        pluginOperations,
    };
}

function buildService(doubles: Doubles): CampaignActivationService {
    return new CampaignActivationService(
        doubles.workLifecycle as never,
        doubles.workQuery as never,
        doubles.workRepository as never,
        doubles.goals as never,
        doubles.agentTemplates as never,
        doubles.agents as never,
        doubles.tasks as never,
        doubles.pluginOperations as never,
    );
}

const BRIEF = {
    name: 'Q3 developer launch',
    objective: 'Book 25 qualified demos with platform engineering teams',
};

describe('CampaignActivationService — provisioning', () => {
    let doubles: Doubles;
    let service: CampaignActivationService;

    beforeEach(() => {
        doubles = buildDoubles();
        service = buildService(doubles);
    });

    it('provisions the Work, the Goal, the agents, the seeded tasks and the pipeline preference', async () => {
        const result = await service.activate(USER, {
            ...BRIEF,
            channels: ['email', 'LinkedIn'],
        });

        // 1. A campaign Work (repo-free, kind-pinned).
        expect(doubles.workLifecycle.createCampaignWork).toHaveBeenCalledTimes(1);
        expect(result.work).toMatchObject({ id: WORK_ID, kind: 'campaign' });

        // 2. A Goal capturing the objective, targeting a campaign metric.
        expect(doubles.goals.create).toHaveBeenCalledTimes(1);
        const goalInput = doubles.goals.create.mock.calls[0][1];
        expect(goalInput.title).toContain(BRIEF.objective);
        expect(goalInput.metricSource).toMatchObject({
            metricId: CAMPAIGN_GOAL_DEFAULTS.metricId,
            params: { workId: WORK_ID },
        });
        expect(goalInput.targetValue).toBe(CAMPAIGN_GOAL_DEFAULTS.targetValue);
        expect(goalInput.description).toContain('email');

        // 3. Every go-to-market template, scoped to the new Work.
        const expectedSlugs = listCampaignAgentTemplateSlugs();
        expect(result.agents.map((a) => a.templateSlug)).toEqual([...expectedSlugs]);
        for (const call of doubles.agentTemplates.createFromTemplate.mock.calls) {
            expect(call[2]).toMatchObject({ scope: AgentScope.WORK, workId: WORK_ID });
        }

        // 4. One Task per seeded stage, carrying BOTH owners (work + goal).
        expect(result.tasks.map((t) => t.stageId)).toEqual(
            CAMPAIGN_SEED_STAGES.map((s) => s.stageId),
        );
        const firstTask = doubles.tasks.create.mock.calls[0][1];
        expect(firstTask).toMatchObject({
            workId: WORK_ID,
            goalId: 'goal-1',
            status: TaskStatus.TODO,
            createdByType: 'user',
            createdById: USER.id,
        });
        expect(firstTask.labels).toEqual(
            expect.arrayContaining([CAMPAIGN_PIPELINE_ID, 'stage:research', 'email', 'LinkedIn']),
        );

        // 5. The pipeline preference.
        expect(doubles.pluginOperations.enablePluginForWork).toHaveBeenCalledWith(
            WORK_ID,
            CAMPAIGN_PIPELINE_ID,
            USER.id,
            { activeCapability: 'pipeline' },
        );
        expect(result.pipeline).toEqual({ id: CAMPAIGN_PIPELINE_ID, applied: true });
    });

    it('passes the activating user id to every owner-scoped service (no cross-account writes)', async () => {
        await service.activate(USER, BRIEF);

        expect(doubles.workLifecycle.createCampaignWork.mock.calls[0][0]).toBe(USER);
        expect(doubles.goals.create.mock.calls[0][0]).toBe(USER.id);
        for (const call of doubles.agentTemplates.createFromTemplate.mock.calls) {
            expect(call[0]).toBe(USER.id);
        }
        for (const call of doubles.tasks.create.mock.calls) {
            expect(call[0]).toBe(USER.id);
        }
        expect(doubles.pluginOperations.enablePluginForWork.mock.calls[0][2]).toBe(USER.id);
    });

    it('de-duplicates the slug through the existing availability check', async () => {
        doubles.workQuery.checkSlugAvailability.mockResolvedValue({
            available: false,
            slug: 'q3-developer-launch',
            suggestion: 'q3-developer-launch-2',
        });

        const result = await service.activate(USER, BRIEF);

        expect(result.work.slug).toBe('q3-developer-launch-2');
        expect(doubles.workLifecycle.createCampaignWork.mock.calls[0][1]).toMatchObject({
            slug: 'q3-developer-launch-2',
        });
    });

    it('honors an explicit target (metric, value, unit, window)', async () => {
        const result = await service.activate(USER, {
            ...BRIEF,
            target: { metricId: 'open-tasks', value: 42, unit: 'tasks', window: 'week' },
        });

        const goalInput = doubles.goals.create.mock.calls[0][1];
        expect(goalInput.metricSource.metricId).toBe('open-tasks');
        expect(goalInput.targetValue).toBe(42);
        expect(goalInput.unit).toBe('tasks');
        expect(goalInput.window).toBe('week');
        expect(result.goal.metricId).toBe('open-tasks');
    });

    it('rejects a metric outside the campaign kind’s vocabulary before writing anything', async () => {
        await expect(
            service.activate(USER, { ...BRIEF, target: { metricId: 'posts' } }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(doubles.workLifecycle.createCampaignWork).not.toHaveBeenCalled();
    });

    it('rejects a blank name / objective / non-positive target', async () => {
        await expect(service.activate(USER, { name: '  ', objective: 'x' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(service.activate(USER, { name: 'x', objective: ' ' })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(
            service.activate(USER, { ...BRIEF, target: { value: 0 } }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(doubles.workLifecycle.createCampaignWork).not.toHaveBeenCalled();
    });

    it('keeps the campaign when the pipeline plugin cannot be pinned (best-effort preference)', async () => {
        doubles.pluginOperations.enablePluginForWork.mockRejectedValue(
            new Error('Plugin "gtm-pipeline" not found'),
        );

        const result = await service.activate(USER, BRIEF);

        expect(result.work.id).toBe(WORK_ID);
        expect(result.pipeline.applied).toBe(false);
        expect(result.pipeline.reason).toContain('gtm-pipeline');
        // Nothing was rolled back — the campaign itself is complete.
        expect(doubles.workRepository.delete).not.toHaveBeenCalled();
        expect(doubles.tasks.remove).not.toHaveBeenCalled();
    });

    it('reports the preference as not applied when plugin operations are unavailable', async () => {
        const withoutPlugins = new CampaignActivationService(
            doubles.workLifecycle as never,
            doubles.workQuery as never,
            doubles.workRepository as never,
            doubles.goals as never,
            doubles.agentTemplates as never,
            doubles.agents as never,
            doubles.tasks as never,
        );

        const result = await withoutPlugins.activate(USER, BRIEF);

        expect(result.pipeline).toMatchObject({ id: CAMPAIGN_PIPELINE_ID, applied: false });
        expect(result.tasks).toHaveLength(CAMPAIGN_SEED_STAGES.length);
    });
});

describe('CampaignActivationService — atomicity', () => {
    let doubles: Doubles;
    let service: CampaignActivationService;

    beforeEach(() => {
        doubles = buildDoubles();
        service = buildService(doubles);
    });

    it('removes the Work and the Goal when agent creation fails', async () => {
        doubles.agentTemplates.createFromTemplate.mockRejectedValueOnce(
            new Error('template blew up'),
        );

        await expect(service.activate(USER, BRIEF)).rejects.toThrow('template blew up');

        expect(doubles.goals.delete).toHaveBeenCalledWith(USER.id, 'goal-1');
        expect(doubles.workRepository.delete).toHaveBeenCalledWith(WORK_ID);
        expect(doubles.tasks.remove).not.toHaveBeenCalled();
    });

    it('removes every artifact — tasks, agents, goal, work — when a later task fails', async () => {
        doubles.tasks.create
            .mockImplementationOnce(async () => ({ id: 'task-1', slug: 'T-1', title: 'first' }))
            .mockRejectedValueOnce(new Error('task blew up'));

        await expect(service.activate(USER, BRIEF)).rejects.toThrow('task blew up');

        expect(doubles.tasks.remove).toHaveBeenCalledWith(USER.id, 'task-1');
        expect(doubles.agents.deleteHard).toHaveBeenCalledTimes(
            listCampaignAgentTemplateSlugs().length,
        );
        expect(doubles.goals.delete).toHaveBeenCalledWith(USER.id, 'goal-1');
        expect(doubles.workRepository.delete).toHaveBeenCalledWith(WORK_ID);
        // Nothing partial survives: the pipeline pin never ran either.
        expect(doubles.pluginOperations.enablePluginForWork).not.toHaveBeenCalled();
    });

    it('rolls back in reverse creation order (tasks → agents → goal → work)', async () => {
        const order: string[] = [];
        doubles.tasks.remove.mockImplementation(async () => {
            order.push('task');
            return { deleted: true } as never;
        });
        doubles.agents.deleteHard.mockImplementation(async () => {
            order.push('agent');
            return { deleted: true } as never;
        });
        doubles.goals.delete.mockImplementation(async () => {
            order.push('goal');
            return { deleted: true } as never;
        });
        doubles.workRepository.delete.mockImplementation(async () => {
            order.push('work');
            return true as never;
        });
        doubles.tasks.create
            .mockImplementationOnce(async () => ({ id: 'task-1', slug: 'T-1', title: 'first' }))
            .mockRejectedValueOnce(new Error('boom'));

        await expect(service.activate(USER, BRIEF)).rejects.toThrow('boom');

        expect(order[0]).toBe('task');
        expect(order[order.length - 2]).toBe('goal');
        expect(order[order.length - 1]).toBe('work');
    });

    it('surfaces the original failure even when a cleanup step also fails', async () => {
        doubles.tasks.create.mockRejectedValueOnce(new Error('task blew up'));
        doubles.workRepository.delete.mockRejectedValue(new Error('cleanup blew up'));

        await expect(service.activate(USER, BRIEF)).rejects.toThrow('task blew up');

        // Cleanup was still attempted for the rest of the ledger.
        expect(doubles.goals.delete).toHaveBeenCalledWith(USER.id, 'goal-1');
        expect(doubles.agents.deleteHard).toHaveBeenCalled();
    });

    it('does not create anything when the Work itself cannot be created', async () => {
        doubles.workLifecycle.createCampaignWork.mockRejectedValue(new Error('slug taken'));

        await expect(service.activate(USER, BRIEF)).rejects.toThrow('slug taken');

        expect(doubles.goals.create).not.toHaveBeenCalled();
        expect(doubles.agentTemplates.createFromTemplate).not.toHaveBeenCalled();
        expect(doubles.tasks.create).not.toHaveBeenCalled();
        expect(doubles.workRepository.delete).not.toHaveBeenCalled();
    });
});
