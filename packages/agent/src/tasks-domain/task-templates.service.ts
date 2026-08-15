import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { Task, TaskPriority, TaskStatus } from '../entities/task.entity';
import { Mission } from '../entities/mission.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskBlock } from '../entities/task-block.entity';
import { TaskTemplate } from '../entities/task-template.entity';
import { TaskTemplateStep } from '../entities/task-template-step.entity';
import { TaskTemplateRepository } from '../database/repositories/task-template.repository';
import { UserTaskCounterRepository } from '../database/repositories/task-side.repositories';
import { AgentRepository } from '../database/repositories/agent.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';

export interface TaskTemplateStepInput {
    title: string;
    prompt?: string | null;
    agentId?: string | null;
    agentTemplateSlug?: string | null;
    requiresApproval?: boolean;
    /** 0-based positions of steps this one depends on. */
    dependsOn?: number[];
}

export interface CreateTaskTemplateInput {
    name: string;
    slug?: string;
    description?: string | null;
    labels?: string[] | null;
    steps: TaskTemplateStepInput[];
}

export interface UpdateTaskTemplateInput {
    name?: string;
    description?: string | null;
    labels?: string[] | null;
    /** Replaces the step list wholesale when provided. */
    steps?: TaskTemplateStepInput[];
}

export interface InstantiateTemplateInput {
    title: string;
    description?: string | null;
    workId?: string | null;
    missionId?: string | null;
    ideaId?: string | null;
    /** Pre-names the parent Task's isolated branch (`branchRef`). */
    branchName?: string | null;
    priority?: TaskPriority;
}

export interface InstantiatedTemplateResult {
    parentTask: Task;
    subtasks: Task[];
}

export type TaskTemplateWithSteps = TaskTemplate & { steps: TaskTemplateStep[] };

export const MAX_TEMPLATE_STEPS = 30;

/** Seeded on first list — the canonical spec→plan→implement→review loop. */
export const DEFAULT_TEMPLATE_SLUG = 'compound-engineering-workflow';

const DEFAULT_TEMPLATE_STEPS: TaskTemplateStepInput[] = [
    {
        title: 'Write spec',
        prompt: 'Write a complete specification for the feature described on the parent task: goals, non-goals, user stories, data model, API surface and acceptance criteria.',
        agentTemplateSlug: 'starter-spec-writer',
        requiresApproval: true,
    },
    {
        title: 'Plan implementation',
        prompt: 'Turn the approved spec into a step-by-step implementation plan: files to touch, migrations, tests, rollout order and risks.',
        agentTemplateSlug: 'starter-planner',
        requiresApproval: true,
        dependsOn: [0],
    },
    {
        title: 'Plan review',
        prompt: 'Review the implementation plan against the spec. Flag gaps, over-engineering, and missing tests. Output a numbered list of required changes.',
        agentTemplateSlug: 'starter-review-coordinator',
        dependsOn: [1],
    },
    {
        title: 'Revise plan from review',
        prompt: 'Apply every required change from the plan review to the implementation plan and re-publish it.',
        agentTemplateSlug: 'starter-planner',
        dependsOn: [2],
    },
    {
        title: 'Implement',
        prompt: 'Execute the approved implementation plan end-to-end on the task branch: code, migrations and tests, keeping commits small and conventional.',
        agentTemplateSlug: 'starter-plan-executor',
        dependsOn: [3],
    },
    {
        title: 'AI review',
        prompt: 'Review the implementation diff for correctness, security and convention drift. Output a numbered findings list ranked by severity.',
        agentTemplateSlug: 'starter-review-coordinator',
        dependsOn: [4],
    },
    {
        title: 'Apply review fixes',
        prompt: 'Fix every confirmed finding from the AI review and re-run the test suite.',
        agentTemplateSlug: 'starter-senior-dev',
        dependsOn: [5],
    },
    {
        title: 'Update wiki',
        prompt: 'Document what shipped: update the knowledge base with the final design, decisions taken and follow-ups.',
        agentTemplateSlug: 'starter-librarian',
        dependsOn: [6],
    },
    {
        title: 'Review & Deploy',
        prompt: 'Human step — review the final PR and deploy.',
        agentTemplateSlug: null,
        dependsOn: [7],
    },
];

