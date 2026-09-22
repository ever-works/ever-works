/**
 * APW-07 — the composition root that lets APW-06 read an App Work's env.
 *
 * `AppEnvModule` (T13) and `AppDependenciesModule` (T16) have existed on this
 * branch since the epic landed, each complete and each in **no DI graph at
 * all**. This module is the missing third file: it imports both and performs the
 * two `useExisting` swaps their own docstrings specify, so APW-06's Deploy
 * preflight stops answering `env_source_unavailable` on an installation that has
 * the whole implementation sitting in the same package.
 *
 * ## Why this is a separate module and not two more lines in `AppEnvModule`
 *
 * `AppEnvRuntimeSource` needs `AppDependenciesService` (through
 * `APP_ENV_DEPLOY_READINESS`), and `AppDependenciesService` needs `AppEnvCrypto`
 * (through `APP_DEPENDENCY_CONFIG_CIPHER`). Binding both inside `AppEnvModule`
 * would make it import `AppDependenciesModule` while `AppDependenciesModule`
 * imports it — a module cycle, which Nest only survives with `forwardRef` and
 * which this repo's own NestJS rules call the first cause of bootstrap crashes.
 *
 * Splitting it keeps the graph a DAG:
 *
 * ```
 * AppRuntimeEnvModule ──▶ AppDependenciesModule ──▶ AppEnvModule
 *          └────────────────────────────────────────────▶
 * ```
 *
 * ## What it binds
 *
 * | Token                      | Bound to                | What was refused before |
 * | -------------------------- | ----------------------- | ----------------------- |
 * | `APP_RUNTIME_ENV_SOURCE`   | `AppEnvRuntimeSource`   | `AppDeployPreconditionsService` reported `env_source_unavailable`, so no Deployment could pass preconditions |
 * | `APP_ENV_DEPLOY_READINESS` | `AppDependenciesService`| `AppEnvRuntimeSource.resolve` reported no not-ready dependencies and **dispatched no provisioning** — GAP-05's reconcile pass never ran |
 *
 * `AppEnvListener` is provided here too, and only here: it subscribes to
 * `app.spec.applied` and is the pass that generates an App Work's generated
 * values and reconciles its dependencies (ACC-07-01). A provider registered in
 * no module never subscribes, so before this file the event was emitted into
 * nothing.
 *
 * ## What it deliberately does NOT bind
 *
 * `APP_PROMPTED_VALUES_PORT` (APW-01 FR-55) stays unbound. Its declared owner is
 * APW-07's env write path, and `AppEnvService.apply` — the only method that
 * stores a value — requires an `AppEnvActor` and an App spec that declares the
 * name. The port's signature carries neither: `storePrompted(workId, values)` has
 * no actor, and at create time the Blueprint that would declare the names has not
 * been applied yet. Binding it would mean inventing an actor and an ordering the
 * spec assigns to T24/T25, which are still open. Unbound, the member's answers
 * are dropped and the drop is logged — the documented behaviour, and an honest
 * one.
 *
 * `APP_DEPENDENCY_PROVISION_DISPATCHER`, `APP_DEPENDENCY_SPEC_SOURCE`,
 * `APP_ENV_SPEC_SOURCE` and `APP_DEPENDENCY_CLUSTER_ACCESS` belong to APW-03 and
 * APW-06 and have no implementation in this tree. Every one of them is
 * `@Optional()` at its consumer and answers a named refusal when absent.
 */

import { Module } from '@nestjs/common';

import { AppDependenciesModule } from '../app-dependencies/app-dependencies.module';
import { AppDependenciesService } from '../app-dependencies/app-dependencies.service';
import { APP_RUNTIME_ENV_SOURCE } from '../app-runtime/ports';
import { APP_ENV_DEPLOY_READINESS, AppEnvRuntimeSource } from './app-env-runtime.source';
import { AppEnvListener } from './app-env.listener';
import { AppEnvModule } from './app-env.module';

@Module({
    imports: [AppEnvModule, AppDependenciesModule],
    providers: [
        AppEnvRuntimeSource,
        AppEnvListener,
        // The readiness pass, and the reason it is an alias rather than a
        // narrowed wrapper: `ensureReadyForDeploy` also DISPATCHES provisioning
        // for the `pending` kinds (GAP-05), and a wrapper that forwarded only
        // the answer would quietly drop that side effect.
        { provide: APP_ENV_DEPLOY_READINESS, useExisting: AppDependenciesService },
        { provide: APP_RUNTIME_ENV_SOURCE, useExisting: AppEnvRuntimeSource },
    ],
    exports: [AppEnvRuntimeSource, APP_RUNTIME_ENV_SOURCE, APP_ENV_DEPLOY_READINESS],
})
export class AppRuntimeEnvModule {}
