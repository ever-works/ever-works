import type { Task } from '../entities/task.entity';

/**
 * APW-08 T16 (APW08-G04; FR-16, FR-17) — what the CI read paths ask about an
 * App Work Task's checks, through ONE token.
 *
 * Two shared services read a pull request's CI on every Work kind:
 * `TaskPrStatusService` (the two-minute sweep and the on-demand read) and
 * `TaskCiAutoResumeService` (the CI fix loop). For an App Work three of their
 * facts are different, and every other kind keeps today's behaviour exactly:
 *
 *  - **which legs decide.** A failing ADVISORY `Ever Works check: {name}` leg
 *    (`AppSpecCheck.required: false`) must not red the roll-up, hold the
 *    merge, appear in **Checks failed: {names}.** or start the fix loop. The
 *    required/advisory split is read from the App rules at the PR BASE —
 *    never from the branch under review, which the agent wrote.
 *  - **the fix-loop budget** is the Work's gate-attempt budget (1–5, default
 *    2), not the platform env var `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS`.
 *  - **exhaustion** moves the Task to `BLOCKED` with the `gate-exhausted`
 *    escalation, instead of filing only an Inbox notice.
 *
 * ## Why a port
 *
 * The App rules live in `app-works/` (`AppWorkRulesService` → APW-03's
 * `AppSpecService`), and a value import of either from `tasks-domain/` closes
 * the require ring `app-work-change-gate.port.ts` documents. This file imports
 * nothing at runtime (the `Task` import is type-only and erased), the
 * implementation (`app-works/task-app-checks.service.ts`) holds every App
 * read, and `TasksDomainModule` binds it. Unbound — a hand-rolled test
 * construction, an install without App Works — both callers behave exactly as
 * they did before T16.
 *
 * Every method answers `null` / `false` rather than throwing: both callers
 * run on paths that must never fail because of an App read (a status refresh,
 * a webhook that has to answer 200).
 */
export const TASK_APP_CHECKS = Symbol('TASK_APP_CHECKS');

/** Where a budget-spent App Work Task's escalation points. */
export interface TaskAppChecksExhaustion {
    attemptsUsed: number;
    maxAttempts: number;
    repoFullName: string;
    prNumber: number | null;
    headSha: string | null;
}

export interface TaskAppChecks {
    /**
     * The CI fix-loop budget for this Task when it is on an App Work: the
     * gate-attempt budget (`resolveMaxGateAttempts`, 1–5, default 2). `null`
     * when the Task is not on an App Work, or its Work cannot be read — the
     * caller then keeps the platform budget, unchanged.
     */
    resumeBudget(task: Task): Promise<number | null>;

    /**
     * The `Ever Works check: {name}` leg names that are ADVISORY under the App
     * rules read at the base branch's tip (`baseRef`, else the Work's base
     * branch). `null` when the Task is not on an App Work, or the rules cannot
     * be read — the caller then classifies NOTHING as advisory, so an
     * unreadable spec can only keep a red gate red, never turn it green.
     */
    advisoryLegs(task: Task, baseRef?: string | null): Promise<ReadonlySet<string> | null>;

    /**
     * The budget is spent: move the Task to `BLOCKED` and raise the
     * `gate-exhausted` escalation (FR-17). `true` when the escalation was
     * recorded. The caller has already claimed the one-shot stop marker, so
     * this runs at most once per Task.
     */
    escalateExhausted(task: Task, exhaustion: TaskAppChecksExhaustion): Promise<boolean>;

    /**
     * The owner unblocked an App Work Task whose CI budget was spent AND the
     * budget now allows another attempt (they raised the Work's gate-attempt
     * budget): release the fix loop's one-shot stop marker so the next red
     * leg resumes the Agent again. `true` when the marker was released.
     *
     * Asked by the two-minute sweep only for an App Work Task that is red,
     * marked stopped and no longer `BLOCKED`. Unblocking WITHOUT raising the
     * budget releases nothing — the Task simply stays out of the loop.
     */
    reopenAfterUnblock(task: Task): Promise<boolean>;
}
