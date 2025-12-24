import {
    IsString,
    IsArray,
    IsOptional,
    ValidateNested,
    IsInt,
    Min,
    Max,
    IsBoolean,
    IsUrl,
    IsEnum,
    IsNotEmpty,
    MaxLength,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
    sanitizeName,
    sanitizeDescription,
    sanitizePrompt,
    sanitizeText,
} from '../../utils/sanitize.util';

export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

export class CompanyDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 200) : value))
    name: string;

    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    website: string;
}

export class ConfigDto {
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100) // Sensible upper limit
    max_search_queries: number = 10;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100) // Sensible upper limit
    max_results_per_query: number = 5;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1000) // Sensible upper limit
    max_pages_to_process: number = 10;

    @IsOptional()
    @Min(0.01)
    @Max(1.0)
    relevance_threshold_content: number = 0.6;

    @IsOptional()
    @IsInt()
    @Min(0)
    min_content_length_for_extraction: number = 100;

    @IsOptional()
    @IsBoolean()
    ai_first_generation_enabled: boolean = false;

    @IsOptional()
    @IsBoolean()
    content_filtering_enabled: boolean = true;

    @IsOptional()
    @Min(0.01)
    @Max(1.0)
    prompt_comparison_confidence_threshold: number = 0.5;
}

/**
 * Helper to sanitize string arrays by trimming and removing empty values
 */
function sanitizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return value as string[];
    }
    return value
        .map((item) => (typeof item === 'string' ? sanitizeText(item) : item))
        .filter((item) => typeof item === 'string' && item.length > 0);
}

export class CreateItemsGeneratorDto {
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
    @ValidateNested()
    @Type(() => CompanyDto)
    company?: CompanyDto;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @Transform(({ value }) => sanitizeStringArray(value))
    initial_categories?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @Transform(({ value }) => sanitizeStringArray(value))
    priority_categories?: string[]; // Categories that should appear first in the final output

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @Transform(({ value }) => sanitizeStringArray(value))
    target_keywords?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @IsUrl({ protocols: ['http', 'https'], require_tld: true }, { each: true })
    @Transform(({ value }) =>
        Array.isArray(value) ? value.map((url: string) => url?.trim()).filter(Boolean) : value,
    )
    source_urls?: string[] = [];

    @IsOptional()
    @ValidateNested()
    @Type(() => ConfigDto)
    config: ConfigDto = new ConfigDto();

    @IsOptional()
    @IsString()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    repository_description?: string;

    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;

    @IsOptional()
    @IsBoolean()
    badge_evaluation_enabled?: boolean = false;

    @IsOptional()
    @IsEnum(WebsiteRepositoryCreationMethod)
    website_repository_creation_method?: WebsiteRepositoryCreationMethod =
        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;
}

export class UpdateItemsGeneratorDto {
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;
}
