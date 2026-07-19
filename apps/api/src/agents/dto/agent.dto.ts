import { ApiProperty } from '@nestjs/swagger';
import {
    IsArray,
    IsBoolean,
    IsEmail,
    IsEnum,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    AGENT_GUARDRAIL_MODES,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    type AgentGuardrails,
} from '@ever-works/agent/agents';
import {
    AGENT_ACTION_PROPOSAL_ACTION_TYPES,
    type AgentActionProposalActionType,
} from '@ever-works/agent/agent-approvals';

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

/**
 * Agent Dispatch Guardrails policy body — mirrors the pure
 * `AgentGuardrails` shape (`packages/agent/src/agents/guardrails.ts`).
 * The service re-validates via `validateGuardrails` (defense-in-depth),
 * so this DTO only has to shape-check for the global ValidationPipe.
 */
export class AgentGuardrailsDto implements AgentGuardrails {
    @ApiProperty({ enum: AGENT_GUARDRAIL_MODES as unknown as string[] })
    @IsIn(AGENT_GUARDRAIL_MODES as unknown as string[])
    mode: 'require_approval' | 'autonomous';

    @ApiProperty({
        required: false,
        isArray: true,
        enum: AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[],
        description:
            'Autonomous-mode narrowing: only these action types may auto-approve. Omitted = all.',
    })
    @IsOptional()
    @IsArray()
    @IsIn(AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[], { each: true })
    autoApproveActionTypes?: AgentActionProposalActionType[];

    @ApiProperty({
        required: false,
        isArray: true,
        enum: AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[],
        description: 'Action types this Agent may never take — auto-rejected with an audit row.',
    })
    @IsOptional()
    @IsArray()
    @IsIn(AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[], { each: true })
    blockedActionTypes?: AgentActionProposalActionType[];
}

/**
 * Body for `PUT /api/agents/:id/guardrails`. PUT semantics — the whole
 * policy is replaced. `{"guardrails": null}` (or an omitted field)
 * clears back to the default queue-everything posture.
 */
export class UpdateAgentGuardrailsDto {
    @ApiProperty({ required: false, type: AgentGuardrailsDto, nullable: true })
    @IsOptional()
    @ValidateNested()
    @Type(() => AgentGuardrailsDto)
    guardrails?: AgentGuardrailsDto | null;
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

/**
 * Payload for `POST /api/agents/:id/attachments`.
 *
 * Security (EW-710 wave M): mirrors `AddAttachmentDto` (tasks) and
 * `AddWorkProposalAttachmentDto` (work-proposals) so the global
 * ValidationPipe schema-validates `uploadId` instead of accepting a
 * raw inline `{ uploadId: string }` object with no decorators.
 */
export class AddAgentAttachmentDto {
    // `uploadId` is the SHA-256 hex id returned by `POST /api/uploads/file`
    // (NOT a UUID). The previous `@IsUUID()` rejected every real upload id and
    // contradicted the service's own `SHA256_RE` guard, so agent attachments
    // could never succeed. Align with the Mission / Idea attachment DTOs.
    @ApiProperty({ pattern: '^[0-9a-fA-F]{64}$' })
    @IsString()
    @Matches(/^[0-9a-f]{64}$/i)
    uploadId: string;
}
