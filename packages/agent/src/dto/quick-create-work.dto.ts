import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { MarkdownReadmeConfigDto } from './create-work.dto';
import { sanitizeDescription, sanitizeName, sanitizePrompt } from '../utils/sanitize.util';

/**
 * EW-617 G4 — payload for `POST /api/works/quick-create`.
 *
 * Combines the fields needed to create a Work (subset of
 * `CreateWorkDto`) plus a `prompt` so the server can kick off AI
 * generation in the same request. The wizard's "Generate now" button
 * sends this; the response carries both the new `workId` and the
 * `generationHistoryId` the client polls.
 *
 * Provider defaults (storage/deploy/git) are read from the user's
 * `onboardingState` server-side, so the client doesn't need to repeat
 * the wizard choices here. Override only when the user picked something
 * non-default (e.g. user-github with their own repo).
 */
export class QuickCreateWorkDto {
    @ApiProperty({
        description: 'URL-friendly identifier (lowercase letters, numbers, hyphens only)',
        example: 'ai-coding-assistants',
    })
    @IsString()
    @IsNotEmpty()
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'Slug can only contain lowercase letters, numbers, and hyphens',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    slug: string;

    @ApiProperty({
        description: 'Display name for the work',
        example: 'AI Coding Assistants',
        maxLength: 100,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @ApiProperty({
        description: 'Brief description of the work',
        maxLength: 500,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description: string;

    @ApiProperty({
        description: 'Generation prompt — the user input from the landing page or wizard',
        example: 'AI coding assistants directory with reviews and pricing',
        maxLength: 5000,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(5000)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizePrompt(value, 5000) : value))
    prompt: string;

    @ApiPropertyOptional({ description: 'Whether the owner is an organization' })
    @IsOptional()
    @IsBoolean()
    organization?: boolean;

    @ApiPropertyOptional({ description: 'Repository owner (defaults to user)' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @ApiPropertyOptional({
        description: 'Override the git provider (default: from onboarding state, then "github")',
    })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    gitProvider?: string;

    @ApiPropertyOptional({
        description: 'Override deploy provider (default: from onboarding state, then "ever-works")',
    })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    deployProvider?: string;

    @ApiPropertyOptional({
        description:
            'Override storage provider (default: from onboarding state, then "user-github")',
    })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    storageProvider?: string;

    @ApiPropertyOptional({ description: 'Website template identifier (default: "classic")' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    websiteTemplateId?: string;

    @ApiPropertyOptional({
        description: 'AI model override (defaults to the provider plugin default)',
    })
    @IsOptional()
    @IsString()
    model?: string;

    @ApiPropertyOptional({
        description: 'Optional README configuration',
        type: MarkdownReadmeConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;
}
