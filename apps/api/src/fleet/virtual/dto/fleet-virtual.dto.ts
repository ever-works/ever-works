import { ApiProperty } from '@nestjs/swagger';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    FLEET_VIRTUAL_CPU_CHOICES,
    FLEET_VIRTUAL_DISK_GIB_CHOICES,
    FLEET_VIRTUAL_MEMORY_GIB_CHOICES,
    FLEET_VIRTUAL_NAME_PATTERN,
    FLEET_VIRTUAL_PHASES,
    FLEET_VIRTUAL_POWER_ACTIONS,
    FLEET_VIRTUAL_STATES,
    FLEET_VIRTUAL_SYSTEM_IDS,
    type FleetActionConfirmFields,
    type FleetVirtualPhase,
    type FleetVirtualPowerAction,
    type FleetVirtualState,
    type FleetVirtualSystemId,
} from '@ever-works/contracts';
import { FleetJobNodeCredentialDto } from '../../dto/fleet-job.dto';

/**
 * Virtual computers (FL-16, plan §4.4, §5) — request shapes. Every
 * enumeration comes from the shared contract; the service re-checks what it
 * relies on (a tool or the CLI reaches it without these DTOs) and the host
 * re-validates the name and the system before anything runs.
 */

export class FleetVirtualOptionsQueryDto {
    @ApiProperty({ required: false, enum: FLEET_VIRTUAL_SYSTEM_IDS, description: 'The system to judge hosts for.' })
    @IsOptional()
    @IsIn([...FLEET_VIRTUAL_SYSTEM_IDS])
    system?: FleetVirtualSystemId;
}

export class FleetVirtualCreateDto {
    @ApiProperty({ pattern: FLEET_VIRTUAL_NAME_PATTERN.source, description: '2–39 lower-case letters, digits and hyphens.' })
    @IsString()
    @MinLength(2)
    @MaxLength(39)
    @Matches(FLEET_VIRTUAL_NAME_PATTERN)
    name: string;

    @ApiProperty({ enum: FLEET_VIRTUAL_SYSTEM_IDS })
    @IsIn([...FLEET_VIRTUAL_SYSTEM_IDS])
    systemId: FleetVirtualSystemId;

    @ApiProperty({ enum: FLEET_VIRTUAL_CPU_CHOICES, default: 4 })
    @IsOptional()
    @IsIn([...FLEET_VIRTUAL_CPU_CHOICES])
    cpus?: 2 | 4 | 8;

    @ApiProperty({ enum: FLEET_VIRTUAL_MEMORY_GIB_CHOICES, default: 8 })
    @IsOptional()
    @IsIn([...FLEET_VIRTUAL_MEMORY_GIB_CHOICES])
    memoryGiB?: 4 | 8 | 16;

    @ApiProperty({ required: false, enum: FLEET_VIRTUAL_DISK_GIB_CHOICES, description: 'Windows VMs only.' })
    @IsOptional()
    @IsIn([...FLEET_VIRTUAL_DISK_GIB_CHOICES])
    diskGiB?: 64 | 128 | 256;

    @ApiProperty({ required: false, description: 'Satisfies the `confirm` class (CONTRACTS §2.2).' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

export class FleetVirtualPowerDto {
    @ApiProperty({ enum: FLEET_VIRTUAL_POWER_ACTIONS })
    @IsIn([...FLEET_VIRTUAL_POWER_ACTIONS])
    action: FleetVirtualPowerAction;

    @ApiProperty({ required: false, description: 'Stop is `confirm`-class: send `confirm: true`.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

export class FleetVirtualDestroyDto {
    @ApiProperty({ required: false, maxLength: 64, description: 'The virtual computer’s exact name (`confirm-destructive`).' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    confirmName?: string;
}

/** The host's node credential + the job it holds (the `push-credential` posture). */
export class FleetVirtualHostJobDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ format: 'uuid', description: 'The vm-create / vm-control job this host holds for the child.' })
    @IsUUID()
    jobId: string;

    @ApiProperty({ minimum: 1, description: 'Lease generation returned with the claim.' })
    @IsInt()
    @Min(1)
    leaseGeneration: number;
}

export class FleetVirtualProgressDto extends FleetVirtualHostJobDto {
    @ApiProperty({ required: false, enum: FLEET_VIRTUAL_PHASES })
    @IsOptional()
    @IsIn([...FLEET_VIRTUAL_PHASES])
    phase?: FleetVirtualPhase;

    @ApiProperty({ required: false, enum: FLEET_VIRTUAL_STATES })
    @IsOptional()
    @IsIn([...FLEET_VIRTUAL_STATES])
    state?: FleetVirtualState;

    @ApiProperty({ required: false, maxLength: 500, description: 'First line of a failure (never a secret).' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    error?: string | null;

    @ApiProperty({ required: false, description: 'The image the host built from: `{ ref, digest }` (the service bounds both).' })
    @IsOptional()
    image?: { ref: string; digest?: string | null } | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    activated?: boolean | null;
}

export function virtualConfirmFields(body: { confirm?: boolean; confirmName?: string } | null | undefined): FleetActionConfirmFields {
    const out: FleetActionConfirmFields = {};
    if (body?.confirm === true) out.confirm = true;
    if (typeof body?.confirmName === 'string') out.confirmName = body.confirmName;
    return out;
}
