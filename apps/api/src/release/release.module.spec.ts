import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES, WorkCustomDomainRepository, WorkRepository } from '@ever-works/agent/database';
import {
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';
import { PluginUsageService } from '@ever-works/agent/usage';
import { BudgetGuardService } from '@ever-works/agent/budgets';
import { EverWorksK8sDeployProvider } from '@ever-works/agent/ever-works-providers';
import {
    ReleasePromotionService,
    ReleaseVerificationService,
} from '@ever-works/agent/tasks-domain';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { PROMOTION_LANE_WATCHER, PROMOTION_MERGE_GUARD } from '@ever-works/agent/policy';
import { ReleaseModule } from './release.module';
import { ReleasePromotionsController } from './release-promotions.controller';
import { ReleaseVerificationCronService } from './release-verification-cron.service';
import { ReleaseVerificationListener } from './release-verification.listener';

/**
 * `ReleaseModule` against a REAL Nest container.
 *
 * The api-side half of the same guard `release-promotion.module.spec.ts`
 * applies in `packages/agent`, and it exists for the same reason: a module
 * whose controller injects something the module does not import passes
 * every unit spec — `release-promotions.controller.spec.ts` constructs the
 * controller positionally — and then the API refuses to boot. Reading
 * `Reflect.getMetadata('imports', …)` does not catch it either; that only
 * proves a name is in a list, never that the graph resolves.
 *
 * MUTATION CHECKS, executed rather than assumed:
 *
 *   - removing `DatabaseModule` from `ReleaseModule`'s imports makes
 *     `WorkRepository` — which `ReleasePromotionsController` injects to
 *     read and write the Work's release ladder — unresolvable, and this
 *     file fails. Before it existed, that change left `apps/api` entirely
 *     green;
 *   - removing `DistributedTaskLockService` from `providers` makes
 *     `ReleaseVerificationCronService` unresolvable — it is not a global
 *     provider — and this file fails;
 *   - removing `ReleaseVerificationListener` or
 *     `ReleaseVerificationCronService` from `providers` fails the two
 *     slice-AJ tests below — and would otherwise mean a platform that
 *     enqueues nothing and reads nothing back, silently.
 *
 * NOT a mutation check, corrected during the slice-AJ review: this file
 * used to claim that removing `TypeOrmModule.forFeature([CacheEntry])`
 * makes `DistributedTaskLockService` unresolvable. It does not — I removed
 * it and all three tests still passed. `DatabaseModule` already registers
 * every entity and re-exports `TypeOrmModule`, which is why
 * `NotificationsModule` provides the same lock service with no `forFeature`
 * of its own. The line stays for self-containedness; the claim does not,
 * because a false provenance note is worse than none — it tells the next
 * author a guard exists where there is nothing.
 *
 * The `@Global()` stub below stands in for the providers the running API
 * supplies from its ROOT module, which `FacadesModule`'s graph reaches
 * transitively. Nothing the release lane itself depends on is stubbed.
 */
const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
    PluginUsageService,
    BudgetGuardService,
    WorkCustomDomainRepository,
    EverWorksK8sDeployProvider,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('ReleaseModule — dependency injection', () => {
    async function compile() {
        return Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                ReleaseModule,
            ],
        }).compile();
    }

    it('resolves the controller with BOTH of its constructor dependencies', async () => {
        const moduleRef = await compile();

        const controller = moduleRef.get(ReleasePromotionsController);
        expect(controller).toBeInstanceOf(ReleasePromotionsController);
        // The two things the controller cannot work without: the promotion
        // service (opens a rung, lists history) and WorkRepository (reads
        // and writes the release ladder — the platform state a caller can
        // never supply itself).
        expect(moduleRef.get(ReleasePromotionService, { strict: false })).toBeInstanceOf(
            ReleasePromotionService,
        );
        expect(moduleRef.get(WorkRepository, { strict: false })).toBeInstanceOf(WorkRepository);

        await moduleRef.close();
    });

    it('resolves the post-deploy verification clock — both halves of it', async () => {
        // Slice AJ (EW-809). Without BOTH of these the lane is inert in a
        // way nothing else would notice: the cron is the only thing that
        // ever produces a `browser-check`, and the listener is the only
        // thing that ever reads one back. A promotion would merge, a
        // verification would start, and the row would sit in
        // `awaiting-rollout` until its deadline.
        const moduleRef = await compile();

        expect(moduleRef.get(ReleaseVerificationCronService)).toBeInstanceOf(
            ReleaseVerificationCronService,
        );
        expect(moduleRef.get(ReleaseVerificationListener)).toBeInstanceOf(
            ReleaseVerificationListener,
        );
        // The lock service the sweep needs, and the entity that backs it.
        expect(moduleRef.get(DistributedTaskLockService)).toBeInstanceOf(
            DistributedTaskLockService,
        );
        // Both halves drive the SAME verification service the promotion
        // lane hands merged promotions to.
        expect(moduleRef.get(ReleaseVerificationService, { strict: false })).toBeInstanceOf(
            ReleaseVerificationService,
        );

        await moduleRef.close();
    });

    it('BINDS both promotion tokens app-wide, which is what makes the lane live', async () => {
        // Importing `ReleasePromotionModule` here is what binds
        // `PROMOTION_MERGE_GUARD` and `PROMOTION_LANE_WATCHER` for the
        // whole app: it is `@Global()`, and `TaskPrStatusService` /
        // `TaskMergeGateService` inject both `@Optional()`. Dropping the
        // import does not open a hole — the merge gate refuses a promotion
        // Task whose guard is unbound — but it silently disables the lane.
        const moduleRef = await compile();

        const service = moduleRef.get(ReleasePromotionService, { strict: false });
        expect(moduleRef.get(PROMOTION_MERGE_GUARD, { strict: false })).toBe(service);
        expect(moduleRef.get(PROMOTION_LANE_WATCHER, { strict: false })).toBe(service);

        await moduleRef.close();
    });
});
