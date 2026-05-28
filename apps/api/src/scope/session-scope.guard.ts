import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import { ScopeContextService } from './scope-context.service';

/**
 * EW-664 (Tenants & Organizations Phase 12) — session-scope fallback
 * for legacy un-prefixed routes.
 *
 * Phase 7's [`ScopeResolverMiddleware`](./scope-resolver.middleware.ts)
 * resolves a `:slug` URL param / `X-Scope-Slug` header to a scope and
 * runs the request under it. When NEITHER is present — a legacy
 * un-prefixed `/api/...` call from the existing web client — it runs
 * under `EMPTY_SCOPE` (both fields `null`).
 *
 * That's wrong for an authenticated user who HAS been upgraded to a
 * Tenant: their legacy-route requests should operate in their default
 * scope (their Tenant + last-active Org), not the empty scope. Otherwise
 * the Phase 5b [`ScopeStampingSubscriber`](./scope-stamping.subscriber.ts)
 * stamps NULLs on rows they create, and scope-filtered reads miss their
 * own data.
 *
 * The middleware can't fix this itself: it runs BEFORE `AuthSessionGuard`
 * populates `request.user`, so it has no user to read `tenantId` /
 * `lastScopeOrganizationId` from. This guard runs AFTER `AuthSessionGuard`
 * (guards execute in `providers`-array registration order — see
 * `api.module.ts`) and seeds the scope in place via
 * [`ScopeContextService.setScope`](./scope-context.service.ts).
 *
 * **Behavior** (always returns `true` — this guard never blocks, it
 * only seeds scope):
 *
 *   - Non-HTTP context (RPC / WS) → allow, do nothing.
 *   - Scope already resolved (`scope.tenantId !== null`) → a slug
 *     resolved a scope (Phase 7 middleware did its job, or it's a
 *     slug-prefixed route) → allow, do nothing.
 *   - No `request.user` → unauthenticated; nothing to seed → allow.
 *   - User has a `tenantId` → seed `{ tenantId, organizationId:
 *     lastScopeOrganizationId ?? null }`.
 *   - User has a null `tenantId` (never created an Org) → leave
 *     `EMPTY_SCOPE`; nothing to seed.
 *
 * **Why this guard is positioned before `ScopeOwnershipGuard`:** the
 * seeded scope is the user's OWN Tenant, so the ownership check passes
 * trivially (`user.tenantId === scope.tenantId`).
 *
 * **Performance:** the `AuthenticatedUser` request object does NOT carry
 * `tenantId` / `lastScopeOrganizationId`, so we look the user up with
 * one extra `findById` per authenticated request that reaches this guard
 * WITH an empty scope — i.e. legacy un-prefixed routes only. Slug routes
 * short-circuit on the `scope.tenantId !== null` check above and never
 * hit the database here. That cost is acceptable.
 */
@Injectable()
export class SessionScopeGuard implements CanActivate {
    private readonly logger = new Logger(SessionScopeGuard.name);

    constructor(
        private readonly scopeContext: ScopeContextService,
        private readonly userRepository: UserRepository,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Only HTTP — skip RPC / WS / etc.
        if (context.getType() !== 'http') {
            return true;
        }

        const scope = this.scopeContext.getScope();
        if (scope.tenantId !== null) {
            // A slug already resolved a scope (Phase 7 middleware, or a
            // slug-prefixed route). Nothing to fall back to.
            return true;
        }

        const req = context.switchToHttp().getRequest<{
            user?: { userId?: string };
        }>();
        const user = req.user;
        if (!user?.userId) {
            // Unauthenticated request — nothing to seed.
            return true;
        }

        // One extra findById per authenticated legacy-route request (slug
        // routes short-circuit above). `AuthenticatedUser` doesn't carry
        // tenantId / lastScopeOrganizationId, so we read the row here.
        const dbUser = await this.userRepository.findById(user.userId);
        const tenantId = dbUser?.tenantId ?? null;
        if (tenantId === null) {
            // User never created an Org → no Tenant → leave EMPTY_SCOPE.
            return true;
        }

        this.scopeContext.setScope({
            tenantId,
            organizationId: dbUser?.lastScopeOrganizationId ?? null,
        });
        this.logger.debug(`Seeded session scope for user ${user.userId}: tenantId=${tenantId}`);

        return true;
    }
}
