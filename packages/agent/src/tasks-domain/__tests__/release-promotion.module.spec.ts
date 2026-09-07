import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReleasePromotionRepository } from '@src/database/repositories/release-promotion.repository';
import {
    PROMOTION_LANE_WATCHER,
    PROMOTION_MERGE_GUARD,
} from '@src/policy/promotion-merge-guard.port';
import { ENTITIES } from '@src/database/database.config';
import { FleetJobService } from '@src/fleet/fleet-job.service';
import { FleetJobRepository } from '@src/fleet/fleet-job.repository';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { PluginUsageService } from '@src/usage/plugin-usage.service';
import { BudgetGuardService } from '@src/budgets/budget-guard.service';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { EverWorksK8sDeployProvider } from '@src/ever-works-providers/ever-works-k8s-deploy.provider';
import { ReleasePromotionModule } from '../release-promotion.module';
import { ReleasePromotionService } from '../release-promotion.service';
import { ReleaseVerificationService } from '../release-verification.service';
import { TasksDomainModule } from '../tasks.module';

/**
 * The promotion lane's wiring, against a REAL Nest container compiling the
 * REAL `ReleasePromotionModule`.
 *
 * This exists because of the failure mode this repo has now paid for
 * twice: `_repository-inventory.ts` is NOT "every repository". Several are
 * deliberately absent, and a module that injects one it did not provide
 * passes every unit spec — the service's own spec constructs it
 * positionally, which proves the logic and says nothing about wiring — and
 * then the API refuses to boot.
 *
 * ## Why the module itself, and not a replica of its provider list
 *
 * An earlier version of this file hand-copied the module's providers into
 * `Test.createTestingModule` and asserted THAT compiled. It proved
 * nothing about the module: deleting
 * `TypeOrmModule.forFeature([ReleasePromotion])` — the only thing
 * providing the `Repository<ReleasePromotion>` token that
 * `ReleasePromotionRepository` injects, and therefore an API that cannot
 * boot — left the whole suite green, because the replica supplied its own
 * `forFeature` and the metadata block only checked `imports.map(e =>
 * e?.name)`, which is `undefined` for every dynamic module.
 *
 * So the module is imported for real. `ReleasePromotionModule` pulls in
 * `TasksDomainModule` and `FacadesModule`, whose graph reaches a handful
 * of providers that the API supplies from its ROOT rather than from any of
 * these modules; those — and only those — are stubbed through a `@Global()`
 * module below, which is the same shape the real application uses. Nothing
 * the promotion lane actually depends on is stubbed: the repository, the
 * entity registration, `TasksService`, `GitFacadeService` and the two
 * token bindings all come from the real graph.
 *
 * MUTATION CHECK, executed rather than assumed, against this file:
 *
 *   - deleting `TypeOrmModule.forFeature([ReleasePromotion])` from the
 *     module fails with "Nest can't resolve dependencies of the
 *     ReleasePromotionRepository (?)";
 *   - deleting `ReleasePromotionRepository` from the module's `providers`
 *     fails to compile as well.
 *
 * Both used to pass.
 */

/**
 * The app-root providers `FacadesModule`'s graph expects to find in the
 * global scope. In the running API they come from the root module; here
 * they are inert, because nothing under test calls them.
 */
