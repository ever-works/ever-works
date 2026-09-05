import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
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
    Validate,
    ValidateIf,
    ValidateNested,
    ValidatorConstraint,
    type ValidationArguments,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
// The kind vocabulary comes from `@ever-works/contracts` rather than the
// agent barrel so specs that stub the barrel (the house idiom for these
// DTOs) keep the real list.
import { GOAL_KINDS, isGoalKind, type GoalKind } from '@ever-works/contracts';
import {
    GOAL_CONSTRAINT_CATEGORIES,
    MAX_GOAL_CONSTRAINTS,
    MAX_GOAL_CRITERIA,
    MAX_GOAL_DOD_CRITERIA,
    type GoalComparator,
    type GoalConstraintCategory,
    type GoalOutcome,
    type GoalWindow,
} from '@ever-works/agent/goals';
import { GoalDoDCriterionDto } from './goal-orchestration.dto';

const GOAL_COMPARATORS: GoalComparator[] = ['gte', 'lte'];
const GOAL_WINDOWS: GoalWindow[] = ['day', 'week', 'month', 'total', 'point'];
const GOAL_OUTCOMES: GoalOutcome[] = ['achieved', 'missed', 'abandoned'] as GoalOutcome[];

/**
 * Fields that only mean something on a metric Goal. Mirrors
 * `GOAL_METRIC_ONLY_FIELDS` in `@ever-works/agent/goals` (goal-kind.ts);
 * spelled out here because the DTO must not depend on the agent barrel's
 * runtime for a rule the service re-checks anyway.
 */
const METRIC_ONLY_FIELDS = [
    'metricSource',
    'comparator',
    'targetValue',
    'unit',
    'window',
    'baselineValue',
    'criteria',
    'constraints',
] as const;

/** Omitted kind = metric — every client that predates kinds. */
function isMetricKind(body: { goalKind?: unknown }): boolean {
    return body.goalKind === undefined || body.goalKind === null || body.goalKind === 'metric';
}

/**
 * Cross-field shape rule for `CreateGoalDto`, evaluated on `goalKind`
 * WITHOUT `@IsOptional()` — that decorator would skip the whole property
 * when the kind is omitted, which is exactly the (metric) case the
 * per-field validators below must still cover.
 *
 * Returns the problems for a DELIVERY body; a metric body reports nothing
 * here because its missing fields keep their own per-field messages
 * (pinned by the e2e validation matrix), and an unknown kind is reported
 * by {@link GoalKindMemberConstraint} instead.
 */
function goalKindShapeProblems(body: Record<string, unknown>): string[] {
    const kind = body.goalKind === undefined || body.goalKind === null ? 'metric' : body.goalKind;
    if (!isGoalKind(kind) || kind === 'metric') return [];
    const problems = METRIC_ONLY_FIELDS.filter(
        (field) => body[field] !== undefined && body[field] !== null,
    ).map((field) => `${field} must be omitted for a delivery Goal`);
    if (!Array.isArray(body.dodCriteria) || body.dodCriteria.length === 0) {
        problems.push(
            'a delivery Goal requires at least one Definition-of-Done criterion (dodCriteria)',
        );
    } else if (
        body.dodCriteria.every(
            (entry) =>
                typeof entry === 'object' &&
                entry !== null &&
                (entry as { proposed?: unknown }).proposed === true,
        )
    ) {
        // `summarizeDoD` excludes proposed criteria from the rollup, so a
        // Goal born with nothing but proposals would have no finish line at
        // all. Mirrors `validateDeliveryGoalInput` in the service.
        problems.push(
            'a delivery Goal cannot be created with only proposed (unapproved) criteria — at least one must be approved',
        );
    }
    return problems;
}

@ValidatorConstraint({ name: 'goalKindMember' })
class GoalKindMemberConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return value === undefined || value === null || isGoalKind(value);
    }

    defaultMessage(): string {
        return `goalKind must be one of the following values: ${GOAL_KINDS.join(', ')}`;
    }
}

@ValidatorConstraint({ name: 'goalKindShape' })
class GoalKindShapeConstraint implements ValidatorConstraintInterface {
    validate(_value: unknown, args: ValidationArguments): boolean {
        return goalKindShapeProblems(args.object as Record<string, unknown>).length === 0;
    }

