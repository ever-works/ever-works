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
        description: 'A cadence makes a Command a Schedule; refused on this route until Schedules arrive.',
    })
    @IsOptional()
    @IsObject()
    cadence?: Record<string, unknown>;
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
