import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
} from 'class-validator';
import { WorkProposalSource, WorkProposalStatus } from '@ever-works/agent/user-research';
import { IdeaFailureKind } from '@ever-works/agent/entities';

export class ListWorkProposalsQueryDto {
    @ApiProperty({
        required: false,
        isArray: true,
        enum: WorkProposalStatus,
        description: 'Filter by status (default: pending only)',
    })
    @IsOptional()
    // Express parses `?statuses=pending` as a string and `?statuses=a&statuses=b`
    // as an array. Normalize to array so @IsArray accepts both shapes.
    @Transform(({ value }) =>
        value === undefined || value === null ? value : Array.isArray(value) ? value : [value],
    )
    @IsArray()
    @IsEnum(WorkProposalStatus, { each: true })
    statuses?: WorkProposalStatus[];

    /**
     * Optional: scope the list to Ideas spawned by a specific Mission
     * (Phase 0 PR 0.1, Phase 1 PR A). When omitted, returns Ideas
     * across all Missions plus standalone Ideas (the existing
     * dashboard behavior). Phase 6 PR R uses this from the Mission
     * detail page; the Dashboard Ideas block and `/ideas` page leave
     * it unset.
     */
    @ApiProperty({
        required: false,
        description: 'Filter by missionId — Ideas spawned by this Mission only',
    })
    @IsOptional()
    @IsUUID()
    missionId?: string;
}

export class AcceptWorkProposalDto {
    @ApiProperty({ description: 'The work that was created from this proposal.' })
    @IsUUID()
    workId: string;
}

/**
 * Phase 1 PR B — body for `POST /me/work-proposals` user-manual
 * create. Description is the only required field; title is auto-
 * derived if absent (placeholder until the AI titler ships in
 * PR I).
 */
export class CreateWorkProposalDto {
    @ApiProperty({
        description:
            'Free-text Idea description. The build pipeline uses this as the prompt to generate the Work.',
        minLength: 10,
        maxLength: 5000,
    })
    @IsString()
    @MinLength(10)
    @MaxLength(5000)
    description: string;

    @ApiProperty({
        required: false,
        description:
            'Optional short title. When omitted, the service derives one from the description (placeholder for the AI-generated title from the shared titler in Phase 3 PR I).',
        maxLength: 120,
    })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    title?: string;
}

// `BuildWorkProposalResponseDto` is declared AFTER
// `WorkProposalResponseDto` further down — it references that class
// in a decorator, and JS class declarations are not hoisted (unlike
// function declarations), so referencing the class before its
// declaration line throws ReferenceError at module-init time.

export class UpdateWorkProposalPreferencesDto {
    @ApiProperty({
        description: 'When true, the user opts out of background research.',
        required: false,
    })
    @IsOptional()
    @IsBoolean()
    optOut?: boolean;

    @ApiProperty({
        description:
            'When true, the user receives proposal notification emails. Alias of !optOut for back-compat with the web client.',
        required: false,
    })
    @IsOptional()
    @IsBoolean()
    emailNotifications?: boolean;
}

export class WorkProposalResponseDto {
    @ApiProperty()
    @IsUUID()
    id: string;

    @ApiProperty()
    @IsString()
    title: string;

    @ApiProperty()
    @IsString()
    description: string;

    @ApiProperty()
    @IsString()
    slugSuggestion: string;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: { name: { type: 'string' }, slug: { type: 'string' } },
        },
    })
    suggestedCategories: Array<{ name: string; slug: string }>;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string' } },
        },
    })
    suggestedFields: Array<{ name: string; type: string }>;

    @ApiProperty({
        type: 'array',
        items: {
            type: 'object',
            properties: { pluginId: { type: 'string' }, reason: { type: 'string' } },
        },
    })
    recommendedPlugins: Array<{ pluginId: string; reason: string }>;

    @ApiProperty()
    @IsString()
    generatedPrompt: string;

    @ApiProperty()
    reasoning: string;

    @ApiProperty({ enum: WorkProposalSource })
    source: WorkProposalSource;

    @ApiProperty({ enum: WorkProposalStatus })
    status: WorkProposalStatus;

    @ApiProperty({ required: false, nullable: true })
    acceptedWorkId?: string | null;

    /**
     * FK to the spawning Mission (Phase 0 PR 0.1). NULL for Ideas
     * not spawned by a Mission. Phase 6 PR R uses this on the
     * Mission detail page to group child Ideas.
     */
    @ApiProperty({ required: false, nullable: true })
    missionId?: string | null;

    /**
     * Human-readable failure reason (Phase 0 PR 0.8, spec §3.9).
     * Populated only when `status = FAILED`. Rendered inline on
     * the Idea Card in Phase 6 PR GG.
     */
    @ApiProperty({ required: false, nullable: true })
    failureMessage?: string | null;

    /**
     * Machine-readable failure classification (Phase 0 PR 0.8,
     * Decision A23). Populated only when `status = FAILED`. Drives
     * the auto-retry decision in the Goal-completion handler
     * (Phase 1 PR FF).
     */
    @ApiProperty({ required: false, nullable: true, enum: IdeaFailureKind })
    failureKind?: IdeaFailureKind | null;

    @ApiProperty()
    generatedAt: Date;
}

/**
 * Phase 1 PR B — response shape for `POST /me/work-proposals/:id/build`.
 * Returns both the Idea after the QUEUED transition AND a compact
 * view of the WorkAgentGoal the build pipeline just created (so the
 * UI can show "build queued, goal id=…").
 *
 * Declared AFTER `WorkProposalResponseDto` because it references that
 * class in a decorator — JS class declarations are not hoisted, so
 * declaring this earlier would throw ReferenceError at module init.
 */
export class BuildWorkProposalResponseDto {
    @ApiProperty({
        description: 'The Idea row after the QUEUED transition.',
        type: () => WorkProposalResponseDto,
    })
    proposal: WorkProposalResponseDto;

    @ApiProperty({
        description: 'The WorkAgentGoal that the build pipeline just created.',
    })
    goal: {
        id: string;
        instruction: string;
        status: string;
        dryRun: boolean;
        createdAt: Date;
    };
}

export class RefreshResponseDto {
    @ApiProperty({ enum: ['queued', 'rate-limited', 'at-limit'] })
    status: 'queued' | 'rate-limited' | 'at-limit';

    @ApiProperty({ required: false })
    error?: string;
}
