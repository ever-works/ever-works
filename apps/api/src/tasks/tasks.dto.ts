import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayNotEmpty,
    IsArray,
    IsBoolean,
    IsDateString,
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
    RUN_BATCH_MAX_TASKS,
    TaskPriority,
    TaskStatus,
    type TaskActorType,
    type TaskIsolationMode,
} from '@ever-works/agent/tasks-domain';
import { AcceptanceCheckDto } from '@ever-works/agent/dto';

// Why every field carries `@ApiProperty`: the API build runs no
// `@nestjs/swagger` CLI plugin, so a DTO field without an explicit decorator
// is simply absent from the OpenAPI document. The MCP server (`apps/mcp`)
// derives each tool's input schema from that document — an undocumented
// field is one an MCP client can never send. `type` is spelled out on the
// nullable unions because `string | null` reflects as `Object`.

const TASK_ACTOR_TYPES: TaskActorType[] = ['user', 'agent'];
const TASK_ISOLATION_MODES: TaskIsolationMode[] = ['on', 'off'];

export class CreateTaskDto {
    @ApiProperty({ maxLength: 200 })
    @IsString()
    @MaxLength(200)
    title: string;

    @ApiProperty({ required: false, nullable: true, type: String })
    @IsOptional()
    @IsString()
    description?: string | null;

    @ApiProperty({ required: false, enum: TaskStatus })
    @IsOptional()
    @IsEnum(TaskStatus)
    status?: TaskStatus;

    @ApiProperty({ required: false, enum: TaskPriority })
    @IsOptional()
    @IsEnum(TaskPriority)
    priority?: TaskPriority;

    @ApiProperty({
        required: false,
        nullable: true,
        type: [String],
        description: 'Free-form labels (each up to 80 chars).',
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    labels?: string[] | null;

    /** Task isolation override (worktree-per-Task, Wave 2): NULL
     *  inherits the Work's taskIsolation setting. */
    @ApiProperty({
        required: false,
        nullable: true,
        type: String,
        enum: TASK_ISOLATION_MODES,
        description:
            "Task isolation override (worktree-per-Task); null inherits the Work's taskIsolation setting.",
    })
    @IsOptional()
    @IsIn(TASK_ISOLATION_MODES)
    isolationMode?: TaskIsolationMode | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    workId?: string | null;

    /**
     * Optional, non-exclusive owners. A Task may be filed against any
     * combination of Work / Team / Agent / Idea / Goal / Mission — these
     * are independent associations, not a single "parent" choice.
     */
    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    teamId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    goalId?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        type: String,
        format: 'uuid',
        description: 'Parent Task — files this Task as one of its sub-tasks.',
    })
    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    requireAllApprovers?: boolean;