/**
 * Tasks upgrades — workflow Task Templates.
 *
 * CRUD over `task_templates` / `task_template_steps` plus the
 * instantiation path that expands a template into a parent Task + one
 * sub-task per step, all inside ONE transaction: dependency edges become
 * `task_blocks` rows keyed by step position, steps with a reachable
 * `agentId` get a `task_assignees` row, and `requiresApproval` steps get
 * a `task_approvers` row for the owner.
 *
 * Owner-scoped throughout: cross-user template ids 404 (no existence
 * leak), and agent bindings are validated against the acting user before
 * a single row is written.
 */
@Injectable()
export class TaskTemplatesService {
    private readonly logger = new Logger(TaskTemplatesService.name);

    constructor(
        private readonly templates: TaskTemplateRepository,
        private readonly counter: UserTaskCounterRepository,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        // Security: the instantiate path stamps `missionId` / `ideaId`
        // onto the parent Task AND every sub-task, so they need the same
        // ownership check `TasksService.assertScopeReachable` applies on
        // the ordinary create path. Appended LAST + @Optional() so every
        // positional construction in the specs keeps compiling.
        @Optional()
        @InjectRepository(Mission)
        private readonly missions?: Repository<Mission>,
        @Optional() private readonly ideas?: WorkProposalRepository,
    ) {}

    /**
     * List the user's templates (steps embedded). Seeds the default
     * "Compound Engineering Workflow" on a user's FIRST list so the
     * templates surface is never empty — the simple consistent-with-repo
     * seeding approach (a migration insert cannot know future users).
     */
    async list(userId: string): Promise<TaskTemplateWithSteps[]> {
        await this.seedDefaultsIfEmpty(userId);
        const rows = await this.templates.findByUserId(userId);
        const stepsByTemplate = await this.templates.findStepsByTemplateIds(rows.map((r) => r.id));
        return rows.map((row) => ({ ...row, steps: stepsByTemplate.get(row.id) ?? [] }));
    }

    async getOne(userId: string, id: string): Promise<TaskTemplateWithSteps> {
        const template = await this.templates.findByIdAndUser(id, userId);
        if (!template) throw new NotFoundException(`Task template ${id} not found.`);
        const steps = await this.templates.findStepsByTemplateId(id);
        return { ...template, steps };
    }

    async create(userId: string, input: CreateTaskTemplateInput): Promise<TaskTemplateWithSteps> {
        this.assertName(input.name);
        const steps = this.normalizeSteps(input.steps);
        await this.assertStepAgentsReachable(userId, steps);
        const slug = this.slugify(input.slug || input.name);
        const existing = await this.templates.findBySlugAndUser(slug, userId);
        if (existing) {
            throw new ConflictException(`A task template with slug '${slug}' already exists.`);
        }
        const created = await this.templates.createWithSteps(
            {
                userId,
                name: input.name.trim(),
                slug,
                description: input.description ?? null,
                labels: input.labels ?? null,
            },
            steps,
        );
        return this.getOne(userId, created.id);
    }

    async update(
        userId: string,
        id: string,
        input: UpdateTaskTemplateInput,
    ): Promise<TaskTemplateWithSteps> {
        await this.getOne(userId, id);
        const patch: Partial<TaskTemplate> = {};
        if (input.name !== undefined) {
            this.assertName(input.name);
            patch.name = input.name.trim();
        }
        if (input.description !== undefined) patch.description = input.description;
        if (input.labels !== undefined) patch.labels = input.labels;
        if (Object.keys(patch).length > 0) {
            await this.templates.updateById(id, patch);
        }
        if (input.steps !== undefined) {
            const steps = this.normalizeSteps(input.steps);
            await this.assertStepAgentsReachable(userId, steps);
            await this.templates.replaceSteps(id, steps);
        }
        return this.getOne(userId, id);
    }

