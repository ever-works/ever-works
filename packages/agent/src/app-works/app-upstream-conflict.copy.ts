/**
 * APW-02 T26 — the conflict copy of spec §6.3 (`spec.md:538-544`), in one place.
 *
 * Spec: `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md` §6.3 (the
 * table), FR-38 (one open Task, its paths), ACC-02-11. Plan: §6.5
 * (`plan.md:773-798`).
 *
 * ## Why the copy is a module and not three template literals
 *
 * FR-38 fixes the Task's title, its description and the comment a later conflict
 * posts; FR-57 makes every string translatable; FR-65 makes each one derive from
 * a stable value. A sentence that lives in two places drifts, and this epic has
 * two callers for the same three strings — the API-side state service that
 * creates the Task ({@link conflictTaskTitle} / {@link conflictTaskDescription})
 * and the update path that comments on it ({@link conflictComment}) — so the
 * text is exported once, here, with the spec's own words quoted above each
 * builder.
 *
 * ## The three rules the builders keep
 *
 *   1. **No `@`, ever** (`plan.md:786-789`). The comment is posted through the
 *      Task chat service, which fans out one agent run per `@<slug>` mention
 *      server-side; this epic starts none, so {@link conflictComment} — and the
 *      description, which reaches the same page — are passed through
 *      {@link withoutMentions}. The §6.3 copy contains none today, which makes
 *      this the guarantee for tomorrow: a repository name, branch or login
 *      interpolated later cannot forge a mention.
 *   2. **The path list is capped, in one place** (FR-38's "up to 50 conflicting
 *      paths"). {@link conflictPaths} is the same normalization the run applies
 *      before it hands paths to the API side, so the Task can never list more
 *      than {@link APP_UPSTREAM_CONFLICT_MAX_PATHS} files however many the
 *      provider returns.
 *   3. **Nothing but counts, shas, a URL and file names** (`plan.md:480`,
 *      FR-58). No token, no repository *content*, no member login.
 *
 * ## Where these strings are consumed
 *
 * {@link conflictPaths} is called by
 * `AppUpstreamSyncService` before `recordConflict` (T26);
 * `AppUpstreamStateService.recordConflict` composes its own title, description
 * and comment today (private `conflictTitle` / `conflictDescription` /
 * `conflictComment`, `app-upstream-state.service.ts:1823-1856`) and the swap is
 * one import — that file belongs to T23/T27, so the swap is reported to the
 * coordinator rather than made here.
 */

import { APP_UPSTREAM_CONFLICT_MAX_PATHS, APP_UPSTREAM_SYNC_BRANCH } from '@ever-works/contracts';

/**
 * Everything the three §6.3 strings interpolate.
 *
 * `repo` is the **Work Repository**'s name (the Task is about the member's own
 * repository), `upstream` is `owner/repo` of the upstream, and `pullRequestUrl`
 * is empty only when the provider could not be asked for one — which the
 * description renders as the honest empty string the API-side builder already
 * uses rather than inventing a URL.
 */
export interface AppUpstreamConflictCopyInput {
    /** The Work Repository's name — what the member sees and owns. */
    repo: string;
    /** `owner/repo` of the upstream the fork was taken from. */
    upstream: string;
    /** The upstream head the sync moved from, and to. */
    fromSha?: string | null;
    toSha?: string | null;
    /** How many commits upstream moved. */
    commits?: number | null;
    /** The sync pull request the member has to resolve. */
    pullRequestUrl?: string | null;
    /** The conflicting/failed-to-merge paths, in provider order. */
    paths?: readonly string[] | null;
    /** The tracked branch the member must **not** merge into directly. */
    branch: string;
}

/**
 * Spec §6.3, title row: `Resolve upstream sync conflicts in {repo}`.
 */
export function conflictTaskTitle(repo: string): string {
    return `Resolve upstream sync conflicts in ${String(repo ?? '')}`;
}

/**
 * Spec §6.3, description row: what moved, where the pull request is, the paths
 * that could not merge (up to 50, one per line), and the one instruction that
 * matters — resolve on the sync branch, never merge into the tracked branch.
 */
export function conflictTaskDescription(input: AppUpstreamConflictCopyInput): string {
    const paths = conflictPaths(input?.paths);
    const lines = [
        `Upstream ${String(input?.upstream ?? '')} moved from ${shortSha(input?.fromSha)} to ` +
            `${shortSha(input?.toSha)} (${commitCount(input?.commits)} commits).`,
        `The sync pull request ${String(input?.pullRequestUrl ?? '')} can't merge because these ` +
            'files conflict:',
        ...paths,
        `Resolve the conflicts on ${APP_UPSTREAM_SYNC_BRANCH} and push. Don't merge into ` +
            `${String(input?.branch ?? '')} directly.`,
    ];

    return withoutMentions(lines.join('\n'));
}

/**
 * Spec §6.3, comment-on-update row:
 * `Upstream moved again: now {toSha} ({count} commits since the last sync).`
 *
 * Posted on the open conflict Task instead of filing a second one (FR-38,
 * ACC-02-11).
 */
export function conflictComment(input?: {
    toSha?: string | null;
    commits?: number | null;
}): string {
    return withoutMentions(
        `Upstream moved again: now ${shortSha(input?.toSha)} ` +
            `(${commitCount(input?.commits)} commits since the last sync).`,
    );
}

/**
 * All three §6.3 strings at once — what a caller that has one conflict in hand
 * needs, so no caller re-derives one of them.
 */
export function conflictCopy(input: AppUpstreamConflictCopyInput): {
    title: string;
    description: string;
    comment: string;
    paths: string[];
} {
    return {
        title: conflictTaskTitle(input?.repo),
        description: conflictTaskDescription(input),
        comment: conflictComment({ toSha: input?.toSha, commits: input?.commits }),
        paths: conflictPaths(input?.paths),
    };
}

/**
 * FR-38's path list: trimmed, de-duplicated in provider order, capped at
 * {@link APP_UPSTREAM_CONFLICT_MAX_PATHS}, with anything that is not a usable
 * path dropped rather than rendered as `undefined`.
 *
 * De-duplication and the cap are both here because both are properties of the
 * *list*, not of either caller: the worker computes the paths (first 50 from
 * `getPullRequestFiles`, §6.5 step 3) and the API side reads them back when the
 * worker could not.
 */
export function conflictPaths(paths: readonly string[] | null | undefined): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of paths ?? []) {
        if (typeof raw !== 'string') {
            continue;
        }
        const path = raw.trim();
        if (path.length === 0 || seen.has(path)) {
            continue;
        }
        if (result.length >= APP_UPSTREAM_CONFLICT_MAX_PATHS) {
            break;
        }
        seen.add(path);
        result.push(path);
    }

    return result;
}

/* -------------------------------------------------------------------------- *
 * internals — the same three renderings the API-side builder uses
 * -------------------------------------------------------------------------- */

/**
 * The `@`-free guarantee (`plan.md:786-789`). The chat service turns every
 * `@<slug>` in a posted body into an agent run; this epic starts none, so the
 * character that could begin one is stripped from every string it publishes.
 */
export function withoutMentions(body: string): string {
    return String(body ?? '')
        .split('@')
        .join('');
}

/** The first seven characters of a sha, or `unknown` when there is none. */
function shortSha(sha: string | null | undefined): string {
    return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : 'unknown';
}

/** A commit count the copy can print: a finite non-negative integer, else `0`. */
function commitCount(commits: number | null | undefined): number {
    return typeof commits === 'number' && Number.isFinite(commits) && commits > 0
        ? Math.floor(commits)
        : 0;
}
