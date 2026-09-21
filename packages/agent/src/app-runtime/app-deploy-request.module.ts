import { Module } from '@nestjs/common';

import { AppDeployPreconditionsService } from './app-deploy-preconditions.service';
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
 * It can be called now. **It still refuses**, and that is the correct behaviour
 * rather than a shortfall: `request()`'s first gate is §9.2's isolated-worker
 * check, so with no `APP_DEPLOY_DISPATCHER` bound it answers
 * `422 worker_not_isolated`, creates no row and reads nothing. That refusal is
 * the honest state of the epic — an App Work cannot deploy until an isolated
 * cluster worker is attested — and it is a very different state from
 * "unreachable", which is what it was.
 *
 * The distance left, named so nobody reads this module as more than it is: the
 * dispatcher (`APP_DEPLOY_DISPATCHER`), the Deployment store
 * (`APP_DEPLOY_DEPLOYMENT_STORE`) and every port
 * `AppDeployPreconditionsService` reads — spec, env, dependencies, builds,
 * hosts, tier policy — are all still unbound. The dormancy register
 * (`app-works-port-dormancy.spec.ts`) counts them.
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
    providers: [AppDeployPreconditionsService, AppDeployRequestService],
    exports: [AppDeployPreconditionsService, AppDeployRequestService],
})
export class AppDeployRequestModule {}
