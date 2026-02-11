import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PluginCategory, PluginIcon } from '@ever-works/plugin/api';
import { PluginIconDto } from './plugin-response.dto';

/**
 * Plugin information for settings menu
 */
export class SettingsMenuPluginDto {
    @ApiProperty({ description: 'Plugin unique identifier' })
    pluginId: string;

    @ApiProperty({ description: 'Plugin display name' })
    name: string;

    @ApiPropertyOptional({ description: 'Plugin icon' })
    icon?: PluginIconDto;

    @ApiProperty({ description: 'Whether plugin is enabled' })
    enabled: boolean;

    @ApiProperty({ description: 'Whether plugin has required settings that are not configured' })
    hasRequiredSettings: boolean;
}

/**
 * Category grouping for settings menu
 */
export class SettingsMenuCategoryDto {
    @ApiProperty({ description: 'Category identifier' })
    category: PluginCategory;

    @ApiProperty({ description: 'Category display label' })
    label: string;

    @ApiProperty({ description: 'Plugins in this category', type: [SettingsMenuPluginDto] })
    plugins: SettingsMenuPluginDto[];
}

/**
 * Response DTO for settings menu
 */
export class SettingsMenuResponseDto {
    @ApiProperty({ description: 'Categories with plugins', type: [SettingsMenuCategoryDto] })
    categories: SettingsMenuCategoryDto[];
}
