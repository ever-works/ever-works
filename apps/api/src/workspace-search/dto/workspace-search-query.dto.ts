import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import {
    WORKSPACE_SEARCH_DEFAULT_PER_KIND,
    WORKSPACE_SEARCH_KINDS,
    WORKSPACE_SEARCH_MAX_PER_KIND,
    WORKSPACE_SEARCH_MAX_QUERY_LENGTH,
    WORKSPACE_SEARCH_MAX_RECENT,
    WORKSPACE_SEARCH_MAX_TOTAL,
    type WorkspaceSearchKind,
} from '@ever-works/contracts/api';

/** Query strings arrive as a single value or a repeated one — always hand back a string array. */
function toStringArray(value: unknown): string[] {
    const values = Array.isArray(value)
        ? value
        : value === undefined || value === null
          ? []
          : [value];
    return values
        .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/** Parse an integer and clamp it into range; anything unparseable becomes the default. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const KNOWN_KINDS = new Set<string>(WORKSPACE_SEARCH_KINDS);
const RECENT_KEY = new RegExp(`^(${WORKSPACE_SEARCH_KINDS.join('|')}):[A-Za-z0-9_-]{1,64}$`);

/**
 * Query for `GET /api/workspace-search`.
 *
 * Every field is forgiving by design: the palette issues this request on
 * every settled keystroke, so an over-long query is truncated, an unknown
 * kind is dropped, and an out-of-range limit is clamped — none of them is a
 * 400. Undeclared parameters are still rejected by the global pipe.
 */
export class WorkspaceSearchQueryDto {
    @ApiPropertyOptional({
        description: `Search text. Queries shorter than 2 characters return no groups; longer than ${WORKSPACE_SEARCH_MAX_QUERY_LENGTH} are truncated.`,
    })
    @IsOptional()
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim().slice(0, WORKSPACE_SEARCH_MAX_QUERY_LENGTH) : '',
    )
    @IsString()
    q?: string;

    @ApiPropertyOptional({
        description:
            'Restrict to these kinds (repeated or comma-separated). Unknown kinds are ignored.',
        enum: WORKSPACE_SEARCH_KINDS,
        isArray: true,
    })
    @IsOptional()
    @Transform(({ value }) =>
        toStringArray(value).filter((kind): kind is WorkspaceSearchKind => KNOWN_KINDS.has(kind)),
    )
    @IsArray()
    kinds?: WorkspaceSearchKind[];

    @ApiPropertyOptional({
        description: `Total rows across all groups (1–${WORKSPACE_SEARCH_MAX_TOTAL}).`,
        default: WORKSPACE_SEARCH_MAX_TOTAL,
    })
    @IsOptional()
    @Transform(({ value }) =>
        clampInt(value, WORKSPACE_SEARCH_MAX_TOTAL, 1, WORKSPACE_SEARCH_MAX_TOTAL),
    )
    @IsInt()
    limit?: number;

    @ApiPropertyOptional({
        description: `Rows per group (1–${WORKSPACE_SEARCH_MAX_PER_KIND}).`,
        default: WORKSPACE_SEARCH_DEFAULT_PER_KIND,
    })
    @IsOptional()
    @Transform(({ value }) =>
        clampInt(value, WORKSPACE_SEARCH_DEFAULT_PER_KIND, 1, WORKSPACE_SEARCH_MAX_PER_KIND),
    )
    @IsInt()
    perKindLimit?: number;

    @ApiPropertyOptional({
        description: `Up to ${WORKSPACE_SEARCH_MAX_RECENT} "<kind>:<id>" keys the caller opened recently; used only to boost ranking. Malformed keys are ignored.`,
        isArray: true,
    })
    @IsOptional()
    @Transform(({ value }) =>
        toStringArray(value)
            .filter((key) => RECENT_KEY.test(key))
            .slice(0, WORKSPACE_SEARCH_MAX_RECENT),
    )
    @IsArray()
    recent?: string[];
}
