import { classifyCheckResult } from './task-ci-auto-resume';
import { taskThreadPost, type TaskThreadPost } from './task-thread-posts';

/**
 * APW-08 T26 / T54 (FR-43) — WHEN the run-side Task-thread posts fire. Pure: each rule takes the
 * value the platform had recorded BEFORE a write and the value it writes, and answers the one
 * keyed post that transition owes, or `null` when nothing changed. A post therefore fires once per
 * EVENT, never once per sweep, poll or retry, and there is no "already posted" table: the
 * recorded value itself is the memory.
 *
 * | Event               | Recorded value (before → after)                        | Hook                                            |
 * | ------------------- | ------------------------------------------------------ | ----------------------------------------------- |
 * | Run started         | `tasks.latestRunId` + `latestRunStatus` → (run, `running`) | `TaskRunDenormService.recordStarted`        |
 * | Pull request opened | `tasks.prNumber` → the number just recorded            | `TaskWorkspaceService.openPullRequestForBranch` |
 * | Checks passed       | `tasks.ciState` → `passing`                            | `TaskPrStatusService.refreshTask`               |
 * | Checks failed       | `tasks.ciState` → `failing` (see {@link checksSettledPost}) | `TaskPrStatusService.refreshTask`          |
 *
 * Whether the Task gets the post at all (App Work Tasks only) and who speaks is the poster's
 * business (`task-lifecycle-poster.port.ts`), not these rules'.
 */

/** How many failing check names one **Checks failed: {names}.** post lists. */
export const CHECKS_FAILED_NAMES_MAX = 5;

/** A check name longer than this is cut (with `…`) — the post is a line, not a log. */
export const CHECK_NAME_MAX_CHARS = 80;

/** The run-pointer columns `TaskRunDenormService` keeps on the Task row. */
export interface TaskLatestRunRecord {
    latestRunId?: string | null;
    latestRunStatus?: string | null;
}

/**
 * **Run started.** — when the Task's run pointer moves to (`runId`, `running`) from anything
 * else: a queued run claimed, or another run's pointer replaced. A retry that re-claims a run
 * already recorded `running` (the worker's CAS allows `queued|running` on purpose) is no event.
 */
export function runStartedPost(
    previous: TaskLatestRunRecord | null | undefined,
    runId: string,
): TaskThreadPost | null {
    if (!runId) return null;
    if (previous?.latestRunId === runId && previous?.latestRunStatus === 'running') return null;
    return taskThreadPost('runStarted');
}

/**
 * **Opened pull request #{number}.** — when the Task's recorded `prNumber` changes to the number
 * just recorded. The same number again (a finalize that re-records the pull request it already
 * had) is no event.
 */
export function pullRequestOpenedPost(
    previousPrNumber: number | null | undefined,
    prNumber: number | null | undefined,
): TaskThreadPost | null {
    if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) return null;
    if (previousPrNumber === prNumber) return null;
    return taskThreadPost('prOpened', { number: prNumber });
}

/** The fields of a cached / provider check the rules read. */
export interface CheckRecord {
    name?: string | null;
    status?: string | null;
    conclusion?: string | null;
}

/** The Task's recorded CI verdict and the (capped) check list cached with it. */
export interface ChecksRecord {
    ciState?: string | null;
    checks?: readonly CheckRecord[] | null;
}

/**
 * **Checks passed.** / **Checks failed: {names}.** — when the recorded CI verdict SETTLES:
 *
 *  - **passed** when `ciState` becomes `passing` from anything else;
 *  - **failed** when `ciState` becomes `failing` from anything else — or when it already read
 *    `failing` but the check list cached with it showed no failing check while the list cached
 *    now does. That second clause exists because the CI webhook
 *    (`TaskCiAutoResumeService.recordHead`) may write `ciState = 'failing'` the moment one
 *    trusted check goes red, without the check list (only this read writes that), and it
 *    usually beats the two-minute sweep. Without the clause the sweep would see
 *    `failing → failing` and the thread would never say the checks failed. A steady red read
 *    (`failing`, failing checks listed, both times) is no event; neither is a red whose failing
 *    checks are all past the cached list's cap, both times.
 *
 * `pending` / `unknown` post nothing — the checks have not settled. Two known limits, both
 * accepted over a marker table: a webhook red whose failing checks all sit past the cap is not
 * posted by the sweep, and a provider that reorders a long list so a failure moves into the
 * cached window can post one more **Checks failed**.
 */
export function checksSettledPost(
    previous: ChecksRecord,
    next: ChecksRecord,
): TaskThreadPost | null {
    const before = previous.ciState ?? null;
    if (next.ciState === 'passing') {
        return before === 'passing' ? null : taskThreadPost('checksPassed');
    }
    if (next.ciState !== 'failing') return null;
    const names = failingCheckNames(next.checks);
    if (before === 'failing') {
        const recordedRed = failingCheckNames(previous.checks).length > 0;
        if (recordedRed || names.length === 0) return null;
    }
    return names.length > 0
        ? taskThreadPost('checksFailed', { names: joinCheckNames(names) })
        : taskThreadPost('checksFailedUnnamed');
}

/**
 * The failing checks' names, in the provider's order, de-duplicated, each cleaned to one line
 * (control characters and runs of whitespace collapsed) and cut at {@link CHECK_NAME_MAX_CHARS}.
 * "Failing" is the CI fix loop's own classification (`classifyCheckResult`).
 */
export function failingCheckNames(checks: readonly CheckRecord[] | null | undefined): string[] {
    if (!Array.isArray(checks)) return [];
    const names: string[] = [];
    for (const check of checks) {
        if (!check || classifyCheckResult(check) !== 'failing') continue;
        const name = cleanCheckName(check.name);
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

/** `lint, test` — at most {@link CHECKS_FAILED_NAMES_MAX} names, then `+N` for the rest. */
export function joinCheckNames(names: readonly string[]): string {
    const shown = names.slice(0, CHECKS_FAILED_NAMES_MAX);
    const rest = names.length - shown.length;
    return rest > 0 ? `${shown.join(', ')}, +${rest}` : shown.join(', ');
}

function cleanCheckName(raw: string | null | undefined): string {
    const flat = (raw ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (flat.length <= CHECK_NAME_MAX_CHARS) return flat;
    let cut = CHECK_NAME_MAX_CHARS - 1;
    // Never end on half of a surrogate pair.
    const last = flat.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    return `${flat.slice(0, cut)}…`;
}
