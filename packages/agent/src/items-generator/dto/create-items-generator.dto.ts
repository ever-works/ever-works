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
    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    @IsString()
    screenshot?: string;

    @IsOptional()
    @IsString()
    ai?: string;

    @IsOptional()
    @IsString()
    contentExtractor?: string;

    @IsOptional()
    @IsString()
    pipeline?: string;
}

/** DTO for creating/triggering item generation. */
export class CreateItemsGeneratorDto implements ICreateItemsGeneratorDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 200) : value))
    name: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(5000)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizePrompt(value, 5000) : value))
    prompt: string;

    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;

    @IsOptional()
    @IsEnum(WebsiteRepositoryCreationMethod)
    website_repository_creation_method?: WebsiteRepositoryCreationMethod =
        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;

    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providers?: ProvidersDto;

    /** Plugin-specific configuration defined by the pipeline plugin's form schema. */
    @IsOptional()
    @IsObject()
    pluginConfig?: Record<string, unknown>;

    /** Per-plugin config extracted by processFormConfig(). Not part of API contract. */
    _processedPluginConfig?: Record<string, Record<string, unknown>>;
}

export class UpdateItemsGeneratorDto implements IUpdateItemsGeneratorDto {
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;

    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providers?: ProvidersDto;
}