    /**
     * Acceptance checks for this Task (quality gates). Merge over the
     * Work's `checkDefaults` by id: a same-id entry overrides the default,
     * `disabled: true` suppresses it. `null` = inherit the defaults as-is.
     */
    @ApiProperty({
        required: false,
        nullable: true,
        type: [AcceptanceCheckDto],
        description:
            "Acceptance checks (quality gates), merged over the Work's checkDefaults by id; null inherits the defaults as-is.",
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => AcceptanceCheckDto)
    acceptanceChecks?: AcceptanceCheckDto[] | null;

    /** Gate-attempt budget (1..5). `null` = inherit the Work's value. */
    @ApiProperty({
        required: false,
        nullable: true,
        type: Number,
        minimum: 1,
        maximum: 5,
        description: "Gate-attempt budget (1..5); null inherits the Work's value.",
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(5)
    maxGateAttempts?: number | null;

    /**
     * Schedule mode "Scheduled": run once at this instant (ISO datetime,
     * must be in the future — service validation). Omitted = Run Once.
     */
    @ApiProperty({
        required: false,
        format: 'date-time',
        description:
            'Schedule mode "Scheduled": run once at this ISO instant (must be in the future). Omitted = Run Once.',
    })
    @IsOptional()
    @IsDateString()
    scheduledAt?: string;
}

export class UpdateTaskDto {
    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, nullable: true, type: String })
    @IsOptional()
    @IsString()
    description?: string | null;

    @ApiProperty({ required: false, enum: TaskPriority })
    @IsOptional()
    @IsEnum(TaskPriority)
    priority?: TaskPriority;

    @ApiProperty({
        required: false,
        nullable: true,
        type: [String],
        description: 'Free-form labels (each up to 80 chars).',
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    labels?: string[] | null;

    /** Task isolation override (worktree-per-Task, Wave 2): NULL
     *  inherits the Work's taskIsolation setting. */
    @ApiProperty({
        required: false,
        nullable: true,
        type: String,
        enum: TASK_ISOLATION_MODES,
        description:
            "Task isolation override (worktree-per-Task); null inherits the Work's taskIsolation setting.",
    })
    @IsOptional()
    @IsIn(TASK_ISOLATION_MODES)
    isolationMode?: TaskIsolationMode | null;

    /**
     * Re-filing a Task under a different owner. `null` detaches it from
     * that owner without touching the others.
     */
    @ApiProperty({
        required: false,
        nullable: true,
        type: String,
        format: 'uuid',
        description: 'Re-file under another Work; null detaches it from the Work only.',
    })
    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    teamId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    goalId?: string | null;

    @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    requireAllApprovers?: boolean;

    /**
     * Replaces the Task's declared checks wholesale (same merge-over-Work
     * semantics as on create). `null` reverts to inheriting the Work's
     * `checkDefaults` untouched.
     */
    @ApiProperty({
        required: false,
        nullable: true,
        type: [AcceptanceCheckDto],
        description:
            "Replaces the Task's acceptance checks wholesale; null reverts to inheriting the Work's checkDefaults.",
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => AcceptanceCheckDto)
    acceptanceChecks?: AcceptanceCheckDto[] | null;

    /** Gate-attempt budget (1..5). `null` reverts to inheriting the Work. */
    @ApiProperty({
        required: false,
        nullable: true,
        type: Number,
        minimum: 1,
        maximum: 5,
        description: 'Gate-attempt budget (1..5); null reverts to inheriting the Work.',
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(5)
    maxGateAttempts?: number | null;

    /**
     * Schedule mode "Scheduled" — ISO datetime, must be in the future
     * (service validation); `null` clears the schedule. Equivalent to
     * `POST`/`DELETE :id/schedule`, offered here so a form that saves
     * the whole Task does not need a second round-trip.
     */
    @ApiProperty({
        required: false,
        nullable: true,
        type: String,
        format: 'date-time',
        description: 'ISO datetime in the future to run once at; null clears the schedule.',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    scheduledAt?: string | null;
}

export class SetTaskRecurringDto {
    /** RFC 5545 RRULE — XOR with `recurrenceCron` (service validation). */
    @ApiProperty({
        required: false,
        maxLength: 200,
        description: 'RFC 5545 RRULE — mutually exclusive with recurrenceCron.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    recurrenceRule?: string;

    /** 5-field cron expression — XOR with `recurrenceRule`. */
    @ApiProperty({
        required: false,
        maxLength: 120,
        description: '5-field cron expression — mutually exclusive with recurrenceRule.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    recurrenceCron?: string;

    @ApiProperty({ required: false, maxLength: 64, description: 'IANA timezone name.' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    recurrenceTimezone?: string;

    @ApiProperty({ required: false, format: 'date-time' })
    @IsOptional()
    @IsDateString()
    recurrenceEndsAt?: string;

    @ApiProperty({ required: false, minimum: 1, maximum: 9999 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(9999)
    recurrenceMaxOccurrences?: number;
}

export class TransitionTaskDto {
    @ApiProperty({ enum: TaskStatus, description: 'Target status.' })
    @IsEnum(TaskStatus)
    to: TaskStatus;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    force?: boolean;
}

export class AddAssigneeDto {
    @ApiProperty({ enum: TASK_ACTOR_TYPES })
    @IsIn(TASK_ACTOR_TYPES)
    assigneeType: TaskActorType;

    @ApiProperty({ maxLength: 128, description: 'User id or Agent id, matching assigneeType.' })
    @IsString()
    @MaxLength(128)
    assigneeId: string;
}

export class AddReviewerDto {
    @ApiProperty({ enum: TASK_ACTOR_TYPES })
    @IsIn(TASK_ACTOR_TYPES)
    reviewerType: TaskActorType;

    @ApiProperty({ maxLength: 128, description: 'User id or Agent id, matching reviewerType.' })
    @IsString()
    @MaxLength(128)
    reviewerId: string;
}

/**
 * Orchestration M9 — `POST /api/tasks/:id/reject`.
 *
 * The 8 KB cap matches `TASK_REVIEW_REJECTION_MAX_FEEDBACK_CHARS`: the
 * text is persisted AND spliced into the next resumed run's first turn,
 * so it is bounded at the edge as well as in the repository (which
 * truncates rather than rejects — two different jobs, both needed).
 */
export class RejectTaskDto {
    @ApiProperty({
        maxLength: 8000,
        description: "Reviewer feedback; spliced into the next resumed run's first turn.",
    })
    @IsString()
    @MaxLength(8000)
    feedback: string;

    /** The run whose output is being rejected, when the caller knows it. */
    @ApiProperty({
        required: false,
        format: 'uuid',
        description: 'The run whose output is being rejected, when known.',
    })
    @IsOptional()
    @IsUUID()
    runId?: string;
}

/** Judgment layer G3 — `POST /api/tasks/:id/escalations/:eid/resolve`. */
export class ResolveEscalationDto {
    @ApiProperty({ required: false, maxLength: 1000, description: 'Optional decision note.' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    note?: string;
}

export class AddApproverDto {
    @ApiProperty({ enum: TASK_ACTOR_TYPES })
    @IsIn(TASK_ACTOR_TYPES)
    approverType: TaskActorType;

    @ApiProperty({ maxLength: 128, description: 'User id or Agent id, matching approverType.' })
    @IsString()
    @MaxLength(128)
    approverId: string;
}

export class AddBlockerDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    blockedByTaskId: string;
}

export class AddAttachmentDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    uploadId: string;

    /** `initial` (input material, default) | `result` (worked output). */
    @ApiProperty({
        required: false,
        enum: ['initial', 'result'],
        description: 'initial (input material, default) | result (worked output).',
    })
    @IsOptional()
    @IsIn(['initial', 'result'])
    role?: 'initial' | 'result';
}

/** Schedule mode "Scheduled" — `POST /api/tasks/:id/schedule`. */
export class ScheduleTaskDto {
    @ApiProperty({ format: 'date-time' })
    @IsDateString()
    runAt: string;
}

export class AddRelationDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    relatedTaskId: string;

    @ApiProperty({ enum: ['related', 'duplicates', 'follow-up'] })
    @IsIn(['related', 'duplicates', 'follow-up'])
    kind: 'related' | 'duplicates' | 'follow-up';
}

export class TaskChatAttachmentDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    uploadId: string;
}

export class PostTaskChatDto {
    @ApiProperty({
        maxLength: 16 * 1024,
        description: 'Message text; @mentions and [[kb]] tokens are parsed server-side.',
    })
    @IsString()
    @MaxLength(16 * 1024)
    body: string;

    @ApiProperty({ required: false, type: [TaskChatAttachmentDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => TaskChatAttachmentDto)
    attachments?: TaskChatAttachmentDto[];
}

// ── Board dispatch (kanban M3 / M4) ───────────────────────────────

export class RunTaskDto {
    /**
     * Which Agent to run. Omit to let the server resolve it (the Task's
     * assigned Agent, then the Work's default Agent) — an ambiguous or
     * empty resolution comes back as a 400 carrying the candidate list,
     * which is what the board's agent picker renders.
     */
    @ApiProperty({
        required: false,
        format: 'uuid',
        description:
            "Agent to run. Omit to resolve the Task's assigned Agent, then the Work's default Agent (400 with the candidate list when ambiguous).",
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;
}

export class RunTaskBatchItemDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    taskId: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string;
}

export class RunTasksBatchDto {
    @ApiProperty({ type: [RunTaskBatchItemDto], minItems: 1, maxItems: RUN_BATCH_MAX_TASKS })
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(RUN_BATCH_MAX_TASKS)
    @ValidateNested({ each: true })
    @Type(() => RunTaskBatchItemDto)
    items: RunTaskBatchItemDto[];
}
