/**
 * APW-05 T18 — the payload of the `app-build-watch` job (plan §7.1:1315).
 *
 * One dispatch is one observation attempt of one Build: claim the `watchLeaseUntil` lease
 * (§7.3:1386-1388), read the provider's snapshot, map it onto the row, and — on a terminal
 * transition — confirm the digest, compute the deployable verdict, record the receipt and
 * publish the terminal event. `null` from the dispatcher runs the same runner in process
 * (§7.1:1321-1331).
 *
 * **A `buildId` and a reason, nothing else.** The runner re-reads the Build row, the
 * preparation row and the provider through Nest DI at run time, so a queue message carries
 * no state that could go stale between enqueue and run — the same rule
 * `workspace-backup.types.ts` records for its own payload.
 *
 * `reason` is recorded (it tells an operator whether the observation was webhook-driven,
 * dispatch-driven or sweep-driven) and is never trusted to skip the lease or a re-read.
 *
 * ## The task id is declared here, and T20's task module consumes it
 *
 * `packages/tasks/src/tasks/trigger/app-build-watch.task.ts` is T20's file and does not
 * exist in this tree yet. `TriggerService.dispatchAppBuildWatch` therefore dispatches by
 * THIS id through the SDK's `tasks.trigger(id, payload, options)` form (the same shape
 * `dispatchers/agent-task-dispatchers.ts` uses) rather than importing a task module it
 * cannot see. When T20 lands, its `task({ id: APP_BUILD_WATCH_TASK_ID, … })` is what makes
 * the id resolve, and the dispatch site can adopt the typed handle without changing this
 * contract.
 *
 * ## Duplication note (routed as a finding)
 *
 * T17's provisional block declares the same shape one directory over
 * (`packages/agent/src/app-builds/app-builds.service.ts:89-105` —
 * `APP_BUILD_WATCH_REASONS`, `AppBuildWatchReason`, `AppBuildWatchJobPayload`) together
 * with a provisional `APP_BUILD_WATCH_DISPATCHER` token of its own. The two agree field for
 * field and literal for literal today; the swap T17 asks for
 * (`app-builds.service.ts:107-117`) is not in T18's file list and is reported rather than
 * made here. The runtime list of reasons deliberately lives there only — this file declares
 * the type, so the barrel gains no second copy of the same three literals.
 */
export const APP_BUILD_WATCH_TASK_ID = 'app-build-watch' as const;

/**
 * Why an observation was asked for — plan §7.1:1315, verbatim. The runtime list is T17's
 * `APP_BUILD_WATCH_REASONS` (`packages/agent/src/app-builds/app-builds.service.ts:89`).
 */
export type AppBuildWatchReason = 'event' | 'dispatched' | 'sweep';

/** One `app-build-watch` dispatch. */
export interface AppBuildWatchPayload {
    /** The `work_builds` row to observe. A uuid in production. */
    buildId: string;
    /** `event` — a GitHub webhook delivery. `dispatched` — the dispatch site. `sweep` — §7.4's tick. */
    reason: AppBuildWatchReason;
}
