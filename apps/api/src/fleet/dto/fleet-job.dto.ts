import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import {
    FLEET_JOB_MAX_ERROR_LENGTH,
    FLEET_JOB_MAX_LEASE_BATCH,
    FLEET_JOB_MAX_LEASE_TTL_SEC,
    FLEET_JOB_MIN_LEASE_TTL_SEC,
    FLEET_RUN_ENV_FILE_MAX_COUNT,
    FLEET_RUN_ENV_FILE_REFS_MAX_COUNT,
} from '@ever-works/contracts';

/**
 * DTOs for the node-facing fleet-job endpoints.
 *
 * All three are PUBLIC and self-authenticating: the `(nodeId, secret)`
 * pair in the body IS the credential, checked constant-time against the
 * stored sha256 by `FleetJobService` — the identical posture the
 * enroll/heartbeat DTOs already use. Every invalid path collapses to one
 * undifferentiated 401.
 *
 * The global `ValidationPipe` runs `forbidNonWhitelisted`, so adding a
 * field here is a wire-contract change: the corresponding `apps/web/e2e`
 * rejection specs must be reconciled in the same PR.
 *
 * Suspend-safe leases (self-build finding R7): the heartbeat and complete
 * bodies REQUIRE `leaseGeneration`, the claim identity handed out with
 * the lease. It is the one thing in this channel that is not a
 * credential yet still decides whether a write lands, so it is validated
 * as strictly as one: integer, at least 1, no default. A node built
 * before this field existed is refused at the edge (400) rather than
 * quietly accepted against whichever claim happens to be current.
 */

/** Shared credential fields for every node-authenticated job call. */
export class FleetJobNodeCredentialDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId: string;

    @ApiProperty({ minLength: 16, maxLength: 256, description: 'Node secret minted at enroll.' })
    @IsString()
    @MinLength(16)
    @MaxLength(256)
    secret: string;
}

/** Request body for the PUBLIC `POST /api/fleet/jobs/lease`. */
export class LeaseFleetJobsDto extends FleetJobNodeCredentialDto {
    @ApiProperty({
        required: false,
        minimum: 1,
        maximum: FLEET_JOB_MAX_LEASE_BATCH,
        description: 'How many jobs to claim in one call. Clamped server-side.',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(FLEET_JOB_MAX_LEASE_BATCH)
    max?: number;

    @ApiProperty({
        required: false,
        minimum: FLEET_JOB_MIN_LEASE_TTL_SEC,
        maximum: FLEET_JOB_MAX_LEASE_TTL_SEC,
        description: 'Requested claim duration in seconds. Clamped server-side.',
    })
    @IsOptional()
    @IsInt()
    @Min(FLEET_JOB_MIN_LEASE_TTL_SEC)
    @Max(FLEET_JOB_MAX_LEASE_TTL_SEC)
    leaseTtlSec?: number;

    @ApiProperty({
        required: false,
        type: [String],
        description:
            'Capability tags advertised for THIS poll. Omitted means "use the tags last reported on heartbeat".',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(16)
    @IsString({ each: true })
    @MaxLength(32, { each: true })
    capabilities?: string[];
}

/** Request body for the PUBLIC `POST /api/fleet/jobs/:id/heartbeat`. */
export class FleetJobHeartbeatDto extends FleetJobNodeCredentialDto {
    @ApiProperty({
        required: false,
        minimum: FLEET_JOB_MIN_LEASE_TTL_SEC,
        maximum: FLEET_JOB_MAX_LEASE_TTL_SEC,
        description: 'Requested lease extension in seconds. Clamped server-side.',
    })
    @IsOptional()
    @IsInt()
    @Min(FLEET_JOB_MIN_LEASE_TTL_SEC)
    @Max(FLEET_JOB_MAX_LEASE_TTL_SEC)
    leaseTtlSec?: number;

    @ApiProperty({
        minimum: 1,
        description:
            'Lease generation returned with the claim. A generation that is not the current one is refused with 409 stale-lease.',
    })
    @IsInt()
    @Min(1)
    leaseGeneration: number;
}

/** Request body for the PUBLIC `POST /api/fleet/jobs/:id/complete`. */
export class CompleteFleetJobDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ description: 'false records a failure; the sweeper may still retry it.' })
    @IsBoolean()
    success: boolean;

    @ApiProperty({
        minimum: 1,
        description:
            'Lease generation returned with the claim. A generation that is not the current one is refused with 409 stale-lease and writes nothing.',
    })
    @IsInt()
    @Min(1)
    leaseGeneration: number;

    @ApiProperty({
        required: false,
        type: Object,
        description: 'Executor output; shape is per job kind. Size-capped server-side.',
    })
    @IsOptional()
    @IsObject()
    result?: Record<string, unknown>;

    @ApiProperty({ required: false, maxLength: FLEET_JOB_MAX_ERROR_LENGTH })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_JOB_MAX_ERROR_LENGTH)
    error?: string;
}

/**
 * One repository's env-file request (self-build slice Y). PATHS only —
 * there is no content field on the way in, and the response is the only
 * place a value ever appears.
 */
export class FleetJobEnvFileRefDto {
    @ApiProperty({ format: 'uuid', description: 'Repository registry row the files belong to.' })
    @IsUUID()
    repoConnectionId: string;

    @ApiProperty({
        type: [String],
        maxItems: FLEET_RUN_ENV_FILE_MAX_COUNT,
        description: 'Repository-relative env file paths, e.g. "apps/api/.env".',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(FLEET_RUN_ENV_FILE_MAX_COUNT)
    @IsString({ each: true })
    @MaxLength(200, { each: true })
    // Repository-relative (never leading `/`), traversal-free (no `.` or
    // `..` segment anywhere), and restricted to the registry's own path
    // alphabet. `FleetRunSecretsService` re-checks with
    // `isValidFleetRunEnvFilePath`; this is the edge half of that pair.
    @Matches(/^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-][A-Za-z0-9._/-]*$/, {
        each: true,
        message: 'each env file path must be repository-relative and free of traversal',
    })
    paths: string[];
}

/**
 * Request body for the PUBLIC `POST /api/fleet/jobs/:id/env-files`
 * (self-build slice Y, EW-781).
 *
 * Same credential posture as its three siblings — the `(nodeId, secret)`
 * pair IS the credential — plus the `leaseGeneration` the claim was handed
 * out with, because delivering a decrypted `.env` to a machine is at least
 * as consequential as letting it settle the job: a node whose claim lapsed
 * while it slept must be refused here exactly as it is on complete.
 */
export class FleetJobEnvFilesDto extends FleetJobNodeCredentialDto {
    @ApiProperty({
        minimum: 1,
        description:
            'Lease generation returned with the claim. A generation that is not the current one is refused with 409 stale-lease and delivers nothing.',
    })
    @IsInt()
    @Min(1)
    leaseGeneration: number;

    @ApiProperty({ type: [FleetJobEnvFileRefDto], maxItems: FLEET_RUN_ENV_FILE_REFS_MAX_COUNT })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(FLEET_RUN_ENV_FILE_REFS_MAX_COUNT)
    @ValidateNested({ each: true })
    @Type(() => FleetJobEnvFileRefDto)
    refs: FleetJobEnvFileRefDto[];
}
