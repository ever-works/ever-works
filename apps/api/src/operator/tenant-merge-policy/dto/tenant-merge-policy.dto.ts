import { IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
    MergePolicy,
    MergePolicyChainEntry,
    MergePolicyOverride,
    MergePolicySource,
} from '@ever-works/contracts';
import { MergePolicyDto } from '@ever-works/agent/validation';

/**
 * Merge-policy matrix (Wave 3, D4) — operator write body for the TENANT
 * scope.
 *
 * Reuses the same `MergePolicyDto` the Work / Agent / organization PATCH
 * paths use, so all four scopes enforce identical constraints on what is,
 * at rest, one `simple-json` shape. `mergePolicy: null` clears the tenant
 * override entirely (everything beneath inherits the platform default
 * again).
 */
export class ReplaceTenantMergePolicyDto {
    @ApiPropertyOptional({
        description:
            'The tenant-scoped slice of the merge-policy matrix. PARTIAL by design: an omitted field ' +
            'inherits the platform default and stays overridable by every organization, Work and Agent ' +
            'beneath this tenant. Pass `null` to clear the tenant override entirely.',
        type: MergePolicyDto,
        nullable: true,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MergePolicyDto)
    mergePolicy?: MergePolicyDto | null;
}

/**
 * Response for both the GET and the PUT: what is STORED at the tenant
 * scope plus what that currently RESOLVES to, so an operator can see the
 * effect of the write in the same round trip that made it.
 */
export class TenantMergePolicyResponseDto {
    @ApiProperty({ format: 'uuid' })
    tenantId: string;

    @ApiProperty({
        description:
            'The PARTIAL override stored on this tenant row. `null` means the tenant declares nothing and everything inherits the platform default.',
        type: Object,
        nullable: true,
    })
    stored: MergePolicyOverride | null;

    @ApiProperty({
        description:
            'The fully-resolved policy for this tenant scope (tenant override folded over the platform default).',
        type: Object,
    })
    resolved: MergePolicy;

    @ApiProperty({
        description: 'Most specific scope that contributed a field — here `tenant` or `default`.',
    })
    source: MergePolicySource;

    @ApiProperty({
        description: 'Resolution chain, least → most specific, with the fields each link owns.',
        type: Object,
        isArray: true,
    })
    chain: MergePolicyChainEntry[];
}
