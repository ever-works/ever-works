import { Type, Transform } from 'class-transformer';
import {
    IsBoolean,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
    Matches,
    MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MarkdownReadmeConfig } from '../entities/work.entity';
import { sanitizeName, sanitizeDescription, sanitizeText } from '../utils/sanitize.util';

export class MarkdownReadmeConfigDto implements MarkdownReadmeConfig {
    @ApiPropertyOptional({ description: 'Custom header content for the README' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? sanitizeText(value, { removeNewlines: false, collapseSpaces: false, trim: true })
            : value,
    )
    header?: string;

    @ApiPropertyOptional({
        description: 'Whether to replace the default header entirely',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    overwriteDefaultHeader?: boolean;

    @ApiPropertyOptional({ description: 'Custom footer content for the README' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? sanitizeText(value, { removeNewlines: false, collapseSpaces: false, trim: true })
            : value,
    )
    footer?: string;

    @ApiPropertyOptional({
        description: 'Whether to replace the default footer entirely',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    overwriteDefaultFooter?: boolean;
}

export class CreateWorkDto {
    @ApiProperty({
        description: 'URL-friendly identifier (lowercase letters, numbers, hyphens only)',
        example: 'my-awesome-work',
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
        example: 'My Awesome Work',
        maxLength: 100,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @ApiProperty({
        description: 'Brief description of the work',
        example: 'A curated list of awesome tools and resources',
        maxLength: 500,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description: string;

    @ApiPropertyOptional({
        description: 'Username or organization for repository ownership',
    })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @ApiProperty({ description: 'Whether the owner is an organization', example: false })
    @IsBoolean()
    organization: boolean;

    @ApiPropertyOptional({
        description: 'Git provider plugin ID (e.g., github, gitlab)',
        default: 'github',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    gitProvider: string = 'github';

    @ApiPropertyOptional({
        description:
            "Deploy provider for this work. One of 'ever-works' (default for users who picked Ever Works in onboarding), 'vercel', 'k8s'. " +
            'When omitted the server seeds from the user’s onboarding choice; failing that, falls back to the historical default of vercel.',
        example: 'ever-works',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    deployProvider?: string;

    @ApiPropertyOptional({
        description:
            "Storage provider. One of 'ever-works-git' (push to the managed Ever Works GitHub org), 'user-github', 'user-gitlab' (planned), 'user-git' (planned). " +
            'Server seeds from the user’s onboarding choice when omitted; defaults to user-github.',
        example: 'ever-works-git',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    storageProvider?: string;

    @ApiPropertyOptional({
        description: 'Website template identifier to use for website repository initialization',
        default: 'classic',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    websiteTemplateId?: string;

    @ApiPropertyOptional({
        description: 'Custom README configuration',
        type: MarkdownReadmeConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;

    @ApiPropertyOptional({
        description:
            'EW-617 G8 zero-friction funnel correlation id. Minted on the landing form (G1) and threaded through the full funnel so REPOS_PUSHED / DEPLOY_STARTED emits stay joinable with the upstream WORK_CREATED event.',
    })
    @IsOptional()
    @IsString()
    correlationId?: string;
}
