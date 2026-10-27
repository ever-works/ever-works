import { ApiProperty } from '@nestjs/swagger';
import {
    IsBoolean,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
} from 'class-validator';
import {
    FLEET_AGENT_SESSION_PROVIDERS,
    FLEET_COMMAND_CWD_MAX_LENGTH,
    FLEET_COMMAND_MAX_LENGTH,
    FLEET_SCHEDULE_NAME_MAX_LENGTH,
    FLEET_SCHEDULE_PROMPT_MAX_BYTES,
} from '@ever-works/contracts';

/**
 * Schedules on computers (FL-13) — request shapes of `/api/fleet/schedules`
 * and `/api/fleet/nodes/:id/schedules/*`. Like FL-12's, these only keep a body
 * to its shape and a size no legitimate request reaches: the bounds a person
 * can hit (120 characters, 8 KiB, 16 KiB, 50 per computer) are answered by the
 * service as `limit_exceeded` naming the limit.
 */

/** `POST /api/fleet/schedules`. */
export class CreateFleetScheduleDto {
    @ApiProperty({
        description: `The schedule's name (1–${FLEET_SCHEDULE_NAME_MAX_LENGTH} characters).`,
    })
    @IsString()
    @MaxLength(FLEET_SCHEDULE_NAME_MAX_LENGTH * 4)
    name!: string;

    @ApiProperty({ description: 'The ONE computer it runs on.' })
    @IsString()
    @MaxLength(64)
    nodeId!: string;

    @ApiProperty({
        description: "The command line, run in the machine owner's login shell with no input.",
    })
    @IsString()
    @MaxLength(FLEET_COMMAND_MAX_LENGTH * 8)
    command!: string;

    @ApiProperty({ required: false, description: "Folder; default the machine owner's home." })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_COMMAND_CWD_MAX_LENGTH * 4)
    cwd?: string;

    @ApiProperty({
        description:
            "`{ kind: 'interval'|'daily'|'weekdays'|'cron', expr?, at? }` on the computer's own clock.",
    })
    @IsObject()
    cadence!: Record<string, unknown>;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** A `{ confirm }` body (Run now, Pause all). */
export class ConfirmFleetScheduleDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** `GET /api/fleet/schedules`. */
export class ListFleetSchedulesQueryDto {
    @ApiProperty({ required: false, description: 'Only the schedules on this computer.' })
    @IsOptional()
    @IsUUID()
    nodeId?: string;
}

/** `POST /api/fleet/nodes/:id/schedules/agent-session` (FL-13 P2, CONTRACTS §11.2). */
export class CreateAgentSessionScheduleDto {
    @ApiProperty()
    @IsString()
    @MaxLength(FLEET_SCHEDULE_NAME_MAX_LENGTH * 4)
    name!: string;

    @ApiProperty({ description: 'The Agent — it must be pinned to this computer.' })
    @IsString()
    @MaxLength(64)
    agentId!: string;

    @ApiProperty({ description: 'What the Agent is asked to do on every fire (at most 16 KiB).' })
    @IsString()
    @MaxLength(FLEET_SCHEDULE_PROMPT_MAX_BYTES * 2)
    prompt!: string;

    @ApiProperty({
        enum: FLEET_AGENT_SESSION_PROVIDERS,
        description: 'The agent CLI the session drives.',
    })
    @IsIn(FLEET_AGENT_SESSION_PROVIDERS as unknown as string[])
    provider!: string;

    @ApiProperty({
        required: false,
        description: 'The checkout on this computer the session works in.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    checkoutId?: string;

    @ApiProperty()
    @IsObject()
    cadence!: Record<string, unknown>;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

/** `POST /api/fleet/nodes/:id/schedules/resume-all` — the breaker's Undo (15 minutes). */
export class UndoPauseAllSchedulesDto {
    @ApiProperty({ description: 'The `breakerAt` the Pause all answered.' })
    @IsString()
    @MaxLength(40)
    breakerAt!: string;
}
