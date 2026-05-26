import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import {
	Task,
	TaskPriority,
	TaskStatus,
	type TaskActorType,
} from '../entities/task.entity';
import { TaskRepository, type ListTasksFilter } from '../database/repositories/task.repository';
import {
	TaskAssigneeRepository,
	TaskApproverRepository,
	TaskReviewerRepository,
	TaskBlockRepository,
	TaskRelationRepository,
	UserTaskCounterRepository,
} from '../database/repositories/task-side.repositories';
import { TaskTransitionService } from './task-transition.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';
import { computeNextOccurrence, validateRecurrenceRule } from './recurrence';

export interface CreateTaskInput {
	title: string;
	description?: string | null;
	status?: TaskStatus;
	priority?: TaskPriority;
	labels?: string[] | null;
	missionId?: string | null;
	ideaId?: string | null;
	workId?: string | null;
	parentTaskId?: string | null;
	createdByType: TaskActorType;
	createdById: string;
	requireAllApprovers?: boolean;
}

export interface UpdateTaskInput {
	title?: string;
	description?: string | null;
	priority?: TaskPriority;
	labels?: string[] | null;
	parentTaskId?: string | null;
	requireAllApprovers?: boolean;
}

@Injectable()
export class TasksService {
	private readonly logger = new Logger(TasksService.name);

	constructor(
		private readonly tasks: TaskRepository,
		private readonly assignees: TaskAssigneeRepository,
		private readonly reviewers: TaskReviewerRepository,
		private readonly approvers: TaskApproverRepository,
		private readonly blocks: TaskBlockRepository,
		private readonly relations: TaskRelationRepository,
		private readonly counter: UserTaskCounterRepository,
		private readonly transitions: TaskTransitionService,
		@Optional() private readonly activityLog?: ActivityLogService,
	) {}

	async list(userId: string, filter: ListTasksFilter = {}): Promise<{ rows: Task[]; total: number }> {
		return this.tasks.findByUserIdFiltered(userId, filter);
	}

	async getOne(userId: string, id: string): Promise<Task> {
		const task = await this.tasks.findByIdAndUser(id, userId);
		if (!task) throw new NotFoundException(`Task ${id} not found.`);
		return task;
	}

	async create(userId: string, input: CreateTaskInput): Promise<Task> {
		this.assertScopeExclusivity(input);
		this.assertTitle(input.title);
		if (input.description) assertNoSecrets(input.description, 'task.description');

		// Validate parent cycle (root task has no parent).
		if (input.parentTaskId) {
			const parent = await this.tasks.findByIdAndUser(input.parentTaskId, userId);
			if (!parent) {
				throw new BadRequestException(`Parent Task ${input.parentTaskId} not found.`);
			}
		}

		const nextNumber = await this.counter.nextSlug(userId);
		const slug = `T-${nextNumber}`;

		const created = await this.tasks.create({
			userId,
			slug,
			title: input.title.trim(),
			description: input.description ?? null,
			status: input.status ?? TaskStatus.BACKLOG,
			priority: input.priority ?? TaskPriority.P3,
			labels: input.labels ?? null,
			missionId: input.missionId ?? null,
			ideaId: input.ideaId ?? null,
			workId: input.workId ?? null,
			parentTaskId: input.parentTaskId ?? null,
			createdByType: input.createdByType,
			createdById: input.createdById,
			requireAllApprovers: input.requireAllApprovers ?? true,
		});

		await this.logActivity({
			userId,
			taskId: created.id,
			actionType: ActivityActionType.TASK_CREATED,
			details: { slug: created.slug, title: created.title },
		});
		return created;
	}

