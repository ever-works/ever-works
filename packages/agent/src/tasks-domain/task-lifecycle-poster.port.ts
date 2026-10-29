import type { TaskThreadPost } from './task-thread-posts';

/**
 * APW-08 T26 / T54 (FR-43) — the RUN-SIDE Task-thread posts of an App Work change: **Run
 * started.**, **Opened pull request #{number}.**, **Checks passed.** / **Checks failed:
 * {names}.** (the delivery chain's own posts, from **Merged into {branch}.** on, go through
 * `TASK_THREAD_POSTER` from `TaskDeliveryService`).
 *
 * Bound to `TaskLifecyclePostsService` in `TasksDomainModule` (`useExisting`). The three hooks
 * that post through it — `TaskRunDenormService.recordStarted`, `TaskWorkspaceService`'s pull
 * request open and `TaskPrStatusService`'s provider read — each decide WHETHER an event happened
 * (a real transition of a value the platform records, see `task-lifecycle-posts.ts`); this port
 * decides whether the Task gets a post at all and who speaks:
 *
 *  - **App Work Tasks only.** A Task whose Work is not `kind: 'app'` (or has no Work) gets
 *    nothing, so every other Task's thread is exactly what it was.
 *  - **The run's Agent speaks**, or the Task's Agent when the event has no run; a Task with no
 *    Agent gets a `system` post (thread-only — no comment event, no "commented" Activity row; that
 *    rule is `TaskChatService.post`'s).
 *  - **Never throws.** A refused or failed post is logged and swallowed: no run, finalize or
 *    sweep path may fail because a progress line could not be written.
 *
 * A token rather than the class, like `TASK_THREAD_POSTER`: the three callers then need neither
 * the poster's import graph nor a `forwardRef`, and an optional dependency injected by token
 * survives SWC's metadata emit.
 */
export const TASK_LIFECYCLE_POSTER = Symbol('TASK_LIFECYCLE_POSTER');

/** The Task fields a lifecycle post reads (a loaded `Task` row satisfies it). */
export interface TaskLifecyclePostTask {
    id: string;
    /** The Task's owner — the post is written on their behalf. */
    userId: string;
    workId?: string | null;
    /** The Task's Agent — the author when neither `agentId` nor `runId` names one. */
    agentId?: string | null;
}

export interface TaskLifecyclePostInput {
    task: TaskLifecyclePostTask;
    post: TaskThreadPost;
    /** The run's Agent, when the caller has it in hand (the pull request open does). */
    agentId?: string | null;
    /** The run behind the event; its Agent speaks when `agentId` is not given (run start). */
    runId?: string | null;
    /**
     * The Task's Work kind when the caller already read the Work (skips a second read).
     * `undefined` means "not read" — the poster reads `task.workId` itself.
     */
    workKind?: string | null;
}

export interface TaskLifecyclePoster {
    /** Post `input.post` into an App Work Task's thread. Never throws; `true` when written. */
    post(input: TaskLifecyclePostInput): Promise<boolean>;
}
