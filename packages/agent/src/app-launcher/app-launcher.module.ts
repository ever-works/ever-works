import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
 * exports them, and the API module imports it.
 *
 * `APP_PUBLISHED_HOSTS`, `WORK_APP_RUNTIME_STATES`, `APPS_TIER_POLICY` and
 * `APP_SPEC_DISPLAY_NAMES` are intentionally **not** bound here. Each is
 * `@Optional()` in the service and each is owned by another epic (APW-06, APW-10,
 * APW-03); binding a fake here would make an unconfigured installation look
 * configured, which is the one thing the optional-injection posture exists to
 * prevent.
 */
@Module({
    imports: [TypeOrmModule.forFeature([AppLauncherPreference])],
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
