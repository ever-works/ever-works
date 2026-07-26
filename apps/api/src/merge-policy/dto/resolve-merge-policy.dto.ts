import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query for `GET /api/merge-policy/resolve` (Wave 3, D4).
 *
 * At least one of `workId` / `agentId` / `organizationId` must be present
 * — the controller enforces that (a bare "resolve nothing" call would
 * only ever echo the platform default and would tell the caller nothing
 * about their setup).
 *
 * There is deliberately no `tenantId` here: the tenant scope is an
 * operator ceiling, read and written through
 * `GET|PUT /api/operator/tenants/:tenantId/merge-policy` behind the
 * platform-admin guard. Its CONTRIBUTION is still visible to every
 * caller — it appears as a link in the returned `chain`, which is what a
 * settings card needs in order to say "inherited from tenant".
 */
export class ResolveMergePolicyQueryDto {
    @ApiPropertyOptional({
        description: 'Resolve the policy as it applies to this Work. Must be owned/accessible.',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({
        description:
            'Resolve the policy as it applies to this Agent (most specific scope; its Work, organization and tenant are discovered from the row). Must be owned.',
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiPropertyOptional({
        description:
            'Resolve the policy as it applies to this Organization (tenant + organization layers only). Must belong to the caller’s Tenant.',
    })
    @IsOptional()
    @IsUUID()
    organizationId?: string;
}
