import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
} from 'class-validator';
import type { FleetNodeKind } from '@ever-works/agent/fleet';

const ENROLLABLE_KINDS: FleetNodeKind[] = ['desktop-node', 'node'];

/**
 * Request body for `POST /api/fleet/nodes/enrollment-token` — issue a
 * one-time enrollment token for a new node. Semantic rules (name floor,
 * kind whitelist) are re-validated in `FleetService`, the single source
 * of truth.
 */
export class CreateFleetEnrollmentTokenDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name: string;

    @ApiProperty({ enum: ENROLLABLE_KINDS, description: 'App shape of the node.' })
    @IsIn(ENROLLABLE_KINDS)
    kind: FleetNodeKind;
}

/** Request body for `PATCH /api/fleet/nodes/:id` (partial update). */
export class UpdateFleetNodeDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name?: string;

    @ApiProperty({
        required: false,
        description:
            'true drains the node (stops heartbeats being accepted); false re-enables it as offline until its next heartbeat.',
    })
    @IsOptional()
    @IsBoolean()
    disabled?: boolean;
}

/** Node self-description shared by enroll + heartbeat refresh. */
export class FleetNodeSelfDescriptionDto {
    @ApiProperty({ required: false, maxLength: 64, description: 'os/arch, e.g. linux/x64.' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    platform?: string;

    @ApiProperty({ required: false, maxLength: 32 })
    @IsOptional()
    @IsString()
    @MaxLength(32)
    version?: string;

    @ApiProperty({
        required: false,
        type: [String],
        description: "Capability tags, e.g. ['terminal', 'workspace', 'docker'].",
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(16)
    @IsString({ each: true })
    @MaxLength(32, { each: true })
    capabilities?: string[];
}

/**
 * Request body for the PUBLIC `POST /api/fleet/enroll` — the one-time
 * token IS the credential; auth is the constant-time hash check in
 * `FleetService.enroll` (fail-closed 401 on any invalid path).
 */
export class EnrollFleetNodeDto extends FleetNodeSelfDescriptionDto {
    @ApiProperty({ minLength: 16, maxLength: 256, description: 'One-time enrollment token.' })
    @IsString()
    @MinLength(16)
    @MaxLength(256)
    token: string;
}

/**
 * Request body for the PUBLIC `POST /api/fleet/heartbeat` — node
 * credential auth (constant-time hash check, fail-closed 401).
 */
export class FleetHeartbeatDto extends FleetNodeSelfDescriptionDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId: string;

    @ApiProperty({ minLength: 16, maxLength: 256, description: 'Node secret minted at enroll.' })
    @IsString()
    @MinLength(16)
    @MaxLength(256)
    secret: string;
}
