import { Global, Module } from '@nestjs/common';
import { ScopeContextService } from './scope-context.service';
import { ScopeStampingSubscriber } from './scope-stamping.subscriber';

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
    providers: [ScopeContextService, ScopeStampingSubscriber],
    exports: [ScopeContextService],
})
export class ScopeModule {}
