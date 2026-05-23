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
 * EW-644 (Greptile P2 follow-up) — the default branch is probed from
 * `octokit.repos.get(default_branch)` on first contact and cached
 * per-Work for `BRANCH_CACHE_TTL_MS`. Probing once per Work covers the
 * common `main`/`master` divergence without paying an Octokit round
 * trip on every upload. The probe can be skipped entirely by setting
 * `GITHUB_STORAGE_DATA_REPO_BRANCH` (e.g. for deployments that pin a
 * non-default branch).
 */
@Injectable()
export class WorkRepoResolverService implements WorkRepoResolver {
    private readonly logger = new Logger(WorkRepoResolverService.name);
    private readonly PROVIDER_ID = 'github';

    /**
     * In-memory cache of `<owner>/<repo>` → `{ branch, expiresAtMs }`.
     * Module-scoped (single Node process); each replica reprobes on its
     * own. TTL keeps stale entries from outlasting a default-branch
     * rename on GitHub's side.
     */
    private readonly branchCache = new Map<string, { branch: string; expiresAtMs: number }>();
    private readonly BRANCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

        const branch = await this.resolveBranch(work.userId, workId, owner, repo);

        return { owner, repo, branch, token };
    }

    /**
     * Resolve the branch for a given `<owner>/<repo>` data repo.
     *
     * Priority:
     *   1. `GITHUB_STORAGE_DATA_REPO_BRANCH` env override — pinned for
     *      the whole deployment.
     *   2. Cached probe result, if not expired.
     *   3. Fresh `GitFacadeService.getRepository(...)` probe, cached.
     *      Routes through the github plugin's Octokit wrapper — same
     *      path the rest of the platform uses for GitHub REST calls,
     *      so we don't reinvent auth / GHE base URL / rate-limit
     *      handling here.
     *   4. `'main'` fallback if the probe fails for any reason — the
     *      worst case is a non-ff push that the operator can fix by
     *      setting the env var. We don't throw on probe failure so a
     *      transient GitHub blip doesn't break uploads.
     */
    private async resolveBranch(
        userId: string,
        workId: string,
        owner: string,
        repo: string,
    ): Promise<string> {
        const pinned = process.env.GITHUB_STORAGE_DATA_REPO_BRANCH;
        if (pinned) return pinned;

        const cacheKey = `${owner}/${repo}`;
        const cached = this.branchCache.get(cacheKey);
        if (cached && cached.expiresAtMs > Date.now()) {
            return cached.branch;
        }

        try {
            const repoInfo = await this.gitFacade.getRepository(owner, repo, {
                userId,
                providerId: this.PROVIDER_ID,
                workId,
            });
            const branch = repoInfo?.defaultBranch || 'main';
            this.branchCache.set(cacheKey, {
                branch,
                expiresAtMs: Date.now() + this.BRANCH_CACHE_TTL_MS,
            });
            return branch;
        } catch (err) {
            this.logger.warn(
                `Failed to probe default branch for ${cacheKey}; falling back to 'main'. ` +
                    `Set GITHUB_STORAGE_DATA_REPO_BRANCH if this Work uses a different default. ` +
                    `Cause: ${err instanceof Error ? err.message : String(err)}`,
            );
            return 'main';
        }
    }
}
