import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ACTION_CATEGORIES,
    AUTONOMY_GRANT_SCOPE_PRECEDENCE,
    LADDERED_CATEGORIES,
    RAIL_REFUSAL_PAGE_SIZE,
    SAFETY_RAIL_ORDER,
    TRUST_RUNG_ORDER,
    type ActionCategory,
    type AutonomyGrantScopeType,
    type LadderedActionCategory,
    type SafetyRailId,
    type TrustRung,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — the request shapes.
 *
 * Every enum is validated against the CONTRACT's own published list rather
 * than a copy: a category, a rung or a rail id that this build does not know
 * is refused at the edge, and the lists cannot drift from the ones the screen
 * and the enforcement point read.
 */

/** Which ladder to read: the workspace's, or one Agent's view of it. */
export class LadderQueryDto {
    @ApiPropertyOptional({
        description:
            "Resolve the ladder as it applies to this Agent, including any narrowing on the Agent itself. Omit for the workspace's own ladder.",
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;
}

/** `PUT /api/safety/ladder` — set one rung. */
export class PutLadderDto {
    @ApiProperty({
        description:
            'Which scope this rung applies to. `workspace` sets it for everyone; `agent` may only ever narrow below the workspace.',
        enum: AUTONOMY_GRANT_SCOPE_PRECEDENCE as readonly string[],
    })
    @IsIn(AUTONOMY_GRANT_SCOPE_PRECEDENCE as readonly string[])
    scopeType: AutonomyGrantScopeType;

    @ApiProperty({
        description:
            'The Organization id for a `workspace` rung, or the Agent id for an `agent` rung.',
    })
    @IsUUID()
    scopeId: string;

    @ApiProperty({
        description: 'One of the twelve laddered kinds of work.',
        enum: LADDERED_CATEGORIES as readonly string[],
    })
    @IsIn(LADDERED_CATEGORIES as readonly string[])
    category: LadderedActionCategory;

    @ApiProperty({
        description:
            'The rung to move to. Promotion moves exactly one rung at a time and may never pass the category ceiling; demotion is unrestricted.',
        enum: TRUST_RUNG_ORDER as readonly string[],
    })
    @IsIn(TRUST_RUNG_ORDER as readonly string[])
    rung: TrustRung;

    @ApiPropertyOptional({ description: 'Optional note — why. Never a secret.' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    note?: string;
}

/** `GET /api/safety/refusals` — filter the log. */
export class ListRefusalsQueryDto {
    @ApiPropertyOptional({
        description: 'Only refusals from this rail.',
        enum: [...SAFETY_RAIL_ORDER, 'taxonomy'] as readonly string[],
    })
    @IsOptional()
    @IsIn([...SAFETY_RAIL_ORDER, 'taxonomy'] as readonly string[])
    railId?: SafetyRailId;

    @ApiPropertyOptional({
        description: 'Only refusals in this kind of work.',
        enum: ACTION_CATEGORIES as readonly string[],
    })
    @IsOptional()
    @IsIn(ACTION_CATEGORIES as readonly string[])
    category?: ActionCategory;

    @ApiPropertyOptional({ description: 'Only refusals involving this Agent.' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiPropertyOptional({ description: 'Start of the window (ISO-8601).' })
    @IsOptional()
    @IsISO8601()
    from?: string;

    @ApiPropertyOptional({ description: 'End of the window (ISO-8601).' })
    @IsOptional()
    @IsISO8601()
    to?: string;

    @ApiPropertyOptional({
        description: `Continue from a previous page — the ISO timestamp returned as nextCursor. Pages are ${RAIL_REFUSAL_PAGE_SIZE} rows.`,
    })
    @IsOptional()
    @IsISO8601()
    cursor?: string;
}

/** `GET /api/safety/refusals/:collapseKey` — expand one collapsed day. */
export class ExpandRefusalGroupQueryDto {
    @ApiPropertyOptional({ description: 'Continue from a previous page.' })
    @IsOptional()
    @IsISO8601()
    cursor?: string;
}
