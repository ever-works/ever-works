import { Type, Transform } from 'class-transformer';
import {
    IsEnum,
    IsBoolean,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
    Matches,
    MaxLength,
} from 'class-validator';
import { MarkdownReadmeConfig } from '../entities/directory.entity';
import { sanitizeName, sanitizeDescription, sanitizeText } from '../utils/sanitize.util';

export enum RepoProvider {
    GITHUB = 'github',
}

export class MarkdownReadmeConfigDto implements MarkdownReadmeConfig {
    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? sanitizeText(value, { removeNewlines: false, collapseSpaces: false, trim: true })
            : value,
    )
    header?: string;

    @IsOptional()
    @IsBoolean()
    overwriteDefaultHeader?: boolean;

    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? sanitizeText(value, { removeNewlines: false, collapseSpaces: false, trim: true })
            : value,
    )
    footer?: string;

    @IsOptional()
    @IsBoolean()
    overwriteDefaultFooter?: boolean;
}

export class CreateDirectoryDto {
    @IsString()
    @IsNotEmpty()
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'Slug can only contain lowercase letters, numbers, and hyphens',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    slug: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description: string;

    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @IsBoolean()
    organization: boolean;

    @IsEnum(RepoProvider)
    @IsOptional()
    repoProvider: RepoProvider = RepoProvider.GITHUB;

    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;
}
