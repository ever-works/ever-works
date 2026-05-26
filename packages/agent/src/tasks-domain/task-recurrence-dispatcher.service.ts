import { Injectable, Logger } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import { UserTaskCounterRepository } from '../database/repositories/task-side.repositories';
import { computeNextOccurrence, cloneRecurringTaskAsInstance } from './recurrence';

export interface RecurrenceDispatchEntry {
	templateId: string;
	templateSlug: string;
	scheduledFor: string;
	outcome: 'spawned' | 'skipped' | 'failed';
	instanceId?: string;
	instanceSlug?: string;
	nextOccurrenceAt?: string | null;
	message?: string;
}

export interface RecurrenceDispatchSummary {
	limit: number;
	dueCount: number;
	spawned: number;
	skipped: number;
	failed: number;
	entries: RecurrenceDispatchEntry[];
}

/**
 * Tasks feature — Phase 17.6.
 *
 * Cron-fed dispatcher that walks recurring Task templates whose
 * `nextOccurrenceAt <= now`, CAS-claims each one, clones a fresh
 * instance into the `tasks` table, and advances
 * `nextOccurrenceAt` to the next computed slot. The CAS guard is
 * what stops two concurrent dispatcher workers from spawning two
 * instances at the same recurrence boundary.
 *
 * Mirrors `AgentScheduleDispatcherService.dispatchDue` posture
 * end to end — same CAS-claim pattern, same per-entry summary,
 * same error containment (one template's failure does not
 * cascade).
 */
@Injectable()
export class TaskRecurrenceDispatcherService {
	private readonly logger = new Logger(TaskRecurrenceDispatcherService.name);

	constructor(
		private readonly tasks: TaskRepository,
		private readonly counter: UserTaskCounterRepository,
	) {}

	async dispatchDue(limit = 50, now: Date = new Date()): Promise<RecurrenceDispatchSummary> {
		const templates = await this.tasks.findDueRecurringTemplates(limit, now);
		const summary: RecurrenceDispatchSummary = {
			limit,
			dueCount: templates.length,
			spawned: 0,
			skipped: 0,
			failed: 0,
			entries: [],
		};

		for (const template of templates) {
			const scheduledFor = template.nextOccurrenceAt!;
			try {
				const nextSlot = computeNextOccurrence({
					rule: template.recurrenceRule!,
					from: scheduledFor,
					recurrenceEndsAt: template.recurrenceEndsAt ?? null,
					recurrenceMaxOccurrences: template.recurrenceMaxOccurrences ?? null,
					recurrenceOccurredCount: (template.recurrenceOccurredCount ?? 0) + 1,
				});

				// CAS-claim — only one worker advances nextOccurrenceAt.
				const claimed = await this.tasks.casClaimRecurrence(
					template.id,
					scheduledFor,
					nextSlot,
				);
				if (!claimed) {
					summary.skipped += 1;
					summary.entries.push({
						templateId: template.id,
						templateSlug: template.slug,
						scheduledFor: scheduledFor.toISOString(),
						outcome: 'skipped',
						message: 'CAS lost — another dispatcher claimed first',
					});
					continue;
				}

				// Spawn the instance with a fresh per-user slug.
				const nextNumber = await this.counter.nextSlug(template.userId);
				const slug = `T-${nextNumber}`;
				const instanceData = {
					...cloneRecurringTaskAsInstance(template),
					slug,
				};
				const instance = await this.tasks.create(instanceData);

				summary.spawned += 1;
				summary.entries.push({
					templateId: template.id,
					templateSlug: template.slug,
					scheduledFor: scheduledFor.toISOString(),
					outcome: 'spawned',
					instanceId: instance.id,
					instanceSlug: instance.slug,
					nextOccurrenceAt: nextSlot?.toISOString() ?? null,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.logger.error(
					`Failed to spawn recurrence instance for ${template.id}: ${message}`,
					err as Error,
				);
				summary.failed += 1;
				summary.entries.push({
					templateId: template.id,
					templateSlug: template.slug,
					scheduledFor: scheduledFor.toISOString(),
					outcome: 'failed',
					message,
				});
			}
		}

		return summary;
	}
}
