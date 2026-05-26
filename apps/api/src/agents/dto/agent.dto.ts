import { ApiProperty } from '@nestjs/swagger';
import {
    IsArray,
    IsBoolean,
    IsEmail,
    IsEnum,
    IsInt,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '@ever-works/agent/agents';

/**
 * Permissions partial sent on create/update — every flag optional;
 * unset = inherit conservative default (all false).
 */
export class AgentPermissionsDto {
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canCreateAgents?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canAssignTasks?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canEditSkills?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canEditAgentFiles?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canSpend?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canCommitToRepo?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canOpenPullRequests?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canCallExternalTools?: boolean;
}

export class AgentTargetDto {
    @ApiProperty({ enum: ['mission', 'idea', 'work', 'wildcard'] })
    @IsEnum(['mission', 'idea', 'work', 'wildcard'] as const)
    type: 'mission' | 'idea' | 'work' | 'wildcard';

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    id?: string;
}

export class CreateAgentDto {
    @ApiProperty({ enum: AgentScope })
    @IsEnum(AgentScope)
    scope: AgentScope;

    @ApiProperty({ required: false }) @IsOptional() @IsUUID() missionId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() ideaId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() workId?: string;

    @ApiProperty({ minLength: 1, maxLength: 120 })
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    @IsNotEmpty()
    name: string;

    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    capabilities?: string;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    aiProviderId?: string;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    modelId?: string;

    @ApiProperty({ required: false, minimum: 0, maximum: 20000 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(20000)
    maxSkillContextTokens?: number;

    @ApiProperty({
        required: false,
        description: "Cron expression or 'manual'; null = manual.",
        maxLength: 64,
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    heartbeatCadence?: string;

    @ApiProperty({ required: false, enum: AgentIdleBehavior })
    @IsOptional()
    @IsEnum(AgentIdleBehavior)
    idleBehavior?: AgentIdleBehavior;

    @ApiProperty({ required: false, minimum: 1, maximum: 20 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(20)
    pauseAfterFailures?: number;

    @ApiProperty({ required: false, type: AgentPermissionsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => AgentPermissionsDto)
    permissions?: AgentPermissionsDto;

    @ApiProperty({ required: false, type: [AgentTargetDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => AgentTargetDto)
    targets?: AgentTargetDto[];

    @ApiProperty({ required: false, enum: AgentAvatarMode })
    @IsOptional()
    @IsEnum(AgentAvatarMode)
    avatarMode?: AgentAvatarMode;

    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    avatarIcon?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    avatarImageUploadId?: string;

    // FU-13 — per-Agent git committer identity. Both nullable; when
    // unset, the AGENT_GIT_FACADE binding falls back to the Agent's
    // name + a synthesized email (see entity docstring + spec).
    @ApiProperty({ required: false, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    committerName?: string;

    @ApiProperty({ required: false, maxLength: 254 })
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    committerEmail?: string;
}

export class UpdateAgentDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string | null;

    @ApiProperty({ required: false, maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    capabilities?: string | null;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    aiProviderId?: string | null;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    modelId?: string | null;

    @ApiProperty({ required: false, minimum: 0, maximum: 20000 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(20000)
    maxSkillContextTokens?: number;

    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    heartbeatCadence?: string | null;

    @ApiProperty({ required: false, enum: AgentIdleBehavior })
    @IsOptional()
    @IsEnum(AgentIdleBehavior)
    idleBehavior?: AgentIdleBehavior;

    @ApiProperty({ required: false, minimum: 1, maximum: 20 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(20)
    pauseAfterFailures?: number;

    @ApiProperty({ required: false, type: AgentPermissionsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => AgentPermissionsDto)
    permissions?: AgentPermissionsDto;

    @ApiProperty({ required: false, type: [AgentTargetDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => AgentTargetDto)
    targets?: AgentTargetDto[] | null;

    @ApiProperty({ required: false, enum: AgentAvatarMode })
    @IsOptional()
    @IsEnum(AgentAvatarMode)
    avatarMode?: AgentAvatarMode;

    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    avatarIcon?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    avatarImageUploadId?: string | null;

    // FU-13 — committer identity (also editable post-create).
    @ApiProperty({ required: false, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    committerName?: string | null;

    @ApiProperty({ required: false, maxLength: 254 })
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    committerEmail?: string | null;
}

export class ListAgentsQueryDto {
    @ApiProperty({ required: false, enum: AgentScope })
    @IsOptional()
    @IsEnum(AgentScope)
    scope?: AgentScope;

    @ApiProperty({ required: false, enum: AgentStatus })
    @IsOptional()
    @IsEnum(AgentStatus)
    status?: AgentStatus;

    @ApiProperty({ required: false }) @IsOptional() @IsUUID() missionId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() ideaId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() workId?: string;

    @ApiProperty({ required: false, maxLength: 80 })
    @IsOptional()
    @IsString()
    @MaxLength(80)
    search?: string;

    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * FU-2 — pagination DTO for `GET /api/agents/:id/runs`.
 */
export class ListAgentRunsQueryDto {
    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * FU-2 — payload for `POST /api/agents/:id/assign-task`.
 */
export class AssignTaskToAgentDto {
    @ApiProperty()
    @IsUUID()
    taskId: string;
}
