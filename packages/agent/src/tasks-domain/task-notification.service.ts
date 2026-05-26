import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';
import {
	NotificationCategory,
	NotificationType,
	type CreateNotificationDto,
} from '../entities/notification.types';
import { TaskWatcherRepository } from '../database/repositories/task-side.repositories';

export type TaskNotificationEvent =
	| 'task_assigned'
	| 'task_mentioned'
	| 'task_status_changed'
	| 'task_blocked'
	| 'task_due_soon'
	| 'task_recurrence_fired';

export interface TaskNotificationContext {
	taskId: string;
	taskSlug: string;
	taskTitle: string;
	actorUserId?: string;
	actorAgentSlug?: string;
	fromStatus?: string;
	toStatus?: string;
	extra?: Record<string, unknown>;
}

const TYPE_BY_EVENT: Record<TaskNotificationEvent, NotificationType> = {
	task_assigned: NotificationType.INFO,
	task_mentioned: NotificationType.INFO,
	task_status_changed: NotificationType.INFO,
	task_blocked: NotificationType.WARNING,
	task_due_soon: NotificationType.WARNING,
	task_recurrence_fired: NotificationType.INFO,
};

/**
 * Tasks feature — Phase 18.4.
 *
 * Thin wrapper around `NotificationService.create()` that maps
 * Task-domain events to in-app notification rows. Computes the
 * recipient set from `TaskWatcherRepository.findByTaskId` + (the
 * event's primary user, e.g. the assignee). Deduplicates the
 * recipient set on userId so a watcher who also got assigned only
 * gets one notification.
 *
 * The email side rides on the recipient's `User.emailAgentAlerts /
 * emailTaskNotifications` flags — `NotificationService.create()`
 * is the call site that consults those flags (it already does
 * so for other categories), so this wrapper doesn't need to
 * fork the dispatch.
 */
@Injectable()
export class TaskNotificationService {
	private readonly logger = new Logger(TaskNotificationService.name);

	constructor(
		private readonly watchers: TaskWatcherRepository,
		@Optional() private readonly notifications?: NotificationService,
	) {}

	async emit(event: TaskNotificationEvent, context: TaskNotificationContext, recipientUserIds: string[] = []): Promise<number> {
		if (!this.notifications) return 0;
		const watchers = await this.watchers.findByTaskId(context.taskId).catch(() => []);
		const uniqueRecipients = new Set<string>([
			...recipientUserIds,
			...watchers.map((w) => w.userId),
		]);
		if (uniqueRecipients.size === 0) return 0;

		const message = this.formatMessage(event, context);
		const title = this.formatTitle(event, context);
		const type = TYPE_BY_EVENT[event];
		const dedupKey = `task:${context.taskId}:${event}`;

		let sent = 0;
		for (const userId of uniqueRecipients) {
			const dto: CreateNotificationDto = {
				userId,
				type,
				category: NotificationCategory.TASK,
				title,
				message,
				actionUrl: `/tasks/${context.taskId}`,
				actionLabel: 'Open Task',
				metadata: {
					event,
					taskId: context.taskId,
					taskSlug: context.taskSlug,
					actorUserId: context.actorUserId,
					actorAgentSlug: context.actorAgentSlug,
					fromStatus: context.fromStatus,
					toStatus: context.toStatus,
					...(context.extra ?? {}),
				},
				deduplicationKey: dedupKey,
				isPersistent: false,
			};
			try {
				await this.notifications.create(dto);
				sent += 1;
			} catch (err) {
				this.logger.warn(`Failed to emit ${event} to user ${userId}: ${err}`);
			}
		}
		return sent;
	}

	private formatTitle(event: TaskNotificationEvent, ctx: TaskNotificationContext): string {
		switch (event) {
			case 'task_assigned':
				return `Assigned: ${ctx.taskSlug}`;
			case 'task_mentioned':
				return `Mentioned in ${ctx.taskSlug}`;
			case 'task_status_changed':
				return `${ctx.taskSlug} → ${ctx.toStatus ?? 'updated'}`;
			case 'task_blocked':
				return `${ctx.taskSlug} blocked`;
			case 'task_due_soon':
				return `${ctx.taskSlug} due soon`;
			case 'task_recurrence_fired':
				return `New recurrence: ${ctx.taskSlug}`;
		}
	}

	private formatMessage(event: TaskNotificationEvent, ctx: TaskNotificationContext): string {
		const actor = ctx.actorAgentSlug
			? `Agent @${ctx.actorAgentSlug}`
			: ctx.actorUserId
				? `User ${ctx.actorUserId.slice(0, 8)}…`
				: 'Someone';
		switch (event) {
			case 'task_assigned':
				return `${actor} assigned you to "${ctx.taskTitle}".`;
			case 'task_mentioned':
				return `${actor} mentioned you in "${ctx.taskTitle}".`;
			case 'task_status_changed':
				return `${actor} moved "${ctx.taskTitle}" from ${ctx.fromStatus ?? '?'} to ${ctx.toStatus ?? '?'}.`;
			case 'task_blocked':
				return `"${ctx.taskTitle}" is blocked.`;
			case 'task_due_soon':
				return `"${ctx.taskTitle}" is due soon.`;
			case 'task_recurrence_fired':
				return `A new instance of recurring Task "${ctx.taskTitle}" was created.`;
		}
	}
}
