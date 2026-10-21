import type { GitDiffResult } from '@ever-works/plugin';
import { isAlwaysProtectedRepoPath } from '../policy/agent-protected-repo-paths';

/**
 * APW-02 T46 (FR-60, FR-61, S29, ACC-02-24) — does an incoming upstream range
 * touch the files that decide what runs in the App Work's repository?
 *
 * The sync run points the platform-owned `ever-works/upstream-sync` branch of the
 * App repository at the upstream head, opens a pull request from it, and — for a
 * behind-only fork — fast-forwards the tracked branch. Every one of those is a
 * SAME-repository ref, so GitHub runs whatever workflows the upstream commits
 * carry with the App repository's secrets (its Build values among them) and
 * write token: a third party's `on: push` workflow would run the moment the
 * branch moved, before Actions hygiene ever sees it. This module is the pure
 * half of the hold that prevents that: it reads the compare of the range the
 * run is about to move and answers which protected paths it touches.
 *
 * Protected = `.github/workflows/**` and `.github/actions/**` (a composite action
 * is code a workflow runs with the same secrets), at any depth, case-insensitive,
 * plus the bare directories themselves (a symlink or submodule swap) — the very
 * set agents may never change (`ALWAYS_PROTECTED_REPO_PREFIXES`). A rename counts
 * on either side: moving a workflow into, or out of, its directory changes what
 * runs.
 *
 * **Fail closed.** `complete: false` means "this compare cannot prove the range
 * is clean" — a truncated file list, a list at the provider's own ceiling, or no
 * readable compare at all — and the caller holds exactly as if a workflow had
 * changed. The hold is lifted per Work by an operator
 * ({@link APP_UPSTREAM_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV}), never by the App
 * spec: the spec is the upstream author's text too.
 */

/** At most this many changed paths are reported (T46: "capping the reported paths at 100"). */
export const APP_UPSTREAM_WORKFLOW_PATHS_MAX = 100;

/**
 * The most files a compare is asked for — the platform's hard diff ceiling, and
 * GitHub's own: its compare endpoint lists at most 300 changed files, so a list of
 * exactly this many may be missing some and is treated as incomplete.
 */
export const APP_UPSTREAM_COMPARE_MAX_FILES = 300;

/** Operator switch naming the App Works whose upstream sync may carry workflow changes unheld. */
export const APP_UPSTREAM_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV =
    'APP_UPSTREAM_WORKFLOW_CHANGES_ALLOWED_WORKS';

/** What one upstream range does to the protected paths. */
export interface UpstreamWorkflowChanges {
    /** The distinct protected paths the range touches, first-seen order, at most {@link APP_UPSTREAM_WORKFLOW_PATHS_MAX}. */
    paths: string[];
    /** How many distinct protected paths the range touches, before the cap. */
    pathCount: number;
    /** `true` ⇔ the file list is provably the whole range. `false` ⇒ the caller must hold. */
    complete: boolean;
}

/** Whether a compare result carries a protected path, or cannot prove it does not. */
export function holdsForWorkflowReview(changes: UpstreamWorkflowChanges): boolean {
    return changes.pathCount > 0 || changes.complete !== true;
}

/**
 * A path as it may be shown to a person and stored in an Activity entry: no
 * control characters (a path is upstream-authored text), at most 300 characters.
 */
function displayPath(path: string): string {
    return path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 300);
}

/**
 * The protected paths a compare touches, and whether the compare is the whole range.
 *
 * `files.length < totalFiles` is a list the provider (or the cap) cut; a
 * `totalFiles` at {@link APP_UPSTREAM_COMPARE_MAX_FILES} is a list GitHub may have
 * cut before reporting it. Patch truncation is irrelevant — only paths are read —
 * so `diff.truncated` is not consulted (the caller asks for no patch text at all).
 */
export function workflowChanges(diff: GitDiffResult | null | undefined): UpstreamWorkflowChanges {
    if (!diff || !Array.isArray(diff.files)) {
        return { paths: [], pathCount: 0, complete: false };
    }

    const seen = new Set<string>();
    const paths: string[] = [];
    for (const file of diff.files) {
        for (const candidate of [file?.path, file?.previousPath]) {
            if (typeof candidate !== 'string' || !isAlwaysProtectedRepoPath(candidate)) continue;
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            if (paths.length < APP_UPSTREAM_WORKFLOW_PATHS_MAX) paths.push(displayPath(candidate));
        }
    }

    const totalFiles = typeof diff.totalFiles === 'number' ? diff.totalFiles : diff.files.length;
    const complete = diff.files.length >= totalFiles && totalFiles < APP_UPSTREAM_COMPARE_MAX_FILES;
    return { paths, pathCount: seen.size, complete };
}

/**
 * Whether the operator lifted the workflow hold for this App Work.
 *
 * `APP_UPSTREAM_WORKFLOW_CHANGES_ALLOWED_WORKS` — comma-separated Work ids,
 * case-insensitive; default empty, i.e. every App Work is held. There is no
 * wildcard on purpose: lifting the hold lets a third party's workflow run with
 * that Work's secrets, which is a decision about one repository at a time. Read
 * by whichever process runs the sync (the Trigger.dev worker as well as the API).
 */
export function upstreamWorkflowChangesAllowedForWork(
    workId: string | null | undefined,
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    if (!workId) return false;
    const listed = (env[APP_UPSTREAM_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV] ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    return listed.includes(workId.trim().toLowerCase());
}