    async remove(userId: string, id: string): Promise<{ deleted: true }> {
        await this.getOne(userId, id);
        await this.templates.deleteById(id);
        return { deleted: true } as const;
    }

    /**
     * Expand a template into a parent Task + one sub-task per step —
     * the whole tree in one transaction, so a failure mid-way leaves
     * nothing behind.
     */
    async instantiateTemplate(
        userId: string,
        templateId: string,
        input: InstantiateTemplateInput,
    ): Promise<InstantiatedTemplateResult> {
        const template = await this.getOne(userId, templateId);
        if (!input.title || input.title.trim().length === 0) {
            throw new BadRequestException('title is required.');
        }
        if (input.title.length > 200) {
            throw new BadRequestException('title exceeds 200 characters.');
        }
        if (template.steps.length === 0) {
            throw new BadRequestException('Template has no steps to instantiate.');
        }
        await this.assertOwnersReachable(userId, input);
        // Validate agent bindings BEFORE allocating slugs / opening the
        // transaction, and remember which are assignable.
        const reachableAgentIds = new Set<string>();
        for (const step of template.steps) {
            if (step.agentId && this.agents) {
                const agent = await this.agents
                    .findByIdAndUser(step.agentId, userId)
                    .catch(() => null);
                if (agent) reachableAgentIds.add(step.agentId);
            }
        }

        // Slug pre-allocation happens outside the transaction: the counter
        // uses its own atomic upsert, and a rolled-back instantiation
        // wasting a few numbers is harmless (slugs are unique, not dense).
        const slugNumbers: number[] = [];
        for (let i = 0; i < template.steps.length + 1; i++) {
            slugNumbers.push(await this.counter.nextSlug(userId));
        }

        const owners = {
            workId: input.workId ?? null,
            missionId: input.missionId ?? null,
            ideaId: input.ideaId ?? null,
        };
        const branchRef = input.branchName?.trim() ? input.branchName.trim().slice(0, 200) : null;

        const result = await this.templates.withTransaction(async (manager: EntityManager) => {
            const parent = await manager.save(
                manager.create(Task, {
                    userId,
                    slug: `T-${slugNumbers[0]}`,
                    title: input.title.trim(),
                    description: this.buildParentDescription(template, input),
                    status: TaskStatus.TODO,
                    priority: input.priority ?? TaskPriority.P2,
                    labels: template.labels ?? null,
                    ...owners,
                    parentTaskId: null,
                    createdByType: 'user' as const,
                    createdById: userId,
                    requireAllApprovers: true,
                    branchRef,
                }),
            );

            const subtasks: Task[] = [];
            for (let i = 0; i < template.steps.length; i++) {
                const step = template.steps[i];
                const subtask = await manager.save(
                    manager.create(Task, {
                        userId,
                        slug: `T-${slugNumbers[i + 1]}`,
                        title: step.title,
                        description: this.buildStepDescription(step, input),
                        status: TaskStatus.TODO,
                        priority: input.priority ?? TaskPriority.P2,
                        labels: template.labels ?? null,
                        ...owners,
                        parentTaskId: parent.id,
                        createdByType: 'user' as const,
                        createdById: userId,
                        requireAllApprovers: true,
                    }),
                );
                subtasks.push(subtask);
            }

            // Dependency edges — dependsOn positions → task_blocks rows.
            for (let i = 0; i < template.steps.length; i++) {
                const deps = template.steps[i].dependsOn ?? [];
                for (const dep of deps) {
                    await manager.save(
                        manager.create(TaskBlock, {
                            taskId: subtasks[i].id,
                            blockedByTaskId: subtasks[dep].id,
                        }),
                    );
                }
            }

            // Agent assignees + owner approvers per step.
            for (let i = 0; i < template.steps.length; i++) {
                const step = template.steps[i];
                if (step.agentId && reachableAgentIds.has(step.agentId)) {
                    await manager.save(
                        manager.create(TaskAssignee, {
                            taskId: subtasks[i].id,
                            assigneeType: 'agent' as const,
                            assigneeId: step.agentId,
                        }),
                    );
                }
                if (step.requiresApproval) {
                    await manager.save(
                        manager.create(TaskApprover, {
                            taskId: subtasks[i].id,
                            approverType: 'user' as const,
                            approverId: userId,
                        }),
                    );
                }
            }

            return { parentTask: parent, subtasks };
        });

        await this.logInstantiation(userId, template, result);
        return result;
    }

