import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import type { WorkMetricId } from '@ever-works/contracts';
import { AgentScope } from '../entities/agent.entity';
import type { GoalWindow } from '../entities/goal.entity';
import type { User } from '../entities/user.entity';
import type { Work } from '../entities/work.entity';
import { AgentsService } from '../agents/agents.service';
import { AgentTemplatesService } from '../agents/agent-templates.service';
import { GoalsService } from '../goals/goals.service';
import { TasksService } from '../tasks-domain/tasks.service';
import { WorkLifecycleService } from '../services/work-lifecycle.service';
import { WorkQueryService } from '../services/work-query.service';
import { WorkRepository } from '../database/repositories/work.repository';
import { PluginOperationsService } from '../plugins/services/plugin-operations.service';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import {
    CAMPAIGN_GOAL_DEFAULTS,
    CAMPAIGN_GOAL_METRIC_IDS,
    CAMPAIGN_GOAL_METRIC_PLUGIN_ID,
    CAMPAIGN_PIPELINE_ID,
    CAMPAIGN_SEED_STAGES,
    listCampaignAgentTemplates,
} from './campaign-template';

/** Campaign brief accepted by {@link CampaignActivationService.activate}. */
export interface CampaignBrief {
    /** Display name of the campaign — also seeds the Work slug. */
    name: string;
    /** What the campaign is trying to achieve; becomes the Goal. */
    objective: string;
    /** Optional explicit slug; derived from `name` when omitted. */
    slug?: string | null;
    /** Optional measurable target for the Goal. */
    target?: {
        /** One of the campaign kind's metric ids (default `conversions`). */
        metricId?: string | null;
        value?: number | null;
        unit?: string | null;
        window?: GoalWindow | null;
    } | null;
    /** Channels the campaign runs on (labels on the drafting stages). */
    channels?: string[] | null;
}

/** Everything one activation provisioned. */
export interface CampaignActivationResult {
    work: { id: string; slug: string; name: string; kind: string };
    goal: { id: string; title: string; metricId: string; targetValue: number };
    agents: Array<{ id: string; name: string; templateSlug: string }>;
    tasks: Array<{ id: string; slug: string; title: string; stageId: string }>;
    pipeline: { id: string; applied: boolean; reason?: string };
}

/** Max channels accepted on a brief (labels are a bounded column). */
const MAX_CAMPAIGN_CHANNELS = 10;
const MAX_CHANNEL_LENGTH = 40;

/**
 * Campaign activation (roadmap 14.1 / audit G20).
 *
 * The `campaign` Work kind shipped with capabilities and metrics but
 * nothing minted one: it is not user-selectable, and no flow provisioned
 * its contents. This service is that flow — pure wiring over surfaces that
 * already exist:
 *
 *   1. `WorkLifecycleService.createCampaignWork` — a repo-free Work row of
 *      kind `campaign` (the `createCompanyWork` idiom);
 *   2. `GoalsService.create` — the objective as an ordinary DRAFT Goal,
 *      targeting a metric id from the campaign kind's own metric list;
 *   3. `AgentTemplatesService.createFromTemplate` — the prebuilt
 *      go-to-market agents, scoped to the new Work;
 *   4. `TasksService.create` — one Task per seeded `gtm-pipeline` stage,
 *      each carrying both `workId` and `goalId` (which is how a Goal and a
 *      Work relate today — there is no Work→Goal column to invent);
 *   5. `PluginOperationsService.enablePluginForWork` — the Work's pipeline
 *      preference, i.e. `gtm-pipeline` as the active `pipeline` capability
 *      provider for this Work.
 *
 * **Atomicity.** The five services own five different repositories and
 * there is no shared transaction to enlist them in, so activation runs as
 * a compensating transaction: every artifact is recorded as it is created
 * and, on ANY failure, they are removed in reverse order before the error
 * is rethrown. A caller therefore sees either a complete campaign or none
 * of it — never a half-provisioned Work.
 *
 * **Owner scope.** Every call is made with the activating user's id and
 * every service re-checks ownership itself, so activation can only ever
 * write into the caller's own account.
 */
@Injectable()
export class CampaignActivationService {
    private readonly logger = new Logger(CampaignActivationService.name);

    constructor(
        private readonly workLifecycle: WorkLifecycleService,
        private readonly workQuery: WorkQueryService,
        private readonly workRepository: WorkRepository,
        private readonly goals: GoalsService,
        private readonly agentTemplates: AgentTemplatesService,
        private readonly agents: AgentsService,
        private readonly tasks: TasksService,
        // Optional: the pipeline preference is a nice-to-have that depends
        // on plugin discovery being wired in this deployment. A missing
        // registration must not cost the user their campaign.
        @Optional() private readonly pluginOperations?: PluginOperationsService,
    ) {}

