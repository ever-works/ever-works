import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayNotEmpty,
    IsArray,
    IsBoolean,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { MAX_TEMPLATE_STEPS, TaskPriority } from '@ever-works/agent/tasks-domain';

export class TaskTemplateStepDto {
    @IsString()
    @MaxLength(200)
    title: string;

    @IsOptional()
    @IsString()
    @MaxLength(8000)
    prompt?: string | null;

    @IsOptional()
    @IsUUID()
    agentId?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    agentTemplateSlug?: string | null;

    @IsOptional()
    @IsBoolean()
    requiresApproval?: boolean;

    /** 0-based positions of steps this one depends on. */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_TEMPLATE_STEPS)
    @IsInt({ each: true })
    @Min(0, { each: true })
    dependsOn?: number[];
}

export class CreateTaskTemplateDto {
    @IsString()
    @MaxLength(200)
    name: string;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    slug?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    description?: string | null;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    labels?: string[] | null;

    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(MAX_TEMPLATE_STEPS)
    @ValidateNested({ each: true })
    @Type(() => TaskTemplateStepDto)
    steps: TaskTemplateStepDto[];
}

export class UpdateTaskTemplateDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    description?: string | null;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    labels?: string[] | null;

    /** Replaces the step list wholesale when provided. */
    @IsOptional()
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(MAX_TEMPLATE_STEPS)
    @ValidateNested({ each: true })
    @Type(() => TaskTemplateStepDto)
    steps?: TaskTemplateStepDto[];
}

export class InstantiateTaskTemplateDto {
    @IsString()
    @MaxLength(200)
    title: string;

    @IsOptional()
    @IsString()
    @MaxLength(8000)
    description?: string | null;

    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    /** Pre-names the parent Task's isolated branch (`branchRef`). */
    @IsOptional()
    @IsString()
    @MaxLength(200)
    branchName?: string | null;

    /** Priority stamped on the parent Task and every step. Default P2. */
    @IsOptional()
    @IsEnum(TaskPriority)
    priority?: TaskPriority;
}
