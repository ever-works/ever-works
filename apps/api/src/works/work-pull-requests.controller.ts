import {
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseIntPipe,
    ParseUUIDPipe,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { GitPullRequest, GitPullRequestFile } from '@ever-works/plugin';
import { GitFacadeService, type GitFacadeOptions } from '@ever-works/agent/facades';
import { WorkRepository } from '@ever-works/agent/database';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { PrReviewService } from '@ever-works/agent/pr-review';
import { IngestedEventRepository } from '@ever-works/agent/ingest';
import type { Work } from '@ever-works/agent/entities';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/** The three repo roles a Work can declare, in display order. */
const WORK_REPO_ROLES = ['work', 'website', 'data'] as const;
type WorkRepoRole = (typeof WORK_REPO_ROLES)[number];

/** One repo's PR listing in the per-Work response. */
export interface WorkRepoPullRequests {
    role: WorkRepoRole;
    owner: string;
    repo: string;
    pullRequests: GitPullRequest[];
    /**
     * How many agent reviews this Work has recorded per PR number, keyed
     * by the number as a string (JSON object keys). Absent numbers mean
     * zero. Sourced from the ingest spine's `github.pr.review` envelopes
     * — the platform's own record — so the list can show a truthful
     * "reviewed" pill without one git call per PR.
     */
    reviewCounts: Record<string, number>;
    /** Present when this repo's listing failed (others still return). */
    error?: string;
}

/**
 * One file's diff in the PR diff response. Mirrors `GitPullRequestFile`
 * with the patch byte-capped so a giant PR can never blow up a browser.
 */
export interface WorkPullRequestDiffFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    /** True when this file's patch was cut at the byte cap. */
    truncated: boolean;
}

/** Per-file patch cap (bytes) — the UI renders, it does not compile. */
export const PR_DIFF_FILE_PATCH_MAX_BYTES = 24_000;

/** Total patch budget across the response (bytes). */
export const PR_DIFF_TOTAL_PATCH_MAX_BYTES = 200_000;

/** Files returned per diff response. */
export const PR_DIFF_MAX_FILES = 300;

/** Agent reviews returned per PR. */
export const PR_REVIEWS_MAX = 20;

/** One agent review of this PR, read back off the ingest spine. */
export interface WorkPullRequestReview {
    id: string;
    occurredAt: Date;
    summary: string | null;
    /** Number of per-file notes the structured review carried. */
    commentCount: number | null;
    /** True when the summary comment landed on the PR. */
    posted: boolean;
    sourceUrl: string | null;
}

export interface WorkPullRequestDiffResponse {
    pullRequest: GitPullRequest;
    files: WorkPullRequestDiffFile[];
    /** True when the file list itself was cut (file count or byte budget). */
    truncated: boolean;
    reviews: WorkPullRequestReview[];
}

/**
 * GitHub PR review loop (Wave 7, feature h — in-platform review surface):
 *
 *   GET  /api/works/:id/pull-requests
 *     → { repos: [{ role, owner, repo, pullRequests[] }] }
 *   GET  /api/works/:id/pull-requests/:owner/:repo/:number
 *     → { pullRequest, files[], truncated, reviews[] }
 *   POST /api/works/:id/pull-requests/:owner/:repo/:number/review
 *     → PrReviewResult (runs the Work-aware reviewer on demand)
 *
 * The list endpoint spans every repo the Work declares (main / website /
 * data roles) through the git facade. The detail endpoint adds the
 * byte-capped per-file diff the web review view renders, plus the agent
 * reviews already recorded for that PR — read back off the event-ingest
 * spine (`github.pr.review` envelopes carry the summary + comment count
 * and are the platform's own record of a review), so the UI shows review
 * history without a second write path. The review endpoint is the
 * "Request agent review" action: it calls the SAME `PrReviewService` the
 * GitHub webhook bridge does, so a manual review is byte-identical to an
 * automatic one.
 *
 * Security: `WorkOwnershipService.ensureAccess` gates the Work first —
 * cross-user Works 404 with no existence leak (architecture/security
 * §9). The per-PR routes additionally require `owner/repo` to be one of
 * the Work's OWN declared repos: without that check these endpoints
 * would let any authenticated caller read diffs from, and post AI
 * reviews onto, an arbitrary repository using the platform's git
 * credentials. Git credentials resolve inside the facade (installation
 * token / OAuth / PAT); this controller never touches tokens.
 */