const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    PluginUsageService,
    BudgetGuardService,
    WorkPluginRepository,
    WorkCustomDomainRepository,
    EverWorksK8sDeployProvider,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('ReleasePromotionModule — dependency injection', () => {
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
                ReleasePromotionModule,
            ],
        }).compile();
    }

    it('compiles the REAL module and resolves the service and BOTH tokens to one instance', async () => {
        const moduleRef = await compile();

        const service = moduleRef.get(ReleasePromotionService);
        expect(service).toBeInstanceOf(ReleasePromotionService);
        // ONE instance behind both tokens, and that matters: the guard
        // reads state the watcher wrote.
        expect(moduleRef.get(PROMOTION_MERGE_GUARD)).toBe(service);
        expect(moduleRef.get(PROMOTION_LANE_WATCHER)).toBe(service);

        await moduleRef.close();
    });

    it('registers the entity with the DataSource, so the first query does not throw', async () => {
        // A forFeature'd-but-uninventoried entity throws
        // EntityMetadataNotFoundError on the FIRST query, not at compile —
        // so compiling is not enough, something has to ask.
        const moduleRef = await compile();

        const promotions = moduleRef.get(ReleasePromotionRepository);
        await expect(promotions.findOpenForLane('work-1', 'develop-to-stage')).resolves.toBeNull();
        await expect(promotions.findOpenByTaskId('task-1')).resolves.toBeNull();

        await moduleRef.close();
    });

    it('resolves the post-deploy verification service from the REAL module', async () => {
        // Slice AJ (EW-809). `ReleaseVerificationService` injects
        // `FleetJobService`, which lives in a module this one did not use
        // to import — and a service that injects a provider its module does
        // not supply passes every unit spec (they construct it
        // positionally) and then refuses to boot the API.
        //
        // MUTATION CHECK, executed rather than assumed:
        //   - deleting `FleetModule` from the module's `imports` fails this
        //     test with "Nest can't resolve dependencies of the
        //     ReleaseVerificationService"; note that `FleetJobService` is
        //     @Optional() on the constructor, so the failure surfaces on
        //     the REQUIRED collaborators rather than silently leaving the
        //     lane unable to enqueue — which is why the assertion below
        //     checks the fleet dependency landed, not merely that the
        //     service exists;
        //   - deleting `ReleaseVerificationService` from `providers` fails
        //     to compile as well.
        const moduleRef = await compile();

        const verification = moduleRef.get(ReleaseVerificationService);
        expect(verification).toBeInstanceOf(ReleaseVerificationService);
        // The @Optional() fleet dependency actually RESOLVED. Without
        // `FleetModule` in `imports` this is `undefined` and the lane
        // silently never produces a browser check — the exact failure an
        // @Optional() dependency hides from a compile-only assertion.
        expect(moduleRef.get(FleetJobService)).toBeDefined();
        expect((verification as unknown as { fleet?: unknown }).fleet).toBe(
            moduleRef.get(FleetJobService),
        );
        // And the READER added by the slice-AJ review, on the same
        // argument. Without it the sweep cannot tell whether the job
        // `enqueue` handed back is the check it asked for, and cannot
        // recover a check that settled without its result being recorded —
        // both of which degrade silently, so a compile-only assertion would
        // not notice. `FleetJobRepository` is exported by the same
        // `FleetModule` already in `imports`.
        expect((verification as unknown as { fleetJobs?: unknown }).fleetJobs).toBe(
            moduleRef.get(FleetJobRepository),
        );

        await moduleRef.close();
    });

    it('gives the promotion service the verification service it hands merges to', async () => {
        const moduleRef = await compile();

        const promotion = moduleRef.get(ReleasePromotionService);
        expect((promotion as unknown as { verification?: unknown }).verification).toBe(
            moduleRef.get(ReleaseVerificationService),
        );

        await moduleRef.close();
    });

    it('exposes the lane to the rest of the app without TasksDomainModule importing it back', async () => {
        // The whole point of the @Global() binding: `TaskPrStatusService`
        // and `TaskMergeGateService` live INSIDE `TasksDomainModule` and
        // inject the two tokens `@Optional()`. If the binding were not
        // global, they would resolve to `undefined` and the lane would be
        // silently inert — which fails closed for merges but also means no
        // promotion is ever watched.
        const moduleRef = await compile();

        const fromTasksDomain = moduleRef.select(TasksDomainModule);
        expect(fromTasksDomain.get(PROMOTION_MERGE_GUARD, { strict: false })).toBe(
            moduleRef.get(ReleasePromotionService),
        );

        await moduleRef.close();
    });
});

