import { Type } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { MarkdownReadmeConfig } from '../entities/directory.entity';

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

    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readme_config?: MarkdownReadmeConfigDto;
}