    async activate(user: User, brief: CampaignBrief): Promise<CampaignActivationResult> {
        const name = (brief?.name ?? '').trim();
        if (!name) {
            throw new BadRequestException('Campaign name is required.');
        }
        const objective = (brief?.objective ?? '').trim();
        if (!objective) {
            throw new BadRequestException('Campaign objective is required.');
        }

        const channels = this.normalizeChannels(brief.channels);
        const metricId = this.resolveMetricId(brief.target?.metricId);
        const targetValue = this.resolveTargetValue(brief.target?.value);
        const slug = await this.resolveSlug(brief.slug ?? name, user);

        // Rollback ledger — reverse order on failure.
        const createdTaskIds: string[] = [];
        const createdAgentIds: string[] = [];
        let createdGoalId: string | null = null;
        let work: Work | null = null;

        try {
            work = await this.workLifecycle.createCampaignWork(user, {
                name,
                slug,
                description: objective,
            });

            const goal = await this.goals.create(user.id, {
                title: `${name} — ${objective}`.slice(0, 200),
                description: this.buildGoalDescription(objective, channels),
                metricSource: {
                    pluginId: CAMPAIGN_GOAL_METRIC_PLUGIN_ID,
                    metricId,
                    params: { workId: work.id },
                },
                comparator: CAMPAIGN_GOAL_DEFAULTS.comparator,
                targetValue,
                unit: (brief.target?.unit ?? CAMPAIGN_GOAL_DEFAULTS.unit).trim(),
                window: brief.target?.window ?? CAMPAIGN_GOAL_DEFAULTS.window,
            });
            createdGoalId = goal.id;

            const agents: CampaignActivationResult['agents'] = [];
            for (const template of listCampaignAgentTemplates()) {
                const agent = await this.agentTemplates.createFromTemplate(user.id, template.slug, {
                    // Scoped to the campaign Work so activating a second
                    // campaign can reuse the same template names without
                    // tripping the per-scope name-uniqueness 409.
                    scope: AgentScope.WORK,
                    workId: work.id,
                });
                createdAgentIds.push(agent.id);
                agents.push({ id: agent.id, name: agent.name, templateSlug: template.slug });
            }

            const tasks: CampaignActivationResult['tasks'] = [];
            for (const stage of CAMPAIGN_SEED_STAGES) {
                const task = await this.tasks.create(user.id, {
                    title: `${stage.title}`,
                    description: this.buildTaskDescription(stage.description, objective, channels),
                    status: stage.status,
                    priority: stage.priority,
                    labels: [CAMPAIGN_PIPELINE_ID, `stage:${stage.stageId}`, ...channels],
                    workId: work.id,
                    // The Goal ↔ Work relation today IS the Task row: a Task
                    // may carry both owners at once (TASK_OWNER_KEYS).
                    goalId: goal.id,
                    createdByType: 'user',
                    createdById: user.id,
                });
                createdTaskIds.push(task.id);
                tasks.push({
                    id: task.id,
                    slug: task.slug,
                    title: task.title,
                    stageId: stage.stageId,
                });
            }

            const pipeline = await this.applyPipelinePreference(work.id, user.id);

            this.logger.log(
                `Activated campaign "${slug}" for user ${user.id}: work=${work.id} goal=${goal.id} ` +
                    `agents=${agents.length} tasks=${tasks.length} pipeline=${pipeline.applied}`,
            );

            return {
                work: { id: work.id, slug: work.slug, name: work.name, kind: work.kind },
                goal: {
                    id: goal.id,
                    title: goal.title,
                    metricId,
                    targetValue: goal.targetValue,
                },
                agents,
                tasks,
                pipeline,
            };
        } catch (error) {
            await this.rollback(user, {
                workId: work?.id ?? null,
                goalId: createdGoalId,
                agentIds: createdAgentIds,
                taskIds: createdTaskIds,
            });
            throw error;
        }
    }

