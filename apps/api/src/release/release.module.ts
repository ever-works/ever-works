import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { ReleasePromotionModule } from '@ever-works/agent/tasks-domain';
import { ReleasePromotionsController } from './release-promotions.controller';
import { ReleaseVerificationCronService } from './release-verification-cron.service';
import { ReleaseVerificationListener } from './release-verification.listener';

/**
 * Release lane (self-build slices AI + AJ, EW-808 / EW-809) — the api-side
 * mount for `develop → stage → main` and for the post-deploy verification
 * that follows a merged rung.
 *
 * Importing `ReleasePromotionModule` here is what BINDS
 * `PROMOTION_MERGE_GUARD` and `PROMOTION_LANE_WATCHER` for the whole app:
 * that module is `@Global()`, so `TaskPrStatusService` and
 * `TaskMergeGateService` — which inject both tokens `@Optional()` — pick
 * them up without `TasksDomainModule` having to import the module that
 * imports it. It also exports `ReleaseVerificationService`, which the two
 * providers below drive.
 *
 * The consequence, stated because it is a safety property rather than an
 * accident: DROP this import and the platform does not silently start
 * merging promotions through the ordinary agent path. `TaskMergeGateService`
 * recognises a promotion Task off its own labels and stands down when the
 * guard is unbound, so the lane fails closed rather than open. The same
 * direction holds for the verification half: without this module nothing
 * checks a deployment, and — because a verdict only ever exists as a row
 * somebody wrote — nothing claims one was checked either.
 *
 * ## The two halves of the verification clock
 *
 * `ReleaseVerificationListener` reacts to `fleet.job.completed` and turns a
 * node's browser-check report into a verdict.
 * `ReleaseVerificationCronService` spaces the probes out and expires the
 * verifications that ran out of road — the fleet queue has no delay
 * primitive, and nothing else in the platform ever revisits a merged
 * promotion.
 *
 * `DistributedTaskLockService` is the documented wiring for a multi-replica
 * sweep (`docs/agent-services/distributed-task-lock.md#module-wiring`), and
 * providing it HERE is load-bearing: it is not global, so removing it from
 * `providers` below makes `ReleaseVerificationCronService` unresolvable and
 * the API does not boot.
 *
 * `TypeOrmModule.forFeature([CacheEntry])` is NOT load-bearing, and this is
 * stated because an earlier version of the spec beside this file claimed it
 * was. `DatabaseModule` already does `TypeOrmModule.forFeature(ENTITIES)`
 * with `CacheEntry` among them and re-exports `TypeOrmModule`, so the
 * repository token is in scope through the import above; the sibling
 * `NotificationsModule` provides the same lock service with `DatabaseModule`
 * alone. This line is kept so the module states its own storage dependency
 * rather than inheriting it silently — removing it is undetectable, so no
 * mutation check claims otherwise.
 *
 * `DatabaseModule` is imported for `WorkRepository`, which the controller
 * uses to read and write the Work's release ladder and verification
 * targets.
 */
@Module({
    imports: [TypeOrmModule.forFeature([CacheEntry]), DatabaseModule, ReleasePromotionModule],
    controllers: [ReleasePromotionsController],
    providers: [
        ReleaseVerificationListener,
        ReleaseVerificationCronService,
        DistributedTaskLockService,
    ],
})
export class ReleaseModule {}
