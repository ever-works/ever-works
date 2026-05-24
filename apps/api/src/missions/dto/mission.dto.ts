import { ApiProperty } from '@nestjs/swagger';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
} from 'class-validator';
import { MissionType } from '@ever-works/agent/missions';

/**
 * Phase 3 PR H — request body for `POST /me/missions`. Validated
 * by NestJS's global ValidationPipe via class-validator decorators.
 * The schedule-vs-type consistency rule (scheduled→schedule required,
 * one-shot→no schedule) is enforced server-side in the service
 * layer (`assertScheduleConsistency`) rather than as a cross-field
 * DTO rule — class-validator's cross-field validation is awkward
 * for this pattern and the service-side check is the single source
 * of truth that PATCH also reuses.
 */
export class CreateMissionDto {
    /**
     * Phase 3 PR I — optional. When omitted, the service generates
     * a short title from `description` via the shared TitlerService.
     * Callers that DO want to control the title can still pass it.
     */
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;

    @ApiProperty({ minLength: 1, maxLength: 10000 })
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    description: string;

    @ApiProperty({ enum: MissionType })
    @IsEnum(MissionType)
    type: MissionType;

    @ApiProperty({
        required: false,
        nullable: true,
        description:
            'Cron expression. Required when type=scheduled, MUST be null/omitted when type=one-shot.',
    })
    @IsOptional()
    @ValidateIf((o) => o.schedule !== null)
    @IsString()
    @MaxLength(64)
    schedule?: string | null;

    @ApiProperty({ required: false, default: false })
    @IsOptional()
    @IsBoolean()
    autoBuildWorks?: boolean;

    /**
     * Soft cap on PENDING/QUEUED/BUILDING Ideas this Mission can
     * have outstanding. NULL = inherit user-level default
     * (`WorkAgentPreference.missionDefaultOutstandingCap`, Phase 0
     * PR 0.4). Negative sentinel (-1) = "unlimited" — the tick
     * worker (PR J) treats negative as no cap.
     */
    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsInt()
    @Min(-1)
    outstandingIdeasCap?: number | null;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'Sparse override of the user-level WorkAgentGuardrails for spawned Ideas.',
    })
    @IsOptional()
    @IsObject()
    guardrailsOverride?: Record<string, unknown> | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 200 })
    @IsOptional()
    @ValidateIf((o) => o.missionTemplateRepo !== null)
    @IsString()
    @MaxLength(200)
    missionTemplateRepo?: string | null;
}

/**
 * Phase 3 PR H — request body for `PATCH /me/missions/:id`. All
 * fields optional; undefined = leave existing untouched; `null`
 * on the nullable fields explicitly clears them. State (`status`)
 * is intentionally NOT updatable here — use the lifecycle
 * endpoints (pause / resume / complete) for state transitions.
 */
export class UpdateMissionDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, minLength: 1, maxLength: 10000 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(10000)
    description?: string;

    @ApiProperty({ required: false, enum: MissionType })
    @IsOptional()
    @IsEnum(MissionType)
    type?: MissionType;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @ValidateIf((o) => o.schedule !== null)
    @IsString()
    @MaxLength(64)
    schedule?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    autoBuildWorks?: boolean;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsInt()
    @Min(-1)
    outstandingIdeasCap?: number | null;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsObject()
    guardrailsOverride?: Record<string, unknown> | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 200 })
    @IsOptional()
    @ValidateIf((o) => o.missionTemplateRepo !== null)
    @IsString()
    @MaxLength(200)
    missionTemplateRepo?: string | null;
}