    defaultMessage(args: ValidationArguments): string {
        return goalKindShapeProblems(args.object as Record<string, unknown>).join('; ');
    }
}

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
 * frequency clamp — spec FR-12, the per-kind shape) are re-validated in
 * `GoalsService.create`, the single source of truth PATCH reuses.
 *
 * Two KINDS share this body (self-build slice AG, EW-795):
 *   - `metric` (default) — `metricSource`, `comparator`, `targetValue`,
 *     `unit` and `window` are REQUIRED, exactly as before the kind
 *     existed; each keeps its own validator and message.
 *   - `delivery` — those fields must be omitted (or null) and `dodCriteria`
 *     must carry at least one criterion; the cross-field rule lives on
 *     `goalKind` so a body that satisfies neither kind is refused here,
 *     before the service refuses it again.
 *
 * The MCP `create_goal` tool schema is derived from these `@ApiProperty`
 * annotations, so the metric fields are declared optional on the wire and
 * the per-kind requirement is documented in their descriptions.
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

    @ApiProperty({
        required: false,
        enum: [...GOAL_KINDS],
        default: 'metric',
        description:
            "'metric' (default) reads a metrics-provider plugin and completes when comparator/targetValue is satisfied — metricSource, comparator, targetValue, unit and window are required. 'delivery' has no metric: omit those fields, supply dodCriteria (at least one), and the Goal completes when every approved Definition-of-Done criterion is done or waived. Immutable after create.",
    })
    @Validate(GoalKindMemberConstraint)
    @Validate(GoalKindShapeConstraint)
    goalKind?: GoalKind;

    @ApiProperty({
        required: false,
        type: GoalMetricSourceDto,
        description:
            'Metric Goals only — required when goalKind is metric, must be omitted for delivery.',
    })
    @ValidateIf(isMetricKind)
    @ValidateNested()
    @Type(() => GoalMetricSourceDto)
    metricSource?: GoalMetricSourceDto;

    @ApiProperty({
        required: false,
        enum: GOAL_COMPARATORS,
        description:
            'Metric Goals only (required for metric, omit for delivery). gte = grow-to-target, lte = shrink.',
    })
    @ValidateIf(isMetricKind)
    @IsIn(GOAL_COMPARATORS)
    comparator?: GoalComparator;

    @ApiProperty({
        required: false,
        description:
            'Metric Goals only — required when goalKind is metric, must be omitted for delivery.',
    })
    @ValidateIf(isMetricKind)
    @IsNumber()
    targetValue?: number;

    @ApiProperty({
        required: false,
        maxLength: 32,
        description:
            "Metric Goals only (required for metric, omit for delivery). Unit of targetValue (e.g. 'usd', 'count').",
    })
    @ValidateIf(isMetricKind)
    @IsString()
    @MinLength(1)
    @MaxLength(32)
    unit?: string;

    @ApiProperty({
        required: false,
        enum: GOAL_WINDOWS,
        description:
            'Metric Goals only — required when goalKind is metric, must be omitted for delivery.',
    })
    @ValidateIf(isMetricKind)
    @IsIn(GOAL_WINDOWS)
    window?: GoalWindow;

    @ApiProperty({ required: false, nullable: true, description: 'Metric Goals only.' })
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
            'Judgment layer G1 - constraints that must hold; a hard violation vetoes ACHIEVED. Metric Goals only.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_CONSTRAINTS)
    @ValidateNested({ each: true })
    @Type(() => GoalConstraintDto)
    constraints?: GoalConstraintDto[];

    @ApiProperty({
        required: false,
        type: [GoalDoDCriterionDto],
        minItems: 1,
        maxItems: MAX_GOAL_DOD_CRITERIA,
        description:
            'Definition of Done. REQUIRED for a delivery Goal (at least one approved criterion — it is the whole completion rule); an optional seed checklist for a metric Goal.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_GOAL_DOD_CRITERIA)
    @ValidateNested({ each: true })
    @Type(() => GoalDoDCriterionDto)
    dodCriteria?: GoalDoDCriterionDto[];
}

/**
 * Request body for `PATCH /api/me/goals/:id`. All fields optional;
 * `null` clears nullable fields. `status` is NOT writable here (use
 * activate/pause) — but `outcome` IS: spec FR-13 makes auto-set
 * outcomes human-overridable, including `abandoned` and clearing
 * with `null`. `goalKind` is deliberately absent: the kind is immutable
 * after create, and the service refuses every metric field on a delivery
 * Goal.
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

    @ApiProperty({
        required: false,
        type: GoalMetricSourceDto,
        description: 'Metric Goals only — rejected (400) on a delivery Goal.',
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => GoalMetricSourceDto)
    metricSource?: GoalMetricSourceDto;

    @ApiProperty({
        required: false,
        enum: GOAL_COMPARATORS,
        description: 'Metric Goals only — rejected (400) on a delivery Goal.',
    })
    @IsOptional()
    @IsIn(GOAL_COMPARATORS)
    comparator?: GoalComparator;

    @ApiProperty({
        required: false,
        description: 'Metric Goals only — rejected (400) on a delivery Goal.',
    })
    @IsOptional()
    @IsNumber()
    targetValue?: number;

    @ApiProperty({
        required: false,
        maxLength: 32,
        description: 'Metric Goals only — rejected (400) on a delivery Goal.',
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(32)
    unit?: string;

    @ApiProperty({
        required: false,
        enum: GOAL_WINDOWS,
        description: 'Metric Goals only — rejected (400) on a delivery Goal.',
    })
    @IsOptional()
    @IsIn(GOAL_WINDOWS)
    window?: GoalWindow;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'Metric Goals only — rejected (400) on a delivery Goal.',
    })
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
