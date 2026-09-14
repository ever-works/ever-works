import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
    FEED_ACTORS_WINDOW_HOURS_DEFAULT,
    FEED_ACTORS_WINDOW_HOURS_MAX,
} from '@ever-works/contracts';

/** `GET /api/feed/actors` query. */
export class FeedActorsQueryDto {
    @ApiPropertyOptional({
        description: 'Look-back window for the per-agent counts, in hours.',
        default: FEED_ACTORS_WINDOW_HOURS_DEFAULT,
        minimum: 1,
        maximum: FEED_ACTORS_WINDOW_HOURS_MAX,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(FEED_ACTORS_WINDOW_HOURS_MAX)
    windowHours?: number;
}
