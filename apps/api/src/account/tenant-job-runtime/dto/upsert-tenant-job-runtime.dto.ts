import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * EW-742 / EW-746 (P2.0 — tenant-job-runtime overlay admin API) — request
 * DTO for `PUT /api/account/job-runtime/config`.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §4 API surface](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#4-api-surface)
 * Tasks: [`tasks.md` T14](../../../../../docs/specs/features/tenant-job-runtime-overlay/tasks.md)
 *
 * Validation contract:
 *   - `providerId` MUST be in the static instance-default allow-list
 *     (per [`providers.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/providers.md)
 *     availability matrix). The dynamic per-tenant operator allow-list
 *     filtering (FR-9 / T34) lives in the service layer and is deferred
 *     to P5; the static enum here is the floor-level gate that 400s
 *     unknown provider ids before they touch the database.
 *   - `mode` MUST be one of `inherit` | `byo` | `override` per ADR-017 §1.
 *   - `credentialsSecretRef` MUST be present when `mode != 'inherit'`.
 *     When `mode = 'inherit'` it is forbidden (the row is reverted to
 *     using the platform-default credentials so a tenant pointer would
 *     leak across the inherit fall-through).
 *
 * The reachability probe (PUT validates against provider's
 * `provisionTenant`) is deferred to P4 (worker host) per the PR scope
 * note in the implementing prompt — this DTO only enforces shape.
 */

/**
 * Allowed `providerId` values. Mirrors the EW-685 contract enumeration
 * (`'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest'`) and the
 * availability matrix in
 * [`providers.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/providers.md).
 * Kept here as a module-local literal tuple (rather than imported from
 * the EW-685 plugin contracts) so the DTO file has zero runtime
 * dependency on the agent / plugin trees and stays cheap to import from
 * the global ValidationPipe.
 */
export const TENANT_JOB_RUNTIME_PROVIDER_IDS = [
    'trigger',
    'temporal',
    'bullmq',
    'pgboss',
    'inngest',
] as const;

export type TenantJobRuntimeProviderId = (typeof TENANT_JOB_RUNTIME_PROVIDER_IDS)[number];

/** Allowed `mode` values per ADR-017 §1. */
export const TENANT_JOB_RUNTIME_MODES = ['inherit', 'byo', 'override'] as const;

export type TenantJobRuntimeMode = (typeof TENANT_JOB_RUNTIME_MODES)[number];

export class UpsertTenantJobRuntimeConfigDto {
    @ApiProperty({
        description: 'Job-runtime provider id from the static allow-list.',
        enum: TENANT_JOB_RUNTIME_PROVIDER_IDS,
        example: 'trigger',
    })
    @IsString()
    @IsIn(TENANT_JOB_RUNTIME_PROVIDER_IDS as unknown as string[])
    readonly providerId!: TenantJobRuntimeProviderId;

    @ApiProperty({
        description:
            'Overlay mode. `inherit` falls back to the platform-default credentials; ' +
            '`byo` uses the tenant-supplied credentials with the same provider as the ' +
            'default; `override` switches both provider and credentials.',
        enum: TENANT_JOB_RUNTIME_MODES,
        example: 'byo',
    })
    @IsString()
    @IsIn(TENANT_JOB_RUNTIME_MODES as unknown as string[])
    readonly mode!: TenantJobRuntimeMode;

    @ApiPropertyOptional({
        description:
            'Opaque pointer into the encrypted secrets store. Required when ' +
            '`mode != inherit`; forbidden when `mode = inherit` (the row falls back ' +
            'to platform-default credentials and a tenant pointer would never resolve). ' +
            'Never holds plaintext secrets — the actual blob is encrypted at rest ' +
            'under PLUGIN_SECRET_ENCRYPTION_KEY.',
        maxLength: 128,
        example: 'tenant-job-runtime:42a1b8de:trigger:v3',
    })
    // Required when mode != inherit (validated against the value of `mode` in
    // the same payload). `@ValidateIf` skips the subsequent validators when
    // the predicate is FALSE, so:
    //   - mode = inherit → @ValidateIf returns false → IsString/MaxLength
    //     skipped → the field passes whether absent OR present (the
    //     "forbidden when inherit" rule is enforced in the service layer
    //     with a precise BadRequestException message; modelling
    //     "absent-required" in class-validator requires the reverse predicate,
    //     which would emit a generic "must be a string" error for legit
    //     inherit submissions).
    //   - mode != inherit → @ValidateIf returns true → IsString runs and
    //     fails on undefined → required-when-not-inherit holds.
    // NOTE: we do NOT add @IsOptional() here. @IsOptional skips validators
    // when the value is null/undefined, which would un-do the
    // required-when-not-inherit invariant.
    @ValidateIf((o: UpsertTenantJobRuntimeConfigDto) => o.mode !== 'inherit')
    @IsString()
    @MaxLength(128)
    readonly credentialsSecretRef?: string | null;

    @ApiPropertyOptional({
        description:
            'Soft-disable without losing the row. When `false` the dispatcher ' +
            'treats the tenant as `inherit` so operators can quickly fall back ' +
            'without dropping the credential pointer.',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    readonly enabled?: boolean;
}
