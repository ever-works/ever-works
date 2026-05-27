import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import type {
    CreateWorkAgentGoalInput,
    UpdateWorkAgentPreferencesInput,
    WorkAgentGoalDto,
    WorkAgentGuardrails,
    WorkAgentPreferencesDto,
    WorkAgentRunDto,
    WorkAgentRunLogDto,
    WorkAgentRunSummary,
} from '@ever-works/agent/work-agent';
import {
    WorkAgentGoalSource,
    WorkAgentGoalStatus,
    WorkAgentRunLogLevel,
    WorkAgentRunStatus,
} from '@ever-works/agent/work-agent';

export class WorkAgentGuardrailsDto implements Partial<WorkAgentGuardrails> {
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(25)
    @Type(() => Number)
    maxWorksPerRun?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(500)
    @Type(() => Number)
    maxItemsPerWork?: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1_000_000)
    @Type(() => Number)
    maxBudgetCentsPerRun?: number;

    @IsOptional()
    @IsBoolean()
    requireApprovalBeforeCreate?: boolean;

    @IsOptional()
    @IsBoolean()
    requireApprovalBeforeDelete?: boolean;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1_000_000)
    @Type(() => Number)
    requireApprovalAboveBudgetCents?: number;

    @IsOptional()
    @IsBoolean()
    dryRunByDefault?: boolean;
}

export class UpdateWorkAgentPreferencesDto
    extends WorkAgentGuardrailsDto
    implements UpdateWorkAgentPreferencesInput
{
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    autoApproveLowImpact?: boolean;

    @IsOptional()
    @IsBoolean()
    dailySuggestionsEnabled?: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    autoGenerateCadence?: string | null;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(20)
    autoGenerateBatchSize?: number | null;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1000)
    autoBuildThrottlePerDay?: number | null;

    @IsOptional()
    @IsInt()
    @Min(-1)
    @Max(1000)
    missionDefaultOutstandingCap?: number | null;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(5)
    maxAutoRetries?: number;

    @IsOptional()
    @IsInt()
    @Min(10)
    @Max(3600)
    backoffSeconds?: number;

    @IsOptional()
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(1)
    @Max(4)
    exponentialBackoffFactor?: number;

    @IsOptional()
    @IsString()
    @Matches(/^\d+$/)
    @MaxLength(32)
    accountWideMonthlyCapCents?: string | null;

    @IsOptional()
    @IsBoolean()
    accountWideAllowOverage?: boolean;
}

export class CreateWorkAgentGoalDto
    extends WorkAgentGuardrailsDto
    implements CreateWorkAgentGoalInput
{
    @ApiProperty({
        description: 'High-level goal for the Work agent.',
        example: 'Create a Work covering the top 50 AI startups in healthcare.',
    })
    @IsString()
    @MinLength(10)
    @MaxLength(2_000)
    instruction: string;

    @IsOptional()
    @IsBoolean()
    dryRun?: boolean;
}

export interface WorkAgentPreferencesResponseDto extends WorkAgentPreferencesDto {
    enabled: boolean;
    autoApproveLowImpact: boolean;
    dailySuggestionsEnabled: boolean;
    guardrails: WorkAgentGuardrails;
}

export interface WorkAgentGoalResponseDto extends WorkAgentGoalDto {
    id: string;
    instruction: string;
    status: WorkAgentGoalStatus;
    source: WorkAgentGoalSource;
    dryRun: boolean;
    guardrailsOverride?: Partial<WorkAgentGuardrails> | null;
    agentPlanSummary?: string | null;
    approvalSummary?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface WorkAgentRunResponseDto extends WorkAgentRunDto {
    id: string;
    goalId: string;
    status: WorkAgentRunStatus;
    dryRun: boolean;
    progressPercent: number;
    summary: WorkAgentRunSummary;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    error?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface WorkAgentRunLogResponseDto extends WorkAgentRunLogDto {
    id: string;
    runId: string;
    level: WorkAgentRunLogLevel;
    step: string;
    message: string;
    metadata?: Record<string, unknown> | null;
    createdAt: Date;
}
