import { Global, Inject, Injectable, Module, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
    ENTITIES,
    GitHubAppInstallationRepoRepository,
    GitHubAppInstallationRepository,
} from '@ever-works/agent/database';
import {
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';
import { PluginUsageService } from '@ever-works/agent/usage';
import { BudgetGuardService } from '@ever-works/agent/budgets';
import { ScopeContextService } from '../scope';
import { FleetApiModule } from './fleet.module';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetPushCredentialService } from './fleet-push-credential.service';

/**
 * `FleetApiModule` against a REAL Nest container.
 *
 * WHY THIS EXISTS. `_repository-inventory.ts` is not "every repository",
 * and a service that injects one the module cannot reach passes every unit
 * spec in this directory — `fleet-push-credential.service.spec.ts`
 * constructs the service positionally, and `fleet-jobs.controller.spec.ts`
 * hands the controller a stub — and then the API refuses to BOOT. A
 * previous slice in this program shipped exactly that. Reading
 * `Reflect.getMetadata('imports', …)` does not catch it either: that only
 * proves a name is in a list, never that the graph resolves.
 *
 * MUTATION CHECK, executed rather than assumed. Both were run against this
 * file and both go red:
 *
 *   1. Removing `DatabaseModule` from `FleetApiModule`'s imports — the
 *      module that supplies `GitHubAppInstallationRepoRepository`, the
 *      installation SNAPSHOT the scoped push credential is narrowed by.
 *      Nest reports `Nest can't resolve dependencies of the
 *      FleetRunSecretsService (FleetJobService, ?)` — it happens to name
 *      the first provider that misses the module rather than this slice's,
 *      which is exactly why the assertion below reaches for the
 *      repositories BY NAME instead of trusting the message.
 *   2. Removing `FleetPushCredentialService` from the providers list:
 *      the controller case and the repository case both fail.
 *
 * Before this file existed, either change left `apps/api` entirely green.
 *
 * The `@Global()` stub stands in for what the running API supplies from
 * its ROOT module and reaches transitively. Nothing the fleet work channel
 * itself depends on is stubbed.
 */
const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
    PluginUsageService,
    BudgetGuardService,
    // Bound app-wide by the root module's @Global() scope module; the
    // owner-scoped fleet controllers resolve it through that.
    ScopeContextService,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('FleetApiModule — dependency injection', () => {
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
                FleetApiModule,
            ],
        }).compile();
    }

    it('resolves the node work channel with ALL FOUR of its constructor dependencies', async () => {
        const moduleRef = await compile();

        const controller = moduleRef.get(FleetJobsController);
        expect(controller).toBeInstanceOf(FleetJobsController);
        // The one this slice adds. A controller that could not resolve it
        // is an API that will not boot — and every unit spec above would
        // still be green, because they construct it by hand.
        expect(moduleRef.get(FleetPushCredentialService, { strict: false })).toBeInstanceOf(
            FleetPushCredentialService,
        );

        await moduleRef.close();
    });

    it('reaches the installation SNAPSHOT the push scope is narrowed by', async () => {
        // The pointed guard. Without both of these the service constructs
        // (they are required, so actually it does not — which is the
        // point) and the scope could only ever come from something a
        // caller supplied.
        const moduleRef = await compile();

        expect(
            moduleRef.get(GitHubAppInstallationRepoRepository, { strict: false }),
        ).toBeInstanceOf(GitHubAppInstallationRepoRepository);
        expect(moduleRef.get(GitHubAppInstallationRepository, { strict: false })).toBeInstanceOf(
            GitHubAppInstallationRepository,
        );

        await moduleRef.close();
    });

    it('SATISFIES an @Optional() consumer that imports it, which is how the planner gets its pre-dispatch check', async () => {
        // `FleetAgentTaskPlannerService` is provided by the api-side
        // `TasksModule`, which imports this one, and takes
        // `@Optional() pushCredentials`. An unsatisfied optional is SILENT:
        // the plan-time refusal would simply never run, and a Task no
        // installation covers would burn twenty minutes on a node before
        // failing at the push.
        //
        // This case used to read `Reflect.getMetadata('exports', …)` and
        // assert the name was in the list — the exact pattern this file's
        // own header rejects, and one that cannot tell "exported and
        // reachable from an importing module" from "exported but shadowed
        // or unreachable" (slice AM review, F10). So it compiles a real
        // consumer instead and reads what Nest actually injected.
        //
        // MUTATION CHECK, executed: removing `FleetPushCredentialService`
        // from `FleetApiModule`'s `exports` leaves the container compiling
        // fine and `injected` `undefined`, which is precisely the silent
        // failure being guarded — and this case then goes red where the
        // metadata assertion also would. Removing it from `providers`
        // instead fails the compile, which the two cases above already
        // catch.
        @Injectable()
        class PlannerLikeConsumer {
            constructor(
                @Optional()
                @Inject(FleetPushCredentialService)
                readonly pushCredentials?: FleetPushCredentialService,
            ) {}
        }

        @Module({ imports: [FleetApiModule], providers: [PlannerLikeConsumer] })
        class ConsumerModule {}

        const moduleRef = await Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                ConsumerModule,
            ],
        }).compile();

        const injected = moduleRef.get(PlannerLikeConsumer).pushCredentials;
        expect(injected).toBeInstanceOf(FleetPushCredentialService);
        // The SAME singleton the controller resolves, not a second copy
        // resolving a second set of repositories.
        expect(injected).toBe(moduleRef.get(FleetPushCredentialService, { strict: false }));

        await moduleRef.close();
    });
});
