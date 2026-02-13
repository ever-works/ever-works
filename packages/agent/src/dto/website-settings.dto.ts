import { Type } from 'class-transformer';
import {
    IsOptional,
    IsBoolean,
    IsString,
    IsArray,
    ValidateNested,
    IsIn,
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

    @IsString()
    @MaxLength(200)
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

    @IsOptional()
    @IsString()
    @MaxLength(200)
    company_website?: string;

    @IsOptional()
    @IsBoolean()
    categories_enabled?: boolean;

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
        companies_enabled?: boolean;
        tags_enabled?: boolean;
        surveys_enabled?: boolean;
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
