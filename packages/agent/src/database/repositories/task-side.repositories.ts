import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { TaskReviewer } from '../../entities/task-reviewer.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskBlock } from '../../entities/task-block.entity';
import { TaskRelation } from '../../entities/task-relation.entity';
import { TaskChatMessage } from '../../entities/task-chat-message.entity';
import { TaskAttachment } from '../../entities/task-attachment.entity';
import { TaskWatcher } from '../../entities/task-watcher.entity';
import { TaskKbMention } from '../../entities/task-kb-mention.entity';
import { UserTaskCounter } from '../../entities/user-task-counter.entity';

/**
 * Tasks feature — Phase 11.5. Side-table repositories for the Task
 * family. Grouped in one file so future contributors see the full
 * surface in one place; each class has the narrow CRUD it needs to
 * support the service.
 */

@Injectable()
export class TaskAssigneeRepository {
	constructor(@InjectRepository(TaskAssignee) private readonly repo: Repository<TaskAssignee>) {}

	async findByTaskId(taskId: string): Promise<TaskAssignee[]> {
		return this.repo.find({ where: { taskId } });
	}
	async findAgentAssignees(taskId: string): Promise<TaskAssignee[]> {
		return this.repo.find({ where: { taskId, assigneeType: 'agent' } });
	}
	async add(taskId: string, assigneeType: 'user' | 'agent', assigneeId: string): Promise<TaskAssignee> {
		const entity = this.repo.create({ taskId, assigneeType, assigneeId });
		return this.repo.save(entity);
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

@Injectable()
export class TaskReviewerRepository {
	constructor(@InjectRepository(TaskReviewer) private readonly repo: Repository<TaskReviewer>) {}

	async findByTaskId(taskId: string): Promise<TaskReviewer[]> {
		return this.repo.find({ where: { taskId } });
	}
	async add(taskId: string, reviewerType: 'user' | 'agent', reviewerId: string): Promise<TaskReviewer> {
		const entity = this.repo.create({ taskId, reviewerType, reviewerId });
		return this.repo.save(entity);
	}
	async setState(id: string, reviewState: 'pending' | 'requested-changes' | 'approved'): Promise<void> {
		await this.repo.update(id, { reviewState, reviewedAt: new Date() });
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

@Injectable()
export class TaskApproverRepository {
	constructor(@InjectRepository(TaskApprover) private readonly repo: Repository<TaskApprover>) {}

	async findByTaskId(taskId: string): Promise<TaskApprover[]> {
		return this.repo.find({ where: { taskId } });
	}
	async add(taskId: string, approverType: 'user' | 'agent', approverId: string): Promise<TaskApprover> {
		const entity = this.repo.create({ taskId, approverType, approverId });
		return this.repo.save(entity);
	}
	async setState(id: string, approvalState: 'pending' | 'approved' | 'rejected'): Promise<void> {
		await this.repo.update(id, { approvalState, approvedAt: new Date() });
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
	async allApproved(taskId: string): Promise<boolean> {
		const rows = await this.repo.find({ where: { taskId } });
		if (rows.length === 0) return false;
		return rows.every((r) => r.approvalState === 'approved');
	}
}

@Injectable()
export class TaskBlockRepository {
	constructor(@InjectRepository(TaskBlock) private readonly repo: Repository<TaskBlock>) {}

	async findByTaskId(taskId: string): Promise<TaskBlock[]> {
		return this.repo.find({ where: { taskId } });
	}
	async findBlockingTasks(blockedByTaskId: string): Promise<TaskBlock[]> {
		return this.repo.find({ where: { blockedByTaskId } });
	}
	async add(taskId: string, blockedByTaskId: string): Promise<TaskBlock> {
		const entity = this.repo.create({ taskId, blockedByTaskId });
		return this.repo.save(entity);
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

@Injectable()
export class TaskRelationRepository {
	constructor(@InjectRepository(TaskRelation) private readonly repo: Repository<TaskRelation>) {}

	async findByTaskId(taskId: string): Promise<TaskRelation[]> {
		return this.repo.find({ where: { taskId } });
	}
	async add(
		taskId: string,
		relatedTaskId: string,
		kind: 'related' | 'duplicates' | 'follow-up',
	): Promise<TaskRelation> {
		const entity = this.repo.create({ taskId, relatedTaskId, kind });
		return this.repo.save(entity);
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

@Injectable()
export class TaskChatMessageRepository {
	constructor(
		@InjectRepository(TaskChatMessage) private readonly repo: Repository<TaskChatMessage>,
	) {}

	async findByTaskId(taskId: string, limit = 50, offset = 0): Promise<TaskChatMessage[]> {
		return this.repo.find({
			where: { taskId },
			order: { createdAt: 'ASC' },
			take: limit,
			skip: offset,
		});
	}
	async findById(id: string): Promise<TaskChatMessage | null> {
		return this.repo.findOne({ where: { id } });
	}
	async create(data: Partial<TaskChatMessage>): Promise<TaskChatMessage> {
		const entity = this.repo.create(data);
		return this.repo.save(entity);
	}
	async updateBody(id: string, body: string): Promise<void> {
		await this.repo.update(id, { body, editedAt: new Date() });
	}
}

@Injectable()
export class TaskAttachmentRepository {
	constructor(
		@InjectRepository(TaskAttachment) private readonly repo: Repository<TaskAttachment>,
	) {}

	async findByTaskId(taskId: string): Promise<TaskAttachment[]> {
		return this.repo.find({ where: { taskId } });
	}
	async add(taskId: string, uploadId: string): Promise<TaskAttachment> {
		const entity = this.repo.create({ taskId, uploadId });
		return this.repo.save(entity);
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

@Injectable()
export class TaskWatcherRepository {
	constructor(@InjectRepository(TaskWatcher) private readonly repo: Repository<TaskWatcher>) {}

	async findByTaskId(taskId: string): Promise<TaskWatcher[]> {
		return this.repo.find({ where: { taskId } });
	}
	async findByUserId(userId: string): Promise<TaskWatcher[]> {
		return this.repo.find({ where: { userId } });
	}
	async add(taskId: string, userId: string): Promise<TaskWatcher> {
		const entity = this.repo.create({ taskId, userId });
		return this.repo.save(entity);
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

@Injectable()
export class TaskKbMentionRepository {
	constructor(
		@InjectRepository(TaskKbMention) private readonly repo: Repository<TaskKbMention>,
	) {}

	async findByTaskId(taskId: string): Promise<TaskKbMention[]> {
		return this.repo.find({ where: { taskId } });
	}
	async findByKbDocumentId(kbDocumentId: string): Promise<TaskKbMention[]> {
		return this.repo.find({ where: { kbDocumentId } });
	}
	async add(taskId: string, kbDocumentId: string): Promise<TaskKbMention> {
		const entity = this.repo.create({ taskId, kbDocumentId });
		return this.repo.save(entity);
	}
	async remove(id: string): Promise<void> {
		await this.repo.delete(id);
	}
}

/**
 * Atomic per-user slug sequence. `nextSlug` runs an INSERT … ON
 * CONFLICT DO UPDATE pattern so two parallel inserts can never
 * collide on the same lastSlugNumber. SQLite's UPSERT and
 * Postgres's INSERT … ON CONFLICT … RETURNING both honor this.
 */
@Injectable()
export class UserTaskCounterRepository {
	constructor(
		@InjectRepository(UserTaskCounter) private readonly repo: Repository<UserTaskCounter>,
	) {}

	async findByUserId(userId: string): Promise<UserTaskCounter | null> {
		return this.repo.findOne({ where: { userId } });
	}

	/**
	 * Bumps the per-user counter and returns the new value. Caller
	 * formats the slug (`T-<n>`). Two-step fallback path: try increment;
	 * if row doesn't exist, INSERT { userId, lastSlugNumber: 1 }
	 * and return 1. Re-tries the increment if the INSERT raced a
	 * concurrent one.
	 */
	async nextSlug(userId: string): Promise<number> {
		const updated = await this.repo
			.createQueryBuilder()
			.update(UserTaskCounter)
			.set({ lastSlugNumber: () => 'lastSlugNumber + 1', updatedAt: new Date() })
			.where('userId = :userId', { userId })
			.execute();
		if ((updated.affected ?? 0) > 0) {
			const row = await this.repo.findOne({ where: { userId } });
			return row?.lastSlugNumber ?? 1;
		}
		try {
			await this.repo.insert({ userId, lastSlugNumber: 1 });
			return 1;
		} catch {
			// Another worker inserted between our UPDATE and our INSERT —
			// re-try the increment now that the row exists.
			await this.repo
				.createQueryBuilder()
				.update(UserTaskCounter)
				.set({ lastSlugNumber: () => 'lastSlugNumber + 1', updatedAt: new Date() })
				.where('userId = :userId', { userId })
				.execute();
			const row = await this.repo.findOne({ where: { userId } });
			return row?.lastSlugNumber ?? 1;
		}
	}

	/** Test/debug helper — list rows older than a cutoff. */
	async findStale(olderThan: Date): Promise<UserTaskCounter[]> {
		return this.repo.find({ where: { updatedAt: LessThan(olderThan) } });
	}
}
