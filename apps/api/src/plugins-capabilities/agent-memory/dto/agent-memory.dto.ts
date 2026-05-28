import {
    IsString,
    IsOptional,
    IsNumber,
    IsArray,
    IsUUID,
    IsObject,
    Min,
    Max,
    MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Shared optional fields that show up on most agent-memory calls:
 *
 *   - `workId` — pre-fills the facade resolution context so per-Work
 *     providers / settings are picked up; also drives the
 *     `WorkOwnershipService.ensureCanView` access check so users can't
 *     read another user's Work memory.
 *   - `projectId` — namespace inside the memory backend. When omitted,
 *     the plugin falls back to the `projectId` setting / env var /
 *     hard-coded `ever-works` default.
 */
class WorkScopedDto {
    @ApiPropertyOptional({
        description: 'Work id to scope provider resolution + ownership check against.',
        example: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({
        description: 'Memory backend project namespace (overrides plugin setting).',
        example: 'best-react-tools',
    })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    projectId?: string;
}

export class SaveMemoryDto extends WorkScopedDto {
    @ApiProperty({
        description: 'The observation text to persist.',
        example: 'Fixed the broken auth migration by adding NOT NULL constraint backfill.',
    })
    @IsString()
    @MaxLength(64_000)
    content: string;

    @ApiPropertyOptional({
        description: 'Tags applied to the memory record for filtering.',
        example: ['bug-fix', 'auth'],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @ApiPropertyOptional({
        description: 'Arbitrary structured metadata stored alongside the record.',
    })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'When supplied, link the observation to a memory session.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    sessionId?: string;
}

export class SearchMemoryDto extends WorkScopedDto {
    @ApiProperty({ description: 'Free-form search query.', example: 'auth migration fixes' })
    @IsString()
    @MaxLength(2_000)
    query: string;

    @ApiPropertyOptional({ description: 'Max results to return.', minimum: 1, maximum: 100 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(100)
    limit?: number;

    @ApiPropertyOptional({ description: 'Tag filter — only records carrying any of these tags.' })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @ApiPropertyOptional({ description: 'Restrict search to this session.' })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    sessionId?: string;
}

export class BuildContextDto extends WorkScopedDto {
    @ApiPropertyOptional({ description: 'Optional retrieval query.' })
    @IsOptional()
    @IsString()
    @MaxLength(2_000)
    query?: string;

    @ApiPropertyOptional({
        description: 'Hint that backends use to bias retrieval.',
        example: 'fix-bug',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    purpose?: string;

    @ApiPropertyOptional({ description: 'Restrict context to this session.' })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    sessionId?: string;

    @ApiPropertyOptional({ description: 'Approximate token budget for the returned context.' })
    @IsOptional()
    @IsNumber()
    @Min(100)
    @Max(64_000)
    maxTokens?: number;
}

export class OpenSessionDto extends WorkScopedDto {
    @ApiPropertyOptional({
        description: 'Seed metadata persisted on the session row.',
    })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;
}

export class ListSessionsQueryDto extends WorkScopedDto {
    @ApiPropertyOptional({ description: 'Max sessions to return.', minimum: 1, maximum: 100 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(100)
    limit?: number;
}
