import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppRuntimeStateModule } from '../app-runtime/app-runtime-state.module';
import { DatabaseModule } from '../database/database.module';
import { AppLauncherPreferenceRepository } from '../database/repositories/app-launcher-preference.repository';
import { AppLauncherPreference } from '../entities/app-launcher-preference.entity';
import { AppLauncherService } from './app-launcher.service';
import {
    DefaultManagedHostRootResolver,
    MANAGED_HOST_ROOT_RESOLVER,
} from './managed-host-root.resolver';

/**
 * APW-11 App Launcher — the agent-side module (plan §3.2:234-237, §2.2).
 *
 * It provides the three things APW-11 P1 needs from this package and exports all
 * three, so `apps/api`'s `AppLauncherModule` (T8) can import this one and add its
 * controller, its catalog service and its guard without re-declaring any of them:
 *
 *   - `AppLauncherService` — the registry read and the arrangement save;
 *   - `AppLauncherPreferenceRepository` — provided **here** rather than by
 *     `DatabaseModule`, because `app_launcher_preferences` is this epic's table
 *     and its repository is deliberately not in `_repository-inventory.ts`
 *     (plan §3.2 lists `TypeOrmModule.forFeature` as the fourth registration
 *     point, and this is it);
 *   - `MANAGED_HOST_ROOT_RESOLVER` — bound to
 *     {@link DefaultManagedHostRootResolver} **by default**, so APW-11 is correct
 *     before APW-06 T48 merges. T48 provides
 *     `AppManagedHostRootResolver` for the same token, and an import order where
 *     the later module wins is exactly the contract CONTRACTS §3 states ("APW-06
 *     T48 binds `AppManagedHostRootResolver` in P1 and its value wins").
 *
 * The repositories the service reads Works, deployments and custom domains
 * through are **not** declared here: they belong to `DatabaseModule`, which
 * exports them — and this module therefore **imports** `DatabaseModule`
 * itself. Importing it in the *parent* is not enough: Nest resolves a provider
 * in the context of the module that declares it, so `apps/api`'s wrapper
 * importing `DatabaseModule` alongside this module left `AppLauncherService`
 * unresolvable and the API refused to boot
 * (`UnknownDependenciesException … the argument WorkRepository at index [0] is
 * not available in the AppLauncherModule module`), which the e2e lane caught on
 * 2026-09-18. A declared provider that injects a repository must declare where
 * that repository comes from.
 *
 * `APP_PUBLISHED_HOSTS`, `APPS_TIER_POLICY` and `APP_SPEC_DISPLAY_NAMES` are
 * intentionally **not** bound here. Each is `@Optional()` in the service and each
 * is owned by another epic (APW-06, APW-10, APW-03); binding a fake here would
 * make an unconfigured installation look configured, which is the one thing the
 * optional-injection posture exists to prevent.
 *
 * `WORK_APP_RUNTIME_STATES` **was** in that list and no longer is (2026-09-21).
 * The distinction the paragraph above draws is between binding a FAKE and binding
 * the real thing: APW-06 T17's `AppRuntimeStateModule` provides the real
 * repository over the real table, so importing it is not a stand-in for the
 * owning epic — it IS the owning epic's binding.
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([AppLauncherPreference]),
        // APW-06 T17 — binds `WORK_APP_RUNTIME_STATES`, which `AppLauncherService`
        // injects `@Optional()` for FR-15's paused / removed reads. Until T17 landed
        // the token was bound nowhere, so every tile's runtime state read as absent.
        AppRuntimeStateModule,
    ],
    providers: [
        AppLauncherPreferenceRepository,
        AppLauncherService,
        {
            provide: MANAGED_HOST_ROOT_RESOLVER,
            useClass: DefaultManagedHostRootResolver,
        },
    ],
    exports: [AppLauncherService, AppLauncherPreferenceRepository, MANAGED_HOST_ROOT_RESOLVER],
})
export class AppLauncherModule {}
