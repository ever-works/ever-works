import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { ReleasePromotionModule } from '@ever-works/agent/tasks-domain';
import { ReleasePromotionsController } from './release-promotions.controller';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the api-side
 * mount for `develop → stage → main`.
 *
 * Importing `ReleasePromotionModule` here is what BINDS
 * `PROMOTION_MERGE_GUARD` and `PROMOTION_LANE_WATCHER` for the whole app:
 * that module is `@Global()`, so `TaskPrStatusService` and
 * `TaskMergeGateService` — which inject both tokens `@Optional()` — pick
 * them up without `TasksDomainModule` having to import the module that
 * imports it.
 *
 * The consequence, stated because it is a safety property rather than an
 * accident: DROP this import and the platform does not silently start
 * merging promotions through the ordinary agent path. `TaskMergeGateService`
 * recognises a promotion Task off its own labels and stands down when the
 * guard is unbound, so the lane fails closed rather than open.
 *
 * `DatabaseModule` is imported for `WorkRepository`, which the controller
 * uses to read and write the Work's release ladder.
 */
@Module({
    imports: [DatabaseModule, ReleasePromotionModule],
    controllers: [ReleasePromotionsController],
})
export class ReleaseModule {}
