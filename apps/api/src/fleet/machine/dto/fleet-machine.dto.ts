import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
    FLEET_PROCESS_SIGNALS,
    FLEET_SERVICE_MANAGERS,
    FLEET_SERVICE_SCOPES,
    type FleetActionConfirmFields,
    type FleetProcessSignal,
    type FleetServiceManager,
    type FleetServiceScope,
} from '@ever-works/contracts';

/**
 * Machine actions (FL-09, plan §5) — request shapes. Every enumeration comes
 * from the shared contract; the service and the node re-check what they rely
 * on (the node never trusts the platform did), and a service name or pid in
 * the PATH is validated by the controller against the strict contracts
 * patterns before anything runs (FR-36).
 */

/** The CONTRACTS §2.2 confirmation fields every machine act accepts — the same for every caller. */
export class FleetActionConfirmDto implements FleetActionConfirmFields {
    @ApiProperty({ required: false, description: 'Satisfies the `confirm` class.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({
        required: false,
        description: 'Satisfies `confirm-destructive`: the target name, typed exactly.',
        maxLength: 256,
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    confirmName?: string;

    @ApiProperty({
        required: false,
        description: 'Satisfies the warning half of `blast-radius`: the caller read the computer’s sentence.',
    })
    @IsOptional()
    @IsBoolean()
    acknowledgeBlastRadius?: boolean;
}

export class ListFleetServicesQueryDto {
    @ApiProperty({ required: false, enum: [...FLEET_SERVICE_SCOPES, 'all'] })
    @IsOptional()
    @IsIn([...FLEET_SERVICE_SCOPES, 'all'])
    scope?: FleetServiceScope | 'all';

    @ApiProperty({ required: false, maxLength: 200, description: 'Filter by name or description.' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    find?: string;
}

export class FleetServiceActionDto extends FleetActionConfirmDto {
    @ApiProperty({ required: false, enum: FLEET_SERVICE_SCOPES, default: 'system' })
    @IsOptional()
    @IsIn([...FLEET_SERVICE_SCOPES])
    scope?: FleetServiceScope;

    @ApiProperty({
        required: false,
        enum: FLEET_SERVICE_MANAGERS,
        description: 'Which manager holds it (macOS: `launchd` or `brew`); the computer’s own by default.',
    })
    @IsOptional()
    @IsIn([...FLEET_SERVICE_MANAGERS])
    manager?: FleetServiceManager;
}

export class ListFleetProcessesQueryDto {
    @ApiProperty({ required: false, enum: ['cpu', 'mem'], default: 'cpu' })
    @IsOptional()
    @IsIn(['cpu', 'mem'])
    sort?: 'cpu' | 'mem';

    @ApiProperty({ required: false, maxLength: 200, description: 'Filter by name, command, owner or pid.' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    find?: string;
}

export class FleetProcessSignalDto extends FleetActionConfirmDto {
    @ApiProperty({ enum: FLEET_PROCESS_SIGNALS, description: '`TERM` (Stop) or `KILL` (Kill).' })
    @IsIn([...FLEET_PROCESS_SIGNALS])
    signal!: FleetProcessSignal;
}

/** The confirmation fields of a body, as the service reads them (only the three CONTRACTS fields). */
export function confirmFieldsOf(body: FleetActionConfirmDto | null | undefined): FleetActionConfirmFields {
    const out: FleetActionConfirmFields = {};
    if (body?.confirm === true) out.confirm = true;
    if (typeof body?.confirmName === 'string') out.confirmName = body.confirmName;
    if (body?.acknowledgeBlastRadius === true) out.acknowledgeBlastRadius = true;
    return out;
}