    // ── internals ─────────────────────────────────────────────────

    private async seedDefaultsIfEmpty(userId: string): Promise<void> {
        try {
            const count = await this.templates.countByUserId(userId);
            if (count > 0) return;
            await this.templates.createWithSteps(
                {
                    userId,
                    name: 'Compound Engineering Workflow',
                    slug: DEFAULT_TEMPLATE_SLUG,
                    description:
                        'Spec → plan → review loop → implement → AI review → fixes → wiki → human deploy. Map your own agents onto each step; the slugs are starter-agent hints.',
                    labels: ['workflow', 'engineering'],
                },
                this.normalizeSteps(DEFAULT_TEMPLATE_STEPS),
            );
        } catch (err) {
            // Unique-violation = a concurrent first-list won the seed race;
            // anything else is logged and the list proceeds unseeded.
            const message = err instanceof Error ? err.message : String(err);
            if (!/unique|duplicate|UNIQUE/i.test(message)) {
                this.logger.warn(`Default task-template seed failed for ${userId}: ${message}`);
            }
        }
    }

    private normalizeSteps(inputs: TaskTemplateStepInput[]): Partial<TaskTemplateStep>[] {
        if (!Array.isArray(inputs) || inputs.length === 0) {
            throw new BadRequestException('A template requires at least one step.');
        }
        if (inputs.length > MAX_TEMPLATE_STEPS) {
            throw new BadRequestException(
                `A template may have at most ${MAX_TEMPLATE_STEPS} steps (received ${inputs.length}).`,
            );
        }
        const steps = inputs.map((step, position) => {
            if (!step.title || step.title.trim().length === 0) {
                throw new BadRequestException(`Step ${position} requires a title.`);
            }
            if (step.title.length > 200) {
                throw new BadRequestException(`Step ${position} title exceeds 200 characters.`);
            }
            const dependsOn = [...new Set(step.dependsOn ?? [])];
            for (const dep of dependsOn) {
                if (!Number.isInteger(dep) || dep < 0 || dep >= inputs.length) {
                    throw new BadRequestException(
                        `Step ${position} depends on unknown step position ${dep}.`,
                    );
                }
                if (dep === position) {
                    throw new BadRequestException(`Step ${position} cannot depend on itself.`);
                }
            }
            return {
                position,
                title: step.title.trim(),
                prompt: step.prompt ?? null,
                agentId: step.agentId ?? null,
                agentTemplateSlug: step.agentTemplateSlug ?? null,
                requiresApproval: step.requiresApproval ?? false,
                dependsOn: dependsOn.length > 0 ? dependsOn : null,
            };
        });
        this.assertAcyclic(steps);
        return steps;
    }

    /** Kahn's algorithm over dependsOn — rejects any dependency cycle. */
    private assertAcyclic(steps: Array<{ dependsOn?: number[] | null }>): void {
        const indegree = steps.map((s) => (s.dependsOn ?? []).length);
        const dependents = new Map<number, number[]>();
        steps.forEach((step, i) => {
            for (const dep of step.dependsOn ?? []) {
                const list = dependents.get(dep) ?? [];
                list.push(i);
                dependents.set(dep, list);
            }
        });
        const queue = indegree.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
        let visited = 0;
        while (queue.length > 0) {
            const current = queue.shift()!;
            visited += 1;
            for (const dependent of dependents.get(current) ?? []) {
                indegree[dependent] -= 1;
                if (indegree[dependent] === 0) queue.push(dependent);
            }
        }
        if (visited !== steps.length) {
            throw new BadRequestException('Template steps contain a dependency cycle.');
        }
    }

