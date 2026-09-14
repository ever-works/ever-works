import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationRepository, TenantRepository } from '@ever-works/agent/database';
import type { SharedViewActor } from '@ever-works/agent/shared-views';

/** Where the guard leaves the resolved Workspace owner for the handler. */
export const SHARED_VIEW_ACTOR_KEY = 'sharedViewActor';

/**
 * Resolves who owns a Workspace: `organizationId → tenantId →
 * tenant.ownerUserId`. The Tenant owner is the only unambiguous owner the
 * platform has; per-Organization roles are display-only today, so this is the
 * single seam a future role model tightens.
 */
@Injectable()
export class SharedViewOwnerResolver {
    constructor(
        private readonly organizations: OrganizationRepository,
        private readonly tenants: TenantRepository,
    ) {}

    /** The Workspace and its owner, or `null` when either cannot be resolved. */
    async resolve(organizationId: string): Promise<SharedViewActor | null> {
        const organization = await this.organizations.findById(organizationId);
        if (!organization?.tenantId) return null;
        const tenant = await this.tenants.findById(organization.tenantId);
        if (!tenant?.ownerUserId) return null;
        return {
            organizationId: organization.id,
            tenantId: organization.tenantId,
            ownerUserId: tenant.ownerUserId,
        };
    }
}

/**
 * Owner-only gate for every Shared view write and for the token-bearing read.
 *
 * Composes AFTER `OrganizationOwnershipGuard`, so a non-member has already
 * been turned away by the existing membership check and never reaches the
 * owner lookup. A member who is not the Tenant owner gets `404`, never `403`
 * — the same no-existence-leak answer the rest of `/api/organizations/:orgId`
 * gives.
 */
@Injectable()
export class SharedViewOwnerGuard implements CanActivate {
    constructor(private readonly owners: SharedViewOwnerResolver) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') return true;
        const request = context.switchToHttp().getRequest<{
            params?: Record<string, string>;
            user?: { userId?: string };
            [SHARED_VIEW_ACTOR_KEY]?: SharedViewActor;
        }>();
        const orgId = request.params?.orgId;
        const userId = request.user?.userId;
        if (!orgId || !userId) {
            throw new NotFoundException('Shared view not found');
        }
        const actor = await this.owners.resolve(orgId);
        if (!actor || actor.ownerUserId !== userId) {
            throw new NotFoundException('Shared view not found');
        }
        request[SHARED_VIEW_ACTOR_KEY] = actor;
        return true;
    }
}