	async update(userId: string, id: string, input: UpdateTaskInput): Promise<Task> {
		const task = await this.getOne(userId, id);
		const patch: Partial<Task> = {};

		if (input.title !== undefined) {
			this.assertTitle(input.title);
			patch.title = input.title.trim();
		}
		if (input.description !== undefined) {
			if (input.description) assertNoSecrets(input.description, 'task.description');
			patch.description = input.description;
		}
		if (input.priority !== undefined) patch.priority = input.priority;
		if (input.labels !== undefined) patch.labels = input.labels;
		if (input.requireAllApprovers !== undefined)
			patch.requireAllApprovers = input.requireAllApprovers;

		if (input.parentTaskId !== undefined) {
			if (input.parentTaskId === null) {
				patch.parentTaskId = null;
			} else {
				const isCycle = await this.tasks.wouldCreateCycle(id, input.parentTaskId);
				if (isCycle) {
					throw new ConflictException(
						`Cannot set parent — would create a sub-task cycle.`,
					);
				}
				patch.parentTaskId = input.parentTaskId;
			}
		}

		await this.tasks.updateById(id, patch);
		const refreshed = (await this.tasks.findById(id)) as Task;
		await this.logActivity({
			userId,
			taskId: id,
			actionType: ActivityActionType.TASK_UPDATED,
			details: this.diffFor(task, refreshed),
		});
		return refreshed;
	}

	async remove(userId: string, id: string): Promise<{ deleted: true }> {
		const task = await this.getOne(userId, id);
		await this.tasks.deleteById(id);
		await this.logActivity({
			userId,
			taskId: id,
			actionType: ActivityActionType.TASK_DELETED,
			details: { slug: task.slug },
		});
		return { deleted: true };
	}

	/**
	 * Phase 17.2 — make a Task recurring (or update its rule).
	 * Validates the RRULE, computes the initial `nextOccurrenceAt`,
	 * and flips the recurring columns. The Task row stays as the
	 * TEMPLATE; the dispatcher spawns instances pointing back via
	 * `parentRecurringTaskId`.
	 */
	async setRecurring(
		userId: string,
		id: string,
		input: {
			recurrenceRule: string;
			recurrenceTimezone?: string;
			recurrenceEndsAt?: Date | null;
			recurrenceMaxOccurrences?: number | null;
		},
	): Promise<Task> {
		const task = await this.getOne(userId, id);
		const check = validateRecurrenceRule(input.recurrenceRule);
		if (!check.valid) throw new BadRequestException(check.reason);

		const next = computeNextOccurrence({
			rule: input.recurrenceRule,
			from: new Date(),
			recurrenceEndsAt: input.recurrenceEndsAt ?? null,
			recurrenceMaxOccurrences: input.recurrenceMaxOccurrences ?? null,
			recurrenceOccurredCount: 0,
		});
		if (!next) {
			throw new BadRequestException(
				'recurrenceRule yields no future occurrences — refusing to mark as recurring.',
			);
		}

		await this.tasks.updateById(id, {
			isRecurring: true,
			recurrenceRule: input.recurrenceRule,
			recurrenceTimezone: input.recurrenceTimezone ?? 'UTC',
			nextOccurrenceAt: next,
			recurrenceEndsAt: input.recurrenceEndsAt ?? null,
			recurrenceMaxOccurrences: input.recurrenceMaxOccurrences ?? null,
		});
		const refreshed = (await this.tasks.findById(id)) as Task;
		void task;
		return refreshed;
	}

	/** Phase 17.2 — turn off recurrence on a template. Existing
	 * spawned instances are untouched. */
	async clearRecurring(userId: string, id: string): Promise<Task> {
		await this.getOne(userId, id);
		await this.tasks.updateById(id, {
			isRecurring: false,
			recurrenceRule: null,
			nextOccurrenceAt: null,
			recurrenceEndsAt: null,
			recurrenceMaxOccurrences: null,
		});
		return (await this.tasks.findById(id)) as Task;
	}

	async transition(
		userId: string,
		id: string,
		to: TaskStatus,
		opts: { force?: boolean } = {},
	): Promise<Task> {
		const task = await this.getOne(userId, id);
		const from = task.status;
		const result = await this.transitions.transition(task, to, opts);
		await this.logActivity({
			userId,
			taskId: id,
			actionType: ActivityActionType.TASK_TRANSITIONED,
			details: { from, to, force: opts.force ?? false },
		});
		return result;
	}

	// ── Members ───────────────────────────────────────────────────

