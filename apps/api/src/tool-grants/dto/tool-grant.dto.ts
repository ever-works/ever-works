import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TOOL_GRANT_PATTERN, type ToolGrantScope } from '@ever-works/contracts';

/** Upper bound on patterns per field — a grant list is a policy, not a database. */
const MAX_PATTERNS = 200;

/**
 * Query for `GET /api/tool-grants/resolve` (audit item G4).
 *
 * At least one of `workId` / `agentId` / `organizationId` must be present
 * — the controller enforces that. A bare call would only echo the
 * permissive platform default and tell the caller nothing about their
 * setup.
 */
export class ResolveToolGrantsQueryDto {
    @ApiPropertyOptional({
        description: 'Resolve the grants as they apply to this Work. Must be owned/accessible.',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({
        description:
            'Resolve the grants as they apply to this Agent (most specific scope; its Work, organization and tenant are discovered from the row). Must be owned.',
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiPropertyOptional({
        description:
            'Resolve the grants as they apply to this Organization (tenant + organization layers only). Must belong to the caller’s Tenant.',
    })
    @IsOptional()
    @IsUUID()
    organizationId?: string;
}

/** Query for `GET /api/tool-grants/check` — same scope, plus the tool. */
export class CheckToolGrantQueryDto extends ResolveToolGrantsQueryDto {
    @ApiProperty({ description: 'The exact tool name to test, e.g. "commitToRepo".' })
    @IsString()
    @MaxLength(120)
    toolName: string;
}

/**
 * Body for `PUT /api/tool-grants` — create-or-update ONE scope's grant.
 *
 * `allow` and `deny` are both optional and independently meaningful:
 *  - omitted `allow` → inherit whatever the ancestors grant;
 *  - `allow: []`     → this scope grants NOTHING (the strongest narrowing);
 *  - `deny`          → always additive and permanent down the chain.
 *
 * Patterns are validated against `TOOL_GRANT_PATTERN` here AND sanitized
 * again in the service — the wire is not a trust boundary you get to
 * check once.
 */
export class UpsertToolGrantDto {
    @ApiProperty({
        enum: ['tenant', 'organization', 'work', 'agent'],
        description: 'Which scope this grant configures.',
    })
    @IsIn(['tenant', 'organization', 'work', 'agent'])
    scopeType: ToolGrantScope;

    @ApiProperty({ description: 'Id of the scope entity. Must be owned/accessible by the caller.' })
    @IsUUID()
    scopeId: string;

    @ApiPropertyOptional({
        type: [String],
        description:
            'Allow patterns: "*", "prefix*" or an exact tool name. Intersected with the ancestors — a pattern they never granted is rejected at resolve time, never widened in.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_PATTERNS)
    @IsString({ each: true })
    @Matches(TOOL_GRANT_PATTERN, { each: true })
    allow?: string[];

    @ApiPropertyOptional({
        type: [String],
        description: 'Deny patterns. Additive and permanent for every scope beneath this one.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_PATTERNS)
    @IsString({ each: true })
    @Matches(TOOL_GRANT_PATTERN, { each: true })
    deny?: string[];

    @ApiPropertyOptional({ description: 'Operator note — why this grant exists. Never a secret.' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    note?: string;
}
