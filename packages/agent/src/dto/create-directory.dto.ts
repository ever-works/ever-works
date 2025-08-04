import { Type } from 'class-transformer';
import {
    IsEnum,
    IsBoolean,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
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
    overwrite_default_header?: boolean;

    @IsOptional()
    @IsString()
    footer?: string;

    @IsOptional()
    @IsBoolean()
    overwrite_default_footer?: boolean;
}

export class CreateDirectoryDto {
    @IsString()
    @IsNotEmpty()
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
    repo_provider: RepoProvider = RepoProvider.GITHUB;

    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readme_config?: MarkdownReadmeConfigDto;
}
