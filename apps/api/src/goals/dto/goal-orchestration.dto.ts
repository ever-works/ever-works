import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    GOAL_DOD_SOURCES,
    GOAL_DOD_STATUSES,
    GOAL_EXECUTION_TARGETS,
    MAX_DOD_EVIDENCE_CHARS,
    MAX_DOD_ID_CHARS,
    MAX_DOD_NOTE_CHARS,
    MAX_DOD_TEXT_CHARS,
    MAX_GOAL_DOD_CRITERIA,
    MAX_GRACE_PERIOD_MINUTES,
    MAX_MODEL_HINT_CHARS,
    MAX_NUDGE_CHARS,
    MAX_CONCURRENT_ITERATIONS,
    MAX_SESSION_BUDGET_MINUTES,
    MAX_SPEND_CAP_CENTS,
    MAX_STUCK_THRESHOLD_ITERATIONS,
    MAX_WALL_CLOCK_LIMIT_HOURS,
    type GoalDoDSource,
    type GoalDoDStatus,
    type GoalExecutionTarget,
} from '@ever-works/agent/goals';

/**
 * Autonomy layer — edge shapes for the Goal execution loop.
 *
 * Every semantic rule (bounds, id uniqueness, approval state) is
 * re-validated in `GoalOrchestratorService`, which is the single source
 * of truth; these classes are the wire contract and the
 * `forbidNonWhitelisted` guard.
 *
 * `null` is MEANINGFUL on every optional limit: it clears the ceiling.
 * `@IsOptional()` accepts both `undefined` (leave alone) and `null`
 * (clear), and the controller forwards the distinction untouched — a
 * surface that could only raise a cap and never remove one would be a
 * trap.
 */

const DOD_STATUSES = [...GOAL_DOD_STATUSES] as GoalDoDStatus[];
const DOD_SOURCES = [...GOAL_DOD_SOURCES] as GoalDoDSource[];
const EXECUTION_TARGETS = [...GOAL_EXECUTION_TARGETS] as GoalExecutionTarget[];

