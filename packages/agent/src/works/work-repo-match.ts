import type { Work } from '../entities/work.entity';

/**
 * Repo roles a Work can own, checked in this order for repo→Work
 * matching. `work` is the browsable provider repository, `website` the
 * generated site, `data` the content repo.
 */
export const WORK_REPO_ROLES = ['work', 'website', 'data'] as const;

export type WorkRepoRole = (typeof WORK_REPO_ROLES)[number];

/** The `owner/name` a Work declares for one repo role, or null. */
export function getWorkRepoFullName(work: Work, role: WorkRepoRole): string | null {
    const owner = work.getRepoOwner?.(role);
    const name =
        role === 'data'
            ? work.getDataRepo?.()
            : role === 'website'
              ? work.getWebsiteRepo?.()
              : work.getMainRepo?.();
    if (!owner || !name) return null;
    return `${owner}/${name}`.toLowerCase();
}

/**
 * THE repo→Work matcher. Pure, dependency-free and synchronous so every
 * caller (the PR reviewer, the ingest `workHint` resolver, anything
 * later) shares one definition of "this repository belongs to that
 * Work" instead of growing a second, subtly different one.
 *
 * `works` MUST already be owner-scoped by the caller — this function has
 * no notion of users and will happily match whatever it is handed. First
 * match wins; an unmatched repo returns null (never an exception).
 */
export function matchWorkByRepo<T extends Work>(
    works: readonly T[],
    owner: string,
    repo: string,
): T | null {
    return matchWorkRepoRole(works, owner, repo)?.work ?? null;
}

/**
 * The repo role a Task's own branch and pull request live in.
 *
 * `data`, not `work`: `TaskWorkspaceService` clones `work.getDataRepo()`
 * for every isolated Task worktree and opens the pull request there, and
 * `TaskPrStatusService.resolveRepo` polls the same repository. So
 * `tasks.branchRef` and `tasks.prNumber` are only unique inside the DATA
 * repository — a pull request #7 in the Work's `work` or `website` repo
 * is a different pull request that happens to share a number.
 */
export const WORK_TASK_REPO_ROLE: WorkRepoRole = 'data';

/**
 * The same match, but it also says WHICH repo roles hit — all of them,
 * because a Work whose `relatedRepositories` does not name a role falls
 * back to a default name and two roles can legitimately resolve to the
 * SAME repository (see `markdown-generator.service.ts`: "`getMainRepo()`
 * and `work.getDataRepo()` can be the SAME repo").
 *
 * Callers that merely decorate an ingested event do not care. Callers
 * that key on a Task's own coordinates — `tasks.prNumber`,
 * `tasks.branchRef` — must check for {@link WORK_TASK_REPO_ROLE}, or a
 * pull request #7 in the Work's website repo resolves to whatever Task
 * opened #7 in the data repo, and anything done on that Task's behalf
 * (rewriting its CI head, resuming its run) lands on the wrong Task and
 * the wrong repository. `matchWorkByRepo` keeps the role-blind behaviour
 * its existing callers were written against.
 */
export function matchWorkRepoRole<T extends Work>(
    works: readonly T[],
    owner: string,
    repo: string,
): { work: T; roles: readonly WorkRepoRole[] } | null {
    const target = `${owner}/${repo}`.trim().toLowerCase();
    if (!target || target === '/') return null;
    for (const work of works) {
        const roles = WORK_REPO_ROLES.filter((role) => getWorkRepoFullName(work, role) === target);
        if (roles.length > 0) return { work, roles };
    }
    return null;
}

/**
 * Split an `owner/repo` string as it arrives on an
 * `IngestedEventWorkHint` of kind `repo`. Returns null for anything that
 * is not exactly two non-empty segments — a malformed hint must resolve
 * to "no Work", never to a partial match.
 */
export function parseRepoFullName(value: string): { owner: string; repo: string } | null {
    const parts = value.trim().split('/');
    if (parts.length !== 2) return null;
    const [owner, repo] = parts.map((part) => part.trim());
    if (!owner || !repo) return null;
    return { owner, repo };
}
