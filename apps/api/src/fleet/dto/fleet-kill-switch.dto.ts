import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
    FLEET_AUDIT_DEFAULT_LIMIT,
    FLEET_AUDIT_MAX_LIMIT,
    FLEET_KILL_SWITCH_REASON_MAX_LENGTH,
} from '@ever-works/contracts';

/**
 * Panic controls (EW-778) — request shapes. Every bound comes from the
 * shared contract so the web tier and the API agree on it at compile
 * time.
 */

/** Body for `POST /api/fleet/kill-switch/stop` (platform admin). */
export class StopFleetKillSwitchDto {
    @ApiProperty({
        required: false,
        maxLength: FLEET_KILL_SWITCH_REASON_MAX_LENGTH,
        description:
            'Why the fleet is being stopped. Shown in the banner and recorded in the audit row.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_KILL_SWITCH_REASON_MAX_LENGTH)
    reason?: string;
}

/** Query for `GET /api/fleet/kill-switch/audit` (platform admin). */
export class FleetAuditQueryDto {
    @ApiProperty({
        required: false,
        minimum: 1,
        maximum: FLEET_AUDIT_MAX_LIMIT,
        default: FLEET_AUDIT_DEFAULT_LIMIT,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(FLEET_AUDIT_MAX_LIMIT)
    limit?: number;
}

/**
 * Body for `POST /api/fleet/cancel-in-flight` (owner).
 *
 * `includeQueued` defaults to FALSE on purpose: the queued rows a
 * drain-all just returned to the pool are a separate decision from the
 * work that is actually executing right now.
 */
export class CancelFleetInFlightDto {
    @ApiProperty({
        required: false,
        default: false,
        description:
            'Also fail every job still QUEUED for this owner (nothing has started them). Default false: only leased / running work is cancelled.',
    })
    @IsOptional()
    @IsBoolean()
    includeQueued?: boolean;
}
