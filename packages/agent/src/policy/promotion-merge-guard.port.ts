import type { GitPullRequestStatus } from '@ever-works/plugin';
import type { Task } from '../entities/task.entity';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the NARROWING
 * the merge gate applies to a promotion pull request.
 *
 * ## What this is for
 *
 * Slice AE made every agent merge go through one path: green provider CI,
 * a `merge_pull_request` Inbox approval decided by an entitled human, and
 * a re-verification against the live head at merge time. A promotion pull
 * request goes through exactly that path — this port does not replace any
 * of it and cannot satisfy any of it.
 *
 * What it adds is one extra refusal, because the CI roll-up AE consults
 * cannot answer the question a release gate asks. `deriveCiState` treats
 * `skipped`, `cancelled`, `neutral` and `stale` as non-blocking, and
 * `promotion-gate.yml` SKIPS its e2e job by design on any head that is not
 * `stage`. So a promotion whose gate never evaluated rolls up `passing`,
 * and without this port the merge gate would raise a human approval on a
 * green badge the platform manufactured.
 *
 * ## Direction of travel
 *
 * This port can only ever say NO. There is no verdict here that permits a
 * merge the ordinary path would refuse, and `{ promotion: false }` — "not
 * a promotion" — leaves the ordinary path exactly as it was.
 *
 * ## Unbound means NO for a promotion
 *
 * Deliberately inverting the usual `@Optional()` convention, the same way
 * `MERGE_APPROVAL_VERIFIER` does: a deployment that cannot evaluate
 * promotions must not merge them through the ordinary agent path. The
 * merge gate detects that case off the Task's own labels (which it has
 * already loaded) and stands down, so the refusal does not depend on the
 * very service that is missing.
 */

/** What the merge gate knows about the Task it is considering. */
export interface PromotionMergeSubject {
    readonly taskId: string;
    /**
     * The Task's labels.
     *
     * A HINT, not the identity. Labels are free-form and any owner can
     * rewrite them through `PATCH /api/tasks/:id`, so an implementation
     * that decided "is this a promotion?" off them alone would let a
     * single request disarm the gate on a live release pull request. The
     * authority is the promotion row keyed by `taskId`; these are used to
     * fail CLOSED when no row resolves, and by the merge gate itself to
     * stand down when no guard is bound at all.
     */
    readonly labels: readonly string[] | null | undefined;
    /**
     * The pull request the merge gate is about to act on.
     *
     * Carried so the guard can refuse when it is not the pull request the
     * promotion opened. The two CAN diverge — an agent run on the
     * promotion Task overwrites `tasks.prNumber` with its own pull
     * request — and a verdict about one pull request must never authorise
     * a merge of another.
     */
    readonly prNumber: number;
    /**
     * The head commit as read from the provider MOMENTS AGO — not from a
     * cache, and not from the caller's memory of what it pushed. The
     * recorded gate verdict is compared against THIS.
     */
    readonly headSha: string;
}

/** Why a promotion may not be merged right now. */
export type PromotionMergeRefusalCode =
    /** The Task says it is a promotion but no promotion row resolves. */
    | 'promotion-row-missing'
    /** The promotion is merged, closed or refused; nothing left to do. */
    | 'promotion-not-open'
    /**
     * The recorded verdict is for a DIFFERENT commit than the one being
     * merged. A verdict is about a commit; it is never inherited.
     */
    | 'promotion-gate-stale'
    /**
     * The gate did not say `success` for this commit. `reason` carries the
     * actual reading — pending, cancelled, skipped, absent, unreadable or
     * failure — because the operator's next action differs for each.
     */
    | 'promotion-gate-not-success'
    /**
     * The pull request the merge gate is holding is not the one this
     * promotion opened. Reachable when something rebinds `tasks.prNumber`
     * — an agent run on the promotion Task does exactly that — and the
     * recorded verdict is then about a pull request nobody is merging.
     */
    | 'promotion-pull-request-mismatch';

export type PromotionMergeVerdict =
    /** Not a promotion Task. The ordinary merge path is unchanged. */
    | { readonly promotion: false }
    /**
     * A promotion whose gate said `success` for exactly this commit, on
     * exactly this pull request.
     *
     * Carries the promotion's OWN branches, because the merge path's
     * default answer to "what is this pull request's base?" is the Work's
     * `taskIsolationBaseBranch` — right for every Task pull request and
     * wrong for every promotion. The protected-branch rule and the string
     * the approving human reads are both computed from it.
     */
    | {
          readonly promotion: true;
          readonly allowed: true;
          readonly promotionId: string;
          readonly headBranch: string;
          readonly baseBranch: string;
          readonly prNumber: number;
      }
    /** A promotion that may not be merged. */
    | {
          readonly promotion: true;
          readonly allowed: false;
          readonly promotionId?: string;
          readonly code: PromotionMergeRefusalCode;
          readonly reason: string;
      };

export interface PromotionMergeGuard {
    /**
     * May this Task's pull request be considered for a merge?
     *
     * Implementations MUST NOT throw for "no" — a throw is treated as a
     * refusal by the caller, but a refusal carries a reason a human can
     * read and a throw does not.
     */
    assessPromotionForMerge(subject: PromotionMergeSubject): Promise<PromotionMergeVerdict>;
}

/** DI token. Bound by `ReleasePromotionModule`. */
export const PROMOTION_MERGE_GUARD = 'PROMOTION_MERGE_GUARD' as const;

/**
 * The other half of the lane: the thing that WATCHES a promotion.
 *
 * Split from the guard because they have different callers and very
 * different postures. The watcher runs on every PR-status refresh
 * regardless of what CI says — a promotion has to be legible even when it
 * can never merge — and it is best-effort by contract. The guard is
 * consulted only at the merge decision and can only ever refuse.
 *
 * Both are tokens rather than concrete classes for the same reason
 * `INBOX_PRODUCER` is: the implementation lives in a module that imports
 * `TasksDomainModule` (it files Tasks), so `TasksDomainModule` cannot
 * import it back. A `@Global()` binding at the app root closes the loop
 * without a cycle.
 */
export interface PromotionLaneWatcher {
    /**
     * Called after every successful provider read for a Task, with the
     * LIVE status. Implementations MUST NOT throw: the caller's job is to
     * keep a PR-status cache honest for every Task behind this one.
     */
    onPullRequestStatusRefreshed(task: Task, status: GitPullRequestStatus): Promise<unknown>;
}

/** DI token. Bound by `ReleasePromotionModule`. */
export const PROMOTION_LANE_WATCHER = 'PROMOTION_LANE_WATCHER' as const;
