import { Type, Transform } from 'class-transformer';
import { IsOptional, IsString, IsBoolean, ValidateNested, MaxLength } from 'class-validator';
import { MarkdownReadmeConfigDto } from './create-directory.dto';
import { sanitizeName, sanitizeDescription } from '../utils/sanitize.util';

export class UpdateDirectoryDto {
    @IsString()
    @IsOptional()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @IsOptional()
    organization?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;

    @IsOptional()
    @IsBoolean()
    websiteTemplateAutoUpdate?: boolean;

    @IsOptional()
    @IsBoolean()
    websiteTemplateUseBeta?: boolean;
}
