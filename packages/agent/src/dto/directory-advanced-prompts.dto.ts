import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { sanitizePrompt } from '../utils/sanitize.util';

const MAX_PROMPT_LENGTH = 2000;

/**
 * Sanitizes a prompt value, returning null for empty/whitespace-only strings.
 */
function sanitizeAndNormalize(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return sanitizePrompt(trimmed, MAX_PROMPT_LENGTH);
}

/**
 * DTO for updating per-directory advanced prompts.
 * All fields are optional - null/undefined means use the standard prompt only.
 */
export class UpdateDirectoryAdvancedPromptsDto {
    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    relevanceAssessment?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    itemGeneration?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    itemExtraction?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    searchQuery?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    categorization?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    deduplication?: string | null;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_PROMPT_LENGTH)
    @Transform(({ value }) => sanitizeAndNormalize(value))
    sourceValidation?: string | null;
}

/**
 * Response DTO for directory advanced prompts.
 */
export interface DirectoryAdvancedPromptsResponseDto {
    directoryId: string;
    relevanceAssessment: string | null;
    itemGeneration: string | null;
    itemExtraction: string | null;
    searchQuery: string | null;
    categorization: string | null;
    deduplication: string | null;
    sourceValidation: string | null;
    updatedAt: string | null;
}