/** One Definition-of-Done criterion on the wire. */
export class GoalDoDCriterionDto {
    @ApiProperty({
        maxLength: MAX_DOD_ID_CHARS,
        description: 'Stable slug, unique within the Goal.',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(MAX_DOD_ID_CHARS)
    id: string;

    @ApiProperty({ maxLength: MAX_DOD_TEXT_CHARS, description: 'The completion statement.' })
    @IsString()
    @MinLength(1)
    @MaxLength(MAX_DOD_TEXT_CHARS)
    text: string;

    @ApiProperty({ enum: DOD_STATUSES })
    @IsIn(DOD_STATUSES)
    status: GoalDoDStatus;

    @ApiProperty({ required: false, nullable: true, maxLength: MAX_DOD_EVIDENCE_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_DOD_EVIDENCE_CHARS)
    evidence?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: MAX_DOD_NOTE_CHARS,
        description: 'Why a criterion was waived, or any operator annotation.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_DOD_NOTE_CHARS)
    note?: string | null;

    @ApiProperty({ required: false, enum: DOD_SOURCES, default: 'operator' })
    @IsOptional()
    @IsIn(DOD_SOURCES)
    source?: GoalDoDSource;

    @ApiProperty({
        required: false,
        description:
            'Awaiting operator approval. Proposed criteria are excluded from the completion rollup.',
    })
    @IsOptional()
    @IsBoolean()
    proposed?: boolean;

    /**
     * Round-trip field. `normalizeDoDCriteria` STAMPS `updatedAt` on every
     * persisted criterion, so the checklist a client reads back always
     * carries it — and the DoD tab replaces the whole list on every add and
     * remove. Without this property `forbidNonWhitelisted` 400s
     * ("property updatedAt should not exist") the moment the Goal has one
     * saved criterion, i.e. every add after the first.
     *
     * Preserved rather than restamped by the service, which is the point:
     * re-saving the list must not make untouched criteria look edited.
     */
    @ApiProperty({
        required: false,
        format: 'date-time',
        description: 'ISO timestamp of the last status/evidence write. Echoed back unchanged.',
    })
    @IsOptional()
    @IsISO8601()
    updatedAt?: string;
}

/** Body for `PUT /api/me/goals/:id/dod` — replaces the whole checklist. */
export class SetGoalDodDto {
    @ApiProperty({
        type: [GoalDoDCriterionDto],
        nullable: true,
        description: '`null` clears the Definition of Done entirely.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_DOD_CRITERIA)
    @ValidateNested({ each: true })
    @Type(() => GoalDoDCriterionDto)
    criteria?: GoalDoDCriterionDto[] | null;
}

/** Body for `POST /api/me/goals/:id/dod/propose` — planner-authored entries. */
export class ProposeGoalDodDto {
    @ApiProperty({ type: [GoalDoDCriterionDto] })
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_DOD_CRITERIA)
    @ValidateNested({ each: true })
    @Type(() => GoalDoDCriterionDto)
    criteria: GoalDoDCriterionDto[];
}

/** Body for `POST /api/me/goals/:id/dod/approve`. */
export class ApproveGoalDodDto {
    @ApiProperty({
        required: false,
        type: [String],
        description: 'Criterion ids to approve. Omitted approves every proposed criterion.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_GOAL_DOD_CRITERIA)
    @IsString({ each: true })
    @MaxLength(MAX_DOD_ID_CHARS, { each: true })
    criterionIds?: string[];
}

/** Body for `PATCH /api/me/goals/:id/dod/:criterionId`. */
export class PatchGoalDodCriterionDto {
    @ApiProperty({ required: false, enum: DOD_STATUSES })
    @IsOptional()
    @IsIn(DOD_STATUSES)
    status?: GoalDoDStatus;

    @ApiProperty({ required: false, maxLength: MAX_DOD_TEXT_CHARS })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(MAX_DOD_TEXT_CHARS)
    text?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: MAX_DOD_EVIDENCE_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_DOD_EVIDENCE_CHARS)
    evidence?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: MAX_DOD_NOTE_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_DOD_NOTE_CHARS)
    note?: string | null;
}

/**
 * Body for `PATCH /api/me/goals/:id/limits` — the "Adjust limits" surface.
 */
export class UpdateGoalLimitsDto {
    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 0,
        maximum: MAX_SPEND_CAP_CENTS,
        description:
            'Hard spend ceiling for the whole Goal, in CENTS (agent_runs.costCents is cents, so no lossy conversion). `null` clears it.',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    spendCapCents?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 1,
        maximum: MAX_WALL_CLOCK_LIMIT_HOURS,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    wallClockLimitHours?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 1,
        maximum: MAX_STUCK_THRESHOLD_ITERATIONS,
        description:
            'Iterations with no Definition-of-Done progress before the loop is marked stuck.',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    stuckThresholdIterations?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 1,
        maximum: MAX_CONCURRENT_ITERATIONS,
        description:
            'How many iterations this Goal may run at once. `null` (the default) means ONE — the serial loop. Raise it only for a Goal whose iterations do not share a branch; concurrent iterations on one branch race each other.',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    maxConcurrentIterations?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 1,
        maximum: MAX_SESSION_BUDGET_MINUTES,
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    sessionBudgetMinutes?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 0,
        maximum: MAX_GRACE_PERIOD_MINUTES,
        description:
            'Extra time an in-flight iteration is allowed after the wall-clock limit, so a session mid-write can land.',
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    gracePeriodMinutes?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        enum: EXECUTION_TARGETS,
        description: 'Advisory routing hint recorded on every dispatch event.',
    })
    @IsOptional()
    @IsIn(EXECUTION_TARGETS)
    executionTarget?: GoalExecutionTarget | null;

    @ApiProperty({ required: false, nullable: true, maxLength: MAX_MODEL_HINT_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_MODEL_HINT_CHARS)
    plannerModelHint?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: MAX_MODEL_HINT_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_MODEL_HINT_CHARS)
    workerModelHint?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        format: 'uuid',
        description: 'Pin routing to one agent. `null` restores round-robin over the Goal history.',
    })
    @IsOptional()
    @IsUUID()
    assignedAgentId?: string | null;
}

/** Body for `POST /api/me/goals/:id/nudge`. */
export class NudgeGoalDto {
    @ApiProperty({ minLength: 1, maxLength: MAX_NUDGE_CHARS })
    @IsString()
    @MinLength(1)
    @MaxLength(MAX_NUDGE_CHARS)
    message: string;
}
