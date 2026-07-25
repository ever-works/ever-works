import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GitPullRequest } from '@ever-works/plugin';
import { GitFacadeService, type GitFacadeOptions } from '@ever-works/agent/facades';
import { WorkRepository } from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/** One repo's PR listing in the per-Work response. */
export interface WorkRepoPullRequests {
    role: 'work' | 'website' | 'data';
    owner: string;
    repo: string;
    pullRequests: GitPullRequest[];
    /** Present when this repo's listing failed (others still return). */
    error?: string;
}

/**
 * GitHub PR review loop (Wave 7, feature h — platform surface, v1):
 *
 *   GET /api/works/:id/pull-requests
 *     → { repos: [{ role, owner, repo, pullRequests[] }] }
 *
 * Lists open PRs across every repo the Work declares (main / website /
 * data roles) through the git facade, owner-scoped, so the web app can
 * render a PR list on Work detail. Per-repo failures degrade to an
 * `error` entry instead of failing the whole response (a Work's data
 * repo may exist while its website repo was never generated).
 *
 * Security: `WorkOwnershipService.ensureAccess` gates the Work first —
 * cross-user Works 404 with no existence leak (architecture/security
 * §9). Git credentials resolve inside the facade (installation token /
 * OAuth / PAT); this controller never touches tokens.
 *
 * Follow-up milestone (documented, not in v1): the full in-platform
 * review UI — diff viewer, approve/merge/comment actions gated by the
 * policy matrix, and chat-first equivalents — builds on this endpoint
 * plus `PrReviewService` (`@ever-works/agent/pr-review`).
 */
@ApiTags('works')
@Controller('api')
export class WorkPullRequestsController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    @Get('works/:id/pull-requests')
    @ApiOperation({
        summary: "List open pull requests across the Work's repos (main / website / data).",
    })
    @HttpCode(HttpStatus.OK)
    async listPullRequests(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ repos: WorkRepoPullRequests[] }> {
        await this.ownership.ensureAccess(id, auth.userId);
        const work = await this.workRepository.findById(id);
        if (!work) {
            return { repos: [] };
        }

        const gitOptions: GitFacadeOptions = {
            providerId: work.gitProvider || 'github',
            userId: auth.userId,
            workId: id,
        };

        // Distinct repo coordinates only — a Work whose roles collapse to
        // one repo (defaults derive from the slug) lists it once.
        const roles: Array<{ role: WorkRepoPullRequests['role']; owner: string; repo: string }> =
            [];
        const seen = new Set<string>();
        for (const role of ['work', 'website', 'data'] as const) {
            const owner = work.getRepoOwner?.(role);
            const repo =
                role === 'data'
                    ? work.getDataRepo?.()
                    : role === 'website'
                      ? work.getWebsiteRepo?.()
                      : work.getMainRepo?.();
            if (!owner || !repo) continue;
            const key = `${owner}/${repo}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            roles.push({ role, owner, repo });
        }

        const repos = await Promise.all(
            roles.map(async ({ role, owner, repo }): Promise<WorkRepoPullRequests> => {
                try {
                    const pullRequests = await this.gitFacade.listPullRequests(
                        owner,
                        repo,
                        { state: 'open', perPage: 30 },
                        gitOptions,
                    );
                    return { role, owner, repo, pullRequests };
                } catch (error) {
                    return {
                        role,
                        owner,
                        repo,
                        pullRequests: [],
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }),
        );

        return { repos };
    }
}
