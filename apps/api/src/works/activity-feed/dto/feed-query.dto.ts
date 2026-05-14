import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { FEED_CATEGORIES, type FeedCategory } from './feed-entry.dto';

export class FeedQueryDto {
    @ApiPropertyOptional({
        description:
            'Cursor returned from a previous response. When present, results returned are older than this cursor.',
    })
    @IsOptional()
    @IsString()
    cursor?: string;

    @ApiPropertyOptional({
        description: 'Maximum number of entries to return (1-200).',
        default: 50,
        minimum: 1,
        maximum: 200,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiPropertyOptional({
        description: 'Filter chip selected in the UI. "all" disables filtering.',
        enum: FEED_CATEGORIES,
        default: 'all',
    })
    @IsOptional()
    @IsEnum(FEED_CATEGORIES as unknown as Record<string, FeedCategory>)
    category?: FeedCategory;
}
