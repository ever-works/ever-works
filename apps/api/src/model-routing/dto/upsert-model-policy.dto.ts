import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Length,
    Max,
    Min,
    ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    MODEL_ROUTING_LIMITS,
    REASONING_EFFORTS,
    type ReasoningEffort,
} from '@ever-works/contracts';
import { NotPrimaryInFallbacks } from './validators/not-primary-in-fallbacks.validator';
import { UniqueChainEntries } from './validators/unique-chain-entries.validator';

/**
 * Model accounts (AW-16) — the body of `PUT /api/model-policies/*`.
 *
 * Every field has three states, on purpose:
 *   - absent → leave as stored
 *   - `null` → clear back to inheriting from the wider scope
 *   - a value → set it
 *
 * `@IsOptional()` lets `null` through untouched, which is exactly "inherit".
 * The same rules are enforced again in the service, so a caller that skips
 * this DTO cannot store a policy the ladder would refuse.
 */

export class ModelSelectionDto {
    @ApiPropertyOptional({ description: 'Id of an installed AI provider plugin.', nullable: true })
    @IsOptional()
    @IsString()
    @Length(1, 128)
    providerPluginId?: string | null;

    @ApiPropertyOptional({
        description: "A model id from that provider's catalogue.",
        nullable: true,
    })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    modelId?: string | null;
}

export class ModelChainEntryDto {
    @ApiProperty({ description: 'Id of an installed AI provider plugin.' })
    @IsString()
    @Length(1, 128)
    providerPluginId: string;

    @ApiProperty({ description: "A model id from that provider's catalogue." })
    @IsString()
    @Length(1, 200)
    modelId: string;
}

export class UpsertModelPolicyDto {
    @ApiPropertyOptional({
        description:
            'The primary model. The workspace and a schedule name both halves; an Agent may name either half, as its own settings always allowed. null = inherit.',
        type: ModelSelectionDto,
        nullable: true,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => ModelSelectionDto)
    primaryModel?: ModelSelectionDto | null;

    @ApiPropertyOptional({
        description: `Ordered fallback models, at most ${MODEL_ROUTING_LIMITS.fallbackEntriesPerPolicy}. Never the primary, never the same model twice. null = inherit, [] = no fallbacks.`,
        type: [ModelChainEntryDto],
        nullable: true,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MODEL_ROUTING_LIMITS.fallbackEntriesPerPolicy)
    @ValidateNested({ each: true })
    @Type(() => ModelChainEntryDto)
    @UniqueChainEntries()
    @NotPrimaryInFallbacks()
    fallbackModels?: ModelChainEntryDto[] | null;

    @ApiPropertyOptional({
        description: 'How hard models think before answering. Higher costs more and takes longer.',
        enum: REASONING_EFFORTS as unknown as string[],
        nullable: true,
    })
    @IsOptional()
    @IsIn(REASONING_EFFORTS as unknown as string[])
    reasoningEffort?: ReasoningEffort | null;

    @ApiPropertyOptional({
        description: `Seconds before a run still going is ended (${MODEL_ROUTING_LIMITS.runTimeoutSeconds.min}–${MODEL_ROUTING_LIMITS.runTimeoutSeconds.max}). Workspace and schedule only.`,
        nullable: true,
    })
    @IsOptional()
    @IsInt()
    @Min(MODEL_ROUTING_LIMITS.runTimeoutSeconds.min)
    @Max(MODEL_ROUTING_LIMITS.runTimeoutSeconds.max)
    runTimeoutSeconds?: number | null;

    @ApiPropertyOptional({
        description: `Seconds one model attempt may take (${MODEL_ROUTING_LIMITS.attemptTimeoutSeconds.min}–${MODEL_ROUTING_LIMITS.attemptTimeoutSeconds.max}).`,
        nullable: true,
    })
    @IsOptional()
    @IsInt()
    @Min(MODEL_ROUTING_LIMITS.attemptTimeoutSeconds.min)
    @Max(MODEL_ROUTING_LIMITS.attemptTimeoutSeconds.max)
    attemptTimeoutSeconds?: number | null;
}
