import { Type, Transform } from 'class-transformer';
import {
    IsOptional,
    IsString,
    IsBoolean,
    IsEmail,
    IsIn,
    ValidateNested,
    MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MarkdownReadmeConfigDto } from './create-work.dto';
import { sanitizeName, sanitizeDescription } from '../utils/sanitize.util';

export class UpdateWorkDto {
    @ApiPropertyOptional({ description: 'Display name for the work', maxLength: 100 })
    @IsString()
    @IsOptional()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name?: string;

    @ApiPropertyOptional({ description: 'Brief description of the work', maxLength: 500 })
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

    @ApiPropertyOptional({ description: 'Website template identifier for this work' })
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

    @ApiPropertyOptional({ description: 'Custom git committer name for this work' })
    @IsString()
    @IsOptional()
    committerName?: string | null;

    @ApiPropertyOptional({ description: 'Custom git committer email for this work' })
    @IsEmail()
    @IsOptional()
    committerEmail?: string | null;

    @ApiPropertyOptional({
        description:
            'EW-120 Activity Feed sync transport (pull / push / disabled). Source of truth is `activity_sync.mode` in works.yml; this field is the platform-side read path. Settings updates flow here then get round-tripped to works.yml by the WorksConfigRepositorySync flow.',
        enum: ['pull', 'push', 'disabled'],
    })
    @IsOptional()
    @IsIn(['pull', 'push', 'disabled'])
    activitySyncMode?: 'pull' | 'push' | 'disabled';
}
