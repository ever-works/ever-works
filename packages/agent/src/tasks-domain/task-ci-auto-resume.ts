import { createHash } from 'node:crypto';

/**
 * CI feedback and the autonomous fix loop (self-build slice AC, EW-806) —
 * the PURE half.
 *
 * Everything here is side-effect free and takes plain shapes, so the
 * service, the API-side webhook consumer and the tests share one set of
 * rules instead of each re-deriving "is this red?", "is this the head we
 * care about?" and "have we already tried exactly this?".
 */

// ── the retry budget ────────────────────────────────────────────────

/**
 * Bounds on the auto-resume budget.
 *
 * `0` is a real, supported value and means the loop is OFF: nothing is
 * ever auto-resumed, the ingest half still runs, and the board still
 * shows the red dot. The ceiling exists because the value arrives from
 * an environment variable and one resume is one full model run on one
 * fleet PC — an out-of-range number must never buy an unbounded spend.
 */
export const MIN_CI_AUTO_RESUME_ATTEMPTS = 0;
export const MAX_CI_AUTO_RESUME_ATTEMPTS = 5;

/**
 * Attempts per Task, over the Task's whole life, when nothing is set.
 *
 * TWO. The first retry catches the ordinary case — a lint slip, a
 * missing import, a snapshot the agent forgot to update — and the second
 * catches "the fix was almost right". A third has, in practice, meant the
 * agent does not understand the failure, and paying a third model run to
 * find that out is worse than filing the Inbox notice one run earlier.
 *
 * Cost: see `docs/features/ci-auto-resume.md`. A resumed run is a normal
 * `agent-task-execute` run — the same order of model spend as the run
 * that opened the pull request in the first place — so the DEFAULT
 * exposure this feature adds to a Task is at most two extra runs.
 */
export const DEFAULT_CI_AUTO_RESUME_ATTEMPTS = 2;

/**
 * Clamp a configured budget into `0..5`.
 *
 * An unparseable value falls back to the DEFAULT rather than to zero:
 * silently switching a shipped loop off because of a typo is the harder
 * failure to notice, and the default is itself bounded.
 */
export function clampAutoResumeAttempts(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_CI_AUTO_RESUME_ATTEMPTS;
    }
    return Math.min(
        MAX_CI_AUTO_RESUME_ATTEMPTS,
        Math.max(MIN_CI_AUTO_RESUME_ATTEMPTS, Math.trunc(raw)),
    );
}

// ── reading a provider check result ─────────────────────────────────

/**
 * The four verdicts a single check result can carry, in the same
 * vocabulary `deriveCiState` uses for the board's CI dot.
 *
 * `failing` is the ONLY one that can buy a resume.
 */
export type CheckVerdict = 'failing' | 'passing' | 'pending' | 'inconclusive';

/**
 * Conclusions that count as RED.
 *
 * Deliberately the same set `packages/plugin`'s `deriveCiState` treats as
 * failures, plus `startup_failure`, which only `workflow_run` reports.
 * `cancelled`, `neutral`, `skipped` and `stale` are NOT failures — a
 * human stopping a job, or a job that decided it had nothing to do, is
 * not something to spend a model run fixing.
 */
export const FAILING_CHECK_CONCLUSIONS: readonly string[] = [
    'failure',
    'timed_out',
    'action_required',
    'startup_failure',
];

/**
 * Verdict of ONE reported check.
 *
 * A check that has not completed is `pending` whatever its conclusion
 * field says, so a red arriving before the job finished (or a payload
 * with a stale conclusion on an `in_progress` re-run) can never trigger
 * the loop. A completed check with no conclusion at all is
 * `inconclusive`, never laundered into a pass — same rule as the board
 * rollup.
 */
export function classifyCheckResult(input: {
    status?: string | null;
    conclusion?: string | null;
}): CheckVerdict {
    const status = (input.status ?? '').toLowerCase();
    if (status !== 'completed') return 'pending';
    const conclusion = (input.conclusion ?? '').toLowerCase();
    if (!conclusion) return 'inconclusive';
    if (FAILING_CHECK_CONCLUSIONS.includes(conclusion)) return 'failing';
    if (conclusion === 'success') return 'passing';
    return 'inconclusive';
}

// ── idempotency coordinates ─────────────────────────────────────────

/**
 * The claim key for a CI failure: ONE attempt per Task per head commit.
 *
 * Stronger than one-per-failing-check on purpose. A 12-job matrix goes
 * red twelve times for one push, GitHub redelivers on any non-2xx, and
 * every one of those is the same single thing to fix. Keying the claim on
 * the head commit collapses the whole storm into one attempt.
 */
export function ciAutoResumeClaimKey(headSha: string): string {
    return `ci:${headSha}`;
}

