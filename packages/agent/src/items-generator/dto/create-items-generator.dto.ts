import {
    IsString,
    IsOptional,
    ValidateNested,
    IsBoolean,
    IsEnum,
    IsNotEmpty,
    MaxLength,
    IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { sanitizeName, sanitizePrompt } from '../../utils/sanitize.util';
import {
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
    type ProvidersDto as IProvidersDto,
    type CreateItemsGeneratorDto as ICreateItemsGeneratorDto,
    type UpdateItemsGeneratorDto as IUpdateItemsGeneratorDto,
} from '@ever-works/contracts/api';

export { GenerationMethod, WebsiteRepositoryCreationMethod } from '@ever-works/contracts/api';

export class ProvidersDto implements IProvidersDto {
    @ApiPropertyOptional({ description: 'Search provider plugin ID' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({ description: 'Screenshot provider plugin ID' })
    @IsOptional()
    @IsString()
    screenshot?: string;

    @ApiPropertyOptional({ description: 'AI provider plugin ID' })
    @IsOptional()
    @IsString()
    ai?: string;

    @ApiPropertyOptional({ description: 'Content extractor plugin ID' })
    @IsOptional()
    @IsString()
    contentExtractor?: string;

    @ApiPropertyOptional({ description: 'Pipeline plugin ID' })
    @IsOptional()
    @IsString()
    pipeline?: string;
}

/** DTO for creating/triggering item generation. */
export class CreateItemsGeneratorDto implements ICreateItemsGeneratorDto {
    @ApiProperty({ description: 'Directory name', maxLength: 200 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 200) : value))
    name: string;

    @ApiProperty({
        description: 'Generation prompt describing what items to generate',
        maxLength: 5000,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(5000)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizePrompt(value, 5000) : value))
    prompt: string;

    @ApiPropertyOptional({
        description: 'Generation method',
        enum: GenerationMethod,
        default: GenerationMethod.CREATE_UPDATE,
    })
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @ApiPropertyOptional({
        description: 'Whether to create a pull request for changes',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;

    @ApiPropertyOptional({
        description: 'Method for creating the website repository',
        enum: WebsiteRepositoryCreationMethod,
        default: WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
    })
    @IsOptional()
    @IsEnum(WebsiteRepositoryCreationMethod)
    website_repository_creation_method?: WebsiteRepositoryCreationMethod =
        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;

    @ApiPropertyOptional({ description: 'Provider plugin overrides', type: ProvidersDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providers?: ProvidersDto;

    @ApiPropertyOptional({
        description: 'Plugin-specific configuration defined by the pipeline plugin form schema',
    })
    @IsOptional()
    @IsObject()
    pluginConfig?: Record<string, unknown>;

    /** Per-plugin config extracted by processFormConfig(). Not part of API contract. */
    _processedPluginConfig?: Record<string, Record<string, unknown>>;
}

export class UpdateItemsGeneratorDto implements IUpdateItemsGeneratorDto {
    @ApiPropertyOptional({
        description: 'Generation method',
        enum: GenerationMethod,
        default: GenerationMethod.CREATE_UPDATE,
    })
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @ApiPropertyOptional({
        description: 'Whether to create a pull request for changes',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;

    @ApiPropertyOptional({ description: 'Provider plugin overrides', type: ProvidersDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providers?: ProvidersDto;
}
