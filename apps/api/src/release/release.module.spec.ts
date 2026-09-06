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
import { ReleasePromotionService } from '@ever-works/agent/tasks-domain';
import { PROMOTION_LANE_WATCHER, PROMOTION_MERGE_GUARD } from '@ever-works/agent/policy';
import { ReleaseModule } from './release.module';
import { ReleasePromotionsController } from './release-promotions.controller';

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
 * MUTATION CHECK, executed rather than assumed: removing `DatabaseModule`
 * from `ReleaseModule`'s imports makes `WorkRepository` — which
 * `ReleasePromotionsController` injects to read and write the Work's
 * release ladder — unresolvable, and this file fails. Before it existed,
 * that change left `apps/api` entirely green.
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
