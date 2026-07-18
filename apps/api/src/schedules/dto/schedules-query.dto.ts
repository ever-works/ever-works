import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import type { ScheduleOwnerType, ScheduleSourceType } from '@ever-works/agent/schedules';

const SOURCE_TYPES = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
] as const;

const OWNER_TYPES = ['task', 'agent', 'work', 'mission'] as const;

/**
 * Query filters for `GET /api/schedules`. Validated by the global
 * ValidationPipe (whitelist + transform + forbidNonWhitelisted) so a
 * typo'd `sourceType`/`entityKind` 400s instead of silently falling
 * back to the full list, and `enabledOnly` is coerced from its raw
 * query-string form.
 */
export class ScheduleQueryDto {
    @ApiPropertyOptional({
        enum: SOURCE_TYPES,
        description: 'Filter to one schedule source type',
    })
    @IsOptional()
    @IsEnum(SOURCE_TYPES)
    sourceType?: ScheduleSourceType;

    @ApiPropertyOptional({
        enum: OWNER_TYPES,
        description: 'Filter to one owning entity kind (task | agent | work | mission)',
    })
    @IsOptional()
    @IsEnum(OWNER_TYPES)
    entityKind?: ScheduleOwnerType;

    @ApiPropertyOptional({
        type: Boolean,
        description: 'When true, drop paused/disabled/ended schedules',
    })
    @IsOptional()
    // Query strings arrive as text — coerce the common 'true'/'false'
    // tokens (and pass real booleans through) so @IsBoolean can police
    // anything else with a 400.
    @Transform(({ value }) => {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    })
    @IsBoolean()
    enabledOnly?: boolean;
}
