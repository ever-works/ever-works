import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import {
    FLEET_CHECKOUT_CREDENTIAL_ACCESS,
    FLEET_CHECKOUT_DELETE_MODES,
    FLEET_CHECKOUT_ISOLATIONS,
    FLEET_CHECKOUT_KINDS,
    FLEET_CHECKOUT_PATH_MAX_LENGTH,
    FLEET_CHECKOUT_REF_MAX_LENGTH,
    FLEET_CHECKOUT_REMOTE_MAX_LENGTH,
    FLEET_CHECKOUT_STATES,
    FLEET_CHECKOUT_SYNC_OPS,
    type FleetCheckoutCredentialAccess,
    type FleetCheckoutDeleteMode,
    type FleetCheckoutIsolation,
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

/** The source of a new checkout: a fresh clone (`repoUrl`) or a worktree (`parentCheckoutId`). */
export class FleetCheckoutCreateSourceDto {
    @ApiProperty({ enum: ['clone', 'worktree'] })
    @IsIn(['clone', 'worktree'])
    kind!: 'clone' | 'worktree';

    @ApiProperty({ required: false, description: 'clone: the repository URL — token-free.' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_CHECKOUT_REMOTE_MAX_LENGTH)
    repoUrl?: string;

    @ApiProperty({ required: false, description: 'worktree: the checkout on the same computer to branch off.' })
    @IsOptional()
    @IsUUID()
    parentCheckoutId?: string;
}

/** Body for `POST /api/fleet/checkouts`. */
export class CreateFleetCheckoutDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId!: string;

    @ApiProperty({ type: FleetCheckoutCreateSourceDto })
    @ValidateNested()
    @Type(() => FleetCheckoutCreateSourceDto)
    source!: FleetCheckoutCreateSourceDto;

    @ApiProperty({ required: false, description: 'Proposed (and made unique) when absent.' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_CHECKOUT_REF_MAX_LENGTH)
    branch?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_CHECKOUT_REF_MAX_LENGTH)
    baseRef?: string;

    @ApiProperty({ required: false, enum: FLEET_CHECKOUT_ISOLATIONS })
    @IsOptional()
    @IsIn(FLEET_CHECKOUT_ISOLATIONS as unknown as string[])
    isolation?: FleetCheckoutIsolation;
}

/** What the person saw in the delete preview (optional: the node re-checks against it). */
export class FleetCheckoutExpectedDto {
    @IsInt()
    @Min(0)
    uncommitted!: number;

    @IsInt()
    @Min(0)
    unpushedCommits!: number;
}

/** Body for `DELETE /api/fleet/checkouts/:id` (CONTRACTS §2.2). */
export class DeleteFleetCheckoutDto {
    @ApiProperty({ required: false, enum: FLEET_CHECKOUT_DELETE_MODES })
    @IsOptional()
    @IsIn(FLEET_CHECKOUT_DELETE_MODES as unknown as string[])
    mode?: FleetCheckoutDeleteMode;

    @ApiProperty({ required: false, description: 'Class `confirm` (nothing would be lost).' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({ required: false, description: 'Class `confirm-destructive`: the checkout’s folder name.' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_CHECKOUT_PATH_MAX_LENGTH)
    confirmName?: string;

    @ApiProperty({ required: false, type: FleetCheckoutExpectedDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => FleetCheckoutExpectedDto)
    expected?: FleetCheckoutExpectedDto;
}

/** `DELETE /api/fleet/checkouts/:id?cleanUp=1` — FL-06's Clean up gate. */
export class DeleteFleetCheckoutQueryDto {
    @ApiProperty({ required: false, description: 'FL-06 Clean up: worktree, pull request merged or closed, no session.' })
    @IsOptional()
    @Transform(queryBoolean)
    @IsBoolean()
    cleanUp?: boolean;
}

/** Body for the node-authenticated `POST /api/fleet/checkouts/:id/credential`. */
export class FleetCheckoutCredentialDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId!: string;

    @ApiProperty({ minLength: 16, maxLength: 256 })
    @IsString()
    @MinLength(16)
    @MaxLength(256)
    secret!: string;

    @ApiProperty({ enum: FLEET_CHECKOUT_CREDENTIAL_ACCESS })
    @IsIn(FLEET_CHECKOUT_CREDENTIAL_ACCESS as unknown as string[])
    access!: FleetCheckoutCredentialAccess;
}
