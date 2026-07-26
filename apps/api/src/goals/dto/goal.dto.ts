import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsDateString,
    IsIn,
    IsInt,
    IsNumber,
    IsObject,
    IsOptional,
    IsPositive,
    IsString,
    IsUUID,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    GOAL_CONSTRAINT_CATEGORIES,
    MAX_GOAL_CONSTRAINTS,
    MAX_GOAL_CRITERIA,
    type GoalComparator,
    type GoalConstraintCategory,
    type GoalOutcome,
    type GoalWindow,
} from '@ever-works/agent/goals';

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
 * Judgment layer G1 — one WEIGHTED success criterion.
 *
 * `metricSource`/`window`/`unit` are all optional and inherit from the
 * Goal, so the common "same metric, several thresholds" Goal needs one
 * line per criterion. `GoalsService.create/update` re-validates the
 * semantic rules (unique ids, positive weight, finite target) as the
 * single source of truth — this class is the edge shape.
 */
export class GoalCriterionDto {
    @ApiProperty({ maxLength: 64, description: 'Stable slug, unique within the Goal.' })
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    id: string;

    @ApiProperty({ maxLength: 200 })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name: string;

    @ApiProperty({
        required: false,
        type: GoalMetricSourceDto,
        description: "Metric override; omitted inherits the Goal's own metricSource.",
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => GoalMetricSourceDto)
    metricSource?: GoalMetricSourceDto;

    @ApiProperty({ required: false, enum: GOAL_WINDOWS })
    @IsOptional()
    @IsIn(GOAL_WINDOWS)
    window?: GoalWindow;

    @ApiProperty({ description: 'Relative weight (> 0); normalized across criteria.' })
    @IsNumber()
    @IsPositive()
    weight: number;

    @ApiProperty({ description: 'Value at which this criterion is fully satisfied.' })
    @IsNumber()
    target: number;

    @ApiProperty({ enum: GOAL_COMPARATORS, description: 'gte = higher is better.' })
    @IsIn(GOAL_COMPARATORS)
    direction: GoalComparator;

    @ApiProperty({ required: false, maxLength: 32 })
    @IsOptional()
    @IsString()
    @MaxLength(32)
    unit?: string;
}

/**
 * Judgment layer G1 — a constraint that must hold.
 *
 * A constraint with neither `maxValue` nor `minValue` is DECLARATIVE:
 * it is carried for prompts and reports and never auto-evaluated,
 * because the platform must not claim to have checked something it
 * cannot measure. `hard` defaults to true — a constraint is a rule
 * until it says otherwise — and a violated hard constraint vetoes
 * ACHIEVED and raises an escalation.
 */
export class GoalConstraintDto {
    @ApiProperty({ maxLength: 64 })
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    id: string;

    @ApiProperty({ maxLength: 300 })
    @IsString()
    @MinLength(1)
    @MaxLength(300)
    name: string;

    @ApiProperty({ enum: GOAL_CONSTRAINT_CATEGORIES })
    @IsIn(GOAL_CONSTRAINT_CATEGORIES)
    category: GoalConstraintCategory;

    @ApiProperty({ required: false, default: true, description: 'Violation disqualifies.' })
    @IsOptional()
    @IsBoolean()
    hard?: boolean;

    @ApiProperty({ required: false, type: GoalMetricSourceDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => GoalMetricSourceDto)
    metricSource?: GoalMetricSourceDto;

    @ApiProperty({ required: false, enum: GOAL_WINDOWS })
    @IsOptional()
    @IsIn(GOAL_WINDOWS)
    window?: GoalWindow;

    @ApiProperty({ required: false, description: 'Violated when the value exceeds this.' })
    @IsOptional()
    @IsNumber()
    maxValue?: number;

    @ApiProperty({ required: false, description: 'Violated when the value falls below this.' })
    @IsOptional()
    @IsNumber()
    minValue?: number;
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

    @ApiProperty({
        required: false,
        type: [GoalCriterionDto],
        description:
            'Judgment layer G1 - weighted success criteria. Omitted keeps this a single-metric Goal (comparator + targetValue decide everything, unchanged).',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_CRITERIA)
    @ValidateNested({ each: true })
    @Type(() => GoalCriterionDto)
    criteria?: GoalCriterionDto[];

    @ApiProperty({
        required: false,
        type: [GoalConstraintDto],
        description:
            'Judgment layer G1 - constraints that must hold; a hard violation vetoes ACHIEVED.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_CONSTRAINTS)
    @ValidateNested({ each: true })
    @Type(() => GoalConstraintDto)
    constraints?: GoalConstraintDto[];
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

    @ApiProperty({
        required: false,
        nullable: true,
        type: [GoalCriterionDto],
        description:
            'Judgment layer G1. `null` (or an empty array) clears the weighted path and the stale resolved score with it.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_CRITERIA)
    @ValidateNested({ each: true })
    @Type(() => GoalCriterionDto)
    criteria?: GoalCriterionDto[] | null;

    @ApiProperty({ required: false, nullable: true, type: [GoalConstraintDto] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_CONSTRAINTS)
    @ValidateNested({ each: true })
    @Type(() => GoalConstraintDto)
    constraints?: GoalConstraintDto[] | null;
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
