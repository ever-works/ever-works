import { ApiPropertyOptional } from '@nestjs/swagger';
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
} from 'class-validator';
import type { ScheduleStatus } from '@ever-works/agent/schedules';
import { ScheduleQueryDto } from './schedules-query.dto';

const STATUSES = ['active', 'paused', 'disabled', 'error', 'ended'] as const;
const HEALTH = ['ok', 'never-runs'] as const;

/**
 * Query for `GET /api/schedules/page`. Extends the flat list's filters (so
 * `sourceType`, `entityKind` and `enabledOnly` mean exactly the same thing on
 * both endpoints) with paging and the workspace filters. Validated by the
 * global ValidationPipe with `forbidNonWhitelisted`, so an unknown parameter
 * is a 400 rather than a silently ignored typo.
 *
 * There is deliberately no parameter naming a user, Organization or tenant:
 * scope comes from the session and the active workspace only.
 */
export class SchedulePageQueryDto extends ScheduleQueryDto {
    @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    cursor?: string;

    @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 50 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    limit?: number;

    @ApiPropertyOptional({ description: 'Only Schedules this Agent would run' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiPropertyOptional({ enum: STATUSES })
    @IsOptional()
    @IsIn(STATUSES)
    status?: ScheduleStatus;

    @ApiPropertyOptional({ enum: HEALTH })
    @IsOptional()
    @IsIn(HEALTH)
    health?: (typeof HEALTH)[number];

    @ApiPropertyOptional({ description: 'Matches the Schedule name, cadence and Agent name' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    q?: string;
}

/** Body of `POST /api/schedules/:id/pause`. */
export class PauseScheduleDto {
    @ApiPropertyOptional({
        type: Boolean,
        description:
            'Required for a Mission tick: pausing it pauses the whole Mission, which stops raising new Ideas.',
    })
    @IsOptional()
    @IsBoolean()
    acknowledgeMissionPause?: boolean;
}
