import { Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import type { Organization } from '@ever-works/agent/entities';

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
 */
@Injectable()
export class OrganizationMembershipService {
    constructor(
        private readonly organizationRepository: OrganizationRepository,
        private readonly userRepository: UserRepository,
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
        return this.ensureMember(orgId, userId);
    }
}
