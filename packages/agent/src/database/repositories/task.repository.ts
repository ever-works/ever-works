import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Task, TaskStatus } from '../../entities/task.entity';

export interface ListTasksFilter {
	status?: TaskStatus | TaskStatus[];
	priority?: string | string[];
	missionId?: string;
	ideaId?: string;
	workId?: string;
	parentTaskId?: string;
	label?: string;
	search?: string;
	limit?: number;
	offset?: number;
}

/**
 * Tasks feature — Phase 11.5.
 *
 * Custom repository for `tasks`. Owns CRUD + cycle detection on
 * sub-task assignment + CAS-claim for the recurrence dispatcher
 * (Phase 17). Cross-user reads route through `findByIdAndUser`
 * so the service can 404 instead of leaking existence.
 */
@Injectable()
export class TaskRepository {
	constructor(
		@InjectRepository(Task)
		private readonly repository: Repository<Task>,
	) {}

	async findById(id: string): Promise<Task | null> {
		return this.repository.findOne({ where: { id } });
	}

	async findByIdAndUser(id: string, userId: string): Promise<Task | null> {
		return this.repository.findOne({ where: { id, userId } });
	}

	async findBySlug(slug: string): Promise<Task | null> {
		return this.repository.findOne({ where: { slug } });
	}

	async findByUserIdFiltered(
		userId: string,
		filter: ListTasksFilter = {},
	): Promise<{ rows: Task[]; total: number }> {
		const qb = this.repository
			.createQueryBuilder('task')
			.where('task.userId = :userId', { userId });

		if (filter.status) {
			if (Array.isArray(filter.status)) {
				qb.andWhere('task.status IN (:...statuses)', { statuses: filter.status });
			} else {
				qb.andWhere('task.status = :status', { status: filter.status });
			}
		}
		if (filter.priority) {
			if (Array.isArray(filter.priority)) {
				qb.andWhere('task.priority IN (:...priorities)', { priorities: filter.priority });
			} else {
				qb.andWhere('task.priority = :priority', { priority: filter.priority });
			}
		}
		if (filter.missionId) qb.andWhere('task.missionId = :missionId', { missionId: filter.missionId });
		if (filter.ideaId) qb.andWhere('task.ideaId = :ideaId', { ideaId: filter.ideaId });
		if (filter.workId) qb.andWhere('task.workId = :workId', { workId: filter.workId });
		if (filter.parentTaskId)
			qb.andWhere('task.parentTaskId = :parentTaskId', { parentTaskId: filter.parentTaskId });

		if (filter.search) {
			qb.andWhere('(task.title LIKE :q OR task.slug LIKE :q OR task.description LIKE :q)', {
				q: `%${filter.search}%`,
			});
		}

		// `labels` is a simple-json array; we hit it as a substring match
		// against the serialized JSON. v1 — proper jsonb indexing lands
		// when the catalog grows.
		if (filter.label) {
			qb.andWhere('task.labels LIKE :label', { label: `%"${filter.label}"%` });
		}

		const total = await qb.getCount();
		qb.orderBy('task.updatedAt', 'DESC')
			.take(filter.limit ?? 50)
			.skip(filter.offset ?? 0);
		const rows = await qb.getMany();
		return { rows, total };
	}

	async create(data: Partial<Task>): Promise<Task> {
		const entity = this.repository.create(data);
		return this.repository.save(entity);
	}

	async updateById(id: string, data: Partial<Task>): Promise<void> {
		await this.repository.update(id, data);
	}

	async deleteById(id: string): Promise<void> {
		await this.repository.delete(id);
	}

	/**
	 * Walk the parent chain from `candidateChildId` upward. Returns
	 * true iff `proposedParentId` appears in the chain — i.e. setting
	 * `candidateChild.parentTaskId = proposedParentId` would form a
	 * cycle. Service-layer guard for sub-task assignment.
	 *
	 * Iterative (not recursive CTE) — small N expected; readable on
	 * SQLite + Postgres alike without dialect branching.
	 */
	async wouldCreateCycle(
		candidateChildId: string,
		proposedParentId: string,
		maxDepth = 200,
	): Promise<boolean> {
		if (candidateChildId === proposedParentId) return true;
		let cursor: string | null = proposedParentId;
		const seen = new Set<string>();
		for (let i = 0; i < maxDepth && cursor; i++) {
			if (seen.has(cursor)) return true; // existing data is already cyclic — bail
			seen.add(cursor);
			if (cursor === candidateChildId) return true;
			const next = await this.repository.findOne({
				where: { id: cursor },
				select: ['id', 'parentTaskId'],
			});
			cursor = next?.parentTaskId ?? null;
		}
		return false;
	}

	/**
	 * Find recurring Task templates due to spawn an instance. Used by
	 * `TaskRecurrenceDispatcherService.dispatchDue` in Phase 17.
	 */
	async findDueRecurringTemplates(limit: number, now: Date = new Date()): Promise<Task[]> {
		return this.repository
			.createQueryBuilder('task')
			.where('task.isRecurring = :rec', { rec: true })
			.andWhere('task.nextOccurrenceAt IS NOT NULL')
			.andWhere('task.nextOccurrenceAt <= :now', { now })
			.orderBy('task.nextOccurrenceAt', 'ASC')
			.take(limit)
			.getMany();
	}

	/**
	 * CAS-claim a recurring template for one spawn round. Atomic
	 * transition: advance `nextOccurrenceAt` AND bump
	 * `recurrenceOccurredCount` only if `nextOccurrenceAt` still
	 * matches `expected`. Returns true iff this caller won the claim.
	 * Mirrors `WorkScheduleRepository.tryMarkDispatched`.
	 */
	async casClaimRecurrence(
		taskId: string,
		expected: Date,
		newNextOccurrence: Date | null,
	): Promise<boolean> {
		const result = await this.repository
			.createQueryBuilder()
			.update(Task)
			.set({
				nextOccurrenceAt: newNextOccurrence,
				recurrenceOccurredCount: () => 'recurrenceOccurredCount + 1',
				updatedAt: new Date(),
			})
			.where('id = :id', { id: taskId })
			.andWhere('isRecurring = :rec', { rec: true })
			.andWhere('nextOccurrenceAt = :expected', { expected })
			.execute();
		return (result.affected ?? 0) > 0;
	}

	async findStuckRecurring(olderThan: Date): Promise<Task[]> {
		return this.repository.find({
			where: {
				isRecurring: true,
				nextOccurrenceAt: LessThanOrEqual(olderThan),
			},
		});
	}
}
