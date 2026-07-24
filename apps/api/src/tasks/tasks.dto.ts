import { Type } from 'class-transformer';
import {
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
import { TaskPriority, TaskStatus, type TaskActorType } from '@ever-works/agent/tasks-domain';

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
