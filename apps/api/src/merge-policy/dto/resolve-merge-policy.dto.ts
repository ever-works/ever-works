import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query for `GET /api/merge-policy/resolve` (Wave 3, D4).
 *
 * At least one of `workId` / `agentId` must be present — the controller
 * enforces that (a bare "resolve nothing" call would only ever echo the
 * platform default and would tell the caller nothing about their setup).
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
}
