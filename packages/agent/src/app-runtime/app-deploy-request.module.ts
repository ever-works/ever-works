import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkBuild } from '../entities/work-build.entity';
import { DatabaseModule } from '../database/database.module';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { AppSpecModule } from '../app-spec/app-spec.module';
import { AppSpecService } from '../app-spec/app-spec.service';
import { AppDeployBuildSourceAdapter } from './app-deploy-build.source';
import { AppDeployDeploymentStoreAdapter } from './app-deploy-deployment.store';
import {
    APP_DEPLOY_BUILD_SOURCE,
    APP_DEPLOY_SPEC_SOURCE,
    AppDeployPreconditionsService,
} from './app-deploy-preconditions.service';
import { buildAppDeployDispatcherProviders } from './app-deploy-dispatcher.provider';
import { APP_DEPLOY_DEPLOYMENT_STORE, AppDeployRequestService } from './app-deploy-request.service';
import { AppLicenseGate } from './app-license-gate';
import { AppRuntimeStateModule } from './app-runtime-state.module';
import { AppDependenciesModule } from '../app-dependencies/app-dependencies.module';
import { AppRuntimeEnvModule } from '../app-env/app-runtime-env.module';

/**
 * APW-06 §2.2 — the module that finally REGISTERS the deploy request path.
 *
 * ## What this fixes, and what it very deliberately does not
 *
 * `AppDeployRequestService` is 1,150 lines with 36 passing tests, and until now
 * its only non-test mentions anywhere in the tree were doc comments: it was
 * declared in **no Nest module at all**, so no route and no `DeployService`
 * could reach it. Nothing failed; the code simply could not be called.
 *
 * It can be called now, and as of 2026-09-22 the §9.2 gate it opens with can
 * answer YES: `buildAppDeployDispatcherProviders()` binds
 * `APP_DEPLOY_DISPATCHER` and `APP_DEPLOY_DISPATCHER_AVAILABILITY` to one gate
 * over the job-runtime registry, and `TriggerService.dispatchAppDeploy` is the
 * method behind it. Where there is no registered runtime — or, in production,
 * no `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true` attestation — the answer is
 * still `422 worker_not_isolated` with no row created, which is the honest
 * state and the safe one.
 *
 * `APP_DEPLOY_DEPLOYMENT_STORE` is bound too (T16, same day):
 * `AppDeployDeploymentStoreAdapter` over `WorkDeploymentRepository`, now that
 * `work_deployments` has the six App columns §7.1 names. Without it §2.2 step 4
 * had nowhere to write the row a Deployment IS.
 *
 * `APP_DEPLOY_BUILD_SOURCE` is bound too: `AppDeployBuildSourceAdapter` over
 * APW-05's `AppBuildRepository`. Unbound, §5.1 answered `no_green_build` for
 * every App Work whether or not it had one, so a Build that succeeded could
 * never be deployed. The adapter class is also EXPORTED, for one consumer: the
 * API's `TriggerInternalController`, which publishes it by name so the isolated
 * App runtime worker (`TriggerAppRuntimeModule`, no DataSource) can proxy the
 * same two reads — exactly as it already proxies `AppSpecService` for
 * `APP_DEPLOY_SPEC_SOURCE`.
 *
 * `APP_DEPLOY_SPEC_SOURCE` → APW-03's `AppSpecService`, which is why this module
 * imports `AppSpecModule`. That import brings `DatabaseModule`, `FacadesModule`
 * and `ActivityLogModule` with it — a graph this module had deliberately stayed
 * out of — and it is taken anyway because the alternative was worse: unbound,
 * §5.1 pushed `spec_invalid` with *"no App spec source is available in this
 * process"* for **every** request, so no App Work could deploy whatever its spec
 * said. `FacadesModule` needs the globally-registered plugin registry, which is
 * present at the API root and absent in a standalone compile, so this module's
 * own spec shells it the way `app-works.module.spec.ts` does.
 *
 * The distance left, named so nobody reads this module as more than it is,
 * with what each one would take:
 *
 *   - `APP_DEPLOY_HOST_SOURCE` → `AppHostsService`, which exists but is provided
 *     by nothing and whose own eight stores are all unbound, so binding it today
 *     would answer `null` for every host. `primary_domain_missing` is advisory,
 *     not a refusal, so this one blocks nothing;
 *   - `APPS_TIER_POLICY` → APW-10, unwritten in this tree.
 *
 * The dormancy register (`app-works-port-dormancy.spec.ts`) counts what is left.
 *
 * ## The env, dependency and license collaborators — bound by IMPORT (2026-09-26)
 *
 * An earlier revision of this docstring said the env and dependency ports "ARE
 * bound, by APW-07's `AppRuntimeEnvModule`". That was false in every running
 * process: Nest resolves a provider's dependencies in the module that DECLARES it,
 * `AppDeployPreconditionsService` is declared HERE, and this module imported
 * neither APW-07 module — while no other API module imported them at all. So
 * `APP_RUNTIME_ENV_SOURCE`, `APP_DEPENDENCIES_SERVICE` and `AppLicenseGate` were
 * all `undefined` in the API, and every Deploy past the dispatcher gate was refused
 * `env_source_unavailable`. `apps/api/src/app-works-di-reachability.spec.ts` found
 * it; `__tests__/app-deploy-request.graph.spec.ts` pins the fix by composition.
 *
 *   - `AppRuntimeEnvModule` is imported for `APP_RUNTIME_ENV_SOURCE`
 *     (`AppEnvRuntimeSource`, §5.1's env step). This import is also what puts that
 *     module in the API graph at all, and with it `AppEnvListener` (subscribed once:
 *     a class module is one instance however many modules import it) and the
 *     `AppEnvRuntimeSource` that `AppBuildsModule`'s `APP_BUILD_RUNNER_RECIPE_SOURCE`
 *     factory looks up lazily.
 *   - `AppDependenciesModule` is imported for `APP_DEPENDENCIES_SERVICE` (GAP-05's
 *     `ensureReadyForDeploy`). `AppRuntimeEnvModule` imports it but does not
 *     re-export it, so it is imported here by name. Both are one instance with the
 *     copy `AppEnvRuntimeSource` reads through `APP_ENV_DEPLOY_READINESS`.
 *   - `AppLicenseGate` (T21) is PROVIDED here: it is the gate "constructed wherever a
 *     Deployment may be requested or started" (`app-license-gate.ts`), a pure class
 *     whose only collaborator — APW-03's `APP_LICENSE_SERVICE` — is unwritten, so it
 *     answers the documented unreadable verdict: `license_blocks_target` for the
 *     managed target, a `license_eligibility_unavailable` warning for your cluster.
 *
 * Both imports are leaves with respect to this module: nothing either reaches
 * imports `AppDeployRequestModule`, so the graph stays a DAG. They add no new module
 * to what this one already carries except the two APW-07 modules themselves —
 * `FacadesModule`, `DatabaseModule` and TypeORM already come with `AppSpecModule`.
 *
 * ⚠ What that turns on today, and where a Deploy is still refused:
 * `APP_DEPENDENCY_SPEC_SOURCE` (APW-07 T25, unwritten) is unbound, so
 * `ensureReadyForDeploy` answers `specUnavailable` for every Work. §5.1 step 9
 * refuses `dependency_not_ready` only when the App spec DECLARES a dependency (its
 * readiness is unknown). A spec that declares none is NOT refused: it gets a
 * `dependencies_unavailable` warning and passes step 9 (see
 * `AppDeployPreconditionsService.checkDependencies`). Before this wiring, step 8
 * refused every Deploy with `env_source_unavailable`. So a Deploy of a spec with no
 * dependencies to your cluster (where `AppLicenseGate` warns rather than refuses)
 * now passes every API precondition, creates a Deployment row and dispatches. The
 * production worker's own §5.1 re-check still refuses it `worker_not_isolated`,
 * because `APP_DEPLOY_DISPATCHER_AVAILABILITY` is unbound there
 * (`trigger-app-runtime.module.ts`; build-progress C38). The managed target is still
 * refused `license_blocks_target`. Nothing is provisioned while the spec source is
 * unbound (`reconcile` fails closed first).
 *
 * ## Why both services, and why only these two
 *
 * `AppDeployPreconditionsService` is `AppDeployRequestService`'s first
 * collaborator and is injected by class, not by token, so registering the
 * request service without it would bind a service whose preconditions are
 * permanently absent — the request would skip straight past every check it is
 * supposed to run. Both, or neither.
 *
 * Nothing else from `app-runtime` is registered here on purpose, bar the one
 * class the preconditions inject by class (`AppLicenseGate`, above). The
 * orchestrator, the health poller, the lifecycle ops and the deletion path each
 * carry their own unbound ports and their own unwritten tasks; adding them to a
 * module would make the graph look wired without making anything work, which is
 * the failure this branch already has 62 instances of.
 *
 * ## The runtime-state import
 *
 * `AppRuntimeStateModule`, because both services inject
 * `WORK_APP_RUNTIME_STATES` and it is the module that binds it (APW-06 T17).
 * Every other collaborator of both services is `@Optional()`, so this module
 * composes and boots with nothing else present — which is what lets it be
 * imported by the API today rather than after the rest of the epic lands.
 */
