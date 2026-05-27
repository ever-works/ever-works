import type { LoggerService } from '@nestjs/common';
import type { GitCommitter } from '@ever-works/plugin';
import type { FacadeCloneOptions, GitFacadeOptions } from '../facades/git.facade';

/**
 * Retry policy for cloning a *freshly-created* GitHub repository.
 *
 * **Why 404 is treated as retryable** (unusual for a "not found"!):
 * after creating a brand-new repo via the GitHub API, there is a
 * short window where the repo isn't yet visible to `git clone`
 * (GitHub's eventual-consistency between API + git frontends). A
 * legitimate "fresh repo doesn't exist yet" appears as a 404 for
 * a few seconds. {@link isFreshRepositoryCloneRetryable} lists 404,
 * "not found", and "could not find" alongside the obvious
 * transient-network errors so that immediate-post-create clones
 * don't fail spuriously.
 *
 * Do NOT use this util to clone a long-existing repo — a real 404
 * there means the user lost access / the repo was deleted, and
 * retrying just wastes 3s before surfacing the real error.
 *
 * Fixed 1s backoff × 3 attempts = ~2s total wait, deliberately
 * tight: GitHub's visibility lag is typically sub-second, so a
 * larger window would just delay genuine failures.
 */
const FRESH_REPOSITORY_CLONE_MAX_ATTEMPTS = 3;
const FRESH_REPOSITORY_CLONE_BACKOFF_MS = 1_000;

type CloneFacade = {
    cloneOrPull(cloneOptions: FacadeCloneOptions, options: GitFacadeOptions): Promise<string>;
};

type FreshRepositoryCloneOptions = {
    owner: string;
    repo: string;
    committer?: GitCommitter;
    userId: string;
    providerId: string;
    workId?: string;
};

export async function cloneFreshRepository(
    gitFacade: CloneFacade,
    { owner, repo, committer, userId, providerId, workId }: FreshRepositoryCloneOptions,
    logger?: Pick<LoggerService, 'warn'>,
): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= FRESH_REPOSITORY_CLONE_MAX_ATTEMPTS; attempt++) {
        try {
            return await gitFacade.cloneOrPull(
                { owner, repo, committer },
                { userId, providerId, workId },
            );
        } catch (error) {
            lastError = error;

            if (
                !isFreshRepositoryCloneRetryable(error) ||
                attempt === FRESH_REPOSITORY_CLONE_MAX_ATTEMPTS
            ) {
                throw error;
            }

            logger?.warn(
                `Clone attempt ${attempt}/${FRESH_REPOSITORY_CLONE_MAX_ATTEMPTS} failed for ${owner}/${repo}; retrying after ${FRESH_REPOSITORY_CLONE_BACKOFF_MS}ms`,
            );

            await new Promise((resolve) => setTimeout(resolve, FRESH_REPOSITORY_CLONE_BACKOFF_MS));
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isFreshRepositoryCloneRetryable(error: unknown): boolean {
    const message =
        error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    return (
        message.includes('404') ||
        message.includes('not found') ||
        message.includes('could not find') ||
        message.includes('econnreset') ||
        message.includes('etimedout')
    );
}