	async addAssignee(
		userId: string,
		taskId: string,
		assigneeType: TaskActorType,
		assigneeId: string,
	) {
		await this.getOne(userId, taskId);
		const row = await this.assignees.add(taskId, assigneeType, assigneeId);
		await this.logActivity({
			userId,
			taskId,
			actionType: ActivityActionType.TASK_ASSIGNEE_ADDED,
			details: { assigneeType, assigneeId },
		});
		return row;
	}

	async removeAssignee(userId: string, taskId: string, assigneeId: string) {
		await this.getOne(userId, taskId);
		await this.assignees.remove(assigneeId);
		await this.logActivity({
			userId,
			taskId,
			actionType: ActivityActionType.TASK_ASSIGNEE_REMOVED,
			details: { assigneeId },
		});
		return { deleted: true } as const;
	}

	async addReviewer(
		userId: string,
		taskId: string,
		reviewerType: TaskActorType,
		reviewerId: string,
	) {
		await this.getOne(userId, taskId);
		return this.reviewers.add(taskId, reviewerType, reviewerId);
	}

	async addApprover(
		userId: string,
		taskId: string,
		approverType: TaskActorType,
		approverId: string,
	) {
		await this.getOne(userId, taskId);
		return this.approvers.add(taskId, approverType, approverId);
	}

	async addBlocker(userId: string, taskId: string, blockedByTaskId: string) {
		await this.getOne(userId, taskId);
		if (taskId === blockedByTaskId) {
			throw new BadRequestException('Task cannot block itself.');
		}
		const blocker = await this.tasks.findByIdAndUser(blockedByTaskId, userId);
		if (!blocker) {
			throw new BadRequestException(`Blocking Task ${blockedByTaskId} not found.`);
		}
		const row = await this.blocks.add(taskId, blockedByTaskId);
		await this.logActivity({
			userId,
			taskId,
			actionType: ActivityActionType.TASK_BLOCKER_ADDED,
			details: { blockedByTaskId },
		});
		return row;
	}

	async removeBlocker(userId: string, taskId: string, blockId: string) {
		await this.getOne(userId, taskId);
		await this.blocks.remove(blockId);
		return { deleted: true } as const;
	}

	async addRelation(
		userId: string,
		taskId: string,
		relatedTaskId: string,
		kind: 'related' | 'duplicates' | 'follow-up',
	) {
		await this.getOne(userId, taskId);
		const related = await this.tasks.findByIdAndUser(relatedTaskId, userId);
		if (!related) {
			throw new BadRequestException(`Related Task ${relatedTaskId} not found.`);
		}
		return this.relations.add(taskId, relatedTaskId, kind);
	}

	// ── internals ─────────────────────────────────────────────────

	private assertTitle(title: string): void {
		if (!title || title.trim().length < 1) {
			throw new BadRequestException('Task title is required.');
		}
		if (title.length > 200) {
			throw new BadRequestException('Task title exceeds 200 characters.');
		}
	}

	private assertScopeExclusivity(input: CreateTaskInput): void {
		const popCount = [input.missionId, input.ideaId, input.workId].filter(Boolean).length;
		if (popCount > 1) {
			throw new BadRequestException(
				'Task must be scoped to exactly zero or one of missionId / ideaId / workId.',
			);
		}
	}

	private diffFor(before: Task, after: Task): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		const keys: Array<keyof Task> = [
			'title',
			'description',
			'priority',
			'labels',
			'parentTaskId',
			'requireAllApprovers',
		];
		for (const k of keys) {
			if (before[k] !== after[k]) out[k as string] = { before: before[k], after: after[k] };
		}
		return out;
	}

	private async logActivity(args: {
		userId: string;
		taskId: string;
		actionType: ActivityActionType;
		details?: Record<string, unknown>;
	}): Promise<void> {
		if (!this.activityLog) return;
		try {
			await this.activityLog.log({
				userId: args.userId,
				action: args.actionType,
				actionType: args.actionType,
				status: ActivityStatus.SUCCESS,
				resourceType: 'task',
				resourceId: args.taskId,
				details: args.details,
			});
		} catch (err) {
			this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
		}
	}
}