    /**
     * Set `gtm-pipeline` as the Work's active pipeline provider.
     *
     * Best-effort on purpose: plugin availability is a deployment
     * property (the plugin must be discovered AND enabled at user level),
     * and a campaign without a pinned pipeline still works — the
     * orchestrator falls back to auto-detect. The outcome is reported back
     * so the caller/UI can surface "pipeline not pinned" instead of
     * pretending it was.
     */
    private async applyPipelinePreference(
        workId: string,
        userId: string,
    ): Promise<CampaignActivationResult['pipeline']> {
        if (!this.pluginOperations) {
            return {
                id: CAMPAIGN_PIPELINE_ID,
                applied: false,
                reason: 'Plugin operations unavailable in this deployment.',
            };
        }
        try {
            await this.pluginOperations.enablePluginForWork(workId, CAMPAIGN_PIPELINE_ID, userId, {
                activeCapability: PLUGIN_CAPABILITIES.PIPELINE,
            });
            return { id: CAMPAIGN_PIPELINE_ID, applied: true };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Campaign work ${workId}: could not pin the "${CAMPAIGN_PIPELINE_ID}" pipeline — ` +
                    `the orchestrator will auto-detect instead (${reason}).`,
            );
            return { id: CAMPAIGN_PIPELINE_ID, applied: false, reason };
        }
    }

    /**
     * Compensating rollback. Every step is individually guarded: a failing
     * cleanup is logged and the rest still runs, because the caller's
     * original error is the one worth surfacing.
     */
    private async rollback(
        user: User,
        created: {
            workId: string | null;
            goalId: string | null;
            agentIds: readonly string[];
            taskIds: readonly string[];
        },
    ): Promise<void> {
        for (const taskId of [...created.taskIds].reverse()) {
            await this.safely('task', taskId, () => this.tasks.remove(user.id, taskId));
        }
        for (const agentId of [...created.agentIds].reverse()) {
            await this.safely('agent', agentId, () => this.agents.deleteHard(user.id, agentId));
        }
        if (created.goalId) {
            await this.safely('goal', created.goalId, () =>
                this.goals.delete(user.id, created.goalId as string),
            );
        }
        if (created.workId) {
            await this.safely('work', created.workId, () =>
                this.workRepository.delete(created.workId as string),
            );
        }
    }

    private async safely(kind: string, id: string, fn: () => Promise<unknown>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.error(
                `Campaign activation rollback: failed to remove ${kind} ${id} — ` +
                    `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Metric ids are constrained to the campaign kind's own vocabulary. */
    private resolveMetricId(value?: string | null): WorkMetricId {
        if (value === undefined || value === null || value === '') {
            return CAMPAIGN_GOAL_DEFAULTS.metricId;
        }
        const match = CAMPAIGN_GOAL_METRIC_IDS.find((id) => id === value);
        if (!match) {
            throw new BadRequestException(
                `Unsupported campaign metric "${value}". Allowed: ${CAMPAIGN_GOAL_METRIC_IDS.join(', ')}.`,
            );
        }
        return match;
    }

    private resolveTargetValue(value?: number | null): number {
        if (value === undefined || value === null) return CAMPAIGN_GOAL_DEFAULTS.targetValue;
        if (!Number.isFinite(value) || value <= 0) {
            throw new BadRequestException('Campaign target value must be a positive number.');
        }
        return value;
    }

    private normalizeChannels(channels?: string[] | null): string[] {
        if (!Array.isArray(channels)) return [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const channel of channels) {
            if (typeof channel !== 'string') continue;
            const trimmed = channel.trim().slice(0, MAX_CHANNEL_LENGTH);
            if (!trimmed) continue;
            const key = trimmed.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(trimmed);
            if (out.length >= MAX_CAMPAIGN_CHANNELS) break;
        }
        return out;
    }

    /** First free `<slug>` / `<slug>-N` for this user, via the existing check. */
    private async resolveSlug(source: string, user: User): Promise<string> {
        const availability = await this.workQuery.checkSlugAvailability(source, user);
        if (availability.available) return availability.slug;
        if (availability.suggestion) return availability.suggestion;
        throw new BadRequestException(
            'Could not derive a free slug for this campaign. Pass an explicit slug.',
        );
    }

    private buildGoalDescription(objective: string, channels: readonly string[]): string {
        const base = `Campaign objective: ${objective}`;
        return channels.length > 0 ? `${base}\n\nChannels: ${channels.join(', ')}` : base;
    }

    private buildTaskDescription(
        stageDescription: string,
        objective: string,
        channels: readonly string[],
    ): string {
        const lines = [stageDescription, '', `Campaign objective: ${objective}`];
        if (channels.length > 0) {
            lines.push(`Channels: ${channels.join(', ')}`);
        }
        return lines.join('\n');
    }
}