    /**
     * Security: every owner id the caller supplies is written onto the
     * parent Task and onto EVERY sub-task, so each one must belong to the
     * acting user. Without this a caller could file a whole task tree
     * against another user's Mission / Idea, which both pollutes the
     * victim's scoped rows and turns the endpoint into an existence
     * oracle (a real foreign id instantiates, a bogus one blows up on the
     * FK). Mirrors `TasksService.assertScopeReachable`, which is the
     * ordinary create path's guard — the two must not drift.
     */
    private async assertOwnersReachable(
        userId: string,
        input: InstantiateTemplateInput,
    ): Promise<void> {
        if (input.workId) {
            if (!this.works) {
                throw new BadRequestException('Work repository not wired in this context.');
            }
            const work = await this.works.findById(input.workId);
            if (!work || work.userId !== userId) {
                throw new BadRequestException(`Work ${input.workId} not found.`);
            }
        }
        if (input.missionId) {
            if (!this.missions) {
                throw new BadRequestException('Mission repository not wired in this context.');
            }
            const mission = await this.missions.findOne({
                where: { id: input.missionId, userId },
                select: ['id', 'userId'],
            });
            if (!mission) {
                throw new BadRequestException(`Mission ${input.missionId} not found.`);
            }
        }
        if (input.ideaId) {
            if (!this.ideas) {
                throw new BadRequestException('Idea repository not wired in this context.');
            }
            const idea = await this.ideas.findByIdForUser(input.ideaId, userId);
            if (!idea) {
                throw new BadRequestException(`Idea ${input.ideaId} not found.`);
            }
        }
    }

    private async assertStepAgentsReachable(
        userId: string,
        steps: Partial<TaskTemplateStep>[],
    ): Promise<void> {
        if (!this.agents) return;
        for (const step of steps) {
            if (!step.agentId) continue;
            const agent = await this.agents.findByIdAndUser(step.agentId, userId).catch(() => null);
            if (!agent) {
                throw new BadRequestException(
                    `Agent ${step.agentId} on step ${step.position} is not reachable for this user.`,
                );
            }
        }
    }

    private buildParentDescription(
        template: TaskTemplateWithSteps,
        input: InstantiateTemplateInput,
    ): string {
        const lines: string[] = [];
        if (input.description?.trim()) lines.push(input.description.trim());
        lines.push('', `Instantiated from template: ${template.name} (${template.slug})`);
        return lines.join('\n').trim();
    }

    private buildStepDescription(step: TaskTemplateStep, input: InstantiateTemplateInput): string {
        const lines: string[] = [];
        if (input.description?.trim()) lines.push(input.description.trim());
        if (step.prompt?.trim()) {
            // Per-step agent prompt rides in the description under a fixed
            // heading — no dedicated column, and executors already feed the
            // whole description to the agent.
            lines.push('', '## Agent prompt', '', step.prompt.trim());
        }
        return lines.join('\n').trim();
    }

    private slugify(raw: string): string {
        const slug = raw
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80)
            .replace(/-+$/g, '');
        if (!slug) throw new BadRequestException('Template slug cannot be empty.');
        return slug;
    }

    private assertName(name: string): void {
        if (!name || name.trim().length === 0) {
            throw new BadRequestException('Template name is required.');
        }
        if (name.length > 200) {
            throw new BadRequestException('Template name exceeds 200 characters.');
        }
    }

    private async logInstantiation(
        userId: string,
        template: TaskTemplateWithSteps,
        result: InstantiatedTemplateResult,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                action: ActivityActionType.TASK_CREATED,
                actionType: ActivityActionType.TASK_CREATED,
                status: ActivityStatus.COMPLETED,
                summary: `Task ${result.parentTask.id} — instantiated from template ${template.slug} (${result.subtasks.length} steps)`,
                details: {
                    resourceType: 'task',
                    resourceId: result.parentTask.id,
                    templateId: template.id,
                    templateSlug: template.slug,
                    subtaskCount: result.subtasks.length,
                },
            });
        } catch (err) {
            this.logger.warn(`Failed to log template instantiation: ${err}`);
        }
    }
}
