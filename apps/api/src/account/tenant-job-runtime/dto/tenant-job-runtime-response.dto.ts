import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    TENANT_JOB_RUNTIME_MODES,
    TENANT_JOB_RUNTIME_PROVIDER_IDS,
    type TenantJobRuntimeMode,
    type TenantJobRuntimeProviderId,
} from './upsert-tenant-job-runtime.dto';

/**
 * EW-742 / EW-746 (P2.0 — tenant-job-runtime overlay admin API) — wire
 * shape returned by the GET / PUT / DELETE / rotate endpoints under
 * `/api/account/job-runtime/...`.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §4 + §6 settings cascade](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 *
 * **Credential redaction (settings-system §7 + spec FR-13):** the response
 * exposes only the presence of a credential pointer (`hasCredentials`) and
 * the redacted ref suffix (`credentialsSecretRefRedacted`) — never the
 * full opaque ref and obviously never the underlying plaintext credential
 * blob. The underlying blob lives in the encrypted secrets store and is
 * decrypted only on the dispatch path (P3) where the worker host needs
 * it.
 *
 * **`mode: inherit` synthetic default (NULL-safe GET):** when the tenant
 * has no overlay row yet, the controller returns this DTO with
 * `mode = 'inherit'`, `providerId = null`, `credentialsSecretRefRedacted
 * = null`, `hasCredentials = false`, and `credentialVersion = null`. That
 * keeps the GET endpoint NULL-safe per FR-7 ("absence of a row is
 * equivalent to inherit") without forcing the UI to special-case 404.
 */
export class TenantJobRuntimeConfigResponseDto {
    @ApiProperty({
        description: 'Tenant id this overlay row belongs to.',
        example: '7f3c1a2e-4d5b-4c6a-9e8f-0b1c2d3e4f5a',
    })
    readonly tenantId!: string;

    @ApiPropertyOptional({
        description:
            'Provider id when an overlay row exists. NULL when no row exists ' +
            '(synthetic `mode = inherit` default — see DTO doc).',
        enum: TENANT_JOB_RUNTIME_PROVIDER_IDS,
        nullable: true,
    })
    readonly providerId!: TenantJobRuntimeProviderId | null;

    @ApiProperty({
        description: 'Active overlay mode (synthetic `inherit` when no row exists).',
        enum: TENANT_JOB_RUNTIME_MODES,
    })
    readonly mode!: TenantJobRuntimeMode;

    @ApiProperty({
        description:
            'Whether a credentials secret pointer is stored on the row. ' +
            '`false` for `mode = inherit` (no overlay credentials).',
    })
    readonly hasCredentials!: boolean;

    @ApiPropertyOptional({
        description:
            'Redacted credentials pointer for operator UX (last 4 chars only — ' +
            'NEVER the full ref). NULL when no credentials are stored.',
        nullable: true,
        example: '***f5a',
    })
    readonly credentialsSecretRefRedacted!: string | null;

    @ApiPropertyOptional({
        description:
            'Current monotonic credential version. NULL when no overlay row ' +
            'exists; `>= 1` when a row exists (incremented on every rotate / ' +
            'force-invalidate per ADR-017 §3).',
        nullable: true,
    })
    readonly credentialVersion!: number | null;

    @ApiProperty({
        description:
            'Soft-disable flag. `false` makes the dispatcher treat the row as ' +
            '`inherit` even when `mode = byo|override`.',
    })
    readonly enabled!: boolean;

    @ApiPropertyOptional({
        description:
            'User id that created the row, or NULL when the row was created by ' +
            'a system / migration actor.',
        nullable: true,
    })
    readonly createdBy!: string | null;

    @ApiPropertyOptional({
        description: 'Row creation timestamp (ISO 8601). NULL for the synthetic inherit default.',
        nullable: true,
    })
    readonly createdAt!: string | null;

    @ApiPropertyOptional({
        description: 'Last update timestamp (ISO 8601). NULL for the synthetic inherit default.',
        nullable: true,
    })
    readonly updatedAt!: string | null;
}

/**
 * Response shape for `POST /api/account/job-runtime/rotate` and `POST
 * /api/account/job-runtime/force-invalidate`. Surfaces the post-bump
 * version so the UI can refresh its cached row without an extra GET.
 */
export class TenantJobRuntimeRotateResponseDto {
    @ApiProperty({
        description:
            'New credential version after the bump. The dispatcher will pick ' +
            'this version up on the next enqueue; in-flight runs keep their ' +
            'captured version per ADR-017 §3 (graceful drain).',
    })
    readonly credentialVersion!: number;
}

/**
 * EW-742 P5 (T34) — response shape for `GET /api/account/job-runtime/available-providers`.
 * Wraps the operator allow-list so the picker can render the dynamic
 * subset of providers the instance operator has enabled via the
 * `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` env var. Empty / unset
 * env returns ALL bundled providers (fail-open default per plan.md §10
 * P5).
 */
export class TenantJobRuntimeAvailableProvidersResponseDto {
    @ApiProperty({
        description:
            'Provider ids the operator allows for tenant overlays. Subset (or full ' +
            'copy) of TENANT_JOB_RUNTIME_PROVIDER_IDS. Order matches the operator ' +
            'declaration (or the canonical bundled order when the env is unset).',
        enum: TENANT_JOB_RUNTIME_PROVIDER_IDS,
        isArray: true,
    })
    readonly providers!: TenantJobRuntimeProviderId[];
}
