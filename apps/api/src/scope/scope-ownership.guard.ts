import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { ScopeContextService } from './scope-context.service';

/**
 * EW-659 (Tenants & Organizations Phase 7) — guards against
 * cross-tenant scope hijacking via slug.
 *
 * [`ScopeResolverMiddleware`](./scope-resolver.middleware.ts) resolves
 * the slug to a `{ tenantId, organizationId }` **purely by public
 * slug lookup** — that's correct for what a middleware should do
 * (it can't access `req.user` because guards haven't run yet). But
 * without an authorization check, an authenticated user could submit
 * any other tenant's slug via `:slug` or `X-Scope-Slug` and the
 * controller would happily query under that tenant's scope.
 * (Codex P1 on PR #1059.)
 *
 * This guard runs AFTER `AuthSessionGuard` (because guards run in
 * registration order from `providers: []`, and this guard is
 * registered after `AuthSessionGuard` in `api.module.ts`), so
 * `request.user` is populated by the time we read it. The check:
 *
 *   - `ScopeContext.tenantId === null` → no scope was resolved (legacy
 *     un-prefixed route, or anonymous request). Allow.
 *   - `request.user` not set → unauthenticated request. The auth
 *     guard would have rejected if auth was required; otherwise it's
 *     a public route and there's no user to check against. Allow.
 *   - `request.user.tenantId === ScopeContext.tenantId` → match.
 *     Allow.
 *   - Otherwise → 403 Forbidden.
 *
 * **Does NOT distinguish "Org belongs to user's Tenant" from "User
 * IS the resolved User":** both produce the same `tenantId` and the
 * guard is satisfied. The bare-Tenant case (User slug resolution
 * with no Org) is correctly handled because the resolved scope is
 * `{ tenantId: user.tenantId, organizationId: null }` and the
 * authenticated user's own `tenantId` matches by definition.
 */
@Injectable()
export class ScopeOwnershipGuard implements CanActivate {
    private readonly logger = new Logger(ScopeOwnershipGuard.name);

    constructor(private readonly scopeContext: ScopeContextService) {}

    canActivate(context: ExecutionContext): boolean {
        // Only HTTP — skip RPC / WS / etc.
        if (context.getType() !== 'http') {
            return true;
        }

        const scope = this.scopeContext.getScope();
        if (scope.tenantId === null) {
            // No scope resolved → middleware short-circuited to
            // EMPTY_SCOPE (legacy route, or exempt path). Nothing to
            // gate on.
            return true;
        }

        const req = context.switchToHttp().getRequest<{
            user?: { userId?: string; tenantId?: string | null };
        }>();
        const user = req.user;
        if (!user) {
            // Unauthenticated request hit a scoped route. If the route
            // requires auth, `AuthSessionGuard` would have already
            // rejected the request before this guard runs (guards
            // execute in registration order — see `api.module.ts`).
            // Reaching this point means the route was @Public() AND
            // a scope was resolved; treat as the EMPTY scope case.
            return true;
        }

        const userTenantId = user.tenantId ?? null;
        if (userTenantId === null) {
            // User has not been upgraded to a Tenant yet (no Org
            // created). They can't access any scoped route by slug —
            // the slug points to *someone else's* Tenant by definition.
            this.logger.warn(
                `User ${user.userId ?? '?'} (no Tenant) attempted scope tenantId=${scope.tenantId}`,
            );
            throw new ForbiddenException('Scope does not belong to authenticated user');
        }

        if (userTenantId !== scope.tenantId) {
            this.logger.warn(
                `User ${user.userId ?? '?'} (tenantId=${userTenantId}) attempted cross-tenant scope tenantId=${scope.tenantId}`,
            );
            throw new ForbiddenException('Scope does not belong to authenticated user');
        }

        return true;
    }
}
