import {
    IsString,
    IsOptional,
    ValidateNested,
    IsBoolean,
    IsUrl,
    IsEnum,
    IsNotEmpty,
    MaxLength,
    IsObject,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { sanitizeName, sanitizeDescription, sanitizePrompt } from '../../utils/sanitize.util';

// ============================================================================
// Enums
// ============================================================================

export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

// ============================================================================
// Supporting DTOs
// ============================================================================

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

/**
 * Provider selection for each capability category.
 * Allows users to select which plugin to use for search, AI, etc.
 */
export class ProvidersDto {
    /** Search provider plugin ID (e.g., "tavily", "exa:search") */
    @IsOptional()
    @IsString()
    search?: string;

    /** Screenshot provider plugin ID (e.g., "screenshotone") */
    @IsOptional()
    @IsString()
    screenshot?: string;

    /** AI provider plugin ID (e.g., "openai", "anthropic") */
    @IsOptional()
    @IsString()
    ai?: string;

    /** Pipeline plugin ID (null = default pipeline, "exa:websets" = full pipeline replacement) */
    @IsOptional()
    @IsString()
    pipeline?: string;
}

// ============================================================================
// Main DTO
// ============================================================================

/**
 * DTO for creating/triggering item generation.
 *
 * This is the minimal core DTO. All pipeline-specific configuration
 * is passed via `pluginConfig`, with fields defined dynamically by
 * the selected pipeline plugin via IFormSchemaProvider.getFormFields().
 */
export class CreateItemsGeneratorDto {
    // ============================================================================
    // Required Fields
    // ============================================================================

    /** Directory name */
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 200) : value))
    name: string;

    /** Generation prompt describing what items to generate */
    @IsString()
    @IsNotEmpty()
    @MaxLength(5000)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizePrompt(value, 5000) : value))
    prompt: string;

    // ============================================================================
    // Optional Core Fields
    // ============================================================================

    /** Company context for generation */
    @IsOptional()
    @ValidateNested()
    @Type(() => CompanyDto)
    company?: CompanyDto;

    /** Description for the repository */
    @IsOptional()
    @IsString()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    repository_description?: string;

    /** How to handle existing items during generation */
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    /** Whether to create a PR for updates or commit directly */
    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;

    /** How to create the website repository */
    @IsOptional()
    @IsEnum(WebsiteRepositoryCreationMethod)
    website_repository_creation_method?: WebsiteRepositoryCreationMethod =
        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE;

    // ============================================================================
    // Plugin System Fields
    // ============================================================================

    /**
     * Provider selection for each capability category.
     * Allows selecting specific plugins for search, AI, screenshots, and pipeline.
     *
     * Example:
     * ```
     * providers: {
     *   search: "tavily",
     *   ai: "openai",
     *   pipeline: "default-pipeline"
     * }
     * ```
     */
    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providers?: ProvidersDto;

    /**
     * Plugin-specific configuration.
     *
     * All pipeline-specific settings are passed here as an opaque object.
     * The structure is defined dynamically by the pipeline plugin via
     * IFormSchemaProvider.getFormFields(). The platform does not hardcode
     * any field names - plugins are fully responsible for their own config.
     *
     * The frontend fetches the form schema from /generator-form endpoint
     * and renders fields accordingly based on the selected pipeline.
     */
    @IsOptional()
    @IsObject()
    pluginConfig?: Record<string, unknown>;
}

// ============================================================================
// Update DTO
// ============================================================================

export class UpdateItemsGeneratorDto {
    @IsOptional()
    @IsEnum(GenerationMethod)
    generation_method?: GenerationMethod = GenerationMethod.CREATE_UPDATE;

    @IsOptional()
    @IsBoolean()
    update_with_pull_request?: boolean = true;
}
