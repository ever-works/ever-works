import { Type, Transform } from 'class-transformer';
import { IsOptional, IsString, IsBoolean, ValidateNested, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MarkdownReadmeConfigDto } from './create-directory.dto';
import { sanitizeName, sanitizeDescription } from '../utils/sanitize.util';

export class UpdateDirectoryDto {
    @ApiPropertyOptional({ description: 'Display name for the directory', maxLength: 100 })
    @IsString()
    @IsOptional()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name?: string;

    @ApiPropertyOptional({ description: 'Brief description of the directory', maxLength: 500 })
    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @ApiPropertyOptional({ description: 'Username or organization for repository ownership' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @ApiPropertyOptional({ description: 'Whether the owner is an organization' })
    @IsOptional()
    organization?: boolean;

    @ApiPropertyOptional({ description: 'Deploy provider (e.g., vercel)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    deployProvider?: string;

    @ApiPropertyOptional({
        description: 'Custom README configuration',
        type: MarkdownReadmeConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;

    @ApiPropertyOptional({ description: 'Whether to auto-update the website template' })
    @IsOptional()
    @IsBoolean()
    websiteTemplateAutoUpdate?: boolean;

    @ApiPropertyOptional({ description: 'Whether to use the beta website template' })
    @IsOptional()
    @IsBoolean()
    websiteTemplateUseBeta?: boolean;

    @ApiPropertyOptional({ description: 'Whether community PR processing is enabled' })
    @IsOptional()
    @IsBoolean()
    communityPrEnabled?: boolean;

    @ApiPropertyOptional({ description: 'Whether to auto-close community PRs after processing' })
    @IsOptional()
    @IsBoolean()
    communityPrAutoClose?: boolean;
}
