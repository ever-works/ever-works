import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    FLEET_JOB_MAX_ERROR_LENGTH,
    FLEET_JOB_MAX_LEASE_BATCH,
    FLEET_JOB_MAX_LEASE_TTL_SEC,
    FLEET_JOB_MIN_LEASE_TTL_SEC,
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
}

/** Request body for the PUBLIC `POST /api/fleet/jobs/:id/complete`. */
export class CompleteFleetJobDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ description: 'false records a failure; the sweeper may still retry it.' })
    @IsBoolean()
    success: boolean;

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
