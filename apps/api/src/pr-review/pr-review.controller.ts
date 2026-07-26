import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrReviewService, type PrReviewResult } from '@ever-works/agent/pr-review';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ReviewPullRequestDto } from './dto/review-pull-request.dto';

/**
 * AI pull-request review trigger:
 *
 *   POST /api/pr-review
 *     { owner, repo, prNumber, instruction?, workId? }
 *     → PrReviewResult
 *
 * Why this exists: `PrReviewService.reviewPullRequest` shipped with two
 * ways in — the GitHub webhook bridge and the `review_pull_request` agent
 * chat tool — and no REST route, so the manifest-driven web tool registry
 * could not register the tool at all. This is that missing trigger.
 *
 * ## Why top-level and not nested under a Work or Task
 *
 * A review is addressed by a PROVIDER coordinate (`owner/repo#number`),
 * not by a platform entity id. A Work declares several repos (main /
 * website / data) and a repo may match no Work at all, so
 * `POST /api/works/:id/pull-requests/:n/review` would demand a Work id
 * that the caller — the chat model, a PR list row, a webhook — usually
 * does not have, and would be undefined for the repo-without-a-Work case
 * the reviewer explicitly supports. `GET /api/works/:id/pull-requests`
 * stays Work-nested because it ENUMERATES one Work's repos, which is a
 * genuinely Work-shaped question. Precedent for a top-level verb
 * resource over a cross-cutting service: `GET /api/merge-policy/resolve`.
 *
 * ## Security — the review must not be a cross-user fetch primitive
 *
 * `reviewPullRequest` pulls a diff with the caller's git credentials and
 * posts a comment back, so an unscoped trigger would let any user aim the
 * platform at any repository. Ownership is therefore established BEFORE
 * anything runs, and the endpoint refuses otherwise:
 *
 *  * `workId` given → `WorkOwnershipService.ensureAccess` (a Work the
 *    caller cannot reach 404s with no existence leak), AND the repo must
 *    belong to a Work in the caller's account;
 *  * no `workId` → `matchWorkForRepo(auth.userId, owner, repo)` must
 *    match, and that lookup only ever searches the caller's OWN Works.
 *
 * A repo connected to somebody else's Work — or to no Work at all —
 * therefore 404s with the same message, leaking nothing about which of
 * the two it was. This is deliberately stricter than the chat tool,
 * which runs inside an already owner-scoped agent; a REST endpoint takes
 * its coordinates straight from the client and has to prove the link
 * itself.
 */
@ApiTags('pr-review')
@Controller('api/pr-review')
export class PrReviewController {
    constructor(
        private readonly prReview: PrReviewService,
        private readonly ownership: WorkOwnershipService,
    ) {}

    @Post()
    @ApiOperation({
        summary:
            'Run the Work-aware AI reviewer on a pull request in a repository connected to one of my Works, and post the review.',
    })
    @HttpCode(HttpStatus.OK)
    // Each review pulls a diff and calls a model — bounded well below the
    // read-endpoint allowance so a loop cannot burn a user's credits.
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async reviewPullRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: ReviewPullRequestDto,
    ): Promise<PrReviewResult> {
        if (dto.workId) {
            // Throws 404 for a Work the caller cannot reach.
            await this.ownership.ensureAccess(dto.workId, auth.userId);
        }

        // Owner-scoped by construction: `matchWorkForRepo` only searches
        // the caller's own Works. Runs even when `workId` was supplied,
        // so a caller cannot pair one of their own Work ids with somebody
        // else's repository.
        const work = await this.prReview.matchWorkForRepo(auth.userId, dto.owner, dto.repo);
        if (!work) {
            throw new NotFoundException(
                `No Work in your account is connected to '${dto.owner}/${dto.repo}'`,
            );
        }

        return this.prReview.reviewPullRequest({
            userId: auth.userId,
            owner: dto.owner,
            repo: dto.repo,
            prNumber: dto.prNumber,
            ...(dto.instruction ? { instruction: dto.instruction } : {}),
            workId: dto.workId ?? work.id,
        });
    }
}
