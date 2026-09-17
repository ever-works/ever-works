import { Injectable } from '@nestjs/common';
import type { ModelWorkspaceScope } from '@ever-works/agent/model-routing';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { ScopeContextService } from '../scope/scope-context.service';

/**
 * Model accounts (AW-16) — which workspace a request acts on, re-authorized.
 *
 * The organization is NEVER taken from the request body or a parameter — it
 * is the session's active scope (an `X-Scope-Slug` header or `/api/<slug>/…`
 * path), re-checked through the shared membership service: reading needs a
 * member, changing needs an admin. An unprefixed request is the personal
 * workspace, which only its own person ever reaches.
 */
@Injectable()
export class ModelWorkspaceAccessService {
    constructor(
        private readonly scopeContext: ScopeContextService,
        private readonly membership: OrganizationMembershipService,
    ) {}

    async resolve(userId: string, access: 'read' | 'write'): Promise<ModelWorkspaceScope> {
        const organizationId = this.scopeContext.getOrganizationId();
        const tenantId = this.scopeContext.getTenantId();
        if (organizationId) {
            if (access === 'write') {
                await this.membership.ensureAdmin(organizationId, userId);
            } else {
                await this.membership.ensureMember(organizationId, userId);
            }
        }
        return { userId, tenantId: tenantId ?? null, organizationId: organizationId ?? null };
    }
}
