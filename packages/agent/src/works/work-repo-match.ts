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
    const target = `${owner}/${repo}`.trim().toLowerCase();
    if (!target || target === '/') return null;
    for (const work of works) {
        for (const role of WORK_REPO_ROLES) {
            if (getWorkRepoFullName(work, role) === target) return work;
        }
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
