import { IsString, IsArray, IsOptional, ValidateNested, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100) // Sensible upper limit
  max_search_queries?: number = 10;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100) // Sensible upper limit
  max_results_per_query?: number = 20;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000) // Sensible upper limit
  max_pages_to_process?: number = 100;

  @IsOptional()
  @Min(0.01)
  @Max(1.0)
  relevance_threshold_content?: number = 0.75;

  @IsOptional()
  @IsInt()
  @Min(0)
  min_content_length_for_extraction?: number = 500;
}

export class CreateItemsGeneratorDto {
  @IsString()
  slug: string;

  @IsString()
  name: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  target_keywords?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigDto)
  config?: ConfigDto;
}