import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import {
    FLEET_ACTIONS_RUNNER_MAX_LABELS,
    FLEET_ACTIONS_RUNNER_MODES,
    FLEET_ACTIONS_RUNNER_PHASES,
    FLEET_ACTIONS_RUNNER_SCOPES,
    FLEET_ACTIONS_RUNNER_STATES,
    FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
    type FleetActionConfirmFields,
    type FleetActionsRunnerMode,
    type FleetActionsRunnerPhase,
    type FleetActionsRunnerScope,
    type FleetActionsRunnerState,
} from '@ever-works/contracts';
import { FleetJobNodeCredentialDto } from '../../dto/fleet-job.dto';

/**
 * Actions runners on computers (FL-18, plan §5) — request shapes. Every
 * enumeration comes from the shared contract; the service re-checks what it
 * relies on (a tool or the CLI reaches it without these DTOs) and the node
 * re-validates names, URLs and checksums before anything runs.
 */

export class FleetActionsRunnerTargetDto {
    @ApiProperty({ enum: FLEET_ACTIONS_RUNNER_SCOPES })
    @IsIn([...FLEET_ACTIONS_RUNNER_SCOPES])
    scope: FleetActionsRunnerScope;

    @ApiProperty({ maxLength: 200, description: '`owner/repo` (scope repo) or the organisation (scope org).' })
    @IsString()
    @MaxLength(200)
    target: string;
}

export class FleetActionsRunnerInstallDto {
    @ApiProperty({ type: FleetActionsRunnerTargetDto })
    @ValidateNested()
    @Type(() => FleetActionsRunnerTargetDto)
    target: FleetActionsRunnerTargetDto;

    @ApiProperty({ minimum: 1, maximum: FLEET_ACTIONS_RUNNERS_MAX_PER_NODE, default: 1 })
    @IsInt()
    @Min(1)
    @Max(64)
    count: number;

    @ApiProperty({ required: false, type: [String], description: 'One name per runner (default `<computer>-<n>`).' })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(FLEET_ACTIONS_RUNNERS_MAX_PER_NODE)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    names?: string[];

    @ApiProperty({ required: false, type: [String], description: 'Extra labels; GitHub adds self-hosted, the OS and the architecture.' })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(FLEET_ACTIONS_RUNNER_MAX_LABELS)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    labels?: string[];

    @ApiProperty({ required: false, enum: FLEET_ACTIONS_RUNNER_MODES, default: 'service' })
    @IsOptional()
    @IsIn([...FLEET_ACTIONS_RUNNER_MODES])
    mode?: FleetActionsRunnerMode;

    @ApiProperty({ required: false, description: 'Phase 3, Docker mode only: share the host Docker daemon (runs as root).' })
    @IsOptional()
    @IsBoolean()
    shareDockerDaemon?: boolean;

    @ApiProperty({ required: false, description: 'Satisfies the `confirm` class (CONTRACTS §2.2).' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** `POST …/runners/:runnerId/:action` — the CONTRACTS §2.2 fields. */
export class FleetActionsRunnerControlDto {
    @ApiProperty({ required: false, description: 'Stop and restart are `confirm`-class: send `confirm: true`.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({ required: false, maxLength: 64, description: 'Remove is `confirm-destructive`: the runner’s exact name.' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    confirmName?: string;
}

export function runnerConfirmFields(body: { confirm?: boolean; confirmName?: string } | null | undefined): FleetActionConfirmFields {
    const fields: FleetActionConfirmFields = {};
    if (body?.confirm === true) fields.confirm = true;
    if (typeof body?.confirmName === 'string') fields.confirmName = body.confirmName;
    return fields;
}

/** The node's credential + the runner job it holds (the `push-credential` posture). */
export class FleetActionsRunnerNodeJobDto extends FleetJobNodeCredentialDto {
    @ApiProperty({ format: 'uuid', description: 'The runner-install / runner-control job this node holds.' })
    @IsUUID()
    jobId: string;

    @ApiProperty({ minimum: 1, description: 'Lease generation returned with the claim.' })
    @IsInt()
    @Min(1)
    leaseGeneration: number;
}

export class FleetActionsRunnerTokenDto extends FleetActionsRunnerNodeJobDto {
    @ApiProperty({ enum: ['register', 'remove'], description: 'Which one-time token the runner needs.' })
    @IsIn(['register', 'remove'])
    kind: 'register' | 'remove';
}

export class FleetActionsRunnerProgressDto extends FleetActionsRunnerNodeJobDto {
    @ApiProperty({ required: false, enum: FLEET_ACTIONS_RUNNER_PHASES })
    @IsOptional()
    @IsIn([...FLEET_ACTIONS_RUNNER_PHASES])
    phase?: FleetActionsRunnerPhase;

    @ApiProperty({ required: false, enum: FLEET_ACTIONS_RUNNER_STATES })
    @IsOptional()
    @IsIn([...FLEET_ACTIONS_RUNNER_STATES])
    state?: FleetActionsRunnerState;

    @ApiProperty({ required: false, nullable: true, maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    error?: string | null;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsString()
    @Matches(/^\d+\.\d+\.\d+$/)
    runnerVersion?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    serviceUnit?: string | null;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsInt()
    @Min(1)
    githubRunnerId?: number | null;
}
