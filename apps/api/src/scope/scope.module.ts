import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { ScopeContextService } from './scope-context.service';
import { ScopeStampingSubscriber } from './scope-stamping.subscriber';
import { ScopeResolverMiddleware } from './scope-resolver.middleware';
import { ScopeOwnershipGuard } from './scope-ownership.guard';
import { SessionScopeGuard } from './session-scope.guard';

/**
 * EW-657 (Tenants & Organizations Phase 5b) — exposes
 * [`ScopeContextService`](./scope-context.service.ts) globally for any
 * service that needs to read or write the current request's scope,
 * and registers
 * [`ScopeStampingSubscriber`](./scope-stamping.subscriber.ts) onto the
 * TypeORM DataSource so every Tier A/C row insert picks up the
 * current scope automatically.
 *
 * `@Global()` because `ScopeContextService` is consumed across every
 * feature module that touches a Tier C entity — and explicitly
 * importing this module into all of them would be needless ceremony.
 *
 * **Phase wiring:**
 *
 * - Phase 5b (this PR): plumbing only. Today scope is always
 *   `EMPTY_SCOPE` because no middleware populates the ALS, so the
 *   subscriber stamps nulls (no-op vs. column default).
 * - Phase 6 (EW-658): `OrganizationService` consumes
 *   `ScopeContextService` to scope its create/list/update paths.
 * - Phase 7 (EW-659): `ScopeResolverMiddleware` populates the ALS
 *   from `:slug` (or `X-Scope-Slug` header) on every scope-sensitive
 *   `/api/*` route. From that point onward the subscriber starts
 *   stamping real values.
 */
@Global()
@Module({
    // DatabaseModule already provides + exports `UserRepository` and
    // `OrganizationRepository` (via REPOSITORY_PROVIDERS), so importing
    // it here is enough — declaring those repos in our own providers
    // array would shadow the singleton with a fresh per-module instance.
    // (Greptile P2 on PR #1059.)
    imports: [DatabaseModule],
    providers: [
        ScopeContextService,
        ScopeStampingSubscriber,
        ScopeResolverMiddleware,
        ScopeOwnershipGuard,
        SessionScopeGuard,
    ],
    exports: [ScopeContextService, ScopeOwnershipGuard, SessionScopeGuard],
})
export class ScopeModule implements NestModule {
    /**
     * EW-659 (Phase 7) — apply ScopeResolverMiddleware globally on
     * `/api/*` with an exempt list.
     *
     * **Exempt routes** ([spec.md §4.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#42-slug-resolution)):
     *
     *   - `/api/auth/*` — login / OAuth callbacks must work before
     *     any scope exists. (Anonymous users have no Tenant.)
     *   - `/api/users/check-username` — public, pre-login.
     *   - `/api/organizations/check-slug` — public, pre-login (the
     *     CreateOrganizationModal calls this from a not-yet-scoped
     *     route to check availability before creating the Org).
     *
     * Everything else under `/api/` runs through the middleware. The
     * middleware itself short-circuits to `EMPTY_SCOPE` when no slug
     * is present (legacy un-prefixed routes), so the cost of being
     * in-band on every request is one synchronous header check.
     */
    configure(consumer: MiddlewareConsumer): void {
        consumer
            .apply(ScopeResolverMiddleware)
            .exclude(
                { path: 'api/auth/(.*)', method: RequestMethod.ALL },
                { path: 'api/auth', method: RequestMethod.ALL },
                { path: 'api/users/check-username', method: RequestMethod.GET },
                { path: 'api/organizations/check-slug', method: RequestMethod.GET },
            )
            .forRoutes({ path: 'api/(.*)', method: RequestMethod.ALL });
    }
}
