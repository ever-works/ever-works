import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { AppLauncherModule as AgentAppLauncherModule } from '@ever-works/agent/app-launcher';
import { AppLauncherController, AppLauncherPlatformsController } from './app-launcher.controller';
import { AppLauncherEnabledGuard } from './guards/app-launcher-enabled.guard';
import { PlatformCatalogService } from './platform-catalog.service';

/**
 * APW-11 (App Launcher) — the API-side module: the three routes of plan §4.1,
 * §4.2 and §4.3 over the agent package's registry (plan §4:353-354).
 *
 * ## What is imported, and why each import is needed
 *
 *   - `AgentAppLauncherModule` (`@ever-works/agent/app-launcher`) provides and
 *     exports `AppLauncherService` and — deliberately, per its own doc — **not**
 *     the repositories the service reads Works, deployments and custom domains
 *     through, because those belong to the database layer;
 *   - `DatabaseModule` (`@ever-works/agent/database`) is therefore the second
 *     import: it supplies `WorkRepository`, `WorkMemberRepository`,
 *     `WorkDeploymentRepository` and `WorkCustomDomainRepository` (plus the
 *     optional `DataSource`), which is exactly the split
 *     `packages/agent/src/app-launcher/app-launcher.module.ts:31-33` documents.
 *     Without it the service cannot be constructed.
 *
 * `ScopeContextService` needs no import: `ScopeModule` is `@Global()`
 * (`apps/api/src/scope/scope.module.ts`). `CACHE_MANAGER` — which
 * `PlatformCatalogService` reads through `@Optional()` — is bound globally by
 * `CacheFactory.TypeORM({ isGlobal: true })` in `api.module.ts`.
 *
 * ## What is declared here
 *
 * Both controllers and the two providers this epic owns on the API side: the
 * installation guard (FR-54) and the runtime catalog reader (FR-8, plan §5.2).
 * The guard is provided although Nest can instantiate a dependency-free guard
 * on its own, so a later change that gives it a dependency fails at wiring
 * review rather than at the first request.
 *
 * `APP_PUBLISHED_HOSTS`, `WORK_APP_RUNTIME_STATES`, `APPS_TIER_POLICY` and
 * `APP_SPEC_DISPLAY_NAMES` are **not** bound here — each is `@Optional()` in the
 * service and each belongs to another epic (APW-06, APW-10, APW-03). Binding a
 * fake would make an unconfigured installation look configured.
 *
 * Registered additively in `apps/api/src/api.module.ts`, next to
 * `WorkAgentModule`.
 */
@Module({
    imports: [DatabaseModule, AgentAppLauncherModule],
    controllers: [AppLauncherController, AppLauncherPlatformsController],
    providers: [AppLauncherEnabledGuard, PlatformCatalogService],
    exports: [PlatformCatalogService],
})
export class AppLauncherModule {}
