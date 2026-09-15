import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsArray,
    IsBooleanString,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Min,
} from 'class-validator';
import {
    FEED_KINDS,
    FEED_MAX_AGENT_FILTER,
    FEED_PAGE_SIZE_DEFAULT,
    FEED_PAGE_SIZE_MAX,
    type FeedKind,
} from '@ever-works/contracts';

/**
 * `?agentIds=a,b` and `?agentIds=a&agentIds=b` both arrive as a list. Empty
 * segments are dropped so a trailing comma is not a validation error.
 */
function toList({ value }: { value: unknown }): unknown {
    if (value === undefined || value === null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((part) =>
        typeof part === 'string' ? part.split(',') : [part],
    );
    return parts
        .map((part) => (typeof part === 'string' ? part.trim() : part))
        .filter((part) => part !== '');
}

/**
 * `GET /api/feed` query. There is deliberately no user or organization
 * parameter: the owner comes from the session and the scope from the request
 * scope context, never from the query string.
 */
export class FeedQueryDto {
    @ApiPropertyOptional({
        description: `Comma-separated agent ids to watch (at most ${FEED_MAX_AGENT_FILTER}; more is refused with \`too-many-agents\`).`,
        type: String,
    })
    @IsOptional()
    @Transform(toList)
    @IsArray()
    @IsUUID('all', { each: true })
    agentIds?: string[];

    @ApiPropertyOptional({
        description: 'Comma-separated feed kinds to show.',
        enum: FEED_KINDS,
        isArray: true,
    })
    @IsOptional()
    @Transform(toList)
    @IsArray()
    @IsIn(FEED_KINDS as FeedKind[], { each: true })
    kinds?: FeedKind[];

    @ApiPropertyOptional({
        description: 'Only what failed — the problem kind. Overrides `kinds`.',
        enum: ['true', 'false'],
    })
    @IsOptional()
    @IsBooleanString()
    failedOnly?: string;

    @ApiPropertyOptional({
        description:
            'Opaque cursor from a previous page. A cursor that does not decode is refused with `invalid-cursor`.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(1024)
    cursor?: string;

    @ApiPropertyOptional({
        description: `Page size (default ${FEED_PAGE_SIZE_DEFAULT}; values above ${FEED_PAGE_SIZE_MAX} are clamped).`,
        default: FEED_PAGE_SIZE_DEFAULT,
        minimum: 1,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number;
}
