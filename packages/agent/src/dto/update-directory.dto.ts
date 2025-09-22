import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { MarkdownReadmeConfigDto } from './create-directory.dto';

export class UpdateDirectoryDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    description?: string;

    @IsString()
    @IsOptional()
    owner?: string;

    @IsOptional()
    organization?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;
}
