import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { FLEET_USAGE_MAX_MODEL_CHARS, FLEET_USAGE_PERIODS, FLEET_USAGE_TASK_COSTS_MAX_IDS } from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20, plan §5) — `GET /api/fleet/usage`.
 *
 * `days` is only shape-checked here: a number outside {1, 7, 30, 90} is the
 * service's `invalid` refusal with its hint (the CONTRACTS §8 envelope), not
 * the validation pipe's generic 400.
 */
export class FleetUsageQueryDto {
    @ApiProperty({ required: false, enum: FLEET_USAGE_PERIODS, description: 'The period in days (default 7).' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    days?: number;

    @ApiProperty({ required: false, description: 'Scope the view to one computer (Fleet node id).' })
    @IsOptional()
    @IsUUID()
    node?: string;

    @ApiProperty({ required: false, description: 'Only this model id.' })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_USAGE_MAX_MODEL_CHARS)
    model?: string;

    @ApiProperty({ required: false, description: "Only this Agent's work (its sessions and Task runs)." })
    @IsOptional()
    @IsUUID()
    agent?: string;
}

/** `GET /api/fleet/usage/tasks?ids=a,b` — recurring Tasks whose Runs' cost the schedule rows show. */
export class FleetUsageTaskCostsQueryDto {
    @ApiProperty({ description: `Comma-separated Task ids (at most ${FLEET_USAGE_TASK_COSTS_MAX_IDS}).` })
    @IsString()
    @MaxLength(FLEET_USAGE_TASK_COSTS_MAX_IDS * 37)
    ids!: string;
}

/** `POST /api/fleet/usage/rescan`. */
export class FleetUsageRescanDto {
    @ApiProperty({ description: 'The computer to scan now (Fleet node id). Owner only.' })
    @IsUUID()
    nodeId!: string;
}
