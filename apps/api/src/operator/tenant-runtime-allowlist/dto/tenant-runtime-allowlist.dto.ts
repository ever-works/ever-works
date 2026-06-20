import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsIn, IsString } from 'class-validator';
import {
    TENANT_JOB_RUNTIME_PROVIDER_IDS,
    type TenantJobRuntimeProviderId,
} from '../../../account/tenant-job-runtime/dto/upsert-tenant-job-runtime.dto';

/**
 * EW-752 P5.1 (T35a) — request shape for
 * `PUT /api/operator/tenants/:tenantId/runtime-allowlist`. Replaces the
 * whole per-tenant allow-list set in one atomic transaction.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §10 P5.1](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 *
 * Validation: each entry MUST be one of `TENANT_JOB_RUNTIME_PROVIDER_IDS`
 * (the static bundled list). Duplicates are rejected at the DTO layer
 * (`ArrayUnique`) instead of being silently dropped so a typoed
 * operator payload surfaces a clear 400 rather than a quiet drop. An
 * EMPTY array is allowed and means "clear the per-tenant overlay"
 * (which falls back to "inherit the global list"). To remove a SINGLE
 * provider, use the DELETE endpoint instead.
 */
export class ReplaceTenantRuntimeAllowlistDto {
    @ApiProperty({
        description:
            'Provider ids the tenant is allowed to use. Each id must be in the bundled ' +
            'allow-list. Empty array clears the per-tenant overlay (tenant inherits the ' +
            'global allow-list).',
        enum: TENANT_JOB_RUNTIME_PROVIDER_IDS,
        isArray: true,
        example: ['trigger', 'temporal'],
    })
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    @IsIn(TENANT_JOB_RUNTIME_PROVIDER_IDS as unknown as string[], { each: true })
    readonly providerIds!: TenantJobRuntimeProviderId[];
}

/**
 * EW-752 P5.1 (T35a) — response shape for
 * `GET /api/operator/tenants/:tenantId/runtime-allowlist` and
 * `PUT /api/operator/tenants/:tenantId/runtime-allowlist`.
 */
export class TenantRuntimeAllowlistResponseDto {
    @ApiProperty({
        description:
            'Tenant id the per-tenant allow-list belongs to. Echoed back so the caller ' +
            'can correlate the response with the request without re-reading the URL.',
        example: '7f3c1a2e-4d5b-4c6a-9e8f-0b1c2d3e4f5a',
    })
    readonly tenantId!: string;

    @ApiProperty({
        description:
            'Per-tenant allow-list rows. EMPTY when no rows exist (the tenant inherits ' +
            'the global allow-list when the gating flag is on, or behaves as today when off).',
        enum: TENANT_JOB_RUNTIME_PROVIDER_IDS,
        isArray: true,
    })
    readonly providerIds!: TenantJobRuntimeProviderId[];

    @ApiProperty({
        description:
            'Whether per-tenant gating is currently ON (env: ' +
            'EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING). Echoed so the operator can ' +
            'tell at a glance whether the rows actually take effect right now.',
    })
    readonly perTenantGatingEnabled!: boolean;
}
