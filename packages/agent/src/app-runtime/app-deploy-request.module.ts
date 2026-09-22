import { Module } from '@nestjs/common';

import { AppDeployPreconditionsService } from './app-deploy-preconditions.service';
import { buildAppDeployDispatcherProviders } from './app-deploy-dispatcher.provider';
import { AppDeployRequestService } from './app-deploy-request.service';
import { AppRuntimeStateModule } from './app-runtime-state.module';

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
 * The distance left, named so nobody reads this module as more than it is: the
 * Deployment store (`APP_DEPLOY_DEPLOYMENT_STORE`) and every port
 * `AppDeployPreconditionsService` reads — spec, env, dependencies, builds,
 * hosts, tier policy — are still unbound, except `APP_RUNTIME_ENV_SOURCE` and
 * `APP_DEPENDENCIES_SERVICE`, which APW-07's `AppRuntimeEnvModule` binds. The
 * dormancy register (`app-works-port-dormancy.spec.ts`) counts what is left.
 *
 * ## Why both services, and why only these two
 *
 * `AppDeployPreconditionsService` is `AppDeployRequestService`'s first
 * collaborator and is injected by class, not by token, so registering the
 * request service without it would bind a service whose preconditions are
 * permanently absent — the request would skip straight past every check it is
 * supposed to run. Both, or neither.
 *
 * Nothing else from `app-runtime` is registered here on purpose. The
 * orchestrator, the health poller, the lifecycle ops and the deletion path each
 * carry their own unbound ports and their own unwritten tasks; adding them to a
 * module would make the graph look wired without making anything work, which is
 * the failure this branch already has 62 instances of.
 *
 * ## The one import
 *
 * `AppRuntimeStateModule`, because both services inject
 * `WORK_APP_RUNTIME_STATES` and it is the module that binds it (APW-06 T17).
 * Every other collaborator of both services is `@Optional()`, so this module
 * composes and boots with nothing else present — which is what lets it be
 * imported by the API today rather than after the rest of the epic lands.
 */
@Module({
    imports: [AppRuntimeStateModule],
    providers: [
        AppDeployPreconditionsService,
        AppDeployRequestService,
        ...buildAppDeployDispatcherProviders(),
    ],
    exports: [AppDeployPreconditionsService, AppDeployRequestService],
})
export class AppDeployRequestModule {}
