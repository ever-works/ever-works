import { Type } from 'class-transformer';
import {
    IsEnum,
    IsBoolean,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
    Matches,
} from 'class-validator';
import { MarkdownReadmeConfig } from '../entities/directory.entity';

export enum RepoProvider {
    GITHUB = 'github',
}

export class MarkdownReadmeConfigDto implements MarkdownReadmeConfig {
    @IsOptional()
    @IsString()
    header?: string;

    @IsOptional()
    @IsBoolean()
    overwriteDefaultHeader?: boolean;

    @IsOptional()
    @IsString()
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
    slug: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    description: string;

    @IsOptional()
    @IsString()
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
