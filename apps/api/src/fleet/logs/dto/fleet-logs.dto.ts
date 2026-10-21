import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    FLEET_LOG_SOURCE_ID_MAX_LENGTH,
    FLEET_LOGS_FILTER_MAX_LENGTH,
    FLEET_LOGS_INITIAL_LINES,
    FLEET_LOGS_MAX_MERGED_SOURCES,
} from '@ever-works/contracts';

/**
 * Logs on computers (FL-08, plan §5) — request shapes. Bounds come from the
 * shared contract; the service re-checks the source id's SHAPE
 * (`parseFleetLogSourceId`) and the machine re-checks everything else (roots,
 * platform, names) — this only keeps the body to the shape.
 */

/** Body for `POST /api/fleet/nodes/:id/logs/attach-token`. */
export class FleetLogsAttachDto {
    @ApiProperty({
        description:
            'The source id from the sources list (`system:journal`, `file:/var/log/syslog`, `container:acme-api`, `service:nginx.service`).',
        maxLength: FLEET_LOG_SOURCE_ID_MAX_LENGTH,
    })
    @IsString()
    @MinLength(3)
    @MaxLength(FLEET_LOG_SOURCE_ID_MAX_LENGTH)
    source!: string;

    @ApiProperty({
        required: false,
        type: [String],
        description: `More sources merged by time into one view (at most ${FLEET_LOGS_MAX_MERGED_SOURCES} with \`source\`).`,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(FLEET_LOGS_MAX_MERGED_SOURCES - 1)
    @IsString({ each: true })
    @MaxLength(FLEET_LOG_SOURCE_ID_MAX_LENGTH, { each: true })
    sources?: string[];

    @ApiProperty({ required: false, minimum: 1, maximum: FLEET_LOGS_INITIAL_LINES, default: FLEET_LOGS_INITIAL_LINES })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(FLEET_LOGS_INITIAL_LINES)
    lines?: number;

    @ApiProperty({ required: false, default: true, description: 'Follow the source live after the first lines.' })
    @IsOptional()
    @IsBoolean()
    follow?: boolean;
}

/** Body for `POST /api/fleet/nodes/:id/logs/read` — one batch, never a follow. */
export class FleetLogsReadDto {
    @ApiProperty({ description: 'The source id from the sources list.', maxLength: FLEET_LOG_SOURCE_ID_MAX_LENGTH })
    @IsString()
    @MinLength(3)
    @MaxLength(FLEET_LOG_SOURCE_ID_MAX_LENGTH)
    source!: string;

    @ApiProperty({ required: false, minimum: 1, maximum: FLEET_LOGS_INITIAL_LINES, default: FLEET_LOGS_INITIAL_LINES })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(FLEET_LOGS_INITIAL_LINES)
    lines?: number;

    @ApiProperty({
        required: false,
        maxLength: FLEET_LOGS_FILTER_MAX_LENGTH,
        description: 'Keep only the lines containing this text (case-insensitive).',
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_LOGS_FILTER_MAX_LENGTH)
    filter?: string;
}
