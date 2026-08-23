import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
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
 * `api.module.ts`) and does TWO things: hydrates `req.user.tenantId`
 * and, on legacy routes, seeds the default scope in place via
 * [`ScopeContextService.setScope`](./scope-context.service.ts).
 *
 * **Behavior:**
 *
 *   - Non-HTTP context (RPC / WS) → allow, do nothing.
 *   - No `request.user` → unauthenticated; nothing to hydrate → allow.
 *   - Otherwise: load the user row once and HYDRATE
 *     `req.user.tenantId` (the auth layer never sets it). This happens
 *     on BOTH legacy and slug-prefixed routes — see below.
 *   - An Organization scope must still have an exact roster membership;
 *     the Tenant owner is the sole row-less exception. A revoked/missing
 *     Organization is an opaque 404.
 *   - Then SEED scope only if no slug already resolved one
 *     (`scope.tenantId === null`) AND the user has a Tenant →
 *     `{ tenantId, organizationId: lastScopeOrganizationId ?? null }`.
 *     A user with no Tenant leaves `EMPTY_SCOPE`.
 *
 * **Why hydrate on slug routes too (not just legacy):** the next guard,
 * `ScopeOwnershipGuard`, authorizes by comparing `req.user.tenantId`
 * against the resolved `scope.tenantId`. `AuthenticatedUser` doesn't
 * carry `tenantId`, so if we only hydrated on legacy routes, every
 * authenticated slug-prefixed request would 403. (Codex + Greptile P1
 * on PR #1074.) Positioned before `ScopeOwnershipGuard` so the
 * hydrated value + seeded scope are both visible to it.
 *
 * **Performance:** one extra indexed-PK `findById` per authenticated
 * request. Acceptable; can be cached or folded into the auth token in
 * a later optimization.
 */
@Injectable()
export class SessionScopeGuard implements CanActivate {
    private readonly logger = new Logger(SessionScopeGuard.name);

    constructor(
        private readonly scopeContext: ScopeContextService,
        private readonly userRepository: UserRepository,
        private readonly organizationRepository: OrganizationRepository,
        private readonly organizationMembers: OrganizationMemberRepository,
        private readonly tenants: TenantRepository,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Only HTTP — skip RPC / WS / etc.
        if (context.getType() !== 'http') {
            return true;
        }

        const req = context.switchToHttp().getRequest<{
            user?: { userId?: string; tenantId?: string | null };
        }>();
        const user = req.user;
        if (!user?.userId) {
            // Unauthenticated request — nothing to hydrate or seed.
            return true;
        }

        // Load the user's Tenant. `AuthenticatedUser` doesn't carry
        // tenantId (the auth layer never sets it), so we read it here —
        // ONE indexed PK lookup per authenticated request.
        //
        // We hydrate on BOTH legacy AND slug-prefixed routes, not just
        // legacy: the next guard (`ScopeOwnershipGuard`) authorizes by
        // comparing `req.user.tenantId` against the resolved
        // `scope.tenantId`. If we only hydrated on legacy routes, every
        // authenticated slug-prefixed request would 403 — `user.tenantId`
        // would be undefined while the slug resolved a real scope.
        // (Codex + Greptile P1 on PR #1074.)
        const dbUser = await this.userRepository.findById(user.userId);
        const tenantId = dbUser?.tenantId ?? null;

        // Hydrate req.user unconditionally so the field is always defined
        // (not ambiguously undefined) by the time the ownership guard
        // reads it.
        user.tenantId = tenantId;

        // Seed the default scope ONLY on legacy routes (no slug resolved
        // a scope). Slug routes keep the middleware-resolved scope; the
        // ownership guard then verifies it belongs to this user's
        // hydrated tenant.
        const scope = this.scopeContext.getScope();
        if (
            scope.organizationId !== null &&
            scope.tenantId !== null &&
            scope.tenantId === tenantId
        ) {
            await this.requireActiveOrganization(user.userId, scope.tenantId, scope.organizationId);
        }
        if (scope.tenantId === null && tenantId !== null) {
            // Security: validate that lastScopeOrganizationId still belongs to
            // this user's tenant before seeding it as the active scope.
            // Missing, foreign, or revoked last-active Organizations fail with
            // the same opaque 404 as an explicit slug request. Falling back to
            // bare personal scope here would make revocation grant a different
            // data surface that the caller did not explicitly select.
            const resolvedOrganizationId: string | null = dbUser?.lastScopeOrganizationId ?? null;
            if (resolvedOrganizationId !== null) {
                await this.requireActiveOrganization(user.userId, tenantId, resolvedOrganizationId);
            }
            this.scopeContext.setScope({
                tenantId,
                organizationId: resolvedOrganizationId,
            });
            this.logger.debug(`Seeded session scope for user ${user.userId}: tenantId=${tenantId}`);
        }

        return true;
    }

    /**
     * Exact active-Organization authorization. Organization slugs are public,
     * so missing rows and revoked roster membership deliberately collapse to
     * the same non-enumerating 404.
     */
    private async requireActiveOrganization(
        userId: string,
        tenantId: string,
        organizationId: string,
    ): Promise<void> {
        const organization = await this.organizationRepository.findById(organizationId);
        if (!organization || organization.tenantId !== tenantId) {
            throw new NotFoundException('Organization not found');
        }

        const [membership, tenant] = await Promise.all([
            this.organizationMembers.findByOrgAndUser(organizationId, userId),
            this.tenants.findById(tenantId),
        ]);
        if (
            tenant?.ownerUserId === userId ||
            (membership !== null && membership.tenantId === tenantId)
        ) {
            return;
        }

        throw new NotFoundException('Organization not found');
    }
}
