import type { LoggerService } from '@nestjs/common';
import type { GitCommitter } from '@ever-works/plugin';
import type { FacadeCloneOptions, GitFacadeOptions } from '../facades/git.facade';

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
    directoryId?: string;
};

export async function cloneFreshRepository(
    gitFacade: CloneFacade,
    { owner, repo, committer, userId, providerId, directoryId }: FreshRepositoryCloneOptions,
    logger?: Pick<LoggerService, 'warn'>,
): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= FRESH_REPOSITORY_CLONE_MAX_ATTEMPTS; attempt++) {
        try {
            return await gitFacade.cloneOrPull(
                { owner, repo, committer },
                { userId, providerId, directoryId },
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
