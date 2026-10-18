import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import type { Organization } from '@ever-works/agent/entities';

/**
 * Opt-in switch for a REAL org-admin check behind {@link
 * OrganizationMembershipService.ensureAdmin}: `ORG_ADMIN_ROLE_ENFORCED=true`.
 *
 * Off by default on purpose. The roster `role` was shipped DISPLAY-ONLY
 * (`organization-member.entity.ts`) and every Tenant member has been allowed
 * to write org KB / org memory / digests / email policy / model routing; a
 * tenant user who predates the roster has no row at all. Turning the check on
 * unconditionally would lock those people out — so the security audit's
 * "ensureAdmin is just membership" finding is gated, not forced: an operator
 * who wants admin-only org writes turns this on.
 */
export function orgAdminRoleEnforced(): boolean {
    return (process.env.ORG_ADMIN_ROLE_ENFORCED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Reusable object-level authorization for raw
 * `/api/organizations/:orgId/...` routes.
 *
 * **Why this exists.** Routes that take an attacker-controlled `:orgId`
 * (or `?orgId`) path/query param are NOT protected by the global
 * scope guards: the un-prefixed `/api/organizations/:orgId/...` shape
 * isn't slug-prefixed, so `ScopeResolverMiddleware` yields
 * `EMPTY_SCOPE` and `ScopeOwnershipGuard` passes trivially — i.e. the
 * platform-wide scope guards do NOT authorize the supplied `:orgId`.
 * Each such route must resolve org→tenant and caller→tenant itself and
 * reject any cross-tenant access.
 *
 * Before this service, that check lived inline in `OrgKbController`
 * (`assertOrgAccess`). It is extracted here so EVERY raw
 * `/api/organizations/:orgId/...` route shares ONE audited
 * implementation instead of each re-deriving the tenant comparison
 * (and risking a copy that drops the check). The implementation
 * mirrors `OrganizationService.update` / `upgradeFromAccount` exactly:
 *
 *   - Load the caller's `User` row → its `tenantId`.
 *   - Load the target `Organization` row → its `tenantId`.
 *   - Require `org.tenantId === user.tenantId`.
 *
 * **Existence-leak contract.** On ANY failure (no user, no tenant,
 * missing org, or cross-tenant org) this throws `NotFoundException`
 * with the same `Organization <id> not found` message — never
 * `ForbiddenException`. Returning 404 (not 403) means an attacker
 * probing foreign `:orgId`s can't distinguish "org doesn't exist" from
 * "org exists but isn't mine", so org IDs in other tenants stay opaque.
 * This matches `OrganizationService.update`/`upgradeFromAccount`.
 *
 * **Scope (intentional).** This is a *tenant-ownership* check: it
 * authorizes any member of the owning Tenant. It deliberately does NOT
 * implement a per-Organization ADMIN role for writes — a true org-admin
 * role is a schema + product decision (a new role column/migration) and
 * is re-deferred. `ensureMember` and `ensureAdmin` are intentionally
 * identical today; `ensureAdmin` exists only so write-side call sites
 * can express intent and so the future role model has a single seam to
 * tighten without touching every caller. Do NOT add a role column here
 * without that product decision.
 *
 * **Opt-in admin check (security audit, 2026-10-18).** With
 * `ORG_ADMIN_ROLE_ENFORCED=true`, `ensureAdmin` additionally requires the
 * Tenant owner or a roster role of `admin` — reusing the existing
 * `organization_members.role` column, no schema change. Off by default so
 * nothing that works today is locked out (see {@link orgAdminRoleEnforced}).
 */
@Injectable()
export class OrganizationMembershipService {
    constructor(
        private readonly organizationRepository: OrganizationRepository,
        private readonly userRepository: UserRepository,
        // The opt-in admin check (`ORG_ADMIN_ROLE_ENFORCED`). @Optional() and
        // appended LAST (positional-spec arity): unbound, an enforced check
        // fails CLOSED rather than falling back to membership.
        @Optional() private readonly tenantRepository?: TenantRepository,
        @Optional() private readonly memberRepository?: OrganizationMemberRepository,
    ) {}

    /**
     * Authorize the caller for a tenant-ownership-gated Organization
     * route and return the resolved `Organization`.
     *
     * Throws `NotFoundException` (NOT `Forbidden`) when the caller has
     * no Tenant, the org doesn't exist, or the org belongs to a
     * different Tenant — see the existence-leak contract above.
     */
    async ensureMember(orgId: string, userId: string): Promise<Organization> {
        const user = await this.userRepository.findById(userId);
        if (!user || !user.tenantId) {
            // No Tenant ⇒ cannot own/belong to any Organization.
            throw new NotFoundException(`Organization ${orgId} not found`);
        }
        const org = await this.organizationRepository.findById(orgId);
        if (!org || org.tenantId !== user.tenantId) {
            // Don't leak existence: same response as missing.
            throw new NotFoundException(`Organization ${orgId} not found`);
        }
        return org;
    }

    /**
     * Authorize a write to a tenant-ownership-gated Organization route.
     *
     * **Today this is exactly `ensureMember`** — there is no separate
     * org-admin role in the schema yet (that's a re-deferred product +
     * schema decision). It exists as a distinct method so write-side
     * call sites read correctly and so a future org-admin role can be
     * enforced HERE, in one place, rather than retrofitted across every
     * write route. Do not collapse it into `ensureMember` at call sites.
     */
    async ensureAdmin(orgId: string, userId: string): Promise<Organization> {
        const org = await this.ensureMember(orgId, userId);
        if (!orgAdminRoleEnforced()) return org;
        // Enforced: the Tenant owner, or a roster member whose role is
        // `admin` (or `owner`). A same-Tenant caller already knows the org
        // exists, so this refusal is a 403, not the 404 of `ensureMember`.
        if (!this.tenantRepository || !this.memberRepository) {
            throw new ForbiddenException('Organization admin access cannot be verified here.');
        }
        const tenant = await this.tenantRepository.findById(org.tenantId);
        if (tenant?.ownerUserId && tenant.ownerUserId === userId) return org;
        const member = await this.memberRepository.findByOrgAndUser(orgId, userId);
        const role = (member?.role ?? '') as string;
        if (role === 'admin' || role === 'owner') return org;
        throw new ForbiddenException('Only an organization admin can change this.');
    }
}
