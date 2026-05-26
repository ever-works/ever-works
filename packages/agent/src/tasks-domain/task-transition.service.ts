import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	Logger,
	Optional,
} from '@nestjs/common';
import { TaskStatus } from '../entities/task.entity';
import type { Task } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import {
	TaskAssigneeRepository,
	TaskBlockRepository,
	TaskApproverRepository,
} from '../database/repositories/task-side.repositories';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import {
	AGENT_TASK_EXECUTE_DISPATCHER,
	type AgentTaskExecuteDispatcher,
} from './task-dispatcher';

/**
 * Tasks feature — Phase 12.1.
 *
 * State-machine guard for Task status transitions per
 * `features/task-tracking/plan.md §3` + spec table:
 *
 *   backlog → todo, cancelled
 *   todo → in_progress, blocked, cancelled
 *   in_progress → in_review, blocked, done, cancelled
 *   in_review → in_progress, blocked, done, cancelled
 *   blocked → todo, in_progress, cancelled  (unblock restores previousStatus)
 *   done → in_progress (re-open) — soft path
 *   cancelled → (terminal)
 *
 * Side-effect rules:
 *   - any → in_progress: set startedAt if null.
 *   - any → done: requires (a) no open blockers AND (b) when
 *     requireAllApprovers=true, all approvers in 'approved' state.
 *     Sets completedAt.
 *   - any → blocked: stash current status into previousStatus.
 *   - blocked → *: clear previousStatus on success.
 *   - force=true override skips approver-gate but NOT cycle/blocker
 *     check (those are integrity rules, not policy).
 */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
	[TaskStatus.BACKLOG]: [TaskStatus.TODO, TaskStatus.CANCELLED],
	[TaskStatus.TODO]: [TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
	[TaskStatus.IN_PROGRESS]: [
		TaskStatus.IN_REVIEW,
		TaskStatus.BLOCKED,
		TaskStatus.DONE,
		TaskStatus.CANCELLED,
	],
	[TaskStatus.IN_REVIEW]: [
		TaskStatus.IN_PROGRESS,
		TaskStatus.BLOCKED,
		TaskStatus.DONE,
		TaskStatus.CANCELLED,
	],
	[TaskStatus.BLOCKED]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
	[TaskStatus.DONE]: [TaskStatus.IN_PROGRESS],
	[TaskStatus.CANCELLED]: [],
};

export interface TransitionOptions {
	force?: boolean;
}

@Injectable()
export class TaskTransitionService {
	private readonly logger = new Logger(TaskTransitionService.name);

	constructor(
		private readonly tasks: TaskRepository,
		private readonly blocks: TaskBlockRepository,
		private readonly approvers: TaskApproverRepository,
		@Optional() private readonly assignees?: TaskAssigneeRepository,
		@Optional() private readonly runs?: AgentRunRepository,
		@Optional()
		@Inject(AGENT_TASK_EXECUTE_DISPATCHER)
		private readonly dispatcher?: AgentTaskExecuteDispatcher,
	) {}

	/**
	 * Assert + execute. Throws on disallowed move or unsatisfied gate.
	 * Returns the resulting Task (re-fetched from DB so callers see the
	 * side-effect columns).
	 */
	async transition(task: Task, to: TaskStatus, opts: TransitionOptions = {}): Promise<Task> {
		const from = task.status;
		if (!ALLOWED[from]?.includes(to)) {
			throw new BadRequestException(`Cannot transition Task from ${from} to ${to}.`);
		}

		// → done: blocker + approver gates.
		if (to === TaskStatus.DONE) {
			const openBlockers = await this.findOpenBlockers(task.id);
			if (openBlockers.length > 0) {
				throw new ConflictException(
					`Task cannot transition to done — has ${openBlockers.length} open blocker(s).`,
				);
			}
			if (!opts.force && task.requireAllApprovers) {
				const ok = await this.approvers.allApproved(task.id);
				if (!ok) {
					throw new ConflictException(
						'Task cannot transition to done — not all approvers have approved (pass force=true to override).',
					);
				}
			}
		}

		const patch: Partial<Task> = { status: to };
		if (to === TaskStatus.IN_PROGRESS && !task.startedAt) {
			patch.startedAt = new Date();
		}
		if (to === TaskStatus.DONE) {
			patch.completedAt = new Date();
		}
		if (to === TaskStatus.BLOCKED) {
			patch.previousStatus = from;
		}
		if (from === TaskStatus.BLOCKED) {
			patch.previousStatus = null;
		}

		await this.tasks.updateById(task.id, patch);
		const refreshed = await this.tasks.findById(task.id);
		if (!refreshed) {
			throw new ConflictException(`Task ${task.id} vanished after transition.`);
		}

		// Phase 15.3 dispatch hook: any → in_progress fans out to
		// `agent-task-execute` for every Agent assignee. Dedup key is
		// `${taskId}:${agentId}:${generation}` where `generation` is
		// the `recurrenceOccurredCount + 1` on the parent template (or
		// just `1` for non-recurring tasks) — keeps a rapid status
		// flip-flop from double-firing the same Agent.
		if (to === TaskStatus.IN_PROGRESS && this.dispatcher && this.assignees) {
			void this.fanOutAgentExecutions(refreshed).catch((err) =>
				this.logger.warn(`Agent fan-out failed for task ${refreshed.id}: ${err}`),
			);
		}
		return refreshed;
	}

	private async fanOutAgentExecutions(task: Task): Promise<void> {
		if (!this.dispatcher || !this.assignees) return;
		const agentAssignees = await this.assignees.findAgentAssignees(task.id);
		if (agentAssignees.length === 0) return;
		const generation = (task.recurrenceOccurredCount ?? 0) + 1;
		for (const assignee of agentAssignees) {
			const dedupKey = `${task.id}:${assignee.assigneeId}:${generation}`;
			try {
				// Pre-create a queued AgentRun row so the worker can find
				// it via findInFlightForTaskAgent (T6 chat-dedup posture).
				if (this.runs) {
					await this.runs.createQueued({
						agentId: assignee.assigneeId,
						userId: task.userId,
						triggerKind: 'task',
						taskId: task.id,
					});
				}
				await this.dispatcher.enqueue({
					agentId: assignee.assigneeId,
					userId: task.userId,
					taskId: task.id,
					dedupKey,
				});
			} catch (err) {
				this.logger.warn(
					`Failed to dispatch agent-task-execute for ${assignee.assigneeId}: ${err}`,
				);
			}
		}
	}

	private async findOpenBlockers(taskId: string): Promise<string[]> {
		const rows = await this.blocks.findByTaskId(taskId);
		if (rows.length === 0) return [];
		const ids = rows.map((r) => r.blockedByTaskId);
		const open: string[] = [];
		for (const id of ids) {
			const t = await this.tasks.findById(id);
			if (t && t.status !== TaskStatus.DONE && t.status !== TaskStatus.CANCELLED) {
				open.push(id);
			}
		}
		return open;
	}

	/** Pure helper for tests + UI affordance check — no DB I/O. */
	canTransition(from: TaskStatus, to: TaskStatus): boolean {
		return ALLOWED[from]?.includes(to) ?? false;
	}
}