describe('ReleasePromotionModule — module shape', () => {
    const imports = () => Reflect.getMetadata('imports', ReleasePromotionModule) ?? [];
    const providers = () => Reflect.getMetadata('providers', ReleasePromotionModule) ?? [];
    const exports_ = () => Reflect.getMetadata('exports', ReleasePromotionModule) ?? [];

    it('is @Global(), which is what lets TasksDomainModule consume the tokens without a cycle', () => {
        // `ReleasePromotionService` files a Task, so it imports
        // `TasksDomainModule`. Two services INSIDE that module need it
        // back. A module cycle is a boot failure, so the consumers inject
        // TOKENS and a @Global() binding closes the loop — the same shape
        // `INBOX_PRODUCER` already uses.
        expect(Reflect.getMetadata('__module:global__', ReleasePromotionModule)).toBe(true);
    });

    it('imports the modules that own its cross-module collaborators', () => {
        const names = imports().map((entry: { name?: string }) => entry?.name);
        // TasksService (files the Task) + TaskRepository / WorkRepository /
        // TaskChatMessageRepository.
        expect(names).toContain(TasksDomainModule.name);
        // GitFacadeService (opens the PR, reads branch tips and the gate).
        expect(names).toContain('FacadesModule');
    });

    it('imports FleetModule, the ONLY source of a browser check producer', () => {
        // Slice AJ. `FleetModule` imports nothing but
        // `TypeOrmModule.forFeature`, so it cannot cycle back into this
        // one — which is why the verification service can inject
        // `FleetJobService` directly instead of behind another token.
        const names = imports().map((entry: { name?: string }) => entry?.name);
        expect(names).toContain('FleetModule');
    });

    it('registers its own entity with forFeature', () => {
        // A dynamic module has no `.name`, so the check above cannot see
        // it. Named explicitly because dropping it is an API that does not
        // boot — the DI test above is the real guard, this one names the
        // line so the failure reads clearly.
        const dynamic = imports().filter(
            (entry: { module?: unknown; name?: string }) =>
                typeof entry === 'object' && entry !== null && 'module' in entry,
        );
        expect(dynamic.length).toBeGreaterThan(0);
    });

    it('provides its own feature repository rather than expecting DatabaseModule to', () => {
        // `_repository-inventory.ts` is the DatabaseModule-owned set.
        // Adding a feature repository to it would export it to the whole
        // platform for the benefit of one module.
        expect(providers()).toContain(ReleasePromotionRepository);
        expect(providers()).toContain(ReleasePromotionService);
        expect(providers()).toContain(ReleaseVerificationService);
    });

    it('binds both tokens with useExisting, so consumers depend on the contract', () => {
        const bindings = providers().filter(
            (entry: { provide?: unknown }) => typeof entry === 'object' && entry?.provide,
        );
        const guard = bindings.find(
            (entry: { provide: unknown }) => entry.provide === PROMOTION_MERGE_GUARD,
        );
        const watcher = bindings.find(
            (entry: { provide: unknown }) => entry.provide === PROMOTION_LANE_WATCHER,
        );
        expect(guard).toEqual({
            provide: PROMOTION_MERGE_GUARD,
            useExisting: ReleasePromotionService,
        });
        expect(watcher).toEqual({
            provide: PROMOTION_LANE_WATCHER,
            useExisting: ReleasePromotionService,
        });
    });

    it('exports the service and both tokens', () => {
        expect(exports_()).toEqual(
            expect.arrayContaining([
                ReleasePromotionRepository,
                ReleasePromotionService,
                // The api-side cron sweep and the fleet-completion listener
                // reach the verification lane through this export.
                ReleaseVerificationService,
                PROMOTION_MERGE_GUARD,
                PROMOTION_LANE_WATCHER,
            ]),
        );
    });
});
