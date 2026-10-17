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
    | 'task_recurrence_fired'
    // Schedule modes — a scheduled/recurring dispatch found NO resolvable
    // agent; the task is waiting for a human instead of silently skipped.
    | 'task_run_no_agent';

export interface TaskNotificationContext {
    taskId: string;
    taskSlug: string;
    taskTitle: string;
    actorUserId?: string;
    actorAgentSlug?: string;
    fromStatus?: string;
    toStatus?: string;
    /** Review-fix C7 dedup discriminator for `task_blocked` events. */
    blockerTaskId?: string;
    /** Review-fix C7 dedup discriminator for `task_recurrence_fired` events. */
    occurrenceCount?: number;
    extra?: Record<string, unknown>;
}

const TYPE_BY_EVENT: Record<TaskNotificationEvent, NotificationType> = {
    task_assigned: NotificationType.INFO,
    task_mentioned: NotificationType.INFO,
    task_status_changed: NotificationType.INFO,
    task_blocked: NotificationType.WARNING,
    task_due_soon: NotificationType.WARNING,
    task_recurrence_fired: NotificationType.INFO,
    task_run_no_agent: NotificationType.WARNING,
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

    async emit(
        event: TaskNotificationEvent,
        context: TaskNotificationContext,
        recipientUserIds: string[] = [],
    ): Promise<number> {
        return (await this.emitCounted(event, context, recipientUserIds)).sent;
    }

    /** True when this service can deliver at all (a notification store is bound). */
    canDeliver(): boolean {
        return !!this.notifications;
    }

    /**
     * {@link emit}, also answering how many recipients it tried, so a caller
     * that must not lose a notice (the due-soon scan, EW-P2-3) can tell a
     * partial delivery from a complete one and retry. A recipient whose notice
     * already exists (same dedup key) counts as sent.
     */
    async emitCounted(
        event: TaskNotificationEvent,
        context: TaskNotificationContext,
        recipientUserIds: string[] = [],
    ): Promise<{ sent: number; recipients: number }> {
        if (!this.notifications) return { sent: 0, recipients: 0 };
        const watchers = await this.watchers.findByTaskId(context.taskId).catch(() => []);
        const uniqueRecipients = new Set<string>([
            ...recipientUserIds,
            ...watchers.map((w) => w.userId),
        ]);
        if (uniqueRecipients.size === 0) return { sent: 0, recipients: 0 };

        const message = this.formatMessage(event, context);
        const title = this.formatTitle(event, context);
        const type = TYPE_BY_EVENT[event];
        // Review-fix C7: the dedup key must be unique per FIRING of an
        // event, not per event-type. With the old `task:<id>:<event>`
        // shape, NotificationService.create's existing-row dedup would
        // silently swallow every status-change after the first, every
        // assignment after the first, etc. We now include the most
        // distinguishing context per event type (from→to for status,
        // blockerTaskId for blocked, occurrenceCount for recurrence,
        // fallback to a millisecond timestamp so each emit is unique).
        const discriminator = (() => {
            switch (event) {
                case 'task_status_changed':
                    return `${context.fromStatus ?? ''}->${context.toStatus ?? ''}`;
                case 'task_blocked':
                    return context.blockerTaskId ?? context.toStatus ?? '';
                case 'task_recurrence_fired':
                    return String(context.occurrenceCount ?? '');
                case 'task_assigned':
                case 'task_mentioned':
                    return context.actorAgentSlug ?? context.actorUserId ?? '';
                case 'task_due_soon': {
                    // EW-P2-3 — one notice per DEADLINE: the same due date is
                    // never noticed twice, a moved one is a new notice (even on
                    // the same day). Without a date, fall back to per-day.
                    const dueAt = context.extra?.dueAt;
                    return typeof dueAt === 'string' && dueAt.length > 0
                        ? `due:${dueAt}`
                        : new Date().toISOString().slice(0, 10);
                }
                default:
                    return String(Date.now());
            }
        })();
        const dedupKey = `task:${context.taskId}:${event}:${discriminator}`;

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
        return { sent, recipients: uniqueRecipients.size };
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
            case 'task_run_no_agent':
                return `${ctx.taskSlug} needs an agent`;
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
            case 'task_run_no_agent':
                return `Scheduled Task "${ctx.taskTitle}" fired but has no Agent to run it — assign one to dispatch it.`;
        }
    }
}
