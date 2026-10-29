import type { TaskChatMessageParams } from '../entities/task-chat-message.entity';

/**
 * APW-08 T26 / T54 (FR-43) — the narrow port the delivery chain posts its progress through into a
 * Task's own thread. Bound to `TaskChatService` in `TasksDomainModule` (`useExisting`), so a post
 * goes through the same checks, mention parsing, Activity row and domain event as any other
 * message.
 *
 * A token rather than the class: `TaskDeliveryService` then needs neither `TaskChatService`'s
 * import graph nor a `forwardRef`, and an optional dependency injected by token survives SWC's
 * metadata emit (a class-or-null parameter type is emitted as `Object`).
 */
export const TASK_THREAD_POSTER = Symbol('TASK_THREAD_POSTER');

/** One keyed platform post, as `TaskChatService.post` takes it. */
export interface TaskThreadPosterInput {
    taskId: string;
    /** `'system'` (with `authorId: null`) on a Task with no Agent to speak for it. */
    authorType: 'agent' | 'system';
    authorId: string | null;
    /** The pre-rendered English (the fallback every key-unaware reader shows). */
    body: string;
    /** `deliveryPosts.<leaf>` — rendered in the reader's locale. */
    messageKey: string;
    messageParams: TaskChatMessageParams | null;
}

export interface TaskThreadPoster {
    /** `userId` is the Task's owner (the post is written on their behalf). */
    post(userId: string, input: TaskThreadPosterInput): Promise<unknown>;
}
