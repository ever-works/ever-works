import { ApiProperty } from '@nestjs/swagger';
import {
    IsBoolean,
    IsDateString,
    IsIn,
    IsInt,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { GoalComparator, GoalOutcome, GoalWindow } from '@ever-works/agent/goals';

const GOAL_COMPARATORS: GoalComparator[] = ['gte', 'lte'];
const GOAL_WINDOWS: GoalWindow[] = ['day', 'week', 'month', 'total', 'point'];
const GOAL_OUTCOMES: GoalOutcome[] = ['achieved', 'missed', 'abandoned'] as GoalOutcome[];

/**
 * Goals & Metrics — PR-8. Which metrics-provider plugin + metric a
 * Goal reads. `pluginId` is explicit by design (spec FR-3): multiple
 * metrics providers can be enabled at once, so a Goal always names
 * its provider rather than relying on a scope default.
 */
export class GoalMetricSourceDto {
    @ApiProperty({ description: "Metrics-provider plugin id (e.g. 'stripe', 'custom-http')." })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    pluginId: string;

    @ApiProperty({ description: "Provider-scoped metric id (e.g. 'income', 'balance')." })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    metricId: string;

    @ApiProperty({
        required: false,
        description: "Extra per-query parameters validated by the provider's paramsSchema.",
    })
    @IsOptional()
    @IsObject()
    params?: Record<string, unknown>;
}

/**
 * Request body for `POST /api/me/goals`. Semantic rules
 * (comparator/window membership, metricSource shape, the ≥15-minute
 * frequency clamp — spec FR-12) are re-validated in
 * `GoalsService.create`, the single source of truth PATCH reuses.
 */
export class CreateGoalDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 10000 })
    @IsOptional()
    @IsString()
    @MaxLength(10000)
    description?: string | null;

    @ApiProperty({ type: GoalMetricSourceDto })
    @ValidateNested()
    @Type(() => GoalMetricSourceDto)
    metricSource: GoalMetricSourceDto;

    @ApiProperty({ enum: GOAL_COMPARATORS, description: 'gte = grow-to-target, lte = shrink.' })
    @IsIn(GOAL_COMPARATORS)
    comparator: GoalComparator;

    @ApiProperty()
    @IsNumber()
    targetValue: number;

    @ApiProperty({ maxLength: 32, description: "Unit of targetValue (e.g. 'usd', 'count')." })
    @IsString()
    @MinLength(1)
    @MaxLength(32)
    unit: string;

    @ApiProperty({ enum: GOAL_WINDOWS })
    @IsIn(GOAL_WINDOWS)
    window: GoalWindow;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsNumber()
    baselineValue?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'ISO-8601 deadline. Passing unmet → auto-outcome MISSED (spec FR-13).',
    })
    @IsOptional()
    @IsDateString()
    deadline?: string | null;

    @ApiProperty({
        required: false,
        default: 60,
        description: 'Evaluation cadence in minutes; clamped to >= 15 (spec FR-12).',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    checkFrequencyMinutes?: number;
}

/**
 * Request body for `PATCH /api/me/goals/:id`. All fields optional;
 * `null` clears nullable fields. `status` is NOT writable here (use
 * activate/pause) — but `outcome` IS: spec FR-13 makes auto-set
 * outcomes human-overridable, including `abandoned` and clearing
 * with `null`.
 */
export class UpdateGoalDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 10000 })
    @IsOptional()
    @IsString()
    @MaxLength(10000)
    description?: string | null;

    @ApiProperty({ required: false, type: GoalMetricSourceDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => GoalMetricSourceDto)
    metricSource?: GoalMetricSourceDto;

    @ApiProperty({ required: false, enum: GOAL_COMPARATORS })
    @IsOptional()
    @IsIn(GOAL_COMPARATORS)
    comparator?: GoalComparator;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    targetValue?: number;

    @ApiProperty({ required: false, maxLength: 32 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(32)
    unit?: string;

    @ApiProperty({ required: false, enum: GOAL_WINDOWS })
    @IsOptional()
    @IsIn(GOAL_WINDOWS)
    window?: GoalWindow;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsNumber()
    baselineValue?: number | null;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsDateString()
    deadline?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsInt()
    @Min(1)
    checkFrequencyMinutes?: number;

    @ApiProperty({
        required: false,
        nullable: true,
        enum: GOAL_OUTCOMES,
        description:
            'Human outcome override (spec FR-13). Non-null completes the Goal; null clears an auto-set outcome.',
    })
    @IsOptional()
    @IsIn(GOAL_OUTCOMES)
    outcome?: GoalOutcome | null;
}

/**
 * Request body for `POST /api/me/missions/:id/goals` — attach a Goal
 * (owned by the same user) to a Mission. Re-POSTing an existing link
 * just updates `isPrimary` (idempotent). At most one primary Goal
 * per Mission (spec FR-11) — service demotes any other primary.
 */
export class LinkMissionGoalDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    goalId: string;

    @ApiProperty({ required: false, default: false })
    @IsOptional()
    @IsBoolean()
    isPrimary?: boolean;
}
