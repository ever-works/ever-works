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

export enum OperationType {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
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
    relevance_threshold_content: number = 0.75;

    @IsOptional()
    @IsInt()
    @Min(0)
    min_content_length_for_extraction: number = 300;

    @IsOptional()
    @IsBoolean()
    ai_first_generation_enabled: boolean = true;

    @IsOptional()
    @Min(0.01)
    @Max(1.0)
    prompt_comparison_confidence_threshold: number = 0.5;
}

export class CreateItemsGeneratorDto {
    @IsString()
    @IsNotEmpty()
    slug: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    prompt: string;

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
    @IsEnum(OperationType)
    operation?: OperationType = OperationType.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;
}
