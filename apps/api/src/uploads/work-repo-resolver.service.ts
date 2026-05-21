import { Injectable, Logger } from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';
import { GitFacadeService } from '@ever-works/agent/facades';
import type { WorkRepoResolver, ResolvedWorkRepo } from '@ever-works/github-storage-plugin';

/**
 * EW-644 — concrete `WorkRepoResolver` for the github-storage plugin's
 * `data-repo` mode.
 *
 * Looks up a Work by ID, derives its data-repo coordinates from the
 * existing entity helpers (`work.getRepoOwner('data')` /
 * `work.getDataRepo()`), and asks `GitFacadeService.getAccessToken` to
 * resolve a usable GitHub token using the same priority the rest of
 * the platform follows:
 *
 *   1. GitHub App installation token (if `Work.githubAppInstallationId`).
 *   2. The Work owner's connected GitHub OAuth account (plugin integration first, social sign-in fallback).
 *   3. Operator-configured PAT from plugin settings.
 *
 * This service is wired into the github-storage plugin's `PluginContext`
 * by `storage-backend.factory.ts` so the plugin can call `resolve(workId)`
 * lazily on each upload without binding to NestJS / TypeORM directly.
 *
 * The branch defaults to `'main'` — modern data repos created by the
 * platform are initialised on `main`. If a customer's repo uses
 * `master` we'd need to probe `octokit.repos.get` for `default_branch`;
 * that's a follow-up if anyone hits it in practice (currently no
 * data-repo writer in the codebase relies on a non-default branch).
 */
@Injectable()
export class WorkRepoResolverService implements WorkRepoResolver {
    private readonly logger = new Logger(WorkRepoResolverService.name);
    private readonly PROVIDER_ID = 'github';

    /**
     * EW-644 (Greptile P2 fix) — branch defaults to `main`, the same
     * default `GitOperations.cloneOrPull` uses for fresh clones. Repos
     * that use `master` (or any other custom default) should set
     * `GITHUB_STORAGE_DATA_REPO_BRANCH` until per-Work `default_branch`
     * probing is added in a follow-up. Documented in the plugin README.
     */
    private get defaultBranch(): string {
        return process.env.GITHUB_STORAGE_DATA_REPO_BRANCH || 'main';
    }

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async resolve(workId: string): Promise<ResolvedWorkRepo> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new Error(`Work not found: ${workId}`);
        }

        const owner = work.getRepoOwner('data');
        const repo = work.getDataRepo();
        if (!owner || !repo) {
            throw new Error(
                `Work ${workId} has no resolvable data repo coordinates ` +
                    `(owner=${JSON.stringify(owner)}, repo=${JSON.stringify(repo)}). ` +
                    `Mode 'data-repo' on the github-storage plugin requires a configured data repo.`,
            );
        }

        const token = await this.gitFacade.getAccessToken({
            userId: work.userId,
            providerId: this.PROVIDER_ID,
            workId,
        });
        if (!token) {
            throw new Error(
                `Work ${workId}: no GitHub token available for user ${work.userId} ` +
                    `(no GitHub App installation, no connected OAuth account with 'repo' scope, ` +
                    `no PAT in plugin settings). Connect GitHub for this user before using ` +
                    `the github-storage plugin in 'data-repo' mode.`,
            );
        }

        return {
            owner,
            repo,
            branch: this.defaultBranch,
            token,
        };
    }
}
