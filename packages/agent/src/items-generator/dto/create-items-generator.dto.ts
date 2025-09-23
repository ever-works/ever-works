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
} from 'class-validator';
import { Type } from 'class-transformer';

export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    FORK = 'fork',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

export class CompanyDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
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
    max_results_per_query: number = 20;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1000) // Sensible upper limit
    max_pages_to_process: number = 100;

    @IsOptional()
    @Min(0.01)
    @Max(1.0)
    relevance_threshold_content: number = 0.5;

    @IsOptional()
    @IsInt()
    @Min(0)
    min_content_length_for_extraction: number = 300;

    @IsOptional()
    @IsBoolean()
    ai_first_generation_enabled: boolean = true;

    @IsOptional()
    @IsBoolean()
    content_filtering_enabled: boolean = true;

    @IsOptional()
    @Min(0.01)
    @Max(1.0)
    prompt_comparison_confidence_threshold: number = 0.5;
}

export class CreateItemsGeneratorDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    prompt: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => CompanyDto)
    company?: CompanyDto;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    initial_categories?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    priority_categories?: string[]; // Categories that should appear first in the final output

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    target_keywords?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @IsUrl({ protocols: ['http', 'https'], require_tld: true }, { each: true })
    source_urls?: string[] = [];

    @IsOptional()
    @ValidateNested()
    @Type(() => ConfigDto)
    config: ConfigDto = new ConfigDto();

    @IsOptional()
    @IsString()
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
        WebsiteRepositoryCreationMethod.DUPLICATE;
}

export class UpdateItemsGeneratorDto {
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;
}
