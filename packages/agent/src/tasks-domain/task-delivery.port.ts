import type { GitPullRequestStatus } from '@ever-works/plugin';
import type { Task } from '../entities/task.entity';

/**
 * APW-08 T22 — the seam between the PR-status sweep and the App Works delivery chain.
 *
 * `TaskPrStatusService` asks it, for a pull request it just saw merged, whether the merge is one
 * the chain follows; a tracked merge is recorded and the sweep does NOT complete the Task (the
 * Task closes when its change is live). Bound to `TaskDeliveryService` in `TasksDomainModule`
 * and injected by TOKEN, `@Optional()`, so the sweep's file never imports the app-works graph and
 * an install without the chain completes merged Tasks exactly as before.
 *
 * 🛑 A leaf file: types and the token only.
 */
export const TASK_DELIVERY_TRACKER = Symbol('TASK_DELIVERY_TRACKER');

export interface TaskDeliveryTracker {
    /** A merge into the App Work's tracked branch, with a merge commit → tracked. */
    isDeliveryTracked(task: Task, status: GitPullRequestStatus | null): Promise<boolean>;
    /** Record the merge once (S29). */
    recordMerge(task: Task, status: GitPullRequestStatus): Promise<{ recorded: boolean }>;
}
