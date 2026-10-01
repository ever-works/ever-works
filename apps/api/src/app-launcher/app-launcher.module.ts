import { MiddlewareConsumer, Module, NestModule, RequestMethod, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { AppLauncherModule as AgentAppLauncherModule } from '@ever-works/agent/app-launcher';
import { AppLauncherController, AppLauncherPlatformsController } from './app-launcher.controller';
import { E2eSeedController, isE2eAppLauncherSeedEnabled } from './e2e-seed.controller';
import { AppLauncherEnabledGuard } from './guards/app-launcher-enabled.guard';
import { LauncherDelegatedCorsMiddleware } from './launcher-delegated-cors.middleware';
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

/**
 * The controllers this module declares, in order: the three launcher surfaces
 * of plan §4.1/§4.2/§4.3, and — **only when the gate is open at boot** — T33's
 * non-production seed route (`POST /api/e2e/app-launcher/seed`, plan §9.3).
 *
 * Why conditional registration rather than a guard alone: a production process
 * then has no such path in its router at all, which is a stronger statement
 * than "the handler refuses" — the route is not merely closed, it was never
 * mounted. The guard on the controller
 * (`e2e-seed.controller.ts` → `E2eSeedEnabledGuard`) is the other half: it
 * re-reads the gate on every request, so flipping `E2E_APP_LAUNCHER_SEED` in a
 * running non-production process opens and closes the door without a restart,
 * and a process that booted outside production cannot serve the route once it
 * is pointed at production traffic.
 *
 * `isE2eAppLauncherSeedEnabled()` is production-first
 * (`packages/agent/src/config/index.ts:824-829`'s shape), so `NODE_ENV=production`
 * can never take the first branch — and an unset variable takes the second, in
 * every environment. The order of the two launcher controllers is unchanged and
 * nothing is removed: this is one appended entry behind one condition.
 */
const CONTROLLERS: Type<unknown>[] = [AppLauncherController, AppLauncherPlatformsController];
if (isE2eAppLauncherSeedEnabled()) {
    CONTROLLERS.push(E2eSeedController);
}

@Module({
    imports: [DatabaseModule, AgentAppLauncherModule],
    controllers: CONTROLLERS,
    providers: [AppLauncherEnabledGuard, PlatformCatalogService],
    exports: [PlatformCatalogService],
})
export class AppLauncherModule implements NestModule {
    /**
     * APW-11 T26 (plan §4.7): the delegated-read CORS middleware, applied to the two launcher read
     * routes **only** — `GET|OPTIONS /api/me/apps` and `/api/app-launcher/platforms`.
     *
     * Two deliberate exclusions, both of which a test in the middleware's spec pins:
     *   - `PUT /api/me/apps/preferences` — the arrangement write is a session call. A cross-origin
     *     write is exactly what the delegated surface must not allow, so the middleware is not applied
     *     to it and a browser from any origin gets no CORS headers there.
     *   - **every other route in the API** — the middleware lives in this module and is applied through
     *     `forRoutes`, so it cannot leak into another module's routes. `ScopeResolverMiddleware` keeps
     *     its global `api/{*splat}` registration untouched.
     *
     * The paths are spelled in full (`api/…`) because these controllers declare their own full paths
     * (`apps/api/src/app-launcher/app-launcher.controller.ts:251,413`) and the app sets no global
     * prefix — the same convention `ScopeResolverMiddleware` uses.
     */
    configure(consumer: MiddlewareConsumer): void {
        consumer
            .apply(LauncherDelegatedCorsMiddleware)
            .forRoutes(
                { path: 'api/me/apps', method: RequestMethod.GET },
                { path: 'api/me/apps', method: RequestMethod.OPTIONS },
                { path: 'api/app-launcher/platforms', method: RequestMethod.GET },
                { path: 'api/app-launcher/platforms', method: RequestMethod.OPTIONS },
            );
    }
}
