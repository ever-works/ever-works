import { Controller, Get, Inject, Optional, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrganizationRepository, TenantRepository } from '@ever-works/agent/database';
import {
    isIntegrationKind,
    isIntegrationScope,
    type IntegrationKeyOrganization,
    type IntegrationWhoamiResponse,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    IntegrationOrgOptional,
    RequireScopes,
} from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { integrationLimits } from '../../auth/integration/integration-limits';
import { IntegrationOnlyGuard } from './integration-only.guard';
import {
    INTEGRATION_FEED_HEAD,
    NO_FEED_HEAD,
    type IntegrationFeedHead,
} from './integration-feed-head';

/**
 * Integration API v1 — `GET /api/integrations/v1/whoami` (contract v1 B.2).
 *
 * Answers any valid integration key and needs no org header: the Tenant, the
 * pinned Organizations (id, slug, display name), the granted scopes, the API
 * version, the change-feed head and the key's rate limits. Gauzy calls it to
 * validate a pasted key and on its daily health check (a 401 there means the
 * key was revoked or rotated out).
 *
 * The rest of `/api/integrations/v1` is EW-P1-4.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
export class IntegrationWhoamiController {
    constructor(
        private readonly tenants: TenantRepository,
        private readonly organizations: OrganizationRepository,
        @Optional()
        @Inject(INTEGRATION_FEED_HEAD)
        private readonly feedHead?: IntegrationFeedHead,
    ) {}

    @Get('whoami')
    @RequireScopes()
    @IntegrationOrgOptional()
    @ApiOperation({ summary: 'Who is this integration key? (tenant, pinned orgs, scopes, limits)' })
    @ApiResponse({ status: 200, description: 'The key, its tenant, pins, scopes and limits' })
    @ApiResponse({ status: 401, description: 'invalid_key' })
    async whoami(@CurrentUser() user: AuthenticatedUser): Promise<IntegrationWhoamiResponse> {
        const principal = user.integration;
        if (!principal) {
            throw new IntegrationHttpException(401, 'invalid_key', 'Invalid integration key.');
        }
        const [tenant, tenantOrgs] = await Promise.all([
            this.tenants.findById(principal.tenantId),
            this.organizations.findByTenantId(principal.tenantId),
        ]);
        if (!tenant) {
            throw new IntegrationHttpException(401, 'invalid_key', 'Invalid integration key.');
        }
        const byId = new Map(tenantOrgs.map((org) => [org.id, org]));
        const organizations: IntegrationKeyOrganization[] = principal.allowedOrganizationIds
            .map((id) => byId.get(id))
            .filter((org): org is NonNullable<typeof org> => !!org)
            .map((org) => ({ id: org.id, slug: org.slug, displayName: org.displayName }));

        const limits = integrationLimits();
        const head = this.feedHead
            ? await this.feedHead.head({
                  tenantId: principal.tenantId,
                  organizationIds: organizations.map((org) => org.id),
              })
            : NO_FEED_HEAD;

        return {
            keyId: principal.keyId,
            keyName: principal.keyName,
            integrationKind: isIntegrationKind(principal.integrationKind)
                ? principal.integrationKind
                : 'generic',
            tenant: { id: tenant.id, slug: tenant.slug },
            organizations,
            scopes: principal.scopes.filter(isIntegrationScope),
            apiVersion: '1',
            feedHead: head,
            limits: { readsPerMin: limits.readsPerMin, writesPerMin: limits.writesPerMin },
        };
    }
}
