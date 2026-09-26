import { getWorkCapabilities } from '@ever-works/contracts';
import type { Work } from '../entities/work.entity';
import { matchWorkRepoRoles } from '../works/work-repo-match';

/**
 * The repository a Task acts on — where its branch is cut, its pull request is
 * opened, its release is promoted and its diff is reviewed.
 *
 * ## Why this exists
 *
 * Every Task path resolved that repository as `work.getRepoOwner()` /
 * `work.getDataRepo()` — the `data` role, unconditionally ("v1 repo
 * resolution"). That was right for every kind that existed then, and it is
 * wrong for exactly one kind that exists now.
 *
 * The kind-capability registry (`packages/contracts/src/domain/work-capabilities.ts`)
 * says which repository roles a kind HAS, and `app` is the only kind whose
 * `data` role is OFF: `repos: { data: false, work: false, website: true }`.
 * APW-01 records an App Work's code in the `website` role only
 * (`app-work-create.service.ts:1151-1155`: *"it is the `website` role — never
 * `data`"*), so `getDataRepo()` falls through to its slug-derived default,
 * `${slug}-data` — a repository that does not exist. Every Task on an App Work
 * was being provisioned, finalized, merged and reviewed against it.
 *
 * ## The rule, and why it is this one
 *
 * **Use the `data` role when the kind has one; otherwise the `website` role.**
 *
 * It is read from the registry rather than written as `kind === 'app'` for the
 * reason the registry exists at all: a future kind that has only a Work
 * Repository gets the right answer without anyone remembering this file.
 *
 * It is deliberately NOT the rule the APW-08 P0 agent git adapter uses
 * (`repos.website ? 'website' : 'data'`, `apps/api/src/agents/agents.module.ts`).
 * Every directory-shaped kind has `website: true`, so that rule would move every
 * directory, blog, website and landing-page Task from its data repository to
 * its website repository. Preferring `data` keeps every kind that has one
 * byte-identical — and today that is every kind except `app`.
 *
 * ## The `data` branch is today's call, verbatim
 *
 * `getRepoOwner()` is called with NO argument on the data branch, exactly as
 * every call site did before. A structural double that implements
 * `getRepoOwner: () => 'acme'` sees the same call it always saw.
 */

/** The two roles a Task can act on. */
export type TaskRepositoryRole = 'data' | 'website';

/**
 * What this module reads of a Work.
 *
 * Structural, because several call sites hand in narrowed shapes rather than
 * the entity. `kind` and `getWebsiteRepo` are optional so those shapes keep
 * compiling — and an object without them resolves to `data`, which is what it
 * resolved to before this file existed.
 */
export interface TaskRepositoryWork {
    readonly kind?: string | null;
    getRepoOwner(role?: 'data' | 'work' | 'website'): string;
    getDataRepo(): string;
    getWebsiteRepo?(): string;
}

/** A resolved Task repository. */
export interface TaskRepositoryTarget {
    readonly role: TaskRepositoryRole;
    readonly owner: string;
    readonly repo: string;
}

/**
 * The role a Task on this kind acts on.
 *
 * `data` when the kind has one, else `website`. A kind with neither falls back
 * to `data` — no kind is like that today, and `data` is what it would have got
 * before this file existed, so the fallback changes nothing.
 */
export function taskRepositoryRole(kind?: string | null): TaskRepositoryRole {
    const repos = getWorkCapabilities(kind).repos;
    if (repos.data) return 'data';
    if (repos.website) return 'website';
    return 'data';
}

/** The owner and repository a Task on this Work acts on. */
export function resolveTaskRepository(work: TaskRepositoryWork): TaskRepositoryTarget {
    if (taskRepositoryRole(work.kind) === 'website' && typeof work.getWebsiteRepo === 'function') {
        return {
            role: 'website',
            owner: work.getRepoOwner('website'),
            repo: work.getWebsiteRepo(),
        };
    }
    return { role: 'data', owner: work.getRepoOwner(), repo: work.getDataRepo() };
}

/** `owner/repo`, for copy that names the repository. */
export function taskRepositoryFullName(work: TaskRepositoryWork): string {
    const { owner, repo } = resolveTaskRepository(work);
    return `${owner}/${repo}`;
}

/**
 * The Task that opened pull request `prNumber` in `owner/repo`, looked for in
 * EVERY Work whose Task repository that is — and only in those.
 *
 * Only those, because `tasks.prNumber` is unique within the Task repository
 * alone: pull request #7 in a directory Work's website repository is not the
 * pull request its Task #7 opened in the data repository. Every one of them,
 * because one account can register a repository as two Works (an App Work over
 * a directory Work's website repository) and `findByUser` has no order — a
 * first-match lookup filed a review on whichever Work the database listed
 * first, while the resume path looked for it on the other.
 */
export async function findTaskForPullRequest<W extends Work, T>(
    works: readonly W[],
    owner: string,
    repo: string,
    prNumber: number,
    findByWorkAndPrNumber: (workId: string, prNumber: number) => Promise<T | null | undefined>,
): Promise<{ work: W; task: T } | null> {
    for (const { work, roles } of matchWorkRepoRoles(works, owner, repo)) {
        if (!roles.includes(taskRepositoryRole(work.kind))) continue;
        const task = await findByWorkAndPrNumber(work.id, prNumber);
        if (task) return { work, task };
    }
    return null;
}
