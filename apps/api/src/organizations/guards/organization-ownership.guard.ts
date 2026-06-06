import {
    CanActivate,
    ExecutionContext,
    Injectable,
    NotFoundException,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationMembershipService } from '../organization-membership.service';

/**
 * Metadata key + decorator marking a route as requiring org **admin**
 * (write-side) ownership rather than plain membership. Default (no
 * decorator) = member-level.
 *
 * Today member and admin resolve to the SAME tenant-ownership check — a
 * true per-Organization admin role is a re-deferred schema + product
 * decision (see `OrganizationMembershipService`). The distinction is
 * carried here so that, once the role lands, the write path tightens in
 * ONE place (the guard's `ensureAdmin` branch) without touching every
 * route.
 */
export const ORG_OWNERSHIP_ADMIN = 'org_ownership_admin';
export const OrgAdmin = () => SetMetadata(ORG_OWNERSHIP_ADMIN, true);

/**
 * Fail-closed object-level authorization for raw
 * `/api/organizations/:orgId/...` (and `?orgId=`) routes.
 *
 * **Why a guard, not only the inline service call.** The platform-wide
 * scope guards do NOT authorize an attacker-supplied `:orgId`: the
 * un-prefixed `/api/organizations/:orgId/...` shape yields
 * `EMPTY_SCOPE`, so `ScopeOwnershipGuard` passes trivially (see
 * `scope-ownership.guard.ts`). Before this guard, every such route had
 * to remember to call `OrganizationMembershipService` inline — and a new
 * `:orgId` route that forgot the call shipped UNPROTECTED by default
 * (the exact gap flagged by the 2026-06-02 security audit, EW-711). This
 * guard makes the tenant-ownership check **declarative and default-on**:
 * decorate a route with `@UseGuards(OrganizationOwnershipGuard)` (plus
 * `@OrgAdmin()` for writes) and it is authorized before the handler runs.
 *
 * It delegates to the same `OrganizationMembershipService.ensureMember /
 * ensureAdmin`, so it inherits the **404-not-403 existence-leak
 * contract** — a foreign or missing `:orgId` is indistinguishable from
 * "not found". Runs after `AuthSessionGuard` (which populates
 * `req.user`); guards execute in registration order, controller-level
 * (`AuthSessionGuard`) before route-level (this guard).
 *
 * Fail-closed: a missing `orgId` or an unauthenticated request resolves
 * to `NotFoundException` — never a silent allow.
 */
@Injectable()
export class OrganizationOwnershipGuard implements CanActivate {
    constructor(
        private readonly membership: OrganizationMembershipService,
        private readonly reflector: Reflector,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Only HTTP — skip RPC / WS / etc.
        if (context.getType() !== 'http') {
            return true;
        }

        const req = context.switchToHttp().getRequest<{
            params?: Record<string, string>;
            query?: Record<string, unknown>;
            user?: { userId?: string };
        }>();

        const orgId =
            req.params?.orgId ??
            (typeof req.query?.orgId === 'string' ? req.query.orgId : undefined);
        const userId = req.user?.userId;

        // Fail closed: no org id or no authenticated user → reject with the
        // same existence-leak-safe 404 the membership service throws.
        // (AuthSessionGuard normally rejects unauthenticated requests before
        // this runs; the user check is defensive.)
        if (!orgId || !userId) {
            throw new NotFoundException(`Organization ${orgId ?? ''} not found`.trimEnd());
        }

        const requiresAdmin = this.reflector.getAllAndOverride<boolean>(ORG_OWNERSHIP_ADMIN, [
            context.getHandler(),
            context.getClass(),
        ]);

        // `ensure*` throws NotFoundException (404) on any failure — no
        // user/tenant, missing org, or cross-tenant org — preserving the
        // existence-leak contract. A clean resolve authorizes the request.
        if (requiresAdmin) {
            await this.membership.ensureAdmin(orgId, userId);
        } else {
            await this.membership.ensureMember(orgId, userId);
        }
        return true;
    }
}
