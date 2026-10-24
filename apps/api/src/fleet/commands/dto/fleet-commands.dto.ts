import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import {
    FLEET_COMMAND_CWD_MAX_LENGTH,
    FLEET_COMMAND_DEFAULT_TIMEOUT_SEC,
    FLEET_COMMAND_MAX_LENGTH,
    FLEET_COMMAND_MAX_NODES,
    FLEET_COMMAND_MAX_TIMEOUT_SEC,
    FLEET_COMMAND_RECENT,
    FLEET_SCHEDULE_HISTORY,
    FLEET_SCHEDULE_NAME_MAX_LENGTH,
} from '@ever-works/contracts';

/**
 * Commands on computers (FL-12, plan §5) — request shapes.
 *
 * The bounds a person can hit (8 KiB, 50 computers, 3 600 s) are NOT
 * enforced here: the service answers them as `limit_exceeded` naming the
 * limit (spec U5), which a class-validator 400 could not. These classes only
 * keep the body to its shape and a size no legitimate request reaches.
 */

/** Body for `POST /api/fleet/commands`. */
export class RunFleetCommandDto {
    @ApiProperty({
        description: `The command line, run in the machine owner's login shell with no input (at most ${FLEET_COMMAND_MAX_LENGTH} bytes).`,
        example: 'git -C ~/code/api status --short',
    })
    @IsString()
    @MaxLength(FLEET_COMMAND_MAX_LENGTH * 8)
    command!: string;

    @ApiProperty({
        description: `The computers to run it on (1–${FLEET_COMMAND_MAX_NODES}).`,
        type: [String],
    })
    @IsArray()
    @ArrayMaxSize(FLEET_COMMAND_MAX_NODES * 10)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    nodeIds!: string[];

    @ApiProperty({
        required: false,
        description: "The folder to run it in; default the machine owner's home (`~`).",
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_COMMAND_CWD_MAX_LENGTH * 4)
    cwd?: string;

    @ApiProperty({
        required: false,
        description: `Seconds before the command is ended (default ${FLEET_COMMAND_DEFAULT_TIMEOUT_SEC}, at most ${FLEET_COMMAND_MAX_TIMEOUT_SEC}).`,
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    timeoutSec?: number;

    @ApiProperty({
        required: false,
        description:
            'CONTRACTS §2.2 class `confirm`: without `true` the call answers 409 `confirmation_required` with one summary line per computer.',
    })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({
        required: false,
        description:
            "A cadence makes the Command a Schedule on ONE computer (FL-13): `{ kind: 'interval'|'cron'|'daily'|'weekdays', expr?, at? }`, on the computer's own clock. Needs `name`.",
    })
    @IsOptional()
    @IsObject()
    cadence?: Record<string, unknown>;

    @ApiProperty({
        required: false,
        description: `Schedules (FL-13): the schedule's name (1–${FLEET_SCHEDULE_NAME_MAX_LENGTH} characters). Required with \`cadence\`.`,
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SCHEDULE_NAME_MAX_LENGTH * 4)
    name?: string;

    @ApiProperty({
        required: false,
        description: 'Schedules (FL-13): the ONE computer, instead of a one-element `nodeIds`.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    nodeId?: string;
}

/**
 * Body for `PATCH /api/fleet/commands/:id` (FL-13) — edit a Command schedule:
 * every field but the kind. `nodeId` moves it to another computer; a move or
 * a change of what runs (command, folder) needs `confirm: true`.
 */
export class UpdateFleetScheduleDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_SCHEDULE_NAME_MAX_LENGTH * 4)
    name?: string;

    @ApiProperty({ required: false, description: 'Move it to this computer.' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    nodeId?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_COMMAND_MAX_LENGTH * 8)
    command?: string;

    @ApiProperty({ required: false, nullable: true, description: "`null` or '' = the machine owner's home." })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_COMMAND_CWD_MAX_LENGTH * 4)
    cwd?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsObject()
    cadence?: Record<string, unknown>;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** Body for `DELETE /api/fleet/commands/:id` (FL-13): CONTRACTS §2.2 class `confirm`. */
export class DeleteFleetScheduleDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** Query for `GET /api/fleet/commands/:id/runs` (a schedule's history: at most 30). */
export class ListFleetCommandRunsQueryDto {
    @ApiProperty({ required: false, minimum: 1, maximum: FLEET_SCHEDULE_HISTORY, default: FLEET_SCHEDULE_HISTORY })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(FLEET_SCHEDULE_HISTORY)
    limit?: number;
}

/** Query for `GET /api/fleet/commands`. */
export class ListFleetCommandsQueryDto {
    @ApiProperty({ required: false, minimum: 1, maximum: 50, default: FLEET_COMMAND_RECENT })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    limit?: number;
}