@ApiTags('works')
@Controller('api')
export class WorkPullRequestsController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly prReview: PrReviewService,
        private readonly events: IngestedEventRepository,
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

        // ONE spine read for the whole Work, not one per PR — the review
        // rows are already owner-scoped and Work-scoped in SQL.
        const reviewRows = await this.loadReviewRows(auth.userId, id);

        const repos = await Promise.all(
            this.resolveRepos(work).map(
                async ({ role, owner, repo }): Promise<WorkRepoPullRequests> => {
                    const reviewCounts = this.countReviews(reviewRows, owner, repo);
                    try {
                        const pullRequests = await this.gitFacade.listPullRequests(
                            owner,
                            repo,
                            { state: 'open', perPage: 30 },
                            gitOptions,
                        );
                        return { role, owner, repo, pullRequests, reviewCounts };
                    } catch (error) {
                        return {
                            role,
                            owner,
                            repo,
                            pullRequests: [],
                            reviewCounts,
                            error: error instanceof Error ? error.message : String(error),
                        };
                    }
                },
            ),
        );

        return { repos };
    }

    /**
     * One PR's diff + the agent reviews already recorded for it. The
     * patch text is capped per file AND in total; `truncated` says so
     * rather than silently shipping a partial diff as if it were whole.
     */
    @Get('works/:id/pull-requests/:owner/:repo/:number')
    @ApiOperation({
        summary: "One pull request's byte-capped diff plus its recorded agent reviews.",
    })
    @HttpCode(HttpStatus.OK)
    async getPullRequestDiff(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('owner') owner: string,
        @Param('repo') repo: string,
        @Param('number', ParseIntPipe) prNumber: number,
    ): Promise<WorkPullRequestDiffResponse> {
        const work = await this.ensureWorkRepo(auth.userId, id, owner, repo);

        const gitOptions: GitFacadeOptions = {
            providerId: work.gitProvider || 'github',
            userId: auth.userId,
            workId: id,
        };

        const pullRequest = await this.gitFacade.getPullRequest(owner, repo, prNumber, gitOptions);
        if (!pullRequest) {
            throw new NotFoundException(`Pull request ${owner}/${repo}#${prNumber} not found`);
        }

        let rawFiles: GitPullRequestFile[] = [];
        try {
            rawFiles = await this.gitFacade.getPullRequestFiles(owner, repo, prNumber, gitOptions);
        } catch {
            // A diff the provider refuses (too large, permissions) still
            // renders as the PR header + reviews rather than a 500.
            rawFiles = [];
        }

        const { files, truncated } = this.capDiff(rawFiles);
        const reviews = await this.loadReviews(auth.userId, id, owner, repo, prNumber);

        return { pullRequest, files, truncated, reviews };
    }

    /**
     * "Request agent review" — runs the Work-aware reviewer on demand
     * through the same service the webhook bridge uses. Throttled: each
     * call is one AI completion plus a comment post.
     */
    @Post('works/:id/pull-requests/:owner/:repo/:number/review')
    @ApiOperation({ summary: 'Run the Work-aware agent PR review for one pull request.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async requestReview(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('owner') owner: string,
        @Param('repo') repo: string,
        @Param('number', ParseIntPipe) prNumber: number,
    ) {
        const work = await this.ensureWorkRepo(auth.userId, id, owner, repo);
        return this.prReview.reviewPullRequest({
            userId: auth.userId,
            owner,
            repo,
            prNumber,
            workId: work.id,
            providerId: work.gitProvider || 'github',
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /**
     * Distinct repo coordinates the Work declares. A Work whose roles
     * collapse to one repo (defaults derive from the slug) lists it once.
     */
    private resolveRepos(work: Work): Array<{ role: WorkRepoRole; owner: string; repo: string }> {
        const roles: Array<{ role: WorkRepoRole; owner: string; repo: string }> = [];
        const seen = new Set<string>();
        for (const role of WORK_REPO_ROLES) {
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
        return roles;
    }

    /**
     * Gate the Work (404 on cross-user) AND confirm the requested
     * repository is one the Work itself declares. Without the second
     * check, the platform's git credentials would read and comment on
     * any repo a caller can name.
     */
    private async ensureWorkRepo(
        userId: string,
        workId: string,
        owner: string,
        repo: string,
    ): Promise<Work> {
        await this.ownership.ensureAccess(workId, userId);
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work ${workId} not found`);
        }
        const wanted = `${owner}/${repo}`.toLowerCase();
        const declared = this.resolveRepos(work).some(
            (r) => `${r.owner}/${r.repo}`.toLowerCase() === wanted,
        );
        if (!declared) {
            throw new ForbiddenException(
                `Repository ${owner}/${repo} is not one of this Work's repositories`,
            );
        }
        return work;
    }

    /** Apply the per-file and total patch budgets to a raw file list. */
    private capDiff(rawFiles: GitPullRequestFile[]): {
        files: WorkPullRequestDiffFile[];
        truncated: boolean;
    } {
        const files: WorkPullRequestDiffFile[] = [];
        let budget = PR_DIFF_TOTAL_PATCH_MAX_BYTES;
        let truncated = rawFiles.length > PR_DIFF_MAX_FILES;

        for (const file of rawFiles.slice(0, PR_DIFF_MAX_FILES)) {
            const entry: WorkPullRequestDiffFile = {
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                truncated: false,
            };
            const patch = file.patch ?? '';
            if (patch.length > 0 && budget > 0) {
                const allowance = Math.min(PR_DIFF_FILE_PATCH_MAX_BYTES, budget);
                entry.patch = patch.length > allowance ? patch.slice(0, allowance) : patch;
                entry.truncated = entry.patch.length < patch.length;
                if (entry.truncated) truncated = true;
                budget -= entry.patch.length;
            } else if (patch.length > 0) {
                // Budget spent — the file is listed with its counts only.
                entry.truncated = true;
                truncated = true;
            }
            files.push(entry);
        }

        return { files, truncated };
    }

    /**
     * The Work's recent `github.pr.review` envelopes — the platform's own
     * record of every review it has run. Owner- and Work-scoped in SQL;
     * a spine failure degrades to "no review history" rather than
     * failing the whole response.
     */
    private async loadReviewRows(
        userId: string,
        workId: string,
    ): Promise<Awaited<ReturnType<IngestedEventRepository['findRecentByWork']>>> {
        try {
            const rows = await this.events.findRecentByWork(userId, workId, 200);
            return rows.filter((row) => row.kind === 'github.pr.review');
        } catch {
            return [];
        }
    }

    /**
     * Does this review row describe `owner/repo#prNumber`? The envelope
     * payload is the only place the PR coordinates live.
     */
    private matchesPr(
        payload: Record<string, unknown>,
        owner: string,
        repo: string,
        prNumber: number,
    ): boolean {
        return (
            String(payload.owner ?? '').toLowerCase() === owner.toLowerCase() &&
            String(payload.repo ?? '').toLowerCase() === repo.toLowerCase() &&
            Number(payload.prNumber) === prNumber
        );
    }

    /** Reviews per PR number for one repo, for the list response's pill. */
    private countReviews(
        rows: Awaited<ReturnType<IngestedEventRepository['findRecentByWork']>>,
        owner: string,
        repo: string,
    ): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const row of rows) {
            const payload = (row.payload ?? {}) as Record<string, unknown>;
            const prNumber = Number(payload.prNumber);
            if (!Number.isFinite(prNumber)) continue;
            if (!this.matchesPr(payload, owner, repo, prNumber)) continue;
            counts[String(prNumber)] = (counts[String(prNumber)] ?? 0) + 1;
        }
        return counts;
    }

    /** Agent reviews for ONE pull request, newest first. */
    private async loadReviews(
        userId: string,
        workId: string,
        owner: string,
        repo: string,
        prNumber: number,
    ): Promise<WorkPullRequestReview[]> {
        const rows = await this.loadReviewRows(userId, workId);
        return rows
            .filter((row) =>
                this.matchesPr(
                    (row.payload ?? {}) as Record<string, unknown>,
                    owner,
                    repo,
                    prNumber,
                ),
            )
            .slice(0, PR_REVIEWS_MAX)
            .map((row) => {
                const payload = (row.payload ?? {}) as Record<string, unknown>;
                return {
                    id: row.id,
                    occurredAt: row.occurredAt,
                    summary: typeof payload.summary === 'string' ? payload.summary : null,
                    commentCount:
                        typeof payload.commentCount === 'number' ? payload.commentCount : null,
                    posted: payload.posted === true,
                    sourceUrl: row.sourceUrl ?? null,
                };
            });
    }
}