@Module({
    imports: [
        AppRuntimeStateModule,
        AppSpecModule,
        // `WorkDeploymentRepository` is one of `DatabaseModule`'s own
        // (`_repository-inventory.ts:152`), so it is IMPORTED rather than
        // re-provided: providing it here would construct a second instance
        // beside the one every other consumer resolves, which is the mistake
        // `AppRuntimeStateModule`'s docstring spells out for `useClass`.
        // `DatabaseModule` is already in this graph through `AppSpecModule`,
        // so the import costs nothing new.
        DatabaseModule,
        // `WorkBuild` only: `AppBuildRepository` is FEATURE-owned (it is
        // deliberately absent from the inventory), so this module provides it
        // and needs the entity's repository token to do so.
        TypeOrmModule.forFeature([WorkBuild]),
        // APW-07's two modules, for the preconditions service declared below:
        // `APP_RUNTIME_ENV_SOURCE` and `APP_DEPENDENCIES_SERVICE` must be
        // visible HERE (see the docstring's "bound by IMPORT" section).
        AppRuntimeEnvModule,
        AppDependenciesModule,
    ],
    providers: [
        AppDeployPreconditionsService,
        // T21's gate, injected by class by the preconditions service. Local
        // because it is this epic's own class with no module of its own.
        AppLicenseGate,
        AppDeployRequestService,
        AppDeployDeploymentStoreAdapter,
        { provide: APP_DEPLOY_DEPLOYMENT_STORE, useExisting: AppDeployDeploymentStoreAdapter },
        // §5.1's Build reads. `AppBuildRepository` is APW-05's and is provided
        // here rather than imported, because `AppBuildsModule` carries the whole
        // build-facade tree (plugins, git, secrets) that this path never calls.
        AppBuildRepository,
        AppDeployBuildSourceAdapter,
        { provide: APP_DEPLOY_BUILD_SOURCE, useExisting: AppDeployBuildSourceAdapter },
        // APW-03's effective spec, at the Build's commit. A plain alias: the
        // swap `app-deploy-preconditions.service.ts:163` documents, and
        // `getEffectiveSpec` is deliberately the ONLY read — `hasValidAppSpec`
        // is APW-01's minimal-path predicate and answering `spec_invalid` from
        // it would read the repository twice.
        { provide: APP_DEPLOY_SPEC_SOURCE, useExisting: AppSpecService },
        ...buildAppDeployDispatcherProviders(),
    ],
    exports: [
        AppDeployPreconditionsService,
        AppDeployRequestService,
        APP_DEPLOY_DEPLOYMENT_STORE,
        // The CLASS, not the token: the API's `TriggerInternalController` publishes it
        // as the remote target `AppDeployBuildSourceAdapter`, which the isolated App
        // runtime worker's `APP_DEPLOY_BUILD_SOURCE` proxies (it owns no DataSource, so
        // it cannot read `work_builds` itself). Exporting the token instead would bind
        // `APP_DEPLOY_BUILD_SOURCE` in every importer's scope as a side effect.
        AppDeployBuildSourceAdapter,
    ],
})
export class AppDeployRequestModule {}
