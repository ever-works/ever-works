/**
 * APW-02 (Fork lifecycle) — the readiness hand-off port.
 *
 * Spec: `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md` FR-22,
 * FR-24a (Resolution **R-4**); plan §6.2 (`plan.md:690-705`) is the normative
 * declaration this file implements, name for name and field for field.
 *
 * ## Why the platform owns this seam instead of a function call
 *
 * APW-01 creates the App Work and, when the member asked for a Blueprint,
 * initialises the repository from it. APW-02 owns the *wait*: an empty
 * repository becomes non-empty when the provider finishes the fork, and only
 * then may the Blueprint be applied. The two epics exchange exactly one
 * message — "the data repository is ready, do your part" — and neither package
 * may import the other (the API and the worker compile separately, and APW-01's
 * implementation lives in `apps/api`).
 *
 * So the seam is a token, bound by whoever implements the hand-off:
 *
 *   - **absent** (`@Optional()`, unbound) — the readiness job records
 *     `initialized` and the App Work is `ready`. That is the fail-closed
 *     default R-4 names: an installation without a handler is an installation
 *     with nothing to initialise, never a Work stuck in `preparing`.
 *   - **bound** — the outcome decides the resting state (`ready`, or
 *     `waiting_for_setup_pr` when the handler opened a pull request the member
 *     must merge, FR-24a) and a `failed` outcome records
 *     `readinessReason = 'handler_failed:<reason>'` (`plan.md:705`).
 *
 * ## The two fields that exist for FR-24a
 *
 * `setupPullRequestUrl` and `setupPullRequestNumber` are what
 * `GET /api/works/:id/upstream` renders and what the setup pull request check
 * reads back (`plan.md:707-713`). The **number** is the key — the URL is for
 * the person. Both are stored on the state row by
 * `AppUpstreamStateService.markReady`.
 *
 * ## What a handler must never do
 *
 * It is called from a background job, after hygiene, exactly once per attempt
 * (`plan.md:684-688`); it never merges a pull request and never pushes to the
 * upstream. Those are the member's actions (spec §7).
 */

/**
 * What the handler did, in the handler's own words (`plan.md:693-698`).
 *
 * `initialized` — a Blueprint (or equivalent) was applied to the repository.
 * `unchanged` — nothing to do: the source is already on the default branch,
 * which is the outcome a `reason: 'setup_merged'` run expects (FR-24a).
 * `blueprint_requested` — the Blueprint is queued and will land shortly.
 * `waiting_for_setup_pr` — the handler opened a pull request the member has to
 * merge; the App Work rests in that state until the setup check sees it merged
 * or closed.
 * `failed` — the hand-off itself failed; `reason` says why.
 */
export interface AppForkReadyOutcome {
    result: 'initialized' | 'unchanged' | 'blueprint_requested' | 'waiting_for_setup_pr' | 'failed';
    /** A reason code, required for `failed` — it becomes `handler_failed:<reason>`. */
    reason?: string;
    /** The setup pull request the member has to merge (FR-24a). */
    setupPullRequestUrl?: string;
    /**
     * The setup pull request **number** — the key the setup check reads back
     * (`plan.md:707-709`). Stored beside the URL by
     * `AppUpstreamStateService.markReady`.
     */
    setupPullRequestNumber?: number;
}

/**
 * APW-01's hand-off, as APW-02 calls it (`plan.md:699-701`).
 *
 * The input is deliberately one id: the handler reads the Work, its repository
 * and its Blueprint itself, because that is where those reads live. A handler
 * that throws is treated exactly like `{ result: 'failed' }` — the readiness
 * job records the failure and never leaves the Work in `preparing`.
 */
export interface AppForkReadyHandler {
    onDataRepositoryReady(input: { workId: string }): Promise<AppForkReadyOutcome>;
}

/**
 * DI token for {@link AppForkReadyHandler} — bound by APW-01's API module, read
 * `@Optional()` by APW-02's `AppForkReadinessService` (T24).
 *
 * A symbol, not the class: the implementing class lives in `apps/api` and a
 * class token would force this package to import it (Resolution R-1's
 * direction — the platform layer reaches the agent layer, never the reverse).
 */
export const APP_FORK_READY_HANDLER = Symbol('APP_FORK_READY_HANDLER');
