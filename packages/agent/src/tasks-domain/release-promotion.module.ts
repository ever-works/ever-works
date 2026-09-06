import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReleasePromotion } from '../entities/release-promotion.entity';
import { ReleasePromotionRepository } from '../database/repositories/release-promotion.repository';
import {
    PROMOTION_LANE_WATCHER,
    PROMOTION_MERGE_GUARD,
} from '../policy/promotion-merge-guard.port';
import { FacadesModule } from '../facades/facades.module';
import { ReleasePromotionService } from './release-promotion.service';
import { TasksDomainModule } from './tasks.module';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the module that
 * binds `PROMOTION_MERGE_GUARD` and `PROMOTION_LANE_WATCHER`.
 *
 * ## Why it is @Global(), and why it is not inside TasksDomainModule
 *
 * `ReleasePromotionService` FILES A TASK, so it needs `TasksService`, and
 * it opens a pull request, so it needs `GitFacadeService`. That makes it a
 * consumer of `TasksDomainModule`. But two services INSIDE
 * `TasksDomainModule` need it back — `TaskPrStatusService` drives the
 * refresh and `TaskMergeGateService` consults the guard — and a module
 * cycle is a boot failure, not a lint warning.
 *
 * The way out is the one `INBOX_PRODUCER` already uses in this codebase:
 * the consumers inject a TOKEN, `@Optional()`, and a `@Global()` module at
 * the app root binds it. `TasksDomainModule` stays a leaf with respect to
 * this feature, and a deployment that never imports this module simply has
 * no promotion lane — which is the safe direction, because the merge gate
 * refuses a promotion Task outright when the guard is unbound.
 *
 * ## `ReleasePromotionRepository` is provided HERE
 *
 * It is deliberately NOT in `_repository-inventory.ts` — that file is the
 * DatabaseModule-owned set, and adding a feature repository to it exports
 * it to the whole platform for the benefit of one module. Same call
 * `MergeApprovalModule` makes for `TaskRepository`. Injecting it without
 * this provider line is an unresolvable dependency and the API does not
 * boot; `release-promotion.module.spec.ts` compiles the provider list
 * against a real container so that cannot ship again.
 *
 * `ReleasePromotion` must ALSO stay registered in
 * `database/_entities-inventory.ts` — this repo has no `autoLoadEntities`,
 * so a forFeature'd-but-unregistered entity throws
 * EntityMetadataNotFoundError on first query.
 */
@Global()
@Module({
    imports: [
        TypeOrmModule.forFeature([ReleasePromotion]),
        // Exports TasksService (files the promotion Task), TaskRepository,
        // WorkRepository and TaskChatMessageRepository.
        TasksDomainModule,
        // Exports GitFacadeService (opens the pull request, reads the
        // branch tips and the gate run).
        FacadesModule,
    ],
    providers: [
        ReleasePromotionRepository,
        ReleasePromotionService,
        // Bound with `useExisting` so consumers depend on the CONTRACT and
        // never on the concrete class — and so both tokens resolve to ONE
        // instance, which matters: the guard reads state the watcher wrote.
        { provide: PROMOTION_MERGE_GUARD, useExisting: ReleasePromotionService },
        { provide: PROMOTION_LANE_WATCHER, useExisting: ReleasePromotionService },
    ],
    exports: [
        ReleasePromotionRepository,
        ReleasePromotionService,
        PROMOTION_MERGE_GUARD,
        PROMOTION_LANE_WATCHER,
    ],
})
export class ReleasePromotionModule {}
