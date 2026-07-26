import { Module } from '@nestjs/common';
import { PrReviewModule } from '@ever-works/agent/pr-review';
import { WorkModule } from '@ever-works/agent/services';
import { PrReviewController } from './pr-review.controller';

/**
 * PR-review API module — thin owner-scoped trigger over the agent-side
 * `PrReviewModule` (diff fetch, prompt assembly, Work/KB/Memory context
 * and the comment post all live there).
 *
 * `WorkModule` supplies `WorkOwnershipService` for the `workId` check the
 * controller runs BEFORE any review starts; the repo→Work match that
 * gates every call comes from `PrReviewService` itself and is already
 * owner-filtered.
 *
 * Named `PrReviewApiModule` to avoid colliding with the agent-side
 * `PrReviewModule` it wraps, matching `MergePolicyApiModule` next door.
 */
@Module({
    imports: [PrReviewModule, WorkModule],
    controllers: [PrReviewController],
    exports: [PrReviewModule],
})
export class PrReviewApiModule {}
