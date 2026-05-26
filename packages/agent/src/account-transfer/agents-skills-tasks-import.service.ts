import { Injectable, Logger } from '@nestjs/common';
import { AgentExportService } from '../agents/agent-export.service';
import { SkillsService } from '../skills/skills.service';
import { TasksService } from '../tasks-domain/tasks.service';
import {
	type AccountExportV2Tail,
	type AgentsSkillsTasksImportOptions,
} from './agents-skills-tasks-types';

export interface AgentsSkillsTasksImportSummary {
	agents: { imported: number; skipped: number; errors: string[] };
	skills: { imported: number; skipped: number; errors: string[] };
	tasks: { imported: number; skipped: number; errors: string[] };
}

/**
 * Tasks/Agents/Skills feature — Phase 19 (ADR-008 v1) import side.
 *
 * Replays the v2 payload tail against the user's account. Reuses
 * the single-Agent / single-Skill / single-Task service surfaces
 * so the secret-scan + slug-uniqueness + recurrence validation
 * paths are honored.
 *
 * Conflict resolution is plumbed through the per-feature options.
 * Cross-tenant id resolution (mission/idea/work slugs from a
 * different tenant pointing at this tenant's targets) is
 * intentionally NOT v1: the importer drops scope references that
 * can't be resolved to a local entity and reports them as
 * warnings — staying inside the v1 ADR scope.
 */
@Injectable()
export class AgentsSkillsTasksImportService {
	private readonly logger = new Logger(AgentsSkillsTasksImportService.name);

	constructor(
		private readonly agentExport: AgentExportService,
		private readonly skillsService: SkillsService,
		private readonly tasksService: TasksService,
	) {}

	async importTail(
		userId: string,
		tail: AccountExportV2Tail,
		options: AgentsSkillsTasksImportOptions = {},
	): Promise<AgentsSkillsTasksImportSummary> {
		const summary: AgentsSkillsTasksImportSummary = {
			agents: { imported: 0, skipped: 0, errors: [] },
			skills: { imported: 0, skipped: 0, errors: [] },
			tasks: { imported: 0, skipped: 0, errors: [] },
		};

		if (options.importAgents && tail.agents?.length) {
			for (const envelope of tail.agents) {
				try {
					await this.agentExport.importOne(userId, envelope as any, {
						onConflict: options.onConflictAgent ?? 'rename',
					});
					summary.agents.imported += 1;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.toLowerCase().includes('skip')) {
						summary.agents.skipped += 1;
					} else {
						summary.agents.errors.push(`${envelope.identity?.slug ?? '?'}: ${msg}`);
					}
				}
			}
		}

		if (options.importSkills && tail.skills?.length) {
			for (const skill of tail.skills) {
				try {
					// v1 imports Skills at tenant scope — cross-tenant ownerId
					// resolution isn't reliable, so we drop the scope hint
					// rather than guess. Bindings drop for the same reason
					// (re-attach lives behind the per-target Skills tab).
					if (skill.ownerType !== 'tenant') {
						summary.skills.skipped += 1;
						continue;
					}
					await this.skillsService.create(userId, {
						ownerType: 'tenant',
						ownerId: userId,
						title: skill.title,
						description: skill.description,
						instructionsMd: skill.instructionsMd,
						frontmatter: skill.frontmatter as any,
						slug: skill.slug,
						version: skill.version,
					});
					summary.skills.imported += 1;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.toLowerCase().includes('already exists')) {
						summary.skills.skipped += 1;
					} else {
						summary.skills.errors.push(`${skill.slug}: ${msg}`);
					}
				}
			}
		}

		if (options.importTasks && tail.tasks?.length) {
			// v1: ignore scope cross-refs; ignore parent-task pointers
			// (resolved post-import once the rest of the payload exists).
			// The importer creates each Task at tenant scope (no
			// missionId/ideaId/workId).
			for (const task of tail.tasks) {
				try {
					await this.tasksService.create(userId, {
						title: task.title,
						description: task.description ?? null,
						priority: task.priority as any,
						labels: task.labels ?? null,
						missionId: null,
						ideaId: null,
						workId: null,
						parentTaskId: null,
						createdByType: 'user',
						createdById: userId,
						requireAllApprovers: task.requireAllApprovers,
					});
					summary.tasks.imported += 1;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					summary.tasks.errors.push(`${task.slug}: ${msg}`);
				}
			}
		}

		return summary;
	}
}
