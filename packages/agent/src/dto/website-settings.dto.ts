import { Type } from 'class-transformer';
import {
    IsOptional,
    IsBoolean,
    IsString,
    IsArray,
    ValidateNested,
    IsIn,
    IsInt,
    IsUrl,
    Matches,
    Min,
    Max,
    MaxLength,
    ArrayMaxSize,
} from 'class-validator';

/**
 * DTO for a custom menu item (header or footer link)
 */
export class CustomMenuItemDto {
    @IsString()
    @MaxLength(50)
    label: string;

    // Security: navigation hrefs are rendered as <a href> in the deployed
    // public directory site. Restrict to a relative path (single leading "/",
    // not protocol-relative "//") or an absolute http(s) URL so stored
    // `javascript:`/`data:`/`vbscript:` and `//evil.com` open-redirect schemes
    // are rejected. Legitimate menu links (relative paths, https URLs) pass.
    @IsString()
    @MaxLength(200)
    @Matches(/^(?:\/(?!\/)\S*|https?:\/\/\S+)$/, {
        message: 'path must be a relative path (starting with /) or an http(s):// URL',
    })
    path: string;

    @IsOptional()
    @IsIn(['_self', '_blank'])
    target?: '_self' | '_blank';

    @IsOptional()
    @IsString()
    @MaxLength(50)
    icon?: string;
}

/**
 * DTO for custom menu configuration
 */
export class CustomMenuDto {
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CustomMenuItemDto)
    @ArrayMaxSize(10)
    header?: CustomMenuItemDto[];

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CustomMenuItemDto)
    @ArrayMaxSize(10)
    footer?: CustomMenuItemDto[];
}

/**
 * DTO for header settings
 */
export class SettingsHeaderDto {
    @IsOptional()
    @IsBoolean()
    submit_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    pricing_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    layout_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    language_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    theme_enabled?: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(20)
    layout_default?: string;

    @IsOptional()
    @IsString()
    @MaxLength(20)
    pagination_default?: string;

    @IsOptional()
    @IsString()
    @IsIn(['light', 'dark', 'system'])
    theme_default?: string;
}

/**
 * DTO for homepage settings
 */
export class SettingsHomepageDto {
    @IsOptional()
    @IsBoolean()
    hero_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    search_enabled?: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(20)
    default_view?: string;

    @IsOptional()
    @IsString()
    @MaxLength(20)
    default_sort?: string;
}

/**
 * DTO for footer settings
 */
export class SettingsFooterDto {
    @IsOptional()
    @IsBoolean()
    subscribe_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    version_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    theme_selector_enabled?: boolean;
}

/**
 * Main DTO for updating website settings
 */
export class UpdateWebsiteSettingsDto {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    company_name?: string;

    // Security: company_website is persisted to the work config and rendered
    // as an <a href> link in the Work Overview tab and the generated site.
    // Require a well-formed http(s) URL so stored `javascript:`/`data:` and
    // other dangerous schemes can never reach an href. Real company URLs pass.
    @IsOptional()
    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
    @MaxLength(200)
    company_website?: string;

    @IsOptional()
    @IsBoolean()
    categories_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    collections_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    companies_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    tags_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    surveys_enabled?: boolean;

    @IsOptional()
    @IsBoolean()
    comparisons_enabled?: boolean;

    /**
     * Enables CSV/Excel bulk export of items (EW-533). Off by default —
     * the directory's Export button is hidden until this flag is set.
     */
    @IsOptional()
    @IsBoolean()
    export_enabled?: boolean;

    /**
     * Enables CSV/Excel bulk import of items (EW-533). Off by default —
     * the import wizard is hidden until this flag is set. Wired up in
     * Phase 3.
     */
    @IsOptional()
    @IsBoolean()
    import_enabled?: boolean;

    /**
     * Per-directory cap on rows accepted by a single import upload.
     * Defaults to 500; the service-level hard ceiling is 2000.
     */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(2000)
    import_max_rows?: number;

    @IsOptional()
    @ValidateNested()
    @Type(() => SettingsHeaderDto)
    header?: SettingsHeaderDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => SettingsHomepageDto)
    homepage?: SettingsHomepageDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => SettingsFooterDto)
    footer?: SettingsFooterDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomMenuDto)
    custom_menu?: CustomMenuDto;
}

/**
 * Response type for website settings
 */
export interface WebsiteSettingsResponseDto {
    status: 'success' | 'error';
    company_name: string;
    company_website: string;
    settings: {
        categories_enabled?: boolean;
        collections_enabled?: boolean;
        companies_enabled?: boolean;
        tags_enabled?: boolean;
        surveys_enabled?: boolean;
        comparisons_enabled?: boolean;
        export_enabled?: boolean;
        import_enabled?: boolean;
        import_max_rows?: number;
        header?: {
            submit_enabled?: boolean;
            pricing_enabled?: boolean;
            layout_enabled?: boolean;
            language_enabled?: boolean;
            theme_enabled?: boolean;
            layout_default?: string;
            pagination_default?: string;
            theme_default?: string;
        };
        homepage?: {
            hero_enabled?: boolean;
            search_enabled?: boolean;
            default_view?: string;
            default_sort?: string;
        };
        footer?: {
            subscribe_enabled?: boolean;
            version_enabled?: boolean;
            theme_selector_enabled?: boolean;
        };
    };
    custom_menu: {
        header: Array<{
            label: string;
            path: string;
            target?: '_self' | '_blank';
            icon?: string;
        }>;
        footer: Array<{
            label: string;
            path: string;
            target?: '_self' | '_blank';
            icon?: string;
        }>;
    };
}
