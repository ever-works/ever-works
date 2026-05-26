import { Injectable, Logger } from '@nestjs/common';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentExportService } from '../agents/agent-export.service';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import {
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
    TaskChatMessageRepository,
} from '../database/repositories/task-side.repositories';
import {
    type AccountExportV2Tail,
    type AgentsSkillsTasksExportOptions,
    type ExportedAgent,
    type ExportedSkill,
    type ExportedSkillBinding,
    type ExportedTask,
} from './agents-skills-tasks-types';

/**
 * Tasks/Agents/Skills feature — Phase 19 (ADR-008 v1).
 *
 * Standalone extension service that gathers the v2 account-transfer
 * payload tail (Agents + Skills + Tasks). The existing
 * `AccountExportService` composes it via the new opts toggle.
 *
 * Designed for additive integration: callers pass the option flags
 * + (optionally) a slug→local-id resolver map; the service returns
 * a JSON-serializable tail object. Empty arrays are stable defaults
 * so the wrapper can decide whether to bump payload version.
 */
@Injectable()
export class AgentsSkillsTasksExportService {
    private readonly logger = new Logger(AgentsSkillsTasksExportService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly agentExport: AgentExportService,
        private readonly skills: SkillRepository,
        private readonly bindings: SkillBindingRepository,
        private readonly tasks: TaskRepository,
        private readonly assignees: TaskAssigneeRepository,
        private readonly reviewers: TaskReviewerRepository,
        private readonly approvers: TaskApproverRepository,
        private readonly chat: TaskChatMessageRepository,
    ) {}

    async exportTail(
        userId: string,
        options: AgentsSkillsTasksExportOptions = {},
    ): Promise<AccountExportV2Tail> {
        const out: AccountExportV2Tail = {};

        if (options.includeAgents) {
            out.agents = await this.exportAgents(userId);
        }
        if (options.includeSkills) {
            out.skills = await this.exportSkills(userId);
        }
        if (options.includeTasks) {
            out.tasks = await this.exportTasks(userId, options.includeTaskChat === true);
        }

        return out;
    }

    private async exportAgents(userId: string): Promise<ExportedAgent[]> {
        const { rows } = await this.agents
            .findByUserIdScoped(userId, { limit: 1000 })
            .catch(() => ({ rows: [], total: 0 }));
        const exported: ExportedAgent[] = [];
        for (const agent of rows) {
            try {
                const env = await this.agentExport.exportOne(userId, agent.id);
                exported.push({ ...(env as any), __kind: 'agent' });
            } catch (err) {
                this.logger.warn(`Skipping Agent ${agent.id} in export: ${err}`);
            }
        }
        return exported;
    }

    private async exportSkills(userId: string): Promise<ExportedSkill[]> {
        const { rows } = await this.skills
            .findByUserIdFiltered(userId, { limit: 1000 })
            .catch(() => ({ rows: [], total: 0 }));
        const out: ExportedSkill[] = [];
        for (const skill of rows) {
            const skillBindings = await this.bindings.findBySkillId(skill.id).catch(() => []);
            const bindings: ExportedSkillBinding[] = skillBindings.map((b) => ({
                targetType: b.targetType,
                // Cross-tenant ids are meaningless — the importer re-resolves
                // the target via local slug lookup. Tenant bindings carry
                // null because the userId alone identifies them.
                targetSlug: b.targetType === 'tenant' ? null : (b.targetId ?? null),
                priority: b.priority,
                injectIntoAgent: b.injectIntoAgent,
                injectIntoGenerator: b.injectIntoGenerator,
            }));
            out.push({
                __kind: 'skill',
                ownerType: skill.ownerType,
                // Review-fix I9: this is the source ownerId (UUID),
                // not a slug. Field renamed to ownerSourceId.
                ownerSourceId: skill.ownerType === 'tenant' ? null : skill.ownerId,
                slug: skill.slug,
                title: skill.title,
                description: skill.description,
                frontmatter: skill.frontmatter as Record<string, unknown>,
                instructionsMd: skill.instructionsMd,
                sourceCatalogSlug: skill.sourceCatalogSlug ?? null,
                sourceCatalogVersion: skill.sourceCatalogVersion ?? null,
                version: skill.version,
                bindings,
            });
        }
        return out;
    }

    private async exportTasks(userId: string, includeChat: boolean): Promise<ExportedTask[]> {
        const { rows } = await this.tasks
            .findByUserIdFiltered(userId, { limit: 1000 })
            .catch(() => ({ rows: [], total: 0 }));

        // Build an id→slug lookup so parent + parent-recurring pointers can be
        // rewritten in slug-space (cross-tenant ids are meaningless).
        const idToSlug = new Map<string, string>();
        for (const t of rows) idToSlug.set(t.id, t.slug);

        const out: ExportedTask[] = [];
        for (const task of rows) {
            const [a, r, ap] = await Promise.all([
                this.assignees.findByTaskId(task.id).catch(() => []),
                this.reviewers.findByTaskId(task.id).catch(() => []),
                this.approvers.findByTaskId(task.id).catch(() => []),
            ]);
            const chat = includeChat
                ? await this.chat.findByTaskId(task.id, 500, 0).catch(() => [])
                : undefined;

            out.push({
                __kind: 'task',
                slug: task.slug,
                title: task.title,
                description: task.description ?? null,
                status: task.status,
                priority: task.priority,
                labels: task.labels ?? null,
                // Review-fix I9: these are source UUIDs, not slugs.
                // Field names corrected to match the actual values.
                missionSourceId: task.missionId ?? null,
                ideaSourceId: task.ideaId ?? null,
                workSourceId: task.workId ?? null,
                parentTaskSlug: task.parentTaskId
                    ? (idToSlug.get(task.parentTaskId) ?? null)
                    : null,
                isRecurring: task.isRecurring,
                recurrenceRule: task.recurrenceRule ?? null,
                recurrenceTimezone: task.recurrenceTimezone ?? null,
                recurrenceEndsAt: task.recurrenceEndsAt?.toISOString() ?? null,
                recurrenceMaxOccurrences: task.recurrenceMaxOccurrences ?? null,
                parentRecurringTaskSlug: task.parentRecurringTaskId
                    ? (idToSlug.get(task.parentRecurringTaskId) ?? null)
                    : null,
                assignees: a.map((row) => ({ type: row.assigneeType, identifier: row.assigneeId })),
                reviewers: r.map((row) => ({ type: row.reviewerType, identifier: row.reviewerId })),
                approvers: ap.map((row) => ({
                    type: row.approverType,
                    identifier: row.approverId,
                })),
                requireAllApprovers: task.requireAllApprovers,
                createdAt: task.createdAt.toISOString(),
                startedAt: task.startedAt?.toISOString() ?? null,
                completedAt: task.completedAt?.toISOString() ?? null,
                chat: chat
                    ? chat.map((m) => ({
                          authorType: m.authorType,
                          authorIdentifier: m.authorId,
                          body: m.body,
                          createdAt: m.createdAt.toISOString(),
                      }))
                    : undefined,
            });
        }
        return out;
    }
}
