import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
    FLEET_CHECKOUT_KINDS,
    FLEET_CHECKOUT_STATES,
    FLEET_CHECKOUT_SYNC_OPS,
    type FleetCheckoutKind,
    type FleetCheckoutState,
    type FleetCheckoutSyncOp,
} from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14, plan §5) — request shapes. Every bound comes
 * from the shared contract; the service re-checks what it relies on (it is
 * also called by tools that never pass through these classes).
 */

/** `?flag=true` — a query string boolean (`'true'` / `true`); anything else is false. */
function queryBoolean({ value }: { value: unknown }): boolean {
    return value === true || value === 'true' || value === '1';
}

/** `GET /api/fleet/checkouts` and `GET /api/fleet/nodes/:id/checkouts`. */
export class ListFleetCheckoutsQueryDto {
    @ApiProperty({ required: false, description: 'Only this computer’s checkouts.' })
    @IsOptional()
    @IsUUID()
    nodeId?: string;

    @ApiProperty({ required: false, description: 'Only checkouts linked to this repository Work.' })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiProperty({ required: false, enum: FLEET_CHECKOUT_STATES, description: '`archived` is the bin.' })
    @IsOptional()
    @IsIn(FLEET_CHECKOUT_STATES as unknown as string[])
    state?: FleetCheckoutState;

    @ApiProperty({ required: false, enum: FLEET_CHECKOUT_KINDS })
    @IsOptional()
    @IsIn(FLEET_CHECKOUT_KINDS as unknown as string[])
    kind?: FleetCheckoutKind;

    @ApiProperty({ required: false, minimum: 1, maximum: 1000 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(1000)
    limit?: number;

    @ApiProperty({ required: false, description: 'The `nextCursor` of the previous page.' })
    @IsOptional()
    @IsUUID()
    cursor?: string;
}

/** `GET /api/fleet/nodes/:id/checkouts` extras. */
export class ListNodeCheckoutsQueryDto {
    @ApiProperty({
        required: false,
        description:
            'Scan the code folders on the computer now (needs `--manage` and the `checkouts` audience).',
    })
    @IsOptional()
    @Transform(queryBoolean)
    @IsBoolean()
    rescan?: boolean;

    @ApiProperty({ required: false, description: 'Recompute every git line now (never contacts a remote).' })
    @IsOptional()
    @Transform(queryBoolean)
    @IsBoolean()
    refresh?: boolean;

    @ApiProperty({ required: false, enum: FLEET_CHECKOUT_STATES })
    @IsOptional()
    @IsIn(FLEET_CHECKOUT_STATES as unknown as string[])
    state?: FleetCheckoutState;
}

/** Body for `POST /api/fleet/checkouts/:id/sync`. */
export class SyncFleetCheckoutDto {
    @ApiProperty({ enum: FLEET_CHECKOUT_SYNC_OPS, description: '`fetch` needs no confirmation.' })
    @IsIn(FLEET_CHECKOUT_SYNC_OPS as unknown as string[])
    op!: FleetCheckoutSyncOp;

    @ApiProperty({ required: false, description: 'CONTRACTS §2.2 class `confirm` (pull, push).' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** Body for `POST /api/fleet/checkouts/:id/archive`. */
export class ArchiveFleetCheckoutDto {
    @ApiProperty({
        required: false,
        description: 'CONTRACTS §2.2 class `confirm`: without it the answer is `confirmation_required`.',
    })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}
