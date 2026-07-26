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
    ValidateNested,
} from 'class-validator';
import {
    RUN_BATCH_MAX_TASKS,
    TaskPriority,
    TaskStatus,
    type TaskActorType,
    type TaskIsolationMode,
} from '@ever-works/agent/tasks-domain';
import { AcceptanceCheckDto } from '@ever-works/agent/dto';

export class CreateTaskDto {
    @IsString()
    @MaxLength(200)
    title: string;

    @IsOptional()
    @IsString()
    description?: string | null;

    @IsOptional()
    @IsEnum(TaskStatus)
    status?: TaskStatus;

    @IsOptional()
    @IsEnum(TaskPriority)
    priority?: TaskPriority;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    labels?: string[] | null;

    /** Task isolation override (worktree-per-Task, Wave 2): NULL
     *  inherits the Work's taskIsolation setting. */
    @IsOptional()
    @IsIn(['on', 'off'])
    isolationMode?: TaskIsolationMode | null;

    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    @IsOptional()
    @IsUUID()
    workId?: string | null;

    /**
     * Optional, non-exclusive owners. A Task may be filed against any
     * combination of Work / Team / Agent / Idea / Goal / Mission — these
     * are independent associations, not a single "parent" choice.
     */
    @IsOptional()
    @IsUUID()
    teamId?: string | null;

    @IsOptional()
    @IsUUID()
    agentId?: string | null;

    @IsOptional()
    @IsUUID()
    goalId?: string | null;

    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    @IsOptional()
    @IsBoolean()
    requireAllApprovers?: boolean;

    /**
     * Acceptance checks for this Task (quality gates). Merge over the
     * Work's `checkDefaults` by id: a same-id entry overrides the default,
     * `disabled: true` suppresses it. `null` = inherit the defaults as-is.
     */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => AcceptanceCheckDto)
    acceptanceChecks?: AcceptanceCheckDto[] | null;

    /** Gate-attempt budget (1..5). `null` = inherit the Work's value. */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(5)
    maxGateAttempts?: number | null;
}

export class UpdateTaskDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;

    @IsOptional()
    @IsString()
    description?: string | null;

    @IsOptional()
    @IsEnum(TaskPriority)
    priority?: TaskPriority;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    labels?: string[] | null;

    /** Task isolation override (worktree-per-Task, Wave 2): NULL
     *  inherits the Work's taskIsolation setting. */
    @IsOptional()
    @IsIn(['on', 'off'])
    isolationMode?: TaskIsolationMode | null;

    /**
     * Re-filing a Task under a different owner. `null` detaches it from
     * that owner without touching the others.
     */
    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    @IsOptional()
    @IsUUID()
    teamId?: string | null;

    @IsOptional()
    @IsUUID()
    agentId?: string | null;

    @IsOptional()
    @IsUUID()
    goalId?: string | null;

    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    @IsOptional()
    @IsBoolean()
    requireAllApprovers?: boolean;

    /**
     * Replaces the Task's declared checks wholesale (same merge-over-Work
     * semantics as on create). `null` reverts to inheriting the Work's
     * `checkDefaults` untouched.
     */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => AcceptanceCheckDto)
    acceptanceChecks?: AcceptanceCheckDto[] | null;

    /** Gate-attempt budget (1..5). `null` reverts to inheriting the Work. */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(5)
    maxGateAttempts?: number | null;
}

export class SetTaskRecurringDto {
    @IsString()
    @MaxLength(200)
    recurrenceRule: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    recurrenceTimezone?: string;

    @IsOptional()
    @IsDateString()
    recurrenceEndsAt?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(9999)
    recurrenceMaxOccurrences?: number;
}

export class TransitionTaskDto {
    @IsEnum(TaskStatus)
    to: TaskStatus;

    @IsOptional()
    @IsBoolean()
    force?: boolean;
}

export class AddAssigneeDto {
    @IsIn(['user', 'agent'])
    assigneeType: TaskActorType;

    @IsString()
    @MaxLength(128)
    assigneeId: string;
}

export class AddReviewerDto {
    @IsIn(['user', 'agent'])
    reviewerType: TaskActorType;

    @IsString()
    @MaxLength(128)
    reviewerId: string;
}

export class AddApproverDto {
    @IsIn(['user', 'agent'])
    approverType: TaskActorType;

    @IsString()
    @MaxLength(128)
    approverId: string;
}

export class AddBlockerDto {
    @IsUUID()
    blockedByTaskId: string;
}

export class AddAttachmentDto {
    @IsUUID()
    uploadId: string;
}

export class AddRelationDto {
    @IsUUID()
    relatedTaskId: string;

    @IsIn(['related', 'duplicates', 'follow-up'])
    kind: 'related' | 'duplicates' | 'follow-up';
}

export class TaskChatAttachmentDto {
    @IsUUID()
    uploadId: string;
}

export class PostTaskChatDto {
    @IsString()
    @MaxLength(16 * 1024)
    body: string;

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
    @IsOptional()
    @IsUUID()
    agentId?: string;
}

export class RunTaskBatchItemDto {
    @IsUUID()
    taskId: string;

    @IsOptional()
    @IsUUID()
    agentId?: string;
}

export class RunTasksBatchDto {
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(RUN_BATCH_MAX_TASKS)
    @ValidateNested({ each: true })
    @Type(() => RunTaskBatchItemDto)
    items: RunTaskBatchItemDto[];
}