/** The claim key for a recorded reviewer rejection: one per rejection row. */
export function reviewAutoResumeClaimKey(rejectionId: string): string {
    return `review:${rejectionId}`;
}

/**
 * Fingerprint of WHAT failed — failing check names plus a digest of the
 * output the provider reported.
 *
 * Used only by the no-progress guard, never by the claim: two different
 * failures on one head still get one attempt, but the SAME failure coming
 * back unchanged on a new head stops the loop instead of buying another
 * model run. Names are lower-cased and sorted so job ordering cannot
 * change the fingerprint; the output is whitespace-collapsed for the same
 * reason.
 */
export function computeCiFailureKey(input: {
    checkNames: readonly string[];
    output?: string | null;
}): string {
    const names = [...new Set(input.checkNames.map((name) => name.trim().toLowerCase()))]
        .filter((name) => name.length > 0)
        .sort();
    const output = (input.output ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return createHash('sha256')
        .update(`${names.join(',')}\u0000${output}`)
        .digest('hex')
        .slice(0, 32);
}

// ── head-commit staleness ───────────────────────────────────────────

/**
 * What a delivery's head commit is, relative to the head the platform
 * last saw for this Task.
 *
 *  - `first-seen` — the Task has no recorded head yet; adopt this one.
 *  - `current`    — same commit; act on it.
 *  - `advanced`   — a different commit that the provider says is the pull
 *                   request's head RIGHT NOW: a new push superseded the
 *                   old head. Adopt and act.
 *  - `stale`      — a different commit the pull request has already moved
 *                   past, or one this platform cannot prove is newer.
 *                   Refuse: this is CI catching up on a revision that has
 *                   been replaced, and resuming on it would fix code
 *                   nobody has any more.
 */
export type CiHeadDecision = 'first-seen' | 'current' | 'advanced' | 'stale';

/** What one delivery tells us about which commit it is really about. */
export interface CiHeadEvidence {
    /** The commit the CHECK ran against. */
    headSha: string;
    /**
     * The commit the provider says the PULL REQUEST is at, from the
     * delivery's own `pull_requests[].head.sha`. This is the authoritative
     * signal and it is checked FIRST — see the ordering note below.
     * `null` when the delivery named no pull request (a fork, or a
     * push-triggered workflow run).
     */
    prHeadSha?: string | null;
    /**
     * The provider's OWN timestamp for this result, or `null` when the
     * delivery carried none (or an unparseable one). Deliberately not
     * defaulted to `now`: a synthesized timestamp is always the newest
     * thing in the comparison, which would make every undated delivery
     * look like a fresh push.
     */
    reportedAt?: Date | null;
}

/**
 * Which commit a delivery is really about, relative to the Task's
 * recorded head.
 *
 * ## Why wall-clock ordering is the FALLBACK, not the rule
 *
 * The obvious implementation — "the later timestamp wins" — is wrong, and
 * wrong in the expensive direction. A push's jobs have wildly different
 * durations (this repo's `ci.yml` runs ~15 job instances per PR push), so
 * a slow job belonging to commit A routinely COMPLETES after commit B has
 * already landed and reported its first queued check. Ordering by
 * timestamp classifies that late result as a new head, rewrites
 * `tasks.ciHeadSha` backwards to A, and buys a full model run against a
 * revision nobody has any more. A manual "Re-run jobs" on an old commit
 * does the same thing. Both are ordinary, not exotic.
 *
 * So the decision is evidence-ordered:
 *
 *  1. **The pull request's own head pointer.** Every `check_run`,
 *     `check_suite` and `workflow_run` delivery for a same-repository pull
 *     request carries `pull_requests[].head.sha`, which is the PR's head
 *     at delivery time. If it disagrees with the check's own head, the
 *     check is for a commit the branch has moved past — `stale`, with no
 *     clock involved. If it agrees, this IS the current head — `advanced`.
 *  2. **Wall clock, only when there is no pointer** (fork pull requests,
 *     push-triggered workflow runs). Then a strictly later PROVIDER-
 *     REPORTED time is the only evidence available, and a delivery with no
 *     provider timestamp at all is refused rather than trusted.
 *
 * Fails toward `stale`, i.e. toward NOT spending a model run: the whole
 * budget of this feature is two runs per Task, and burning them on dead
 * commits is the failure that leaves the fleet stalled at exactly the
 * moment the loop exists to prevent.
 */
export function decideCiHead(
    stored: { ciHeadSha?: string | null; ciHeadSeenAt?: Date | null } | null | undefined,
    event: CiHeadEvidence,
): CiHeadDecision {
    // Commit ids are compared case-insensitively: they are hex, providers
    // are not consistent about case, and a mismatch that is only casing
    // would read as a different commit and wedge the Task on `stale`
    // forever.
    const sha = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
    const storedSha = sha(stored?.ciHeadSha);
    const eventSha = sha(event.headSha);
    if (!storedSha) return 'first-seen';
    if (storedSha === eventSha) return 'current';

    // (1) The provider's own pointer to the pull request head. Decisive
    //     in both directions, and available on every same-repo delivery.
    const prHeadSha = sha(event.prHeadSha);
    if (prHeadSha) return prHeadSha === eventSha ? 'advanced' : 'stale';

    // (2) No pointer. Fall back to the clock, and only to a real one.
    const reportedAt = event.reportedAt ?? null;
    if (!(reportedAt instanceof Date) || Number.isNaN(reportedAt.getTime())) return 'stale';
    const seenAt = stored?.ciHeadSeenAt ?? null;
    // A recorded head with no recorded sighting time can only come from a
    // hand-edited row (this loop always writes the pair together). There
    // is nothing to order against, and refusing forever would wedge the
    // Task, so the newer sighting wins.
    if (!(seenAt instanceof Date) || Number.isNaN(seenAt.getTime())) return 'advanced';
    return reportedAt.getTime() > seenAt.getTime() ? 'advanced' : 'stale';
}

/**
 * Pull-request states that mean "there is nothing left to push a fix to".
 *
 * `tasks.prState` is the poll's cache of the provider's own verdict and
 * `tasks.branchState` is the branch chip; both are durable platform state
 * on the row the evaluator already holds, and either one reaching a
 * terminal value is enough. Deliberately NOT `draft`: a draft pull
 * request is still being worked on, and a red build on one is exactly
 * what the loop is for.
 */
export const FINISHED_PR_STATES: readonly string[] = ['merged', 'closed'];
export const FINISHED_BRANCH_STATES: readonly string[] = ['merged', 'discarded'];

/**
 * Has this Task's pull request already landed (or been abandoned)?
 *
 * Checked separately from `TaskStatus` because the merged -> DONE
 * transition is poll-driven, runs on a two-minute cron, and only fires
 * from `in_progress` / `in_review` — so a Task sitting in `blocked` with a
 * merged pull request stays non-DONE indefinitely, and every Task has a
 * window after merge. A pull request the owner closed without merging is
 * never transitioned at all.
 */
export function isPullRequestFinished(task: {
    prState?: string | null;
    branchState?: string | null;
}): boolean {
    const prState = (task.prState ?? '').toLowerCase();
    if (prState && FINISHED_PR_STATES.includes(prState)) return true;
    const branchState = (task.branchState ?? '').toLowerCase();
    return Boolean(branchState) && FINISHED_BRANCH_STATES.includes(branchState);
}

// ── why a resume did or did not happen ──────────────────────────────

/**
 * Every terminal reason the evaluator can report. Exhaustive on purpose:
 * the service returns one of these for EVERY delivery, the specs assert
 * on them, and "we did nothing and cannot say why" is not an option for
 * something that spends money when it says yes.
 */
export type AutoResumeOutcomeReason =
    /** A run was created. */
    | 'resumed'
    /** `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS=0`. */
    | 'disabled'
    /** The delivery is not a completed failure (green, pending, cancelled…). */
    | 'not-a-failure'
    /** The global stop flag is set, or could not be read. */
    | 'halted'
    /** The repo/branch/PR resolved to no Task this owner holds. */
    | 'no-task'
    /** A review delivery arrived but the Task has no unconsumed rejection. */
    | 'no-feedback'
    /** The Task is `done` or `cancelled`. */
    | 'task-finished'
    /**
     * The pull request is `merged` or `closed` (or the branch is merged /
     * discarded). There is nothing left to push a fix to.
     */
    | 'pr-closed'
    /**
     * The loop already gave up on this Task and said so in the Inbox. A
     * terminal, durable state — no further delivery is evaluated.
     */
    | 'stopped'
    /** The delivery reports a head the Task has already moved past. */
    | 'stale-head'
    /** The ledger could not be read — the loop STOPS rather than guesses. */
    | 'budget-unreadable'
    /** Every attempt in the budget has been spent. */
    | 'budget-spent'
    /** This exact failure has already been retried once. */
    | 'repeat-failure'
    /** Another delivery (or replica) already claimed this coordinate. */
    | 'already-claimed'
    /** The Task has no run to resume. */
    | 'no-run'
    /** A run is queued or running — the fix may already be in flight. */
    | 'run-in-flight'
    /** The run is parked on a QUESTION; that is the human's to answer. */
    | 'awaiting-human'
    /** The latest run ended in a state an automated resume must not touch. */
    | 'run-not-resumable'
    /** The steering port is not bound on this install. */
    | 'no-steering'
    /** The dispatch itself failed; the attempt is spent. */
    | 'dispatch-failed'
    /**
     * Something unexpected threw. The loop STOPS on it rather than
     * continuing — the caller is a webhook that must answer 200, and an
     * error is never permission to spend a model run.
     */
    | 'error';

export interface AutoResumeOutcome {
    reason: AutoResumeOutcomeReason;
    /** The Task the delivery resolved to, when it resolved to one. */
    taskId?: string;
    /** The run the resume created. */
    runId?: string;
    /** Attempts spent for this Task INCLUDING this one. */
    attemptsUsed?: number;
    /** The budget in force. */
    maxAttempts?: number;
    /** True when this call filed the one-and-only Inbox notice. */
    noticeFiled?: boolean;
}

// ── the message the resumed run reads ───────────────────────────────

/** Longest failure body persisted as rejection feedback. */
export const CI_FAILURE_FEEDBACK_MAX_CHARS = 4000;

/**
 * Compose the durable rejection text for a red gate.
 *
 * Written in the same register as the gate's own iterate message so an
 * agent that has learned to read one reads the other, and deliberately
 * honest about its own blind spot: the delivery carries the FIRST failure
 * observed for this commit, not necessarily the only one, and the run
 * that reads this has a git provider it can ask.
 *
 * Every interpolated value is provider-reported and therefore untrusted;
 * `RunSteeringService` neutralizes chat-template markers when it splices
 * the stored row into a prompt, and the caller caps the length.
 */
export function composeCiFailureFeedback(input: {
    repoFullName: string;
    headSha: string;
    checkName: string;
    conclusion: string;
    prNumber?: number | null;
    url?: string | null;
    outputTitle?: string | null;
    outputSummary?: string | null;
}): string {
    const lines: string[] = [
        `Continuous integration is RED for ${input.repoFullName} at commit ${input.headSha}.`,
        '',
        `Failing check: ${input.checkName} (${input.conclusion}).`,
    ];
    if (input.prNumber) lines.push(`Pull request: #${input.prNumber}.`);
    if (input.url) lines.push(`Details: ${input.url}`);
    if (input.outputTitle) lines.push('', `Reported title: ${input.outputTitle}`);
    if (input.outputSummary) lines.push('', 'Reported output:', input.outputSummary);
    lines.push(
        '',
        'Other checks on this commit may also be failing — this is the first red result reported for it, not a full list. Read the pull request checks, fix the cause, and push to the same branch. Do not disable, skip or weaken a check to make it pass.',
    );
    return lines.join('\n').slice(0, CI_FAILURE_FEEDBACK_MAX_CHARS);
}

/**
 * Title + body of the ONE Inbox notice filed when the loop gives up.
 *
 * Both reasons are TERMINAL for the Task — `TaskCiAutoResumeService`
 * treats the notice marker itself as the stop flag, so the body's promise
 * that "nothing further will be retried automatically" is literally true
 * for whichever of the two conditions fires first. It used to be filed
 * for `repeat-failure` while the loop happily carried on resuming any
 * DIFFERENT failure inside the remaining budget, which meant the owner
 * read a hard stop that had not happened and the real budget-spent event
 * then filed nothing (the one-shot marker was already burned).
 */
export function composeBudgetSpentNotice(input: {
    taskTitle: string;
    reason: Extract<AutoResumeOutcomeReason, 'budget-spent' | 'repeat-failure'>;
    attemptsUsed: number;
    maxAttempts: number;
    repoFullName?: string | null;
    prNumber?: number | null;
    headSha?: string | null;
}): { title: string; body: string } {
    const why =
        input.reason === 'repeat-failure'
            ? `the same failure came back unchanged after an automatic retry, so retrying it again would not be progress (${input.attemptsUsed} of ${input.maxAttempts} attempts used)`
            : `the automatic retry budget for this task is spent (${input.attemptsUsed} of ${input.maxAttempts} attempts used)`;
    const where = input.repoFullName
        ? `${input.repoFullName}${input.prNumber ? `#${input.prNumber}` : ''}`
        : 'the pull request';
    return {
        title: `CI is still red on ${input.taskTitle} — automatic retries stopped`,
        body: [
            `The build for ${where} is failing and ${why}.`,
            input.headSha ? `Last head commit seen: ${input.headSha}.` : null,
            '',
            'Nothing further will be retried automatically for this task. Open the pull request, read the failing check, and either fix it yourself or resume the run manually once you know what to tell the agent.',
        ]
            .filter((line): line is string => line !== null)
            .join('\n'),
    };
}
